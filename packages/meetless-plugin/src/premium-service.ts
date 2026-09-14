import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import {
  PremiumAccessWireSchema,
  PremiumMutationResultWireSchema,
  type PremiumAccessWire,
  type PremiumMutationResultWire,
} from "@meetless/meeting-contracts";
import { z } from "zod";

export const PREMIUM_ENTITLEMENT = "premium" as const;
export const PREMIUM_MONTHLY_PRODUCT = "com.meetless.app.premium.monthly" as const;
export const PREMIUM_ANNUAL_PRODUCT = "com.meetless.app.premium.annual" as const;
export const PREMIUM_REQUIRED_MESSAGE = "Managed transcription requires Meetless Premium. Open the paywall or restore purchases.";

type PremiumDiagnosticStage = "plugin_rpc_dispatch" | "native_rpc_dispatch" | "plugin_completion";
type PremiumDiagnosticOutcome = "started" | "active" | "cancelled" | "pending" | "failed";
export type PremiumAuthorizationState = "active" | "grace" | "expired" | "refunded" | "revoked";

export interface PremiumAuthorizationSnapshot {
  readonly state: PremiumAuthorizationState;
  readonly naturalExpiryAt: number | null;
}

interface PremiumEnrollmentResult {
  readonly ok: boolean;
  readonly authorization: PremiumAuthorizationSnapshot | null;
}

function logPremiumDiagnostic(stage: PremiumDiagnosticStage, outcome: PremiumDiagnosticOutcome, operationId?: string): void {
  if (typeof console === "undefined") return;
  console.info(`[meetless-premium] ${JSON.stringify({ stage, outcome, ...(operationId ? { operationId } : {}), timestampMs: Date.now() })}`);
}

const NativePremiumResponseSchema = z.object({
  version: z.literal(1),
  requestId: z.string().trim().min(1),
  ok: z.boolean(),
  type: z.literal("premium.access"),
  outcome: z.enum(["status", "active", "cancelled", "pending", "failed"]),
  access: PremiumAccessWireSchema,
  /** Trusted host/plugin field; PremiumService strips it before RPC return. */
  appleSignedTransaction: z.string().trim().min(1).max(65_536).optional(),
  operationId: z.uuid().optional(),
}).strict();

type NativePremiumOperation = "premiumStatus" | "premiumPurchase" | "premiumRestore" | "premiumRecover" | "premiumTransaction";

export interface PremiumMutationResultInternal extends PremiumMutationResultWire {
  /** Opaque JWS retained inside the trusted plugin path only. */
  readonly appleSignedTransaction?: string;
  readonly operationId?: string;
}

export interface PremiumAccessPort {
  status(): Promise<PremiumAccessWire>;
  purchase(packageId: "monthly" | "annual", operationId?: string): Promise<PremiumMutationResultInternal>;
  restore(operationId?: string): Promise<PremiumMutationResultInternal>;
  /** Private native/plugin recovery; null means no retained native terminal. */
  recover(): Promise<PremiumMutationResultInternal | null>;
}

export class UnavailablePremiumAccessPort implements PremiumAccessPort {
  constructor(private readonly reason: "not_configured" | "store_unavailable") {}

  async status(): Promise<PremiumAccessWire> {
    return unavailablePremium(this.reason);
  }

  async purchase(_packageId: "monthly" | "annual"): Promise<PremiumMutationResultInternal> {
    return { outcome: "failed", access: unavailablePremium(this.reason) };
  }

  async restore(operationId?: string): Promise<PremiumMutationResultInternal> {
    return { outcome: "failed", access: unavailablePremium(this.reason) };
  }

  async recover(): Promise<PremiumMutationResultInternal | null> {
    return null;
  }
}

export class PremiumRequiredError extends Error {
  constructor() {
    super(PREMIUM_REQUIRED_MESSAGE);
    this.name = "PremiumRequiredError";
  }
}

class NativePremiumRequestError extends Error {
  constructor(readonly dispatched: boolean) {
    super("Premium purchase service is unavailable");
  }
}

export class NativePremiumAccessPort implements PremiumAccessPort {
  constructor(private readonly socketPath: string) {}

