#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const entrypoint = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const child = spawn(
  process.execPath,
  ["--env-file-if-exists=.env", entrypoint],
  { stdio: "inherit" },
);

const signals = ["SIGINT", "SIGTERM"];
const forwardSignal = (signal) => child.kill(signal);

for (const signal of signals) {
  process.on(signal, forwardSignal);
}

child.on("exit", (code, signal) => {
  if (signal) {
    for (const parentSignal of signals) {
      process.removeListener(parentSignal, forwardSignal);
    }
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
