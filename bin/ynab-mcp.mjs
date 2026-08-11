#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const entrypoint = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const child = spawn(
  process.execPath,
  ["--env-file-if-exists=.env", entrypoint],
  { stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
