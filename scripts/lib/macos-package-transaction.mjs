import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readlink, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const PACKAGE_TRANSACTION_VERSION = 1;

export function newPackageTransactionId() {
  return `${Date.now()}-${process.pid}-${randomUUID().slice(0, 12)}`;
}

export function packageTransactionPaths(target, runId) {
  const parent = path.dirname(target);
  return {
    staging: path.join(parent, `.Meetless.app.m7.${runId}.installing`),
    backup: path.join(parent, `.Meetless.app.m7.${runId}.backup`),
    displaced: path.join(parent, `.Meetless.app.m7.${runId}.displaced`),
    journal: path.join(parent, `.Meetless.app.m7.${runId}.transaction.json`),
  };
}

export async function replacePackageBundle(input) {
  const { source, target, identityPath, ownerToken, runId, inspect, faultAt } = input;
  assertRequiredInput({ source, target, identityPath, ownerToken, runId, inspect });
  const paths = packageTransactionPaths(target, runId);
  for (const candidate of Object.values(paths)) {
    if (await exists(candidate)) throw new Error(`package transaction path already exists: ${candidate}`);
  }
  const sourceFingerprint = await fingerprintPath(source);
  if (!sourceFingerprint) throw new Error(`package transaction source is missing: ${source}`);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  const previous = {
    targetExists: await exists(target),
    targetFingerprint: await fingerprintPath(target),
    identityBytes: await readBytes(identityPath),
  };
  if (previous.targetExists !== Boolean(previous.targetFingerprint)) {
    throw new Error(`package transaction target existence changed while it was inspected: ${target}`);
  }
  const transaction = {
    version: PACKAGE_TRANSACTION_VERSION,
    ownerToken,
    runId,
    source,
    target,
    identityPath,
    paths,
    previous,
    sourceFingerprint,
    candidateFingerprint: sourceFingerprint,
    state: "prepared",
  };
  await writeJournal(transaction);

  await cp(source, paths.staging, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  });
  const stagedFingerprint = await fingerprintPath(paths.staging);
  if (stagedFingerprint !== sourceFingerprint) {
    throw new Error("package staging fingerprint differs from the source snapshot; recovery will fail closed");
  }
  transaction.stagingFingerprint = stagedFingerprint;
  await transition(transaction, "staged", faultAt);

  if (previous.targetExists) {
    await assertOwnedPath(target, previous.targetFingerprint, "prior package target");
    await rename(target, paths.backup);
    transaction.backupFingerprint = await fingerprintPath(paths.backup);
    if (transaction.backupFingerprint !== previous.targetFingerprint) {
      throw new Error("package backup fingerprint differs from the prior target; recovery will fail closed");
    }
  }
  await transition(transaction, "target-backed-up", faultAt);

  await rename(paths.staging, target);
  const candidateFingerprint = await fingerprintPath(target);
  if (candidateFingerprint !== sourceFingerprint) {
    throw new Error("installed package fingerprint differs from the source snapshot; recovery will fail closed");
  }
  transaction.candidateFingerprint = candidateFingerprint;
  await transition(transaction, "candidate-installed", faultAt);

  const inspected = await inspect(target);
  transaction.nextIdentityBytes = serializeSortedJson(inspected);
  transaction.nextIdentityFingerprint = digest(transaction.nextIdentityBytes);
  await writeJournal(transaction);
  await writeBytesAtomic(identityPath, transaction.nextIdentityBytes);
  await transition(transaction, "identity-published", faultAt);
  await transition(transaction, "committed", faultAt);
  return transaction;
}

export async function recoverPackageTransaction(transactionOrJournal, options = {}) {
  const transaction = await loadTransaction(transactionOrJournal);
  assertTransaction(transaction, options);
  if (options.assertNoLiveHost) await options.assertNoLiveHost();
  if (transaction.state === "finalizing" || transaction.state === "finalized") {
    await finishFinalization(transaction);
  } else {
    await restoreToPrevious(transaction);
  }
  return transaction.previous;
}

export async function restorePackageTransaction(transaction, options = {}) {
  assertTransaction(transaction, options);
  if (options.assertNoLiveHost) await options.assertNoLiveHost();
  if (transaction.state !== "committed" && transaction.state !== "restoring" &&
      transaction.state !== "target-displaced" && transaction.state !== "target-restored" &&
      transaction.state !== "target-removed" && transaction.state !== "identity-restored") {
    throw new Error(`cannot restore a package transaction in state ${transaction.state}`);
  }
  await restoreToPrevious(transaction, options.faultAt);
}

