import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createDesktopRecordingClient, type DesktopRecordingClient } from "@meetless/client";
import type { RecordingStatusWire } from "@meetless/meeting-contracts";

const idle: RecordingStatusWire = { status: "idle", recordingId: null, meetingId: null, title: null, elapsedMs: 0, paused: false, chunks: [], outputPath: null, error: null };

interface RecordingContextValue {
  enabled: boolean;
  status: RecordingStatusWire;
  displayElapsedMs: number;
  pending: boolean;
  error: string | null;
  start(title: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  retry(): Promise<void>;
}

const RecordingContext = createContext<RecordingContextValue | null>(null);

export function RecordingProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const client = useRef<DesktopRecordingClient | null>(null);
  const [status, setStatus] = useState(idle);
  const [receivedAt, setReceivedAt] = useState(Date.now());
  const [tick, setTick] = useState(Date.now());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback((next: RecordingStatusWire) => {
    setStatus(next); setReceivedAt(Date.now()); setError(next.error);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const active = createDesktopRecordingClient();
    client.current = active;
    const unsubscribe = active.subscribe((next) => { if (!cancelled) accept(next); });
    void active.connect().then(accept).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      cancelled = true; unsubscribe(); client.current = null; void active.close();
    };
  }, [accept, enabled]);

  useEffect(() => {
    if (status.status !== "recording" || status.paused) return;
    const timer = setInterval(() => setTick(Date.now()), 250);
    return () => clearInterval(timer);
  }, [status.paused, status.status]);

  const invoke = useCallback(async (operation: (active: DesktopRecordingClient) => Promise<RecordingStatusWire>) => {
    const active = client.current;
    if (!active) throw new Error("Desktop recording controls are not connected");
    setPending(true); setError(null);
    try { accept(await operation(active)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); throw reason; }
    finally { setPending(false); }
  }, [accept]);

  const value = useMemo<RecordingContextValue>(() => ({
    enabled,
    status,
    displayElapsedMs: status.elapsedMs + (status.status === "recording" && !status.paused ? Math.max(0, tick - receivedAt) : 0),
    pending,
    error,
    start: (title) => invoke((active) => active.start(title)),
    pause: () => invoke((active) => active.pause()),
    resume: () => invoke((active) => active.resume()),
    stop: () => invoke((active) => active.stop()),
    retry: () => invoke((active) => active.retryFinalization()),
  }), [enabled, error, invoke, pending, receivedAt, status, tick]);

  return <RecordingContext.Provider value={value}>{children}</RecordingContext.Provider>;
}

export function useRecording(): RecordingContextValue {
  const value = useContext(RecordingContext);
  if (!value) throw new Error("useRecording must run inside RecordingProvider");
  return value;
}
