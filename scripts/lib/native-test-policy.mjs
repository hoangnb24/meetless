export const NATIVE_TEST_POLICY_REQUIRED = "required";
export const NATIVE_TEST_POLICY_OWNER_DEFERRED_INTERNAL_BETA = "owner-deferred-internal-beta";
export const NATIVE_TEST_POLICIES = Object.freeze([
  NATIVE_TEST_POLICY_REQUIRED,
  NATIVE_TEST_POLICY_OWNER_DEFERRED_INTERNAL_BETA,
]);

export const OWNER_BETA_DECISION_POINTER = ".artifacts/app-store-upload/20260915-build4/owner-beta-source-acceptance.json";
export const OWNER_BETA_DECISION_AUTHORITY = "docs/plans/active/v1-paseo-foundation.md#owner-directed-build4-internal-beta-deferral";

export function validateNativeTestPolicy(value) {
  if (!NATIVE_TEST_POLICIES.includes(value)) {
    throw new Error(`Unsupported native test policy ${JSON.stringify(value)}`);
  }
  return value;
}

export function parseNativeTestPolicyArguments(args) {
  let policy = NATIVE_TEST_POLICY_REQUIRED;
  let seen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let value = null;
    if (argument === "--native-test-policy") {
      if (seen) throw new Error("Duplicate --native-test-policy");
      value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("Missing value for --native-test-policy");
    } else if (argument.startsWith("--native-test-policy=")) {
      if (seen) throw new Error("Duplicate --native-test-policy");
      value = argument.slice("--native-test-policy=".length);
      if (!value) throw new Error("Missing value for --native-test-policy");
    } else {
      throw new Error(`Unknown native build option ${argument}`);
    }
    seen = true;
    policy = validateNativeTestPolicy(value);
  }
  return policy;
}

export function nativeTestEvidence(policy) {
  validateNativeTestPolicy(policy);
  if (policy === NATIVE_TEST_POLICY_REQUIRED) return { policy, status: "PASSED" };
  return {
    policy,
    status: "DEFERRED",
    ownerDecision: {
      pointer: OWNER_BETA_DECISION_POINTER,
      authority: OWNER_BETA_DECISION_AUTHORITY,
    },
  };
}
