export async function runFailClosedCleanup(steps, verifyCleanState) {
  const errors = [];
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(new Error(`${label} failed: ${describe(error)}`, { cause: error }));
    }
  }
  try {
    assertCleanState(await verifyCleanState());
  } catch (error) {
    errors.push(new Error(`clean-state verification failed: ${describe(error)}`, { cause: error }));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "M6 host-auth preflight cleanup failed closed");
  }
}

export function assertCleanState(state) {
  const violations = [];
  if (state.hostProcessIds.length > 0) violations.push(`owned host processes remain: ${state.hostProcessIds.join(",")}`);
  if (state.listenerProcessIds.length > 0) violations.push(`owned listener remains: ${state.listenerProcessIds.join(",")}`);
  if (state.ownedSocketPaths.length > 0) violations.push(`owned sockets remain: ${state.ownedSocketPaths.join(",")}`);
  if (state.runtimeRootExists) violations.push("temporary runtime root remains");
  if (state.launchPasswordKeys.length > 0) {
    violations.push(`temporary launch password keys remain: ${state.launchPasswordKeys.join(",")}`);
  }
  if (violations.length > 0) throw new Error(violations.join("; "));
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
