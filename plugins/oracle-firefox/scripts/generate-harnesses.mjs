import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(pluginRoot, "../..");
const claudeRoot = path.join(repositoryRoot, "plugins", "oracle-firefox-claude");
const mcpbRoot = path.join(pluginRoot, "mcpb");
const meta = JSON.parse(await readFile(path.join(pluginRoot, "plugin.meta.json"), "utf8"));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

await rm(claudeRoot, { recursive: true, force: true });
await mkdir(path.join(claudeRoot, ".claude-plugin"), { recursive: true });
await mkdir(path.join(claudeRoot, "dist"), { recursive: true });
await mkdir(path.join(claudeRoot, "skills", "oracle-firefox"), { recursive: true });
await cp(path.join(pluginRoot, "dist"), path.join(claudeRoot, "dist"), { recursive: true });
await cp(path.join(pluginRoot, "skills", "oracle-firefox", "SKILL.md"), path.join(claudeRoot, "skills", "oracle-firefox", "SKILL.md"));
await cp(
  path.join(pluginRoot, "skills", "oracle-firefox", "references"),
  path.join(claudeRoot, "skills", "oracle-firefox", "references"),
  { recursive: true },
);
await cp(path.join(pluginRoot, "LICENSE"), path.join(claudeRoot, "LICENSE"));
await cp(path.join(pluginRoot, "THIRD_PARTY_NOTICES.md"), path.join(claudeRoot, "THIRD_PARTY_NOTICES.md"));
await cp(path.join(pluginRoot, "build-manifest.json"), path.join(claudeRoot, "build-manifest.json"));
await writeFile(path.join(claudeRoot, ".claude-plugin", "plugin.json"), json({
  name: meta.name,
  displayName: meta.displayName,
  version: meta.version,
  description: meta.description,
  author: meta.author,
  homepage: meta.homepage,
  repository: meta.repository,
  license: meta.license,
  keywords: meta.keywords,
  skills: "./skills/",
  mcpServers: "./.mcp.json",
  defaultEnabled: true,
  userConfig: {
    node_path: {
      type: "string",
      title: "Node.js 24+ executable",
      description: "Executable used for the durable broker. Leave as node when Node 24+ is on PATH.",
      default: "node"
    }
  }
}));
await writeFile(path.join(claudeRoot, ".mcp.json"), json({
  mcpServers: {
    "oracle-firefox": {
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs"],
      env: {
        ORACLE_FIREFOX_NODE_PATH: "${user_config.node_path}",
        ORACLE_FIREFOX_HARNESS: "claude-code-mcp"
      }
    }
  }
}));

await mkdir(path.join(repositoryRoot, ".claude-plugin"), { recursive: true });
await writeFile(path.join(repositoryRoot, ".claude-plugin", "marketplace.json"), json({
  name: "nikokuma-oracle",
  owner: { name: "nikokuma" },
  description: "Local-browser Oracle plugins by nikokuma.",
  plugins: [{
    name: meta.name,
    source: "./plugins/oracle-firefox-claude",
    displayName: meta.displayName,
    description: meta.description,
    version: meta.version,
    author: meta.author,
    homepage: meta.homepage,
    repository: meta.repository,
    license: meta.license,
    keywords: meta.keywords,
    category: "developer-tools"
  }]
}));

await rm(mcpbRoot, { recursive: true, force: true });
await mkdir(path.join(mcpbRoot, "server"), { recursive: true });
await cp(path.join(pluginRoot, "dist", "server.mjs"), path.join(mcpbRoot, "server", "server.mjs"));
await cp(path.join(pluginRoot, "dist", "broker.mjs"), path.join(mcpbRoot, "server", "broker.mjs"));
for (const name of ["server.mjs.LEGAL.txt", "broker.mjs.LEGAL.txt"]) {
  await cp(path.join(pluginRoot, "dist", name), path.join(mcpbRoot, "server", name)).catch(() => undefined);
}
await cp(path.join(pluginRoot, "LICENSE"), path.join(mcpbRoot, "LICENSE"));
await cp(path.join(pluginRoot, "THIRD_PARTY_NOTICES.md"), path.join(mcpbRoot, "THIRD_PARTY_NOTICES.md"));
await cp(path.join(pluginRoot, "build-manifest.json"), path.join(mcpbRoot, "build-manifest.json"));
await writeFile(path.join(mcpbRoot, "manifest.json"), json({
  manifest_version: "0.3",
  name: meta.name,
  display_name: meta.displayName,
  version: meta.version,
  description: meta.description,
  long_description: `${meta.longDescription}\n\nThe bundle never contains login cookies. Firefox and Chrome use separate dedicated local profiles; Safari uses an isolated automation session.`,
  author: meta.author,
  repository: { type: "git", url: `${meta.repository}.git` },
  homepage: meta.homepage,
  documentation: meta.homepage,
  support: `${meta.repository}/issues`,
  server: {
    type: "node",
    entry_point: "server/server.mjs",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/server.mjs"],
      env: {
        ORACLE_FIREFOX_NODE_PATH: "${user_config.node_path}",
        ORACLE_FIREFOX_HARNESS: "claude-desktop-mcp"
      }
    }
  },
  tools: meta.tools,
  tools_generated: false,
  prompts: [{
    name: "consult-chatgpt-pro",
    description: "Ask ChatGPT Pro for a durable second opinion through the selected browser.",
    arguments: ["question"],
    text: "Use consult_start with a new UUID, monitor the returned job, and independently verify the answer: ${arguments.question}"
  }],
  keywords: meta.keywords,
  license: meta.license,
  privacy_policies: ["https://openai.com/policies/privacy-policy/"],
  compatibility: {
    claude_desktop: ">=1.0.0",
    platforms: ["darwin"],
    runtimes: { node: ">=18.0.0" }
  },
  user_config: {
    node_path: {
      type: "string",
      title: "Node.js 24+ executable",
      description: "Path or command for a Node.js 24+ runtime used by the durable broker.",
      default: "node",
      required: true
    }
  }
}));

await mkdir(path.join(pluginRoot, "releases"), { recursive: true });
await chmod(path.join(claudeRoot, "dist", "oracle-claudex.mjs"), 0o755).catch(() => undefined);
