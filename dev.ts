// Dev: run the API server (watch) and the Vite dev server together.
const opts = { stdout: "inherit", stderr: "inherit", stdin: "inherit" } as const;

const procs = [
  Bun.spawn(["bun", "--watch", "server/index.ts"], opts),
  Bun.spawn(["bun", "x", "vite", "--config", "web/vite.config.ts"], opts),
];

const shutdown = () => {
  for (const p of procs) p.kill();
  process.exit();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.race(procs.map((p) => p.exited));
shutdown();