  /** Trusted plugin only; host and plugin are shipped as one matched artifact.
   * Only an authorized successful response without proof means no evidence.
   * Unsupported operations, EOF, malformed replies and authorization failures
   * remain errors; none may silently suppress subscription evidence.
   */
  async readSignedTransaction(): Promise<string | null> {
    const response = await this.request("premiumTransaction");
    if (!response.ok) throw new Error("Premium transaction verification is unavailable");
    return response.appleSignedTransaction ?? null;
  }

  async status(): Promise<PremiumAccessWire> {
    const response = await this.request("premiumStatus");
    return response.access;
  }

  async purchase(packageId: "monthly" | "annual", operationId?: string): Promise<PremiumMutationResultInternal> {
    const response = await this.request("premiumPurchase", packageId, operationId);
    return { ...PremiumMutationResultWireSchema.parse({ outcome: response.outcome, access: response.access }), appleSignedTransaction: response.appleSignedTransaction, operationId: response.operationId };
  }

  async restore(operationId?: string): Promise<PremiumMutationResultInternal> {
    const response = await this.request("premiumRestore", undefined, operationId);
    return { ...PremiumMutationResultWireSchema.parse({ outcome: response.outcome, access: response.access }), appleSignedTransaction: response.appleSignedTransaction, operationId: response.operationId };
  }

  async recover(): Promise<PremiumMutationResultInternal | null> {
    const response = await this.request("premiumRecover");
    if (!response.ok) return null;
    return { ...PremiumMutationResultWireSchema.parse({ outcome: response.outcome, access: response.access }), appleSignedTransaction: response.appleSignedTransaction, operationId: response.operationId };
  }

  private request(operation: NativePremiumOperation, packageId?: "monthly" | "annual", operationId?: string) {
    if (operation === "premiumPurchase" || operation === "premiumRestore") {
      logPremiumDiagnostic("native_rpc_dispatch", "started", operationId);
    }
    const requestId = randomUUID();
    const message = JSON.stringify({ version: 1, requestId, operation, ...(packageId ? { packageId } : {}), ...(operationId ? { operationId } : {}) });
    return new Promise<z.infer<typeof NativePremiumResponseSchema>>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      let dispatched = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        callback();
      };
      if (operation === "premiumTransaction") {
        socket.setTimeout(12_000, () => finish(() => reject(new NativePremiumRequestError(dispatched))));
      }
      socket.setEncoding("utf8");
      socket.once("error", () => finish(() => reject(new NativePremiumRequestError(dispatched))));
      socket.once("close", () => finish(() => reject(new NativePremiumRequestError(dispatched))));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > 131_072) {
          finish(() => reject(new NativePremiumRequestError(dispatched)));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = NativePremiumResponseSchema.parse(JSON.parse(buffer.slice(0, newline)));
          if (response.requestId !== requestId) throw new Error("native request identity mismatch");
          finish(() => resolve(response));
        } catch {
          finish(() => reject(new NativePremiumRequestError(dispatched)));
        }
      });
      socket.once("connect", () => {
        dispatched = true;
        socket.end(`${message}\n`);
      });
    });
  }
}

export function unavailablePremium(reason: PremiumAccessWire["reason"] = "store_unavailable"): PremiumAccessWire {
  return { entitlement: PREMIUM_ENTITLEMENT, status: "unavailable", packages: [], reason };
}

export class PremiumService {
  private readonly operations = new Map<string, { token: number; result: PremiumMutationResultWire }>();
  private readonly operationIds = new Map<number, string>();

  async operationResult(operationId: string): Promise<PremiumMutationResultWire | null> {
    const entry = this.operations.get(operationId);
    if (!entry) return null;
    if (entry.result.outcome === "pending" && !this.enrollment) {
      await this.reconcilePendingMutation();
    }
    return this.operations.get(operationId)!.result;
  }

  private retainResult(token: number, result: PremiumMutationResultWire): void {
    const operationId = this.operationIds.get(token);
    if (!operationId) return;
    const entry = this.operations.get(operationId);
    if (entry && entry.result.outcome !== "pending") return;
    this.operations.set(operationId, { token, result });
    if (result.outcome !== "pending") logPremiumDiagnostic("plugin_completion", result.outcome, operationId);
  }

