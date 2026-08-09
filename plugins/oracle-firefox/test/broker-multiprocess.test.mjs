import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  BROKER_BUILD_ID,
  BROKER_BUILD_VERSION,
  BROKER_PROTOCOL_VERSION,
  BROKER_RELEASE_SEQUENCE,
  createFrameDecoder,
  encodeFrame,
} from "../src/protocol.mjs";

const execFileAsync = promisify(execFile);

async function startFakeBroker(root, handleRequest) {
  const endpoint = path.join(root, "b.sock");
  const coordinatorHome = path.join(root, "coordinator");
  const token = "a".repeat(64);
  await mkdir(coordinatorHome, { recursive: true, mode: 0o700 });
  await writeFile(path.join(coordinatorHome, "broker.token"), `${token}\n`, { mode: 0o600 });
  const hello = {
    coordinatorId: "fixture-coordinator",
    instanceId: "fixture-instance",
    brokerInstanceId: "fixture-instance",
    leaseGeneration: 1,
    state: "ready",
    protocol: { minimum: BROKER_PROTOCOL_VERSION, maximum: BROKER_PROTOCOL_VERSION },
    releaseSequence: BROKER_RELEASE_SEQUENCE,
    buildVersion: BROKER_BUILD_VERSION,
    buildId: BROKER_BUILD_ID,
  };
  const sockets = new Set();
  const errors = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const decoder = createFrameDecoder((request) => {
      void Promise.resolve().then(async () => {
        let outcome;
        if (request.method === "broker.hello") {
          outcome = { result: hello };
        } else if (request.method === "broker.openSession") {
          outcome = {
            result: {
              sessionId: request.params.stableSessionId,
              sessionHandle: request.params.stableSessionHandle,
            },
          };
        } else {
          outcome = await handleRequest(request);
        }
        if (outcome?.disconnect) {
          socket.destroy();
          return;
        }
        socket.end(encodeFrame({
          id: request.id,
          ok: !outcome?.error,
          ...(outcome?.error ? { error: outcome.error } : { result: outcome?.result }),
          server: hello,
        }));
      }).catch((error) => {
        errors.push(error);
        socket.destroy();
      });
    }, (error) => {
      errors.push(error);
      socket.destroy();
    });
    socket.on("data", decoder);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  return {
    coordinatorHome,
    endpoint,
    errors,
    env: {
      ...process.env,
      ORACLE_FIREFOX_HOME: path.join(root, "home"),
      ORACLE_FIREFOX_COORDINATOR_HOME: coordinatorHome,
      ORACLE_FIREFOX_BROKER_ENDPOINT: endpoint,
      ORACLE_FIREFOX_DISABLE_LEGACY_DISCOVERY: "1",
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function receiptPaths(coordinatorHome) {
  return readdir(path.join(coordinatorHome, "pending-start-receipts"), { recursive: true })
    .catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
}

test("CLI publishes version, session attention, and start-receipt recovery", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-cli-public-api-"));
  const authorizationId = crypto.randomUUID();
  const digest = "d".repeat(64);
  const recoveryHandle = "receipt-fixture-handle";
  const requests = [];
  const broker = await startFakeBroker(root, (request) => {
    requests.push({ method: request.method, params: request.params });
    if (request.method === "jobs.listAttention") return { result: { attention: [] } };
    if (request.method === "jobs.recoverStartReceipt") {
      return {
        result: {
          authorizationId,
          requestDigest: digest,
          receiptRecoveryHandle: recoveryHandle,
          receiptState: "recovered",
        },
      };
    }
    throw new Error(`Unexpected fixture method: ${request.method}`);
  });
  const cliPath = path.resolve("src/cli.mjs");
  try {
    const version = JSON.parse((await execFileAsync(process.execPath, [cliPath, "version"], {
      env: broker.env,
      timeout: 10_000,
    })).stdout);
    assert.deepEqual(version, { version: "1.7.0" });

    const attention = JSON.parse((await execFileAsync(process.execPath, [cliPath, "list-attention"], {
      env: broker.env,
      timeout: 10_000,
    })).stdout);
    assert.deepEqual(attention, { attention: [] });

    const recovered = JSON.parse((await execFileAsync(process.execPath, [
      cliPath,
      "recover-start-receipt",
      "--authorization-id", authorizationId,
      "--request-digest", digest,
      "--receipt-recovery-handle", recoveryHandle,
    ], {
      env: broker.env,
      timeout: 10_000,
    })).stdout);
    assert.equal(recovered.receiptState, "recovered");
    assert.equal(recovered.receiptRecoveryHandle, recoveryHandle);
    assert.deepEqual(requests, [
      { method: "jobs.listAttention", params: {} },
      {
        method: "jobs.recoverStartReceipt",
        params: { authorizationId, requestDigest: digest, recoveryHandle },
      },
    ]);
    assert.deepEqual(broker.errors, []);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
      requesterReleaseSequence: ${BROKER_RELEASE_SEQUENCE + 1},
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
    const failureEvidence = value.released ? "" : await Promise.all([
      readFile(path.join(root, "coordinator", "broker.log"), "utf8").catch((error) => `log unavailable: ${error.message}`),
      readFile(path.join(root, "coordinator", "broker.locator.json"), "utf8").catch((error) => `locator unavailable: ${error.message}`),
    ]).then(([log, locator]) => `\nBroker log:\n${log}\nLocator:\n${locator}`);
    assert.equal(value.released, true, failureEvidence);
    assert.equal(value.upgrade.state, "draining");
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("broker clients isolate no-hint processes while a real host hint resumes exactly one owner", { timeout: 40_000 }, async () => {
  const root = await mkdtemp("/tmp/ofx-owner-");
  const endpoint = path.join(root, "broker.sock");
  const coordinatorHome = path.join(root, "coordinator");
  const env = {
    ...process.env,
    ORACLE_FIREFOX_HOME: path.join(root, "home"),
    ORACLE_FIREFOX_COORDINATOR_HOME: coordinatorHome,
    ORACLE_FIREFOX_BROKER_ENDPOINT: endpoint,
    ORACLE_FIREFOX_PATH: path.join(root, "missing-firefox"),
    ORACLE_FIREFOX_LEGACY_COMPLETION_FILES: "0",
  };
  const clientUrl = new URL("../src/broker-client.mjs", import.meta.url).href;
  const startInput = `{
    authorizationId: randomUUID(), prompt: 'fixture only', files: [],
    responseTimeoutSeconds: 30, attachmentTimeoutSeconds: 30,
    modelRequirement: 'current', maxAutomaticEvidenceReplies: 0,
    responseFailurePolicy: 'report', completionMode: 'harness', headless: true
  }`;
  const firstNoHintScript = `
    import { randomUUID } from 'node:crypto';
    import { callBroker } from ${JSON.stringify(clientUrl)};
    const options = { harness: 'owner-process-test' };
    const receipt = await callBroker('jobs.startConsult', ${startInput}, options);
    const listed = await callBroker('jobs.list', {}, options);
    console.log(JSON.stringify({ receipt, listed }));
  `;
  const secondNoHintScript = `
    import { randomUUID } from 'node:crypto';
    import { callBroker } from ${JSON.stringify(clientUrl)};
    const options = { harness: 'owner-process-test' };
    const receipt = await callBroker('jobs.startConsult', ${startInput}, options);
    const listed = await callBroker('jobs.list', {}, options);
    const codes = {};
    for (const method of ['jobs.status', 'jobs.cancel']) {
      try { await callBroker(method, { jobId: process.env.FOREIGN_JOB_ID }, options); }
      catch (error) { codes[method] = error.code; }
    }
    const broker = await callBroker('broker.status', {}, options);
    console.log(JSON.stringify({ receipt, listed, codes, broker }));
  `;
  const stableCreateScript = `
    import { randomUUID } from 'node:crypto';
    import { callBroker } from ${JSON.stringify(clientUrl)};
    const options = { harness: 'owner-process-test', hostSessionHint: 'real-host-task-42' };
    const receipt = await callBroker('jobs.startConsult', ${startInput}, options);
    console.log(JSON.stringify({ receipt }));
  `;
  const stableResumeScript = `
    import { callBroker } from ${JSON.stringify(clientUrl)};
    const options = { harness: 'owner-process-test', hostSessionHint: process.env.TEST_HOST_HINT };
    const listed = await callBroker('jobs.list', {}, options);
    let status = null;
    let statusCode = null;
    try { status = await callBroker('jobs.status', { jobId: process.env.TEST_JOB_ID }, options); }
    catch (error) { statusCode = error.code; }
    const broker = await callBroker('broker.status', {}, options);
    console.log(JSON.stringify({ listed, status, statusCode, broker }));
  `;
  let pid = null;
  try {
    const first = JSON.parse((await execFileAsync(process.execPath, ["--input-type=module", "-e", firstNoHintScript], {
      env,
      timeout: 20_000,
    })).stdout);
    assert.deepEqual(first.listed.jobs.map((job) => job.jobId), [first.receipt.jobId]);
    const durableBeforeHint = await readdir(path.join(coordinatorHome, "client-sessions")).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    assert.deepEqual(durableBeforeHint, [], "no-hint clients must not create a shared durable identity file");

    const second = JSON.parse((await execFileAsync(process.execPath, ["--input-type=module", "-e", secondNoHintScript], {
      env: { ...env, FOREIGN_JOB_ID: first.receipt.jobId },
      timeout: 20_000,
    })).stdout);
    pid = second.broker.pid;
    assert.deepEqual(second.listed.jobs.map((job) => job.jobId), [second.receipt.jobId]);
    assert.deepEqual(second.codes, {
      "jobs.status": "JOB_NOT_FOUND",
      "jobs.cancel": "JOB_NOT_FOUND",
    });

    const stableCreated = JSON.parse((await execFileAsync(process.execPath, ["--input-type=module", "-e", stableCreateScript], {
      env,
      timeout: 20_000,
    })).stdout);
    const stableResumed = JSON.parse((await execFileAsync(process.execPath, ["--input-type=module", "-e", stableResumeScript], {
      env: {
        ...env,
        TEST_HOST_HINT: "real-host-task-42",
        TEST_JOB_ID: stableCreated.receipt.jobId,
      },
      timeout: 20_000,
    })).stdout);
    assert.equal(stableResumed.status.jobId, stableCreated.receipt.jobId);
    assert.equal(stableResumed.statusCode, null);
    assert.deepEqual(stableResumed.listed.jobs.map((job) => job.jobId), [stableCreated.receipt.jobId]);

    const stableForeign = JSON.parse((await execFileAsync(process.execPath, ["--input-type=module", "-e", stableResumeScript], {
      env: {
        ...env,
        TEST_HOST_HINT: "real-host-task-foreign",
        TEST_JOB_ID: stableCreated.receipt.jobId,
      },
      timeout: 20_000,
    })).stdout);
    assert.equal(stableForeign.status, null);
    assert.equal(stableForeign.statusCode, "JOB_NOT_FOUND");
    assert.deepEqual(stableForeign.listed.jobs, []);
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("broker-client receipt recovery returns a committed start without resending it", { timeout: 20_000 }, async () => {
  const root = await mkdtemp("/tmp/ofx-receipt-commit-");
  const authorizationId = crypto.randomUUID();
  const committedJobId = crypto.randomUUID();
  let startCount = 0;
  let recoveryCount = 0;
  let recoveryHandle = null;
  const broker = await startFakeBroker(root, (request) => {
    if (request.method === "jobs.startConsult") {
      startCount += 1;
      assert.equal(request.params.authorizationId, authorizationId);
      assert.match(request.params._receiptRecoveryHandle, /^ofx1\.receipt\./u);
      recoveryHandle = request.params._receiptRecoveryHandle;
      return { disconnect: true };
    }
    if (request.method === "jobs.recoverStartReceipt") {
      recoveryCount += 1;
      assert.equal(request.params.authorizationId, authorizationId);
      assert.equal(request.params.recoveryHandle, recoveryHandle);
      return { result: { jobId: committedJobId, receiptRecovered: true } };
    }
    throw new Error(`Unexpected fixture method: ${request.method}`);
  });
  const clientUrl = new URL("../src/broker-client.mjs", import.meta.url).href;
  const script = `
    import { callBroker } from ${JSON.stringify(clientUrl)};
    const result = await callBroker('jobs.startConsult', {
      authorizationId: process.env.TEST_AUTHORIZATION_ID,
      prompt: 'receipt fixture', files: []
    }, {
      harness: 'receipt-test', hostSessionHint: 'receipt-host-session', timeoutMs: 1000
    });
    console.log(JSON.stringify(result));
  `;
  try {
    const result = JSON.parse((await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...broker.env, TEST_AUTHORIZATION_ID: authorizationId },
      timeout: 10_000,
    })).stdout);
    assert.equal(result.jobId, committedJobId);
    assert.equal(result.receiptRecovered, true);
    assert.equal(startCount, 1);
    assert.equal(recoveryCount, 1);
    assert.deepEqual((await receiptPaths(broker.coordinatorHome)).filter((entry) => entry.endsWith(".json")), []);
    assert.deepEqual(broker.errors, []);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker-client preserves an ambiguous receipt and never resends after inconclusive recovery", { timeout: 20_000 }, async () => {
  const root = await mkdtemp("/tmp/ofx-receipt-ambiguous-");
  const authorizationId = crypto.randomUUID();
  let startCount = 0;
  let recoveryCount = 0;
  const broker = await startFakeBroker(root, (request) => {
    if (request.method === "jobs.startConsult") {
      startCount += 1;
      return { disconnect: true };
    }
    if (request.method === "jobs.recoverStartReceipt") {
      recoveryCount += 1;
      if (recoveryCount === 1) return { disconnect: true };
      return {
        error: {
          code: "START_RECEIPT_NOT_FOUND",
          message: "No committed receipt is currently provable.",
          safeToRetry: false,
        },
      };
    }
    throw new Error(`Unexpected fixture method: ${request.method}`);
  });
  const clientUrl = new URL("../src/broker-client.mjs", import.meta.url).href;
  const script = `
    import { callBroker } from ${JSON.stringify(clientUrl)};
    try {
      await callBroker('jobs.startConsult', {
        authorizationId: process.env.TEST_AUTHORIZATION_ID,
        prompt: 'ambiguous receipt fixture', files: []
      }, {
        harness: 'receipt-test', hostSessionHint: 'ambiguous-host-session', timeoutMs: 1000
      });
      console.log(JSON.stringify({ ok: true }));
    } catch (error) {
      console.log(JSON.stringify({
        ok: false,
        code: error.code,
        submissionMayHaveOccurred: error.submissionMayHaveOccurred,
        recoveryAction: error.recoveryAction
      }));
    }
  `;
  const run = () => execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...broker.env, TEST_AUTHORIZATION_ID: authorizationId },
    timeout: 10_000,
  });
  try {
    const first = JSON.parse((await run()).stdout);
    assert.deepEqual(first, {
      ok: false,
      code: "RECEIPT_MAY_EXIST",
      submissionMayHaveOccurred: true,
      recoveryAction: "call recover_start_receipt with the preserved authorizationId, requestDigest, and receiptRecoveryHandle; do not create a new authorization",
    });
    assert.equal(startCount, 1);
    assert.equal(recoveryCount, 1);
    const firstPaths = await receiptPaths(broker.coordinatorHome);
    assert.equal(firstPaths.filter((entry) => entry.endsWith(".json")).length, 1);
    assert.equal(firstPaths.some((entry) => entry.includes(authorizationId)), false);

    const second = JSON.parse((await run()).stdout);
    assert.deepEqual(second, {
      ok: false,
      code: "RECEIPT_MAY_EXIST",
      submissionMayHaveOccurred: true,
      recoveryAction: "call recover_start_receipt with the preserved authorizationId, requestDigest, and receiptRecoveryHandle; do not create a new authorization",
    });
    assert.equal(startCount, 1, "an existing ambiguous receipt must never re-enter jobs.startConsult");
    assert.equal(recoveryCount, 2);
    const secondPaths = await receiptPaths(broker.coordinatorHome);
    assert.equal(secondPaths.filter((entry) => entry.endsWith(".json")).length, 1);
    assert.equal(secondPaths.some((entry) => entry.includes(authorizationId)), false);
    assert.deepEqual(broker.errors, []);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker-client removes a receipt after a definite pre-commit rejection", { timeout: 20_000 }, async () => {
  const root = await mkdtemp("/tmp/ofx-receipt-rejected-");
  const authorizationId = crypto.randomUUID();
  let startCount = 0;
  let recoveryCount = 0;
  const broker = await startFakeBroker(root, (request) => {
    if (request.method === "jobs.startConsult") {
      startCount += 1;
      return {
        error: {
          code: "TARGET_NOT_FOUND",
          message: "The exact fixture target does not exist.",
          safeToRetry: true,
          submissionMayHaveOccurred: false,
        },
      };
    }
    if (request.method === "jobs.recoverStartReceipt") recoveryCount += 1;
    throw new Error(`Unexpected fixture method: ${request.method}`);
  });
  const clientUrl = new URL("../src/broker-client.mjs", import.meta.url).href;
  const script = `
    import { callBroker } from ${JSON.stringify(clientUrl)};
    try {
      await callBroker('jobs.startConsult', {
        authorizationId: process.env.TEST_AUTHORIZATION_ID,
        prompt: 'rejected receipt fixture', files: []
      }, {
        harness: 'receipt-test', hostSessionHint: 'rejected-host-session', timeoutMs: 1000
      });
    } catch (error) {
      console.log(JSON.stringify({ code: error.code, submissionMayHaveOccurred: error.submissionMayHaveOccurred }));
    }
  `;
  try {
    const rejected = JSON.parse((await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...broker.env, TEST_AUTHORIZATION_ID: authorizationId },
      timeout: 10_000,
    })).stdout);
    assert.deepEqual(rejected, { code: "TARGET_NOT_FOUND", submissionMayHaveOccurred: false });
    assert.equal(startCount, 1);
    assert.equal(recoveryCount, 0);
    assert.deepEqual((await receiptPaths(broker.coordinatorHome)).filter((entry) => entry.endsWith(".json")), []);
    assert.deepEqual(broker.errors, []);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
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
    assert.match(value.receipt.receiptRecoveryHandle, /^ofx1\.receipt\./u);
    assert.match(value.receipt.requestDigest, /^[a-f0-9]{64}$/u);
    assert.equal(value.receipt.receiptState, "committed");
    assert.equal(JSON.stringify(value.broker).includes(value.receipt.jobId), false, "broker status must not expose active job ids");
  } finally {
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await rm(root, { recursive: true, force: true });
  }
});
