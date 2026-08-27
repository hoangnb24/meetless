import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, lstat, readFile, readlink, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MACOS_OWNER_TOOL_PATHS = Object.freeze({
  file: "/usr/bin/file",
  otool: "/usr/bin/otool",
});

function ownerToolEnvironment(environment = process.env) {
  const sanitized = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" };
  for (const name of ["HOME", "USER", "LOGNAME", "TERM", "TERM_PROGRAM"]) {
    if (typeof environment?.[name] === "string" && environment[name].length > 0) sanitized[name] = environment[name];
  }
  return sanitized;
}

export async function enumeratePackageEntries(root) {
  const entries = [];
  await visit(root, root, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function inspectPackageMachOEntries(root, entries, { ownerMode = false } = {}) {
  const regularFiles = entries.filter((entry) => entry.type === "file");
  const fileTypes = await inspectFileTypes(root, regularFiles, { ownerMode });
  const results = [];
  for (const entry of regularFiles) {
    const fileOutput = fileTypes.get(path.resolve(root, entry.path));
    if (fileOutput && /Mach-O/u.test(fileOutput)) {
      const machOHeader = await inspectMachOHeader(path.resolve(root, entry.path), { ownerMode });
      results.push({ ...entry, fileOutput, ...machOHeader });
    }
  }
  return results.sort((left, right) => left.path.localeCompare(right.path));
}

export async function inspectMachO(binary, { ownerMode = false } = {}) {
  const fileOutput = await runFile(binary, { ownerMode });
  if (!/Mach-O/u.test(fileOutput)) return null;
  const [machOHeader, dependenciesOutput, loadCommandsOutput] = await Promise.all([
    inspectMachOHeader(binary, { ownerMode }),
    runOtool(binary, ["-L"], { ownerMode }),
    runOtool(binary, ["-l"], { ownerMode }),
  ]);
  return {
    fileOutput,
    ...machOHeader,
    dependencies: parseOtoolDependencies(dependenciesOutput, parseInstallName(loadCommandsOutput)),
    rpaths: parseRpaths(loadCommandsOutput),
  };
}

export function parseMachOHeaders(output, relativePath = "Mach-O") {
  const lines = String(output ?? "").split("\n").map((line) => line.trim());
  const blocks = [];
  let currentBlock = null;
  for (const line of lines) {
    if (line === "Mach header") {
      if (currentBlock && currentBlock.headerLine === null) {
        throw new Error(`Mach-O header for ${relativePath} has a malformed header block; inspect every regular Mach-O slice before signing`);
      }
      currentBlock = { headerLine: null };
      blocks.push(currentBlock);
      continue;
    }
    if (/^MH_[A-Z0-9_]+\s+/u.test(line)) {
      if (!currentBlock) {
        throw new Error(`Mach-O header for ${relativePath} has a header outside a Mach header block; inspect every regular Mach-O slice before signing`);
      }
      if (currentBlock.headerLine !== null) {
        throw new Error(`Mach-O header for ${relativePath} has multiple headers in one slice block; inspect every regular Mach-O slice before signing`);
      }
      currentBlock.headerLine = line;
    }
  }
  if (currentBlock && currentBlock.headerLine === null) {
    throw new Error(`Mach-O header for ${relativePath} has a malformed header block; inspect every regular Mach-O slice before signing`);
  }
  const slices = blocks.map(({ headerLine }) => {
    const fields = headerLine?.split(/\s+/u) ?? [];
    if (fields.length < 5 || !/^MH_[A-Z0-9_]+$/u.test(fields[0]) || !/^[A-Z0-9_]+$/u.test(fields[1]) || !/^[A-Z0-9_]+$/u.test(fields[2]) || !/^[A-Z0-9_]+$/u.test(fields[4])) {
      throw new Error(`Mach-O header for ${relativePath} has no authoritative CPU type, subtype, or file type; inspect every regular Mach-O slice before signing`);
    }
    return {
      cpuType: fields[1].toLowerCase(),
      cpuSubtype: fields[2].toLowerCase(),
      fileType: `MH_${fields[4]}`,
    };
  });
  if (slices.length === 0) {
    throw new Error(`Mach-O header for ${relativePath} has no authoritative slice headers; inspect every regular Mach-O slice before signing`);
  }
  const machOSlices = normalizeMachOSlices(slices, relativePath);
  return {
    machOSlices,
    machOFileType: machOSlices.length === 1 ? machOSlices[0].fileType : null,
    machOArchitecture: machOSlices.length === 1 ? machOSlices[0].architecture : null,
  };
}

export function parseMachOHeader(output, relativePath = "Mach-O") {
  const parsed = parseMachOHeaders(output, relativePath);
  if (parsed.machOSlices.length !== 1) {
    throw new Error(`Mach-O header for ${relativePath} has ${parsed.machOSlices.length} architecture slices; inspect the complete slice set before signing`);
  }
  return {
    machOFileType: parsed.machOFileType,
    machOArchitecture: parsed.machOArchitecture,
  };
}

export function normalizeMachOSlices(slices, relativePath = "Mach-O") {
  if (!Array.isArray(slices) || slices.length === 0) return [];
  const normalized = slices.map((slice) => {
    const suppliedArchitecture = String(slice?.architecture ?? slice?.machOArchitecture ?? "").toLowerCase();
    const cpuType = String(slice?.cpuType ?? (suppliedArchitecture === "arm64e" ? "arm64" : suppliedArchitecture)).toLowerCase();
    const cpuSubtype = String(slice?.cpuSubtype ?? (suppliedArchitecture === "arm64e" ? "e" : "all")).toLowerCase();
    const architecture = normalizeMachOArchitecture(cpuType, cpuSubtype);
    const fileType = String(slice?.fileType ?? slice?.machOFileType ?? "");
    if (!/^[a-z0-9_]+$/u.test(cpuType) || !/^[a-z0-9_]+$/u.test(cpuSubtype) || !/^[a-z0-9_]+$/u.test(architecture) || !/^MH_[A-Z0-9_]+$/u.test(fileType) || (suppliedArchitecture !== "" && suppliedArchitecture !== architecture)) {
      throw new Error(`Mach-O slice evidence for ${relativePath} has a malformed or mismatched CPU type/subtype or file type; inspect every slice before signing`);
    }
    return { architecture, cpuType, cpuSubtype, fileType };
  });
  const architectures = new Set();
  for (const slice of normalized) {
    if (architectures.has(slice.architecture)) {
      throw new Error(`Mach-O slice evidence for ${relativePath} contains duplicate or ambiguous architecture ${slice.architecture}; inspect the complete slice set before signing`);
    }
    architectures.add(slice.architecture);
  }
  return normalized.sort((left, right) => `${left.architecture}:${left.cpuSubtype}:${left.fileType}`.localeCompare(`${right.architecture}:${right.cpuSubtype}:${right.fileType}`));
}

function normalizeMachOArchitecture(cpuType, cpuSubtype) {
  if (cpuType === "arm64" && cpuSubtype === "all") return "arm64";
  if (cpuType === "arm64" && cpuSubtype === "e") return "arm64e";
  if (cpuSubtype === "all") return cpuType;
  return `${cpuType}_${cpuSubtype}`;
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
    } else {
      throw new Error(
        `package entry ${relative} has unsupported lstat type (mode ${inspected.mode.toString(8)}). Authority: docs/plans/active/v1-paseo-foundation.md. Next action: remove the FIFO, socket, device, or unsupported entry, or obtain an accepted package-entry rule before signing.`,
      );
    }
  }
}

