import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  assert.equal(claudeMcp.mcpServers["oracle-firefox"].env.ORACLE_FIREFOX_HARNESS, "claude-code-mcp");
  assert.equal(mcpb.server.mcp_config.env.ORACLE_FIREFOX_HARNESS, "claude-desktop-mcp");
  const { stdout: tracked } = await execFileAsync("git", [
    "ls-files",
    "--error-unmatch",
    "plugins/oracle-firefox-claude/dist/server.mjs",
    "plugins/oracle-firefox-claude/dist/broker.mjs",
  ], { cwd: repositoryRoot });
  assert.match(tracked, /plugins\/oracle-firefox-claude\/dist\/server\.mjs/u);
  assert.match(tracked, /plugins\/oracle-firefox-claude\/dist\/broker\.mjs/u);

  const packageJson = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
  const build = JSON.parse(await readFile(path.join(pluginRoot, "build-manifest.json"), "utf8"));
  const claudeBuild = JSON.parse(await readFile(path.join(repositoryRoot, "plugins", "oracle-firefox-claude", "build-manifest.json"), "utf8"));
  const mcpbBuild = JSON.parse(await readFile(path.join(pluginRoot, "mcpb", "build-manifest.json"), "utf8"));
  assert.equal(packageJson.version, meta.version);
  assert.equal(build.packageVersion, meta.version);
  assert.equal(build.protocolVersion, meta.protocolVersion);
  assert.equal(build.schemaVersion, meta.schemaVersion);
  assert.equal(build.releaseSequence, meta.releaseSequence);
  assert.deepEqual(claudeBuild, build);
  assert.deepEqual(mcpbBuild, build);
  assert.match(build.sourceDigest, /^[0-9a-f]{64}$/u);
  for (const artifact of [
    path.join(pluginRoot, "dist", "server.mjs"),
    path.join(pluginRoot, "dist", "broker.mjs"),
    path.join(repositoryRoot, "plugins", "oracle-firefox-claude", "dist", "server.mjs"),
    path.join(repositoryRoot, "plugins", "oracle-firefox-claude", "dist", "broker.mjs"),
    path.join(pluginRoot, "mcpb", "server", "server.mjs"),
    path.join(pluginRoot, "mcpb", "server", "broker.mjs"),
  ]) {
    assert.match(await readFile(artifact, "utf8"), new RegExp(build.buildId), `${artifact} must carry the canonical build id`);
  }
});

test("Codex MCP launcher survives a restricted PATH and unrelated working directory", async () => {
  const launcher = path.join(pluginRoot, "bin", "oracle-firefox-codex-launcher");
  const unrelated = await mkdtemp(path.join(os.tmpdir(), "oracle-codex-launcher-"));
  try {
    const { stdout } = await execFileAsync(launcher, ["--launcher-probe"], {
      cwd: unrelated,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        ORACLE_FIREFOX_NODE_PATH: "/bin/echo",
      },
    });
    assert.equal(stdout.trim(), `${path.join(pluginRoot, "dist", "server.mjs")} --launcher-probe`);
    const contents = await readFile(launcher, "utf8");
    assert.match(contents, /\/opt\/homebrew\/bin\/node/u);
    assert.match(contents, /ORACLE_FIREFOX_NODE_PATH/u);
  } finally {
    await rm(unrelated, { recursive: true, force: true });
  }
});

test("generated Claude skill includes the canonical progressive-disclosure references", async () => {
  const canonicalRoot = path.join(pluginRoot, "skills", "oracle-firefox");
  const generatedRoot = path.join(repositoryRoot, "plugins", "oracle-firefox-claude", "skills", "oracle-firefox");
  const canonicalSkill = await readFile(path.join(canonicalRoot, "SKILL.md"), "utf8");
  const generatedSkill = await readFile(path.join(generatedRoot, "SKILL.md"), "utf8");
  assert.equal(generatedSkill, canonicalSkill);
  assert.ok([...canonicalSkill].length <= 6500, "always-loaded Oracle skill must stay within its character budget");

  const referenced = [...new Set(
    [...canonicalSkill.matchAll(/\]\((references\/[^)]+\.md)\)/gu)].map((match) => match[1]),
  )].sort();
  const expected = [
    "references/downloads.md",
    "references/local-evidence.md",
    "references/recovery.md",
    "references/setup.md",
    "references/targeting.md",
  ];
  assert.deepEqual(referenced, expected);

  const canonicalFiles = (await readdir(path.join(canonicalRoot, "references")))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `references/${name}`)
    .sort();
  const generatedFiles = (await readdir(path.join(generatedRoot, "references")))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `references/${name}`)
    .sort();
  assert.deepEqual(canonicalFiles, expected);
  assert.deepEqual(generatedFiles, expected);

  for (const relativePath of expected) {
    const canonical = await readFile(path.join(canonicalRoot, relativePath), "utf8");
    const generated = await readFile(path.join(generatedRoot, relativePath), "utf8");
    assert.equal(generated, canonical, `${relativePath} must be byte-identical in the Claude package`);
    assert.doesNotMatch(canonical, /\]\(references\/[^)]+\.md\)/u, `${relativePath} must not route to another reference`);
  }
});

test("Claudex wrapper adds only plugin-dir and preserves managed or Fable arguments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-claudex-test-"));
  const plugin = path.join(root, "plugin");
  const fake = path.join(root, "fake-claudex.mjs");
  await mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(plugin, ".claude-plugin", "plugin.json"), "{}\n");
  await writeFile(fake, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), harness: process.env.ORACLE_FIREFOX_HARNESS }));\n");
  await chmod(fake, 0o755);
  try {
    const wrapper = path.join(pluginRoot, "src", "oracle-claudex.mjs");
    const { stdout } = await execFileAsync(process.execPath, [wrapper, "--model", "fable", "-p", "hello"], {
      env: { ...process.env, ORACLE_FIREFOX_CLAUDE_PLUGIN: plugin, CLAUDEX_PATH: fake },
    });
    const value = JSON.parse(stdout);
    assert.deepEqual(value.args, ["--plugin-dir", plugin, "--model", "fable", "-p", "hello"]);
    assert.equal(value.args.includes("--mcp-config"), false);
    assert.equal(value.harness, "claudex");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("broker spawn survives install paths containing spaces", async () => {
  // Regression (2026-08-04): URL.pathname keeps percent-encoding, so the
  // Claude Desktop extension install under "Application Support" spawned
  // node against ".../Application%20Support/.../broker.mjs" and died
  // MODULE_NOT_FOUND (BROKER_START_FAILED for every caller). The spawn must
  // decode via fileURLToPath, in the source and in every built artifact.
  const artifacts = [
    path.join(pluginRoot, "src", "broker-client.mjs"),
    path.join(pluginRoot, "dist", "server.mjs"),
    path.join(pluginRoot, "dist", "cli.mjs"),
    path.join(pluginRoot, "mcpb", "server", "server.mjs"),
  ];
  for (const artifact of artifacts) {
    const text = await readFile(artifact, "utf8");
    assert.match(
      text,
      /fileURLToPath\(new URL\("\.\/broker\.mjs", import\.meta\.url\)\)/u,
      `${artifact} must resolve the broker entry via fileURLToPath`,
    );
    assert.doesNotMatch(
      text,
      /brokerEntry\.pathname/u,
      `${artifact} must not spawn from URL.pathname`,
    );
  }
});
