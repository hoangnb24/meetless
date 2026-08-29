import { writeFileSync } from "node:fs";

const [pidPath, exitPath] = process.argv.slice(2);
writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });
process.on("exit", () => writeFileSync(exitPath, "exited\n", { mode: 0o600 }));
process.stdin.resume();
