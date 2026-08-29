import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createDesktopRecordingClient, type DesktopRecordingClient } from "@meetless/client";
import type { RecordingStatusWire } from "@meetless/meeting-contracts";
import { AppState } from "react-native";

export type CapturePermissionStatus = "authorized" | "notDetermined" | "denied" | "restricted";
export interface CapturePermissionState {
  microphone: CapturePermissionStatus | null;
  systemAudio: CapturePermissionStatus | null;
  checking: boolean;
  error: string | null;
}

const idle: RecordingStatusWire = {
  status: "idle", recordingId: null, meetingId: null, title: null, elapsedMs: 0, paused: false, chunks: [],
  inventoryState: null, chunkCount: 0, microphoneCount: 0, systemCount: 0,
  inventoryDigest: null, retryEligible: false, outputPath: null, error: null,
};

interface RecordingContextValue {
  enabled: boolean;
  status: RecordingStatusWire;
  displayElapsedMs: number;
  pending: boolean;
  error: string | null;
  permissions: CapturePermissionState;
  start(title: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  retry(): Promise<void>;
  recheckPermissions(): Promise<void>;
  openPermissionSettings(source: "microphone" | "systemAudio"): Promise<void>;
}

const RecordingContext = createContext<RecordingContextValue | null>(null);

export function RecordingProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const client = useRef<DesktopRecordingClient | null>(null);
  const [status, setStatus] = useState(idle);
  const [receivedAt, setReceivedAt] = useState(Date.now());
  const [tick, setTick] = useState(Date.now());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<CapturePermissionState>({
    microphone: null,
    systemAudio: null,
    checking: true,
    error: null,
  });

  const loadPermissions = useCallback(async (operation: "status" | "request" = "status") => {
    setPermissions((current) => ({ ...current, checking: true, error: null }));
    try {
      const response = operation === "request"
        ? await postWithFreshPermissionIntent("/__meetless/capture-permissions/request")
        : await fetch("/__meetless/capture-permissions", { method: "GET", cache: "no-store" });
      const decoded = await decodeJsonObject(response);
      if (!response.ok || !isPermissionStatus(decoded.microphone) || !isPermissionStatus(decoded.systemAudio)) {
        throw new Error("permission status response is invalid");
      }
      const next: CapturePermissionState = {
        microphone: decoded.microphone,
        systemAudio: decoded.systemAudio,
        checking: false,
        error: null,
      };
      setPermissions(next);
      return next;
    } catch (reason) {
      const message = `Capture permission status is unavailable. Recheck to try again. (${describe(reason)})`;
      setPermissions((current) => ({ ...current, checking: false, error: message }));
      throw new Error(message, { cause: reason });
    }
  }, []);

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
    void loadPermissions().catch(() => undefined);
    return () => {
      cancelled = true; unsubscribe(); client.current = null; void active.close();
    };
  }, [accept, enabled, loadPermissions]);

  useEffect(() => {
    if (!enabled || !AppState?.addEventListener) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void loadPermissions().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [enabled, loadPermissions]);

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
    permissions,
    start: async (title) => {
      const active = client.current;
      if (!active) throw new Error("Desktop recording controls are not connected");
      setPending(true); setError(null);
      try {
        const ready = await loadPermissions("request");
        if (ready.microphone !== "authorized" || ready.systemAudio !== "authorized") {
          const source = ready.microphone !== "authorized" ? "microphone" : "systemAudio";
          throw new Error(`capture permission ${source}/${ready[source]} is not ready`);
        }
        accept(await active.start(title));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        throw reason;
      } finally {
        setPending(false);
      }
    },
    pause: () => invoke((active) => active.pause()),
    resume: () => invoke((active) => active.resume()),
    stop: () => invoke((active) => active.stop()),
    retry: () => invoke((active) => active.retryFinalization()),
    recheckPermissions: async () => { await loadPermissions().catch(() => undefined); },
    openPermissionSettings: async (source) => {
      try {
        const response = await postWithFreshPermissionIntent(`/__meetless/capture-permissions/settings?source=${source}`);
        const decoded = await decodeJsonObject(response);
        if (!response.ok || decoded.settingsOpened !== true) throw new Error("System Settings did not open");
        setPermissions((current) => ({ ...current, error: null }));
      } catch (reason) {
        setPermissions((current) => ({
          ...current,
          error: `Meetless could not open System Settings. Open Privacy & Security manually, then Recheck. (${describe(reason)})`,
        }));
      }
    },
  }), [accept, enabled, error, invoke, loadPermissions, pending, permissions, receivedAt, status, tick]);

  return <RecordingContext.Provider value={value}>{children}</RecordingContext.Provider>;
}

function isPermissionStatus(value: unknown): value is CapturePermissionStatus {
  return value === "authorized" || value === "notDetermined" || value === "denied" || value === "restricted";
}

async function postWithFreshPermissionIntent(pathname: string): Promise<Response> {
  const intentResponse = await fetch("/__meetless/capture-permissions/intent", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const intent = await decodeJsonObject(intentResponse);
  if (!intentResponse.ok || typeof intent.intentToken !== "string" || intent.intentToken.length === 0
    || typeof intent.expiresAt !== "number") {
    throw new Error("permission intent response is invalid");
  }
  return fetch(pathname, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Meetless-Permission-Intent": intent.intentToken,
    },
    body: "{}",
  });
}

async function decodeJsonObject(response: Response): Promise<Record<string, unknown>> {
  const decoded: unknown = await response.json();
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("response body is not a JSON object");
  }
  return decoded as Record<string, unknown>;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function useRecording(): RecordingContextValue {
  const value = useContext(RecordingContext);
  if (!value) throw new Error("useRecording must run inside RecordingProvider");
  return value;
}
