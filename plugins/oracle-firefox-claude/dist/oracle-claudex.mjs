#!/usr/bin/env node
import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);

// src/oracle-claudex.mjs
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
var pluginDirectory = path.resolve(
  process.env.ORACLE_FIREFOX_CLAUDE_PLUGIN || path.join(os.homedir(), ".local", "share", "oracle-firefox", "claude-plugin")
);
try {
  await access(path.join(pluginDirectory, ".claude-plugin", "plugin.json"));
} catch {
  process.stderr.write(`Oracle Firefox Claude package is not installed at ${pluginDirectory}. Run the Claudex installer first.
`);
  process.exit(1);
}
var args = ["--plugin-dir", pluginDirectory, ...process.argv.slice(2)];
var child = spawn(process.env.CLAUDEX_PATH || "claudex", args, {
  stdio: "inherit",
  env: { ...process.env, ORACLE_FIREFOX_NODE_PATH: process.env.ORACLE_FIREFOX_NODE_PATH || process.execPath }
});
child.once("error", (error) => {
  process.stderr.write(`Unable to launch Claudex: ${error.message}
`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
