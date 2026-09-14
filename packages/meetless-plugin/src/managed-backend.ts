import { createHash } from "node:crypto";
import type { ManagedConvexCredential } from "./managed-upload.js";
import type { ConvexManagedCredentialSource, ManagedAppleVerificationMaterial } from "./managed-auth.js";

export type AppleEnvironment = "SANDBOX" | "PRODUCTION";
export interface VerifiedStoreTransaction {
  readonly signedTransaction: string;
  readonly environment: AppleEnvironment;
}
export interface ManagedBackendContext {
  readonly endpoint: string;
  readonly namespace: string;
  readonly environment: AppleEnvironment | null;
  readonly source: ConvexManagedCredentialSource;
}
export interface ManagedBackendOperation {
  readonly context: ManagedBackendContext;
  readonly apple?: ManagedAppleVerificationMaterial;
}

/** An operation captures exactly one backend; no fallback or cross-backend token cache. */
export class ManagedBackendRouter {
  private readonly contexts = new Map<string, ManagedBackendContext>();
  private readonly credentials = new Map<ManagedBackendContext, ManagedConvexCredential>();
  constructor(
    private readonly endpoints: { readonly development: string } | Readonly<Record<AppleEnvironment, string>>,
    private readonly createSource: (endpoint: string) => ConvexManagedCredentialSource,
    private readonly readProof: () => Promise<VerifiedStoreTransaction | null>,
  ) {
    for (const endpoint of Object.values(endpoints)) validateEndpoint(endpoint);
    if ("SANDBOX" in endpoints && new URL(endpoints.SANDBOX).href === new URL(endpoints.PRODUCTION).href) {
      throw new Error("Store backends must be distinct");
    }
  }
  get routed(): boolean { return !("development" in this.endpoints); }
  async select(proof?: VerifiedStoreTransaction, apple?: ManagedAppleVerificationMaterial): Promise<ManagedBackendOperation> {
    if ("development" in this.endpoints) return { context: this.context(this.endpoints.development, null), ...(apple ? { apple } : {}) };
    const verified = proof ?? await this.readProof();
    if (!verified || !["SANDBOX", "PRODUCTION"].includes(verified.environment) || !verified.signedTransaction.trim()) {
      throw new Error("Verified Store environment is required before selecting a backend");
    }
    if (apple && (apple.adapter !== "app-store-server-api" || apple.signedTransaction !== verified.signedTransaction)) {
      throw new Error("Apple evidence does not belong to the selected Store context");
    }
    return {
      context: this.context(this.endpoints[verified.environment], verified.environment),
      apple: { adapter: "app-store-server-api", signedTransaction: verified.signedTransaction },
    };
  }
  async authorize(operation: ManagedBackendOperation, options: { enroll?: boolean; refresh?: boolean; credential?: ManagedConvexCredential } = {}): Promise<ManagedConvexCredential> {
    const { context, apple } = operation;
    const cached = this.credentials.get(context);
    if (this.routed && options.credential && options.credential !== cached) throw new Error("Credential is not bound to the selected backend");
    const supplied = options.credential ?? cached;
    if (!options.enroll && !options.refresh && supplied && !needsRefresh(supplied)) return supplied;
    const credential = options.enroll
      ? await context.source.enroll(requireApple(apple))
      : await context.source.refresh(apple?.adapter === "app-store-server-api" ? apple : undefined);
    this.credentials.set(context, credential);
    return credential;
  }
  private context(endpoint: string, environment: AppleEnvironment | null): ManagedBackendContext {
    const key = `${environment ?? "development"}:${endpoint}`;
    let context = this.contexts.get(key);
    if (!context) {
      context = Object.freeze({ endpoint, environment, namespace: environment ? `${environment.toLowerCase()}-${createHash("sha256").update(endpoint).digest("hex").slice(0, 24)}` : "", source: this.createSource(endpoint) });
      this.contexts.set(key, context);
    }
    return context;
  }
}
function requireApple(apple?: ManagedAppleVerificationMaterial): ManagedAppleVerificationMaterial {
  if (!apple) throw new Error("Apple enrollment evidence is missing");
  return apple;
}
function needsRefresh(credential: ManagedConvexCredential): boolean {
  return (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) ||
    ((credential.state === "active" || credential.state === "grace") && credential.naturalExpiryAt != null && credential.naturalExpiryAt <= Date.now());
}
function validateEndpoint(value: string): void {
  const url = new URL(value);
  if (!value.startsWith("https://") || /[\s\\]/u.test(value) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Managed backend must be an exact public HTTPS root URL");
}
