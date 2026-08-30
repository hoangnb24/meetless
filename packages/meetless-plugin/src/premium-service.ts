import { randomUUID } from "node:crypto";
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
export const PREMIUM_REQUIRED_MESSAGE = "Ask requires Meetless Premium. Open the paywall or restore purchases.";

const NativePremiumResponseSchema = z.object({
  version: z.literal(1),
  requestId: z.string().trim().min(1),
  ok: z.boolean(),
  type: z.literal("premium.access"),
  outcome: z.enum(["status", "active", "cancelled", "pending", "failed"]),
  access: PremiumAccessWireSchema,
}).strict();

type NativePremiumOperation = "premiumStatus" | "premiumPurchase" | "premiumRestore";

export interface PremiumAccessPort {
  status(): Promise<PremiumAccessWire>;
  purchase(packageId: "monthly" | "annual"): Promise<PremiumMutationResultWire>;
  restore(): Promise<PremiumMutationResultWire>;
}

export class UnavailablePremiumAccessPort implements PremiumAccessPort {
  constructor(private readonly reason: "not_configured" | "store_unavailable") {}

  async status(): Promise<PremiumAccessWire> {
    return unavailablePremium(this.reason);
  }

  async purchase(_packageId: "monthly" | "annual"): Promise<PremiumMutationResultWire> {
    return { outcome: "failed", access: unavailablePremium(this.reason) };
  }

  async restore(): Promise<PremiumMutationResultWire> {
    return { outcome: "failed", access: unavailablePremium(this.reason) };
  }
}

export class PremiumRequiredError extends Error {
  constructor() {
    super(PREMIUM_REQUIRED_MESSAGE);
    this.name = "PremiumRequiredError";
  }
}

export class NativePremiumAccessPort implements PremiumAccessPort {
  constructor(private readonly socketPath: string) {}

  async status(): Promise<PremiumAccessWire> {
    const response = await this.request("premiumStatus");
    return response.access;
  }

  async purchase(packageId: "monthly" | "annual"): Promise<PremiumMutationResultWire> {
    const response = await this.request("premiumPurchase", packageId);
    return PremiumMutationResultWireSchema.parse({ outcome: response.outcome, access: response.access });
  }

  async restore(): Promise<PremiumMutationResultWire> {
    const response = await this.request("premiumRestore");
    return PremiumMutationResultWireSchema.parse({ outcome: response.outcome, access: response.access });
  }

  private request(operation: NativePremiumOperation, packageId?: "monthly" | "annual") {
    const requestId = randomUUID();
    const message = JSON.stringify({ version: 1, requestId, operation, ...(packageId ? { packageId } : {}) });
    return new Promise<z.infer<typeof NativePremiumResponseSchema>>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        callback();
      };
      socket.setEncoding("utf8");
      socket.once("error", () => finish(() => reject(new Error("Premium purchase service is unavailable"))));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = NativePremiumResponseSchema.parse(JSON.parse(buffer.slice(0, newline)));
          if (response.requestId !== requestId) throw new Error("native request identity mismatch");
          finish(() => resolve(response));
        } catch {
          finish(() => reject(new Error("Premium purchase service returned an invalid response")));
        }
      });
      socket.once("connect", () => socket.end(`${message}\n`));
    });
  }
}

export function unavailablePremium(reason: PremiumAccessWire["reason"] = "store_unavailable"): PremiumAccessWire {
  return { entitlement: PREMIUM_ENTITLEMENT, status: "unavailable", packages: [], reason };
}

export class PremiumService {
  constructor(private readonly access: PremiumAccessPort) {}

  async status(): Promise<PremiumAccessWire> {
    try {
      return PremiumAccessWireSchema.parse(await this.access.status());
    } catch {
      return unavailablePremium();
    }
  }

  async requireActive(): Promise<void> {
    if ((await this.status()).status !== "active") throw new PremiumRequiredError();
  }

  async purchase(packageId: "monthly" | "annual"): Promise<PremiumMutationResultWire> {
    try {
      return PremiumMutationResultWireSchema.parse(await this.access.purchase(packageId));
    } catch {
      return { outcome: "failed", access: unavailablePremium() };
    }
  }

  async restore(): Promise<PremiumMutationResultWire> {
    try {
      return PremiumMutationResultWireSchema.parse(await this.access.restore());
    } catch {
      return { outcome: "failed", access: unavailablePremium() };
    }
  }
}
