import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(pluginRoot, "../..");

test("canonical metadata matches Codex, Claude, marketplace, and MCPB packages", async () => {
  const meta = JSON.parse(await readFile(path.join(pluginRoot, "plugin.meta.json"), "utf8"));
  const codex = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const claude = JSON.parse(await readFile(path.join(repositoryRoot, "plugins", "oracle-firefox-claude", ".claude-plugin", "plugin.json"), "utf8"));
  const marketplace = JSON.parse(await readFile(path.join(repositoryRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  const mcpb = JSON.parse(await readFile(path.join(pluginRoot, "mcpb", "manifest.json"), "utf8"));
  assert.equal(codex.version.split("+")[0], meta.version);
  assert.equal(claude.version, meta.version);
  assert.equal(marketplace.plugins[0].version, meta.version);
  assert.equal(mcpb.version, meta.version);
  const claudeMcp = JSON.parse(await readFile(path.join(repositoryRoot, "plugins", "oracle-firefox-claude", ".mcp.json"), "utf8"));
  assert.match(claudeMcp.mcpServers["oracle-firefox"].args[0], /\$\{CLAUDE_PLUGIN_ROOT\}/u);
  const { stdout: tracked } = await execFileAsync("git", [
    "ls-files",
    "--error-unmatch",
    "plugins/oracle-firefox-claude/dist/server.mjs",
    "plugins/oracle-firefox-claude/dist/broker.mjs",
  ], { cwd: repositoryRoot });
  assert.match(tracked, /plugins\/oracle-firefox-claude\/dist\/server\.mjs/u);
  assert.match(tracked, /plugins\/oracle-firefox-claude\/dist\/broker\.mjs/u);
});

test("Claudex wrapper adds only plugin-dir and preserves managed or Fable arguments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-claudex-test-"));
  const plugin = path.join(root, "plugin");
  const fake = path.join(root, "fake-claudex.mjs");
  await mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(plugin, ".claude-plugin", "plugin.json"), "{}\n");
  await writeFile(fake, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  await chmod(fake, 0o755);
  try {
    const wrapper = path.join(pluginRoot, "src", "oracle-claudex.mjs");
    const { stdout } = await execFileAsync(process.execPath, [wrapper, "--model", "fable", "-p", "hello"], {
      env: { ...process.env, ORACLE_FIREFOX_CLAUDE_PLUGIN: plugin, CLAUDEX_PATH: fake },
    });
    assert.deepEqual(JSON.parse(stdout), ["--plugin-dir", plugin, "--model", "fable", "-p", "hello"]);
    assert.equal(JSON.parse(stdout).includes("--mcp-config"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
