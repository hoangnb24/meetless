export interface PostM3CleanupFacts {
  root: string;
  preservedPath: string | null;
  originalRootExisted: boolean;
  staged: boolean;
  stagedRootRemoved: boolean;
  originalRootRestored: boolean;
  runStateRemoved: boolean;
  liveHostPids: number[];
  errors: string[];
}

export interface PostM3CleanupReport extends PostM3CleanupFacts {
  status: "passed" | "failed";
  diagnostic: string;
}

export function summarizePostM3Cleanup(facts: PostM3CleanupFacts): PostM3CleanupReport {
  const errors = [...facts.errors];
  if (facts.liveHostPids.length > 0) {
    errors.push(`exact MeetlessHost PID(s) remain live: ${facts.liveHostPids.join(", ")}`);
  }
  if (facts.staged && !facts.stagedRootRemoved) errors.push(`staged runtime root was not removed: ${facts.root}`);
  if (facts.originalRootExisted && !facts.originalRootRestored) {
    errors.push(`original runtime root was not restored${facts.preservedPath ? `; preserved state remains at ${facts.preservedPath}` : ""}`);
  }
  if (!facts.runStateRemoved) errors.push(`owned UI-test run state was not removed under ${facts.root}`);
  const status = errors.length === 0 ? "passed" : "failed";
  return {
    ...facts,
    errors,
    status,
    diagnostic: status === "passed"
      ? `Post-M3 cleanup passed for ${facts.root}; original runtime state restored and owned run state removed.`
      : `Post-M3 cleanup failed for ${facts.root}: ${errors.join("; ")}${facts.preservedPath ? `; preserved diagnostic path: ${facts.preservedPath}` : ""}`,
  };
}
