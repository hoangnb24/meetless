import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { OutputIdentity } from "@meetless/meeting-domain";

export interface VerifiedAudioSnapshot {
  path: string;
  cleanup(): Promise<void>;
}

export interface AudioSnapshotStore {
  initialize(): Promise<void>;
  create(sourcePath: string, expectedIdentity: OutputIdentity): Promise<VerifiedAudioSnapshot>;
}

export class PrivateAudioSnapshotStore implements AudioSnapshotStore {
  private initialization: Promise<void> | null = null;
  private readonly ownedName: RegExp;

  constructor(
    private readonly directory: string,
    private readonly prefix: string,
  ) {
    this.ownedName = new RegExp(`^${escapeRegExp(prefix)}-[0-9a-f-]{36}\\.mp3$`);
  }

  initialize(): Promise<void> {
    this.initialization ??= this.prepareDirectory();
    return this.initialization;
  }

  async create(sourcePath: string, expectedIdentity: OutputIdentity): Promise<VerifiedAudioSnapshot> {
    await this.initialize();
    const target = path.join(this.directory, `${this.prefix}-${randomUUID()}.mp3`);
    const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let destination: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const sourceStats = await source.stat();
      if (!sourceStats.isFile() || sourceStats.nlink !== 1 || sourceStats.size <= 0) {
        throw new Error("Saved MP3 snapshot source must be a private regular file");
      }
      if (sourceStats.size !== expectedIdentity.byteLength) {
        throw new Error("Saved MP3 identity changed before private snapshot");
      }
      destination = await open(
        target,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let byteLength = 0;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        const bytes = buffer.subarray(0, bytesRead);
        digest.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await destination.write(bytes, offset, bytes.length - offset, null);
          if (result.bytesWritten <= 0) throw new Error("Private audio snapshot write did not make progress");
          offset += result.bytesWritten;
        }
        byteLength += bytesRead;
      }
      await destination.sync();
      const sha256 = digest.digest("hex");
      if (byteLength !== expectedIdentity.byteLength || sha256 !== expectedIdentity.sha256) {
        throw new Error("Saved MP3 identity changed before private snapshot");
      }
      await destination.close();
      destination = null;
      return { path: target, cleanup: () => rm(target, { force: true }) };
    } catch (error) {
      await destination?.close().catch(() => undefined);
      await rm(target, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await source.close();
    }
  }

  private async prepareDirectory(): Promise<void> {
    await sweepOwnedAudioCandidates(this.directory, this.ownedName);
  }
}

export async function sweepOwnedAudioCandidates(directory: string, ownedName: RegExp): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    ownedName.lastIndex = 0;
    if (entry.isFile() && ownedName.test(entry.name)) {
      await rm(path.join(directory, entry.name), { force: true });
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
