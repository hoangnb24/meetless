import type { CitationWire } from "@meetless/meeting-contracts";
import { Platform } from "react-native";

export interface CitationAudioElement {
  readyState: number;
  currentTime: number;
  onloadedmetadata: (() => void) | null;
  onerror: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
}

export type CitationAudioFactory = (source: string) => CitationAudioElement;

export interface CitationPlaybackHandle {
  stop(): void;
}

export interface CitationPlaybackOptions {
  onComplete?(): void;
}

export interface NativeCitationPlayer {
  play(): void;
  pause(): void;
  remove(): void;
}

export interface NativeCitationPlaybackDependencies {
  configureAudioSession(): Promise<void>;
  createTemporaryClip(
    bytes: Uint8Array,
    register: (clip: { uri: string; delete(): void }) => void,
  ): Promise<{ uri: string; delete(): void }>;
  createPlayer(uri: string): NativeCitationPlayer;
}

export async function playCitationAudio(
  citation: CitationWire,
  factory: CitationAudioFactory = browserAudioFactory,
  nativeDependencies: NativeCitationPlaybackDependencies = defaultNativeDependencies,
  options: CitationPlaybackOptions = {},
): Promise<CitationPlaybackHandle> {
  validateCitation(citation);
  if (Platform.OS !== "web") return playNativeCitation(citation, nativeDependencies, options.onComplete);
  const audio = factory(citationDataUrl(citation));
  await waitForMetadata(audio);
  audio.currentTime = 0;
  await audio.play();
  let stopped = false;
  const durationSeconds = (citation.endMs - citation.startMs) / 1_000;
  const timer = setInterval(() => {
    if (stopped || audio.currentTime >= durationSeconds) {
      stopped = true;
      clearInterval(timer);
      audio.pause();
      options.onComplete?.();
    }
  }, 40);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      audio.pause();
    },
  };
}

async function playNativeCitation(
  citation: CitationWire,
  dependencies: NativeCitationPlaybackDependencies,
  onComplete?: () => void,
): Promise<CitationPlaybackHandle> {
  const cleanup = new NativeCleanupGuard();
  try {
    await dependencies.configureAudioSession();
    let registeredClip: { uri: string; delete(): void } | null = null;
    const clip = await dependencies.createTemporaryClip(
      decodeBase64(citation.audio.base64),
      (created) => {
        registeredClip = created;
        cleanup.register(() => created.delete());
      },
    );
    if (registeredClip !== clip) cleanup.register(() => clip.delete());
    const player = dependencies.createPlayer(clip.uri);
    cleanup.register(() => player.remove());
    cleanup.register(() => player.pause());
    player.play();
    const timer = setTimeout(() => {
      onComplete?.();
      cleanup.run();
    }, citation.endMs - citation.startMs);
    cleanup.register(() => clearTimeout(timer));
    return { stop: () => cleanup.run() };
  } catch (error) {
    cleanup.run();
    throw error;
  }
}

class NativeCleanupGuard {
  private actions: Array<() => void> = [];
  private cleaned = false;

  register(action: () => void): void {
    if (this.cleaned) {
      try { action(); } catch { /* cleanup remains best-effort after all owned resources were attempted */ }
      return;
    }
    this.actions.unshift(action);
  }

  run(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    for (const action of this.actions) {
      try { action(); } catch { /* continue so one native cleanup failure cannot strand later resources */ }
    }
    this.actions = [];
  }
}

function waitForMetadata(audio: CitationAudioElement): Promise<void> {
  if (audio.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    audio.onloadedmetadata = () => resolve();
    audio.onerror = () => reject(new Error("Cited audio could not be loaded"));
  });
}

function browserAudioFactory(source: string): CitationAudioElement {
  const AudioConstructor = (globalThis as unknown as { Audio?: new (source?: string) => CitationAudioElement }).Audio;
  if (!AudioConstructor) throw new Error("Cited audio playback requires a desktop/web audio runtime");
  return new AudioConstructor(source);
}

export function citationDataUrl(citation: CitationWire): string {
  validateCitation(citation);
  return `data:${citation.audio.mimeType};base64,${citation.audio.base64}`;
}

function validateCitation(citation: CitationWire): void {
  if (citation.endMs <= citation.startMs) throw new Error("Citation playback interval is not bounded");
  if (citation.audio.mimeType !== "audio/mpeg" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(citation.audio.base64)) {
    throw new Error("Cited audio payload is invalid");
  }
}

function decodeBase64(value: string): Uint8Array {
  const decoded = globalThis.atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

const defaultNativeDependencies: NativeCitationPlaybackDependencies = {
  async configureAudioSession() {
    const ExpoAudio = await import("expo-audio");
    await ExpoAudio.setAudioModeAsync({
      allowsRecording: false,
      allowsBackgroundRecording: false,
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
      interruptionMode: "mixWithOthers",
    });
  },
  async createTemporaryClip(bytes, register) {
    const { File, Paths } = await import("expo-file-system");
    const file = new File(Paths.cache, `meetless-citation-${globalThis.crypto.randomUUID()}.mp3`);
    const clip = { uri: file.uri, delete: () => { if (file.exists) file.delete(); } };
    register(clip);
    file.create({ overwrite: true });
    file.write(bytes);
    return clip;
  },
  createPlayer(uri) {
    // Expo bundles this native module. Loading it here keeps the web path on the browser Audio API.
    const ExpoAudio = require("expo-audio") as typeof import("expo-audio");
    return ExpoAudio.createAudioPlayer(uri);
  },
};