  private pendingMutation: {
    readonly token: number;
    readonly kind: "purchase" | "restore";
    readonly packageId?: "monthly" | "annual";
    readonly access: PremiumAccessWire;
  } | null = null;
  private enrollment: {
    readonly access: PremiumAccessWire;
    readonly sourceAccess: PremiumAccessWire;
    readonly digest: string;
    readonly promise: Promise<PremiumEnrollmentResult>;
    readonly token: number;
    readonly reportCompletion: boolean;
  } | null = null;
  private settledEnrollment: {
    readonly digest: string;
    readonly result: PremiumEnrollmentResult;
  } | null = null;
  private verifiedAccess: PremiumAccessWire | null = null;
  private lastAccess: PremiumAccessWire | null = null;
  private operationSequence = 0;
  private reconciliationInFlight: Promise<void> | null = null;
  private recoveryInFlight: Promise<PremiumMutationResultWire | null> | null = null;
  private enrollmentFailure = false;

  constructor(
    private readonly access: PremiumAccessPort,
    private readonly options: {
      readonly onAppleSignedTransaction?: (signedTransaction: string) => Promise<unknown>;
      readonly requireAppleSignedTransaction?: boolean;
      /** Device-key refresh is the source of truth after a daemon relaunch. */
      readonly readAuthorization?: () => Promise<PremiumAuthorizationSnapshot>;
    } = {},
  ) {}

  async status(): Promise<PremiumAccessWire> {
    if (this.pendingMutation && !this.enrollment) {
      await this.reconcilePendingMutation();
    }
    if (this.enrollment) return this.enrollment.access;
    if (this.pendingMutation) return this.pendingMutation.access;
    const recovered = await this.recoverRetainedTerminal();
    const enrollmentAccess = this.currentEnrollmentAccess();
    if (enrollmentAccess) return enrollmentAccess;
    const pendingAccess = this.currentPendingAccess();
    if (pendingAccess) return pendingAccess;
    if (recovered) {
      const access = recovered.outcome === "active"
        ? recovered.access
        : inactivePremiumAccess(recovered.access);
      this.lastAccess = access;
      return access;
    }
    const authorization = await this.readAuthorization();
    if (authorization) this.enrollmentFailure = false;
    if (this.enrollmentFailure) return unavailablePremium();
    if (this.options.readAuthorization && !authorization) {
      this.verifiedAccess = null;
      try {
        const access = PremiumAccessWireSchema.parse(await this.access.status());
        const inactive = inactivePremiumAccess(access);
        this.lastAccess = inactive;
        return inactive;
      } catch {
        return unavailablePremium();
      }
    }
    if (authorization && !authorizationAllowsPremium(authorization)) {
      this.verifiedAccess = null;
      try {
        const access = PremiumAccessWireSchema.parse(await this.access.status());
        const inactive = inactivePremiumAccess(access);
        this.lastAccess = inactive;
        return inactive;
      } catch {
        return unavailablePremium();
      }
    }
    if (this.verifiedAccess) return this.verifiedAccess;
    try {
      const access = PremiumAccessWireSchema.parse(await this.access.status());
      const authorizedAccess = authorization ? activePremiumAccess(access) : access;
      this.lastAccess = authorizedAccess;
      return authorizedAccess;
    } catch {
      return unavailablePremium();
    }
  }

  async requireActive(): Promise<void> {
    if ((await this.status()).status !== "active") throw new PremiumRequiredError();
  }

  purchase(packageId: "monthly" | "annual", operationId: string = randomUUID()): Promise<PremiumMutationResultWire> {
    return this.beginMutation(operationId, "purchase", packageId);
  }

  restore(operationId: string = randomUUID()): Promise<PremiumMutationResultWire> {
    return this.beginMutation(operationId, "restore");
  }

  private admissionToken: number | null = null;

