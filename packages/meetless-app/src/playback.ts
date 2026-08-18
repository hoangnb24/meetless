import type { CitationWire } from "@meetless/meeting-contracts";

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

export async function playCitationAudio(
  citation: CitationWire,
  factory: CitationAudioFactory = browserAudioFactory,
): Promise<CitationPlaybackHandle> {
  if (citation.endMs <= citation.startMs) throw new Error("Citation playback interval is not bounded");
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
  if (citation.audio.mimeType !== "audio/mpeg" || !/^[A-Za-z0-9+/]+={0,2}$/.test(citation.audio.base64)) {
    throw new Error("Cited audio payload is invalid");
  }
  return `data:${citation.audio.mimeType};base64,${citation.audio.base64}`;
}
