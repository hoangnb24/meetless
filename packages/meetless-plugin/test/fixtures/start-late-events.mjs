const delayMs = Number(process.argv[2] ?? "75");

process.stdin.resume();
setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ version: 1, event: "started" })}\n`);
  process.stdout.write(`${JSON.stringify({
    version: 1,
    event: "captureFailed",
    error: "late capture failure after start timeout",
  })}\n`);
}, delayMs);
