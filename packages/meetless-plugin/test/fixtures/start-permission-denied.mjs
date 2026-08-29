process.stdin.setEncoding("utf8");
process.stdin.once("data", () => {
  process.stdout.write(`${JSON.stringify({
    version: 1,
    event: "error",
    error: "The user declined TCCs for application, window, display capture",
  })}\n`);
});
