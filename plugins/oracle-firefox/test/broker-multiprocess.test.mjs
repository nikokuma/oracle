import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("20 simultaneous clients converge on one broker", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-broker-test-"));
  const endpoint = path.join(root, "broker.sock");
  const env = {
    ...process.env,
    ORACLE_FIREFOX_HOME: path.join(root, "home"),
    ORACLE_FIREFOX_COORDINATOR_HOME: path.join(root, "coordinator"),
    ORACLE_FIREFOX_BROKER_ENDPOINT: endpoint,
  };
  const clientUrl = new URL("../src/broker-client.mjs", import.meta.url).href;
  const script = `import { callBroker } from ${JSON.stringify(clientUrl)}; console.log(JSON.stringify(await callBroker('broker.status', {}, { timeoutMs: 15000, harness: 'test' })));`;
  let pid = null;
  try {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => execFileAsync(process.execPath, ["--input-type=module", "-e", script], { env, timeout: 20_000 })),
    );
    const statuses = responses.map(({ stdout }) => JSON.parse(stdout));
    const pids = new Set(statuses.map((status) => status.browser?.pid || status.pid).filter(Boolean));
    const statusScript = `import { rpcRequest } from ${JSON.stringify(new URL("../src/protocol.mjs", import.meta.url).href)}; import { readOrCreateBrokerToken } from ${JSON.stringify(clientUrl)}; console.log(JSON.stringify(await rpcRequest(process.env.ORACLE_FIREFOX_BROKER_ENDPOINT, await readOrCreateBrokerToken(), 'broker.status')));`;
    const status = JSON.parse((await execFileAsync(process.execPath, ["--input-type=module", "-e", statusScript], { env })).stdout);
    pid = status.pid;
    assert.ok(pid > 0);
    assert.equal(status.queuedJobs, 0);
    assert.ok(pids.size <= 1);
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await rm(root, { recursive: true, force: true });
  }
});
