/** E2 admission only; no transcription allowance or E3 offer policy. */
export function assertManagedAskAdmission(input: {
  config: { mode: string; revenueCatEnvironment: string; providerMode: string; appleVerifierMode: string };
  principal: { accountId: string; lineageVerified: boolean; revokedAt: number | null; entitlement: string; naturalExpiryAt?: number | null };
  lineages: readonly { accountId: string; adapter: string; environment: string; currentState: string; expiresAt: number; gracePeriodExpiresAt?: number }[];
  now: number;
}): void {
  const { config, principal, lineages, now } = input;
  const active = (state: string) => state === "active" || state === "grace";
  const future = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > now;
  if (config.mode !== "hosted-development" || config.revenueCatEnvironment !== "SANDBOX" ||
      config.providerMode !== "real" || config.appleVerifierMode !== "app-store-server-api" ||
      !principal.lineageVerified || principal.revokedAt !== null || !active(principal.entitlement) ||
      !future(principal.naturalExpiryAt) || !lineages.some((lineage) =>
        lineage.accountId === principal.accountId && lineage.adapter === "app-store-server-api" &&
        lineage.environment === "SANDBOX" && active(lineage.currentState) &&
        future(lineage.currentState === "grace" ? lineage.gracePeriodExpiresAt : lineage.expiresAt))) {
    throw new Error("Managed Ask requires a verified active Sandbox subscription. Refresh or restore subscription access.");
  }
}
