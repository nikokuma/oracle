import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("bundled MCP initializes, lists the durable API, and performs doctor", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-mcp-test-"));
  const env = {
    ...process.env,
    ORACLE_FIREFOX_HOME: path.join(root, "home"),
    ORACLE_FIREFOX_COORDINATOR_HOME: path.join(root, "coordinator"),
    ORACLE_FIREFOX_BROKER_ENDPOINT: path.join(root, "broker.sock"),
  };
  const client = new Client({ name: "oracle-firefox-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/server.mjs")],
    env,
  });
  let brokerPid = null;
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    for (const required of [
      "consult_start",
      "continue_chat_start",
      "job_status",
      "job_wait",
      "job_result",
      "list_jobs",
      "reconcile_job",
      "acknowledge_uncertain",
      "cancel_job",
      "broker_status",
      "reply_with_local_data",
    ]) assert.equal(names.has(required), true, `missing MCP tool ${required}`);
    const status = await client.callTool({ name: "broker_status", arguments: {} });
    brokerPid = status.structuredContent.pid;
    assert.equal(status.structuredContent.ready, true);
    const doctor = await client.callTool({ name: "doctor", arguments: {} });
    assert.equal(typeof doctor.structuredContent.profileDirectory, "string");
  } finally {
    await client.close().catch(() => undefined);
    if (brokerPid) {
      try { process.kill(brokerPid, "SIGTERM"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await rm(root, { recursive: true, force: true });
  }
});