  private async beginMutation(
    operationId: string,
    kind: "purchase" | "restore",
    packageId?: "monthly" | "annual",
  ): Promise<PremiumMutationResultWire> {
    z.uuid().parse(operationId);
    const previous = this.operations.get(operationId);
    if (previous) return (await this.operationResult(operationId))!;
    const token = ++this.operationSequence;
    this.operationIds.set(token, operationId);
    const pendingAccess = pendingPremiumAccess(this.lastAccess ?? unavailablePremium());
    this.retainResult(token, { outcome: "pending", access: pendingAccess });
    logPremiumDiagnostic("plugin_rpc_dispatch", "started", operationId);
    // A different action cannot acquire an already-owned StoreKit operation.
    // Repeating the same UUID above only observes that operation's result.
    if (this.admissionToken !== null || this.pendingMutation) {
      const result = failedPremiumResult();
      this.retainResult(token, result);
      return result;
    }
    this.admissionToken = token;
    try {
      // Recovery belongs to its original operation, never to this new UUID.
      // Finish trusted enrollment before dispatching the newly requested action.
      await this.recoverRetainedTerminal();
      if (this.enrollment) await this.enrollment.promise;
      this.enrollmentFailure = false;
      this.pendingMutation = { token, kind, packageId, access: pendingAccess };
      this.admissionToken = null;
      return await this.dispatchMutation(token, () => kind === "purchase"
        ? this.access.purchase(packageId!, operationId)
        : this.access.restore(operationId));
    } finally {
      if (this.admissionToken === token) this.admissionToken = null;
    }
  }

  private async dispatchMutation(
    token: number,
    operation: () => Promise<PremiumMutationResultInternal>,
  ): Promise<PremiumMutationResultWire> {
    try {
      const result = await this.complete(await operation(), token);
      if (this.pendingMutation?.token === token && result.outcome !== "pending") this.pendingMutation = null;
      this.retainResult(token, result);
      return result;
    } catch (error) {
      const retained = this.operations.get(this.operationIds.get(token)!)?.result;
      if (retained && retained.outcome !== "pending") return retained;
      if (error instanceof NativePremiumRequestError && error.dispatched) {
        // Losing a socket after dispatch cannot cancel StoreKit. Recovery is
        // read-only and can still retrieve its later categorical completion.
        return retained ?? { outcome: "pending", access: pendingPremiumAccess(unavailablePremium()) };
      }
      if (this.pendingMutation?.token === token) this.pendingMutation = null;
      this.retainResult(token, failedPremiumResult());
      return failedPremiumResult();
    }
  }