export async function finalizePackageTransaction(transaction, options = {}) {
  assertTransaction(transaction, options);
  if (options.assertNoLiveHost) await options.assertNoLiveHost();
  if (transaction.state !== "committed" && transaction.state !== "finalizing" && transaction.state !== "finalized") {
    throw new Error(`cannot finalize a package transaction in state ${transaction.state}`);
  }
  if (transaction.state === "committed") {
    await assertOwnedPath(transaction.target, transaction.candidateFingerprint, "installed package");
    await assertIdentityState(transaction, transaction.nextIdentityFingerprint);
    await transition(transaction, "finalizing", options.faultAt);
  }
  await finishFinalization(transaction, options.faultAt);
}

export async function fingerprintPath(root) {
  if (!(await exists(root))) return null;
  const entries = [];
  await fingerprintVisit(root, root, entries);
  return digest(Buffer.from(JSON.stringify(entries.sort((left, right) => left.relative.localeCompare(right.relative)))));
}

export async function readBytes(candidate) {
  return readFile(candidate).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  });
}

async function loadTransaction(transactionOrJournal) {
  if (typeof transactionOrJournal !== "string") return normalizeTransaction(transactionOrJournal);
  return normalizeTransaction(JSON.parse(await readFile(transactionOrJournal, "utf8")));
}

async function restoreToPrevious(transaction, faultAt) {
  if (transaction.state !== "restoring" && transaction.state !== "target-displaced" &&
      transaction.state !== "target-restored" && transaction.state !== "target-removed" &&
      transaction.state !== "identity-restored") {
    await transition(transaction, "restoring", faultAt);
  }

  const expectedPrior = transaction.previous.targetExists ? transaction.previous.targetFingerprint : null;
  const expectedCandidate = transaction.candidateFingerprint ?? transaction.sourceFingerprint;
  const targetFingerprint = await fingerprintPath(transaction.target);
  const displacedFingerprint = await fingerprintPath(transaction.paths.displaced);
  const backupFingerprint = await fingerprintPath(transaction.paths.backup);

  if (displacedFingerprint !== null && displacedFingerprint !== expectedCandidate) {
    throw new Error("refusing package recovery; displaced artifact ownership fingerprint changed");
  }
  if (targetFingerprint !== null && targetFingerprint !== expectedPrior && targetFingerprint !== expectedCandidate) {
    throw new Error("refusing package recovery; canonical target changed outside the package transaction");
  }

  if (expectedPrior !== null) {
    if (targetFingerprint === expectedCandidate) {
      if (displacedFingerprint !== null) throw new Error("refusing package recovery; two candidate artifacts are present");
      await rename(transaction.target, transaction.paths.displaced);
      await transition(transaction, "target-displaced", faultAt);
    }
    const currentTarget = await fingerprintPath(transaction.target);
    if (currentTarget === null) {
      const currentBackup = await fingerprintPath(transaction.paths.backup);
      if (currentBackup !== expectedPrior) {
        throw new Error("refusing package recovery; prior package backup is missing or changed");
      }
      await rename(transaction.paths.backup, transaction.target);
      await transition(transaction, "target-restored", faultAt);
    } else if (currentTarget === expectedPrior) {
      if (backupFingerprint !== null) {
        if (backupFingerprint !== expectedPrior) throw new Error("refusing package recovery; backup ownership fingerprint changed");
        await rm(transaction.paths.backup, { recursive: true, force: true });
      }
      if (transaction.state === "target-displaced") await transition(transaction, "target-restored", faultAt);
    } else {
      throw new Error("refusing package recovery; canonical target is neither the prior nor candidate package");
    }
  } else {
    if (targetFingerprint === expectedCandidate) {
      await removeOwnedPath(transaction.target, expectedCandidate, "installed package");
    } else if (targetFingerprint !== null) {
      throw new Error("refusing package recovery; a package appeared where no prior target was recorded");
    }
    if (await exists(transaction.paths.backup)) {
      throw new Error("refusing package recovery; unexpected prior-package backup exists");
    }
    if (transaction.state !== "target-removed" && transaction.state !== "identity-restored") {
      await transition(transaction, "target-removed", faultAt);
    }
  }

  if (await exists(transaction.paths.displaced)) {
    await removeOwnedPath(transaction.paths.displaced, expectedCandidate, "displaced package");
  }
  if (await exists(transaction.paths.staging)) {
    await removeOwnedPath(transaction.paths.staging, transaction.stagingFingerprint ?? transaction.sourceFingerprint, "package staging");
  }
  await restoreIdentity(transaction);
  if (transaction.state !== "identity-restored") await transition(transaction, "identity-restored", faultAt);
  await removeJournal(transaction);
}

