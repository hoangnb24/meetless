export function validateBoundedPlaybackObservation(observation, citation) {
  const expectedIdentity = citationIdentity(citation);
  const observedIdentity = observation?.citationIdentity;
  if (!sameIdentity(observedIdentity, expectedIdentity)) {
    throw new Error("playback citation identity differs from the resolved citation");
  }
  if (observation?.playResolved !== true) {
    throw new Error("bounded playback did not resolve play");
  }
  if (observation?.pauseObserved !== true) {
    throw new Error("bounded playback did not observe pause");
  }
  const currentTimeSeconds = Number(observation.maximumCurrentTime);
  const startMs = Number(citation.startMs);
  const endMs = Number(citation.endMs);
  const clipDurationSeconds = (endMs - startMs) / 1000;
  if (
    !Number.isFinite(currentTimeSeconds) ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    !Number.isFinite(clipDurationSeconds) ||
    clipDurationSeconds <= 0 ||
    !(currentTimeSeconds > 0 && currentTimeSeconds <= clipDurationSeconds)
  ) {
    throw new Error("bounded playback did not make positive clip-relative progress inside the resolved citation duration");
  }
  return {
    citationIdentity: expectedIdentity,
    clipDurationSeconds,
    positiveBoundedProgress: true,
    currentTimeSeconds,
  };
}

export function citationIdentity(citation) {
  return {
    meetingId: citation?.meetingId,
    recordingId: citation?.recordingId,
    segmentId: citation?.segmentId,
    startMs: citation?.startMs,
    endMs: citation?.endMs,
  };
}

function sameIdentity(left, right) {
  return left && right &&
    left.meetingId === right.meetingId &&
    left.recordingId === right.recordingId &&
    left.segmentId === right.segmentId &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs;
}
