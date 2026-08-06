import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("protocol upgrades wait for the expected broker instance to release ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-broker-release-"));
  const endpoint = path.join(root, "broker.sock");
  const { waitForBrokerRelease } = await import("../src/broker-client.mjs");
  const startedAt = Date.now();
  let released = false;
  setTimeout(() => { released = true; }, 75);
  try {
    const observed = await waitForBrokerRelease("test-token", {
      identity: { endpoint },
      expectedInstanceId: "old-instance",
      timeoutMs: 2_000,
      probe: async () => released
        ? { kind: "absent" }
        : { kind: "live", hello: { instanceId: "old-instance" } },
    });
    assert.equal(observed, true);
    assert.ok(Date.now() - startedAt >= 70);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    const downgradeScript = `import { rpcRequest } from ${JSON.stringify(new URL("../src/protocol.mjs", import.meta.url).href)}; import { readOrCreateBrokerToken } from ${JSON.stringify(clientUrl)}; console.log(JSON.stringify(await rpcRequest(process.env.ORACLE_FIREFOX_BROKER_ENDPOINT, await readOrCreateBrokerToken(), 'broker.requestUpgrade', { requesterReleaseSequence: 1401 })));`;
    const downgrade = JSON.parse((await execFileAsync(process.execPath, ["--input-type=module", "-e", downgradeScript], { env })).stdout);
    assert.equal(downgrade.accepted, false);
    assert.equal(downgrade.code, "BROKER_DOWNGRADE_FORBIDDEN");
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("different harness TMPDIR values still converge on one canonical broker", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-broker-tmpdir-test-"));
  const runtimeRoot = await mkdtemp("/tmp/oracle-runtime-test-");
  const common = {
    ...process.env,
    ORACLE_FIREFOX_HOME: path.join(root, "home"),
    ORACLE_FIREFOX_COORDINATOR_HOME: path.join(root, "coordinator"),
    ORACLE_FIREFOX_RUNTIME_ROOT: runtimeRoot,
    ORACLE_FIREFOX_DISABLE_LEGACY_DISCOVERY: "1",
  };
  delete common.ORACLE_FIREFOX_BROKER_ENDPOINT;
  const clientUrl = new URL("../src/broker-client.mjs", import.meta.url).href;
  const identityUrl = new URL("../src/coordinator-identity.mjs", import.meta.url).href;
  const identityScript = `import { resolveCoordinatorIdentity } from ${JSON.stringify(identityUrl)}; const value = await resolveCoordinatorIdentity(); console.log(JSON.stringify({ coordinatorId: value.coordinatorId, endpoint: value.endpoint }));`;
  const script = `import { callBroker } from ${JSON.stringify(clientUrl)}; console.log(JSON.stringify(await callBroker('broker.status', {}, { timeoutMs: 15000, harness: 'tmpdir-test' })));`;
  let pid = null;
  try {
    const identities = await Promise.all(Array.from({ length: 12 }, (_, index) => execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", identityScript],
      { env: { ...common, TMPDIR: path.join(root, `identity-tmp-${index}`) }, timeout: 20_000 },
    )));
    const resolved = identities.map(({ stdout }) => JSON.parse(stdout));
    assert.equal(new Set(resolved.map((value) => value.coordinatorId)).size, 1);
    assert.equal(new Set(resolved.map((value) => value.endpoint)).size, 1);
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env: { ...common, TMPDIR: path.join(root, `tmp-${index}`) }, timeout: 20_000 },
    )));
    const statuses = responses.map(({ stdout }) => JSON.parse(stdout));
    pid = statuses[0].pid;
    assert.equal(new Set(statuses.map((status) => status.pid)).size, 1);
    assert.equal(new Set(statuses.map((status) => status.coordinatorId)).size, 1);
    assert.equal(new Set(statuses.map((status) => status.brokerInstanceId)).size, 1);
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a strictly newer release request drains and releases the exact idle broker", { timeout: 40_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-broker-upgrade-test-"));
  const endpoint = path.join(root, "broker.sock");
  const env = {
    ...process.env,
    ORACLE_FIREFOX_HOME: path.join(root, "home"),
    ORACLE_FIREFOX_COORDINATOR_HOME: path.join(root, "coordinator"),
    ORACLE_FIREFOX_BROKER_ENDPOINT: endpoint,
  };
  const clientUrl = new URL("../src/broker-client.mjs", import.meta.url).href;
  const protocolUrl = new URL("../src/protocol.mjs", import.meta.url).href;
  const identityUrl = new URL("../src/coordinator-identity.mjs", import.meta.url).href;
  const script = `
    import { callBroker, readOrCreateBrokerToken, waitForBrokerRelease } from ${JSON.stringify(clientUrl)};
    import { rpcRequest } from ${JSON.stringify(protocolUrl)};
    import { resolveCoordinatorIdentity } from ${JSON.stringify(identityUrl)};
    const status = await callBroker('broker.status', {}, { harness: 'upgrade-test' });
    const token = await readOrCreateBrokerToken();
    const identity = await resolveCoordinatorIdentity();
    const upgrade = await rpcRequest(identity.endpoint, token, 'broker.requestUpgrade', {
      expectedInstanceId: status.brokerInstanceId,
      expectedLeaseGeneration: status.leaseGeneration,
      requesterReleaseSequence: 1700,
      requesterBuildId: 'upgrade-fixture'
    });
    const released = await waitForBrokerRelease(token, {
      identity, expectedInstanceId: status.brokerInstanceId, timeoutMs: 20000
    });
    console.log(JSON.stringify({ status, upgrade, released }));
  `;
  let pid = null;
  try {
    const value = JSON.parse((await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      env,
      timeout: 30_000,
    })).stdout);
    pid = value.status.pid;
    assert.equal(value.upgrade.accepted, true);
    assert.equal(value.released, true);
    assert.equal(value.upgrade.state, "draining");
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("independent harness sessions cannot read a foreign job UUID but can explicitly resume by capability", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-broker-owner-test-"));
  const endpoint = path.join(root, "broker.sock");
  const env = {
    ...process.env,
    ORACLE_FIREFOX_HOME: path.join(root, "home"),
    ORACLE_FIREFOX_COORDINATOR_HOME: path.join(root, "coordinator"),
    ORACLE_FIREFOX_BROKER_ENDPOINT: endpoint,
    ORACLE_FIREFOX_PATH: path.join(root, "missing-firefox"),
    ORACLE_FIREFOX_LEGACY_COMPLETION_FILES: "0",
  };
  const clientUrl = new URL("../src/broker-client.mjs", import.meta.url).href;
  const script = `
    import { randomUUID } from 'node:crypto';
    import { callBroker } from ${JSON.stringify(clientUrl)};
    const receipt = await callBroker('jobs.startConsult', {
      authorizationId: randomUUID(), prompt: 'fixture only', files: [],
      responseTimeoutSeconds: 30, attachmentTimeoutSeconds: 30,
      modelRequirement: 'current', maxAutomaticEvidenceReplies: 0,
      responseFailurePolicy: 'report', completionMode: 'harness', headless: true
    }, { harness: 'codex-test' });
    let foreignCode = null;
    try { await callBroker('jobs.status', { jobId: receipt.jobId }, { harness: 'claude-test' }); }
    catch (error) { foreignCode = error.code; }
    const resumed = await callBroker('jobs.status', {
      jobId: receipt.jobId, jobHandle: receipt.jobHandle
    }, { harness: 'claude-test' });
    const listed = await callBroker('jobs.list', {}, { harness: 'claude-test' });
    const broker = await callBroker('broker.status', {}, { harness: 'claude-test' });
    console.log(JSON.stringify({ receipt, foreignCode, resumed, listed, broker }));
  `;
  let pid = null;
  try {
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { env, timeout: 20_000 });
    const value = JSON.parse(stdout);
    pid = value.broker.pid;
    assert.equal(value.foreignCode, "JOB_NOT_FOUND");
    assert.equal(value.resumed.jobId, value.receipt.jobId);
    assert.equal(value.listed.jobs.some((job) => job.jobId === value.receipt.jobId), true);
    assert.match(value.receipt.jobHandle, /^ofx1\.control\./u);
    assert.match(value.receipt.completionHandle, /^ofx1\.subscription\./u);
    assert.equal(JSON.stringify(value.broker).includes(value.receipt.jobId), false, "broker status must not expose active job ids");
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await rm(root, { recursive: true, force: true });
  }
});