async function finishFinalization(transaction, faultAt) {
  await assertOwnedPath(transaction.target, transaction.candidateFingerprint, "installed package");
  await assertIdentityState(transaction, transaction.nextIdentityFingerprint);
  if (await exists(transaction.paths.backup)) {
    await removeOwnedPath(transaction.paths.backup, transaction.backupFingerprint, "prior package backup");
  }
  if (await exists(transaction.paths.staging)) {
    await removeOwnedPath(transaction.paths.staging, transaction.stagingFingerprint ?? transaction.sourceFingerprint, "package staging");
  }
  if (await exists(transaction.paths.displaced)) {
    await removeOwnedPath(transaction.paths.displaced, transaction.candidateFingerprint, "displaced package");
  }
  if (transaction.state !== "finalized") await transition(transaction, "finalized", faultAt);
  await removeJournal(transaction);
}

async function restoreIdentity(transaction) {
  const previousBytes = transaction.previous.identityBytes;
  const current = await readBytes(transaction.identityPath);
  const currentDigest = digest(current);
  const previousDigest = digest(previousBytes);
  const nextDigest = transaction.nextIdentityFingerprint ?? digest(transaction.nextIdentityBytes);
  if (currentDigest !== previousDigest && currentDigest !== nextDigest) {
    throw new Error(`refusing to restore host identity changed outside package transaction ${transaction.identityPath}`);
  }
  if (currentDigest === previousDigest) return;
  if (previousBytes === null) await rm(transaction.identityPath, { force: true });
  else await writeBytesAtomic(transaction.identityPath, previousBytes);
}

async function assertIdentityState(transaction, expectedDigest) {
  const current = await readBytes(transaction.identityPath);
  if (digest(current) !== expectedDigest) {
    throw new Error(`refusing to modify host identity changed outside package transaction ${transaction.identityPath}`);
  }
}

async function assertOwnedPath(candidate, expectedFingerprint, label) {
  const actual = await fingerprintPath(candidate);
  if (actual !== expectedFingerprint) throw new Error(`refusing to modify ${label}; ownership fingerprint changed`);
}

async function removeOwnedPath(candidate, expectedFingerprint, label = "transaction path") {
  if (!(await exists(candidate))) return;
  await assertOwnedPath(candidate, expectedFingerprint, label);
  await rm(candidate, { recursive: true, force: true });
}

async function removeJournal(transaction) {
  if (!(await exists(transaction.paths.journal))) return;
  const onDisk = normalizeTransaction(JSON.parse(await readFile(transaction.paths.journal, "utf8")));
  assertTransaction(onDisk, { ownerToken: transaction.ownerToken, target: transaction.target, identityPath: transaction.identityPath });
  if (onDisk.runId !== transaction.runId || onDisk.state !== transaction.state) {
    throw new Error("refusing to remove a package transaction journal with a changed owner or state");
  }
  await rm(transaction.paths.journal, { force: true });
}

async function transition(transaction, state, faultAt) {
  transaction.state = state;
  await writeJournal(transaction);
  if (faultAt === state) throw new Error(`injected package transaction interruption at ${state}`);
}