  private async reconcilePendingMutation(): Promise<void> {
    if (this.reconciliationInFlight) {
      await this.reconciliationInFlight;
      return;
    }
    const operation = this.reconcilePendingMutationOnce();
    this.reconciliationInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.reconciliationInFlight === operation) this.reconciliationInFlight = null;
    }
  }

  private async reconcilePendingMutationOnce(): Promise<void> {
    const pending = this.pendingMutation;
    if (!pending || this.enrollment) return;
    const operation = () => this.access.recover();
    try {
      const recovered = await operation();
      if (!recovered) return;
      const result = await this.complete(recovered, pending.token);
      this.retainResult(pending.token, result);
      if (this.pendingMutation?.token !== pending.token) return;
      if (result.outcome !== "pending") {
        this.pendingMutation = null;
        this.lastAccess = result.access;
      }
    } catch {
      // A failed observation is not a native terminal outcome. Keep ownership
      // and retry recovery; never redispatch purchase or invent cancellation.
    }
  }

  private async recoverRetainedTerminal(): Promise<PremiumMutationResultWire | null> {
    if (this.recoveryInFlight) return this.recoveryInFlight;
    const token = ++this.operationSequence;
    const operation = (async () => {
      const retained = await this.access.recover();
      if (!retained) return null;
      if (retained.operationId) {
        const known = this.operations.get(retained.operationId);
        if (known && known.result.outcome !== "pending") return known.result;
        this.operationIds.set(token, retained.operationId);
        this.retainResult(token, { outcome: "pending", access: pendingPremiumAccess(retained.access) });
      }
      const result = await this.complete(retained, token);
      this.retainResult(token, result);
      if (this.pendingMutation?.token === token && result.outcome !== "pending") {
        this.pendingMutation = null;
      }
      if (!this.enrollment || this.enrollment.token !== token) this.lastAccess = result.access;
      return result;
    })().catch(() => null);
    this.recoveryInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.recoveryInFlight === operation) this.recoveryInFlight = null;
    }
  }

  private async complete(result: PremiumMutationResultInternal, token: number): Promise<PremiumMutationResultWire> {
    const requestedId = this.operationIds.get(token);
    const retained = requestedId ? this.operations.get(requestedId)?.result : null;
    if (retained && retained.outcome !== "pending") return retained;
    if (result.operationId && requestedId && result.operationId !== requestedId) {
      // A host retained across daemon restart can still own an older action.
      // Reconcile its terminal under that identity, never report it as this purchase.
      if (result.outcome !== "pending" || result.appleSignedTransaction) {
        const recoveredToken = ++this.operationSequence;
        this.operationIds.set(recoveredToken, result.operationId);
        const recovered = await this.complete(result, recoveredToken);
        this.retainResult(recoveredToken, recovered);
      }
      return failedPremiumResult();
    }
    const parsed = PremiumMutationResultWireSchema.parse({ outcome: result.outcome, access: result.access });
    const signedTransaction = result.appleSignedTransaction;
    if (parsed.outcome === "pending") {
      if (!signedTransaction) return { outcome: "pending", access: pendingPremiumAccess(parsed.access) };
      if (!this.options.onAppleSignedTransaction) return failedPremiumResult();
      const pendingAccess = this.beginAppleEnrollment(parsed.access, signedTransaction, token);
      return pendingAccess
        ? { outcome: "pending", access: pendingAccess }
        : failedPremiumResult();
    }
    if (parsed.outcome !== "active") {
      return { outcome: parsed.outcome, access: inactivePremiumAccess(parsed.access) };
    }
    if (this.options.requireAppleSignedTransaction && !signedTransaction) return failedPremiumResult();
    if (!signedTransaction) return parsed;
    if (!this.options.onAppleSignedTransaction) return failedPremiumResult();
    try {
      const enrollment = this.startEnrollment(parsed.access, signedTransaction, token, false);
      if (!enrollment) return failedPremiumResult();
      const enrolled = await enrollment.promise;
      if (!enrolled.ok || !enrolled.authorization || !authorizationAllowsPremium(enrolled.authorization)) return failedPremiumResult();
      this.verifiedAccess = activePremiumAccess(parsed.access);
      this.lastAccess = this.verifiedAccess;
      return parsed;
    } catch {
      return failedPremiumResult();
    }
  }

  private beginAppleEnrollment(
    access: PremiumAccessWire,
    signedTransaction: string,
    token: number,
  ): PremiumAccessWire | null {
    if (!this.options.onAppleSignedTransaction) return null;
    const enrollment = this.startEnrollment(access, signedTransaction, token, true);
    return enrollment?.access ?? null;
  }

  private startEnrollment(
    sourceAccess: PremiumAccessWire,
    signedTransaction: string,
    token: number,
    reportCompletion: boolean,
  ): {
    readonly access: PremiumAccessWire;
    readonly digest: string;
    readonly promise: Promise<PremiumEnrollmentResult>;
  } | null {
    const digest = transactionDigest(signedTransaction);
    if (this.enrollment) {
      return this.enrollment.digest === digest
        ? this.enrollment
        : null;
    }
    const settledEnrollment = this.settledEnrollment;
    if (settledEnrollment?.digest === digest) {
      const result = settledEnrollment.result;
      const entry = {
        access: pendingPremiumAccess(sourceAccess),
        sourceAccess,
        digest,
        promise: Promise.resolve(result),
        token,
        reportCompletion,
      };
      void entry.promise.then((value) => this.applyEnrollmentResult(entry, value));
      return entry;
    }
    const callback = this.options.onAppleSignedTransaction;
    if (!callback) return null;
    const promise = Promise.resolve().then(() => callback(signedTransaction)).then(
      (value) => {
        try {
          return { ok: true, authorization: parseEnrollmentAuthorization(value) };
        } catch {
          return { ok: false, authorization: null };
        }
      },
      () => ({ ok: false, authorization: null }),
    );
    const entry = {
      access: pendingPremiumAccess(sourceAccess),
      sourceAccess,
      digest,
      promise,
      token,
      reportCompletion,
    };
    this.enrollment = entry;
    void promise.then((value) => this.applyEnrollmentResult(entry, value));
    return entry;
  }

  private applyEnrollmentResult(
    entry: {
      readonly access: PremiumAccessWire;
      readonly sourceAccess: PremiumAccessWire;
      readonly digest: string;
      readonly promise: Promise<PremiumEnrollmentResult>;
      readonly token: number;
      readonly reportCompletion: boolean;
    },
    result: PremiumEnrollmentResult,
  ): void {
    if (this.enrollment && this.enrollment.promise !== entry.promise) return;
    if (this.enrollment?.promise === entry.promise) this.enrollment = null;
    this.settledEnrollment = { digest: entry.digest, result };
    if (result.ok && result.authorization && authorizationAllowsPremium(result.authorization)) {
      if (this.pendingMutation?.token === entry.token) this.pendingMutation = null;
      this.verifiedAccess = activePremiumAccess(entry.sourceAccess);
      this.lastAccess = this.verifiedAccess;
      this.retainResult(entry.token, { outcome: "active", access: this.verifiedAccess });
    } else {
      if (this.pendingMutation?.token === entry.token) this.pendingMutation = null;
      this.verifiedAccess = null;
      this.lastAccess = unavailablePremium();
      this.enrollmentFailure = true;
      this.retainResult(entry.token, failedPremiumResult());
    }
  }

  private async readAuthorization(): Promise<PremiumAuthorizationSnapshot | null> {
    if (!this.options.readAuthorization) return null;
    try {
      const snapshot = await this.options.readAuthorization();
      if (!(["active", "grace", "expired", "refunded", "revoked"] as const).includes(snapshot.state)) return null;
      if (
        snapshot.naturalExpiryAt !== null
        && (!Number.isSafeInteger(snapshot.naturalExpiryAt) || snapshot.naturalExpiryAt <= 0)
      ) return null;
      return snapshot;
    } catch {
      return null;
    }
  }

  private currentEnrollmentAccess(): PremiumAccessWire | null {
    return this.enrollment?.access ?? null;
  }

  private currentPendingAccess(): PremiumAccessWire | null {
    return this.pendingMutation?.access ?? null;
  }
}

