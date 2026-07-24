#!/usr/bin/env node
import { chmod, cp, mkdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(pluginRoot, "../oracle-firefox-claude");
const base = path.join(os.homedir(), ".local", "share", "oracle-firefox");
const destination = path.join(base, "claude-plugin");
const temporary = path.join(base, `claude-plugin.installing-${process.pid}`);
const binDirectory = path.join(os.homedir(), ".local", "bin");
const wrapper = path.join(binDirectory, "oracle-claudex");

await mkdir(base, { recursive: true, mode: 0o700 });
await rm(temporary, { recursive: true, force: true });
await cp(source, temporary, { recursive: true });
await rm(destination, { recursive: true, force: true });
await rename(temporary, destination);
await mkdir(binDirectory, { recursive: true });
await cp(path.join(destination, "dist", "oracle-claudex.mjs"), wrapper);
await chmod(wrapper, 0o755);
process.stdout.write(`Installed Oracle Firefox's Claude package at ${destination}\nWrapper: ${wrapper}\nRun: oracle-claudex [your normal Claudex arguments]\n`);