async function writeJournal(transaction) {
  const bytes = Buffer.from(`${JSON.stringify(transaction, replacer, 2)}\n`);
  const temporary = `${transaction.paths.journal}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, transaction.paths.journal);
}

function assertRequiredInput(input) {
  for (const [name, value] of Object.entries(input)) {
    if (!value) throw new Error(`package transaction ${name} is required`);
  }
}

function assertTransaction(transaction, options = {}) {
  if (!transaction || transaction.version !== PACKAGE_TRANSACTION_VERSION || typeof transaction.ownerToken !== "string") {
    throw new Error("invalid package transaction journal");
  }
  if (!/^[-A-Za-z0-9]+$/u.test(transaction.runId ?? "")) throw new Error("invalid package transaction run ID");
  if (options.ownerToken !== undefined && transaction.ownerToken !== options.ownerToken) {
    throw new Error("package transaction owner token mismatch");
  }
  if (options.target !== undefined && path.resolve(transaction.target) !== path.resolve(options.target)) {
    throw new Error("package transaction target is not the fixed canonical target");
  }
  if (options.identityPath !== undefined && path.resolve(transaction.identityPath) !== path.resolve(options.identityPath)) {
    throw new Error("package transaction identity path is not the fixed canonical identity");
  }
  const expectedPaths = packageTransactionPaths(transaction.target, transaction.runId);
  for (const name of Object.keys(expectedPaths)) {
    if (transaction.paths?.[name] !== expectedPaths[name]) throw new Error(`package transaction ${name} path is not canonical`);
  }
  if (!transaction.previous || typeof transaction.previous.targetExists !== "boolean") {
    throw new Error("package transaction prior target record is missing");
  }
  transaction.previous.identityBytes = reviveBuffer(transaction.previous.identityBytes);
  transaction.nextIdentityBytes = reviveBuffer(transaction.nextIdentityBytes);
}

function normalizeTransaction(transaction) {
  assertTransaction(transaction);
  return transaction;
}

function replacer(_key, value) {
  if (Buffer.isBuffer(value)) return { type: "Buffer", data: value.toString("base64") };
  if (value?.type === "Buffer" && Array.isArray(value.data)) {
    return { type: "Buffer", data: Buffer.from(value.data).toString("base64") };
  }
  return value;
}

function reviveBuffer(value) {
  if (value?.type !== "Buffer") return value;
  if (typeof value.data === "string") return Buffer.from(value.data, "base64");
  if (Array.isArray(value.data)) return Buffer.from(value.data);
  return value;
}

async function fingerprintVisit(root, candidate, entries) {
  const inspected = await lstat(candidate);
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  if (inspected.isSymbolicLink()) {
    const target = await readlink(candidate);
    entries.push({ relative, type: "symlink", target, sha256: digest(Buffer.from(target)) });
    return;
  }
  if (inspected.isFile()) {
    const bytes = await readFile(candidate);
    entries.push({ relative, type: "file", size: bytes.byteLength, sha256: digest(bytes) });
    return;
  }
  if (!inspected.isDirectory()) return;
  for (const name of (await readdir(candidate)).sort()) await fingerprintVisit(root, path.join(candidate, name), entries);
}

async function writeBytesAtomic(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  const handle = await open(temporary, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filePath);
}

async function exists(candidate) {
  return (await lstat(candidate).catch(() => null)) !== null;
}

function digest(bytes) {
  return bytes === null || bytes === undefined ? null : createHash("sha256").update(bytes).digest("hex");
}

export function serializeSortedJson(value) {
  const encoded = writeFoundationJsonValue(value, 0, "root");
  if (encoded === undefined) throw new Error("cannot serialize package identity as JSON");
  return Buffer.from(`${encoded}\n`);
}

function writeFoundationJsonValue(value, indent, context) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const values = value.map((entry, index) =>
      writeFoundationJsonValue(entry, indent + 2, `${context}[${index}]`) ?? "null",
    );
    const childIndent = " ".repeat(indent + 2);
    const currentIndent = " ".repeat(indent);
    return values.length === 0
      ? `[\n\n${currentIndent}]`
      : `[\n${values.map((entry) => `${childIndent}${entry}`).join(",\n")}\n${currentIndent}]`;
  }
  if (typeof value === "string") return writeFoundationJsonString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error(`cannot serialize package identity value at ${context}`);
    return encoded;
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value !== "object") throw new Error(`cannot serialize package identity value at ${context}`);

  const entries = [];
  for (const key of Object.keys(value).sort()) {
    const encoded = writeFoundationJsonValue(value[key], indent + 2, `${context}.${key}`);
    if (encoded !== undefined) entries.push([key, encoded]);
  }
  const childIndent = " ".repeat(indent + 2);
  const currentIndent = " ".repeat(indent);
  return entries.length === 0
    ? `{\n\n${currentIndent}}`
    : `{\n${entries.map(([key, encoded]) => `${childIndent}${writeFoundationJsonString(key)} : ${encoded}`).join(",\n")}\n${currentIndent}}`;
}

function writeFoundationJsonString(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("cannot serialize package identity string");
  let result = "";
  for (const character of encoded) result += character === "/" ? "\\/" : character;
  return result;
}