function transactionDigest(signedTransaction: string): string {
  return createHash("sha256").update(signedTransaction).digest("hex");
}

function parseEnrollmentAuthorization(value: unknown): PremiumAuthorizationSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { state?: unknown; naturalExpiryAt?: unknown };
  if (!("state" in candidate) || !("naturalExpiryAt" in candidate)) return null;
  if (!( ["active", "grace", "expired", "refunded", "revoked"] as const).includes(candidate.state as PremiumAuthorizationState)) {
    throw new Error("Managed Premium enrollment returned an invalid authorization state");
  }
  const naturalExpiryAt = candidate.naturalExpiryAt;
  if (
    naturalExpiryAt !== null
    && (
      typeof naturalExpiryAt !== "number"
      || !Number.isSafeInteger(naturalExpiryAt)
      || naturalExpiryAt <= 0
    )
  ) {
    throw new Error("Managed Premium enrollment returned an invalid natural expiry");
  }
  return {
    state: candidate.state as PremiumAuthorizationState,
    naturalExpiryAt: naturalExpiryAt as number | null,
  };
}

function authorizationAllowsPremium(snapshot: PremiumAuthorizationSnapshot): boolean {
  return (snapshot.state === "active" || snapshot.state === "grace")
    && (snapshot.naturalExpiryAt === null || snapshot.naturalExpiryAt > Date.now());
}

function failedPremiumResult(): PremiumMutationResultWire {
  return { outcome: "failed", access: unavailablePremium("store_unavailable") };
}

function pendingPremiumAccess(access: PremiumAccessWire): PremiumAccessWire {
  return access.status === "inactive" ? access : { ...access, status: "inactive", reason: null };
}

function activePremiumAccess(access: PremiumAccessWire): PremiumAccessWire {
  return access.status === "active" ? access : { ...access, status: "active", reason: null };
}

function inactivePremiumAccess(access: PremiumAccessWire): PremiumAccessWire {
  if (access.status === "inactive" || access.status === "unavailable") return access;
  return { ...access, status: "inactive", reason: null };
}
