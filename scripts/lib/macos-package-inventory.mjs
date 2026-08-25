import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, lstat, readFile, readlink, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function enumeratePackageEntries(root) {
  const entries = [];
  await visit(root, root, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function inspectPackageMachOEntries(root, entries) {
  const regularFiles = entries.filter((entry) => entry.type === "file");
  const fileTypes = await inspectFileTypes(root, regularFiles);
  const results = [];
  for (const entry of regularFiles) {
    const fileOutput = fileTypes.get(path.resolve(root, entry.path));
    if (fileOutput && /Mach-O/u.test(fileOutput)) results.push({ ...entry, fileOutput });
  }
  return results.sort((left, right) => left.path.localeCompare(right.path));
}

export async function inspectMachO(binary) {
  const fileOutput = await runFile(binary);
  if (!/Mach-O/u.test(fileOutput)) return null;
  const [dependenciesOutput, loadCommandsOutput] = await Promise.all([
    runOtool(binary, ["-L"]),
    runOtool(binary, ["-l"]),
  ]);
  return {
    fileOutput,
    dependencies: parseOtoolDependencies(dependenciesOutput, parseInstallName(loadCommandsOutput)),
    rpaths: parseRpaths(loadCommandsOutput),
  };
}

export function parseOtoolDependencies(output, installName = null) {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" (")[0])
    .filter((dependency) => dependency && dependency !== installName);
}

export function parseInstallName(output) {
  const match = output.match(/cmd LC_ID_DYLIB[\s\S]*?\n\s*name\s+(.+?)\s+\(offset\s+\d+\)/u);
  return match?.[1] ?? null;
}

export function parseRpaths(output) {
  return [...output.matchAll(/^\s*path\s+(.+?)\s+\(offset\s+\d+\)/gmu)]
    .map((match) => match[1]);
}

async function visit(root, directory, entries) {
  const names = (await readdir(directory)).sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    const absolute = path.join(directory, name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const inspected = await lstat(absolute);
    if (inspected.isSymbolicLink()) {
      const target = await readlink(absolute);
      entries.push({ path: relative, type: "symlink", target, sha256: sha256(Buffer.from(target)) });
    } else if (inspected.isFile()) {
      const bytes = await readFile(absolute);
      entries.push({ path: relative, type: "file", size: bytes.byteLength, sha256: sha256(bytes) });
    } else if (inspected.isDirectory()) {
      await visit(root, absolute, entries);
    }
  }
}

async function runFile(binary) {
  const result = await execFileAsync("file", [binary]);
  return result.stdout;
}

async function inspectFileTypes(root, entries) {
  const batches = [];
  for (let index = 0; index < entries.length; index += 256) batches.push(entries.slice(index, index + 256));
  const result = new Map();
  await mapLimit(batches, 4, async (batch) => {
    const absolutePaths = batch.map((entry) => path.join(root, entry.path));
    const inspected = await execFileAsync("file", ["-0", ...absolutePaths], { maxBuffer: 32 * 1024 * 1024 });
    for (const match of inspected.stdout.matchAll(/([^\n\0]+)\0:\s*([^\n]*)/gu)) {
      result.set(path.resolve(match[1]), match[2].trim());
    }
  });
  return result;
}

async function runOtool(binary, arguments_) {
  if (!/[()]/u.test(binary)) return (await execFileAsync("otool", [...arguments_, binary])).stdout;
  const temporary = path.join(
    "/private/tmp",
    `meetless-m7-otool-${process.pid}-${randomUUID()}-${sha256(Buffer.from(binary)).slice(0, 16)}-${path.basename(binary).replaceAll(/[^A-Za-z0-9_.-]/gu, "_")}`,
  );
  await copyFile(binary, temporary);
  try {
    return (await execFileAsync("otool", [...arguments_, temporary])).stdout;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function mapLimit(items, limit, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await operation(items[index]);
    }
  });
  await Promise.all(workers);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
