#!/usr/bin/env node
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const pluginDirectory = path.resolve(
  process.env.ORACLE_FIREFOX_CLAUDE_PLUGIN ||
    path.join(os.homedir(), ".local", "share", "oracle-firefox", "claude-plugin"),
);
try {
  await access(path.join(pluginDirectory, ".claude-plugin", "plugin.json"));
} catch {
  process.stderr.write(`Oracle Firefox Claude package is not installed at ${pluginDirectory}. Run the Claudex installer first.\n`);
  process.exit(1);
}

const args = ["--plugin-dir", pluginDirectory, ...process.argv.slice(2)];
const child = spawn(process.env.CLAUDEX_PATH || "claudex", args, {
  stdio: "inherit",
  env: {
    ...process.env,
    ORACLE_FIREFOX_NODE_PATH: process.env.ORACLE_FIREFOX_NODE_PATH || process.execPath,
    ORACLE_FIREFOX_HARNESS: "claudex",
  },
});
child.once("error", (error) => {
  process.stderr.write(`Unable to launch Claudex: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