async function runFile(binary, { ownerMode = false } = {}) {
  const result = await execFileAsync(ownerMode ? MACOS_OWNER_TOOL_PATHS.file : "file", [binary], ownerMode ? { env: ownerToolEnvironment() } : undefined);
  return result.stdout;
}

async function inspectMachOHeader(binary, { ownerMode = false } = {}) {
  const output = await runOtool(binary, ["-arch", "all", "-hv"], { ownerMode });
  return parseMachOHeaders(output, binary);
}

async function inspectFileTypes(root, entries, { ownerMode = false } = {}) {
  const batches = [];
  for (let index = 0; index < entries.length; index += 256) batches.push(entries.slice(index, index + 256));
  const result = new Map();
  await mapLimit(batches, 4, async (batch) => {
    const absolutePaths = batch.map((entry) => path.join(root, entry.path));
    const inspected = await execFileAsync(ownerMode ? MACOS_OWNER_TOOL_PATHS.file : "file", ["-0", ...absolutePaths], {
      maxBuffer: 32 * 1024 * 1024,
      ...(ownerMode ? { env: ownerToolEnvironment() } : {}),
    });
    for (const match of inspected.stdout.matchAll(/([^\n\0]+)\0:\s*([^\n]*)/gu)) {
      result.set(path.resolve(match[1]), match[2].trim());
    }
  });
  return result;
}

async function runOtool(binary, arguments_, { ownerMode = false } = {}) {
  const command = ownerMode ? MACOS_OWNER_TOOL_PATHS.otool : "otool";
  const options = ownerMode ? { env: ownerToolEnvironment() } : undefined;
  if (!/[()]/u.test(binary)) return (await execFileAsync(command, [...arguments_, binary], options)).stdout;
  const temporary = path.join(
    "/private/tmp",
    `meetless-m7-otool-${process.pid}-${randomUUID()}-${sha256(Buffer.from(binary)).slice(0, 16)}-${path.basename(binary).replaceAll(/[^A-Za-z0-9_.-]/gu, "_")}`,
  );
  await copyFile(binary, temporary);
  try {
    return (await execFileAsync(command, [...arguments_, temporary], options)).stdout;
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
