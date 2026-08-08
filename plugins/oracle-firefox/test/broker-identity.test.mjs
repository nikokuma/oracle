import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { BrokerLifetimeLease } from "../src/broker-lease.mjs";
import { resolveCoordinatorIdentity } from "../src/coordinator-identity.mjs";
import {
  BROKER_BUILD_ID,
  BROKER_PROTOCOL_VERSION,
  BROKER_RELEASE_SEQUENCE,
  ORACLE_FIREFOX_VERSION,
} from "../src/build-info.mjs";
import { StateStore } from "../src/state-store.mjs";

const ENV_KEYS = [
  "ORACLE_FIREFOX_HOME",
  "ORACLE_FIREFOX_COORDINATOR_HOME",
  "ORACLE_FIREFOX_RUNTIME_ROOT",
  "ORACLE_FIREFOX_BROKER_ENDPOINT",
  "TMPDIR",
];

async function withEnvironment(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-broker-identity-"));
  const runtimeRoot = process.platform === "win32" ? path.join(root, "runtime") : await mkdtemp("/tmp/oracle-identity-runtime-");
  const prior = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    delete process.env.ORACLE_FIREFOX_BROKER_ENDPOINT;
    process.env.ORACLE_FIREFOX_HOME = path.join(root, "home");
    process.env.ORACLE_FIREFOX_COORDINATOR_HOME = path.join(root, "coordinator");
    process.env.ORACLE_FIREFOX_RUNTIME_ROOT = runtimeRoot;
    return await callback(root);
  } finally {
    for (const key of ENV_KEYS) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
    await rm(root, { recursive: true, force: true });
    if (runtimeRoot !== path.join(root, "runtime")) {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }
}

function brokerContext(coordinatorId, instanceId = randomUUID()) {
  return {
    coordinatorId,
    instanceId,
    leaseGeneration: 0,
    protocolVersion: BROKER_PROTOCOL_VERSION,
    releaseSequence: BROKER_RELEASE_SEQUENCE,
    buildVersion: ORACLE_FIREFOX_VERSION,
    buildId: BROKER_BUILD_ID,
    pid: process.pid,
    processStartId: `fixture-${instanceId}`,
    endpoint: `fixture://${instanceId}`,
    endpointKind: "fixture",
    endpointDevice: null,
    endpointInode: null,
  };
}

function createQueuedJob(store, suffix = "one") {
  const job = store.createJob({
    authorizationId: randomUUID(),
    operation: "continue_chat",
    request: {},
    conversationKey: `https://chatgpt.com/c/${suffix}`,
    conversationUrl: `https://chatgpt.com/c/${suffix}`,
    sessionPath: `/tmp/${suffix}`,
  }).job;
  store.transition(job.id, "snapshotted");
  store.transition(job.id, "queued");
  return job;
}

test("canonical broker identity and endpoint do not depend on TMPDIR", async () => {
  await withEnvironment(async (root) => {
    process.env.TMPDIR = path.join(root, "tmp-a");
    const first = await resolveCoordinatorIdentity();
    process.env.TMPDIR = path.join(root, "tmp-b");
    const second = await resolveCoordinatorIdentity();
    assert.equal(second.coordinatorId, first.coordinatorId);
    assert.equal(second.profileId, first.profileId);
    assert.equal(second.endpoint, first.endpoint);
    assert.equal(second.runtimeDirectory, first.runtimeDirectory);
  });
});

test("a symlinked Firefox profile is rejected before identity or lease creation", async () => {
  await withEnvironment(async (root) => {
    const actual = path.join(root, "actual-profile");
    await mkdir(actual, { recursive: true });
    await mkdir(process.env.ORACLE_FIREFOX_HOME, { recursive: true });
    await symlink(actual, path.join(process.env.ORACLE_FIREFOX_HOME, "profile"));
    await assert.rejects(() => resolveCoordinatorIdentity(), (error) => error.code === "PROFILE_PATH_INVALID");
  });
});

test("an overlong Unix socket path fails clearly before broker startup", async () => {
  if (process.platform === "win32") return;
  await withEnvironment(async (root) => {
    process.env.ORACLE_FIREFOX_RUNTIME_ROOT = path.join(root, "a".repeat(90));
    await assert.rejects(() => resolveCoordinatorIdentity(), (error) => error.code === "BROKER_ENDPOINT_TOO_LONG");
  });
});

test("one profile lease blocks brokers using different coordinator homes", async () => {
  await withEnvironment(async (root) => {
    const sharedHome = process.env.ORACLE_FIREFOX_HOME;
    process.env.ORACLE_FIREFOX_COORDINATOR_HOME = path.join(root, "coordinator-a");
    const firstIdentity = await resolveCoordinatorIdentity();
    process.env.ORACLE_FIREFOX_COORDINATOR_HOME = path.join(root, "coordinator-b");
    process.env.ORACLE_FIREFOX_HOME = sharedHome;
    const secondIdentity = await resolveCoordinatorIdentity();
    const first = await BrokerLifetimeLease.acquire(firstIdentity);
    try {
      await assert.rejects(
        () => BrokerLifetimeLease.acquire(secondIdentity),
        (error) => error.code === "BROKER_LEASE_HELD" && error.details?.label === "Firefox profile",
      );
    } finally {
      first.release();
    }
  });
});

test("a lifetime lease detects replacement of its durable lease file", async () => {
  await withEnvironment(async (root) => {
    const identity = await resolveCoordinatorIdentity();
    const lease = await BrokerLifetimeLease.acquire(identity);
    const displaced = path.join(root, "displaced-lease.sqlite");
    try {
      await rename(identity.coordinatorLeasePath, displaced);
      await writeFile(identity.coordinatorLeasePath, "replacement", { mode: 0o600 });
      assert.throws(() => lease.assertHeld(), (error) => error.code === "BROKER_LEASE_LOST");
    } finally {
      lease.release();
    }
  });
});

test("coordinator identity mismatch fails closed before takeover", async () => {
  await withEnvironment(async (root) => {
    const databasePath = path.join(root, "coordinator.sqlite");
    const first = await new StateStore(databasePath, { brokerContext: brokerContext("coordinator-a") }).open();
    first.close();
    await assert.rejects(
      () => new StateStore(databasePath, { brokerContext: brokerContext("coordinator-b") }).open(),
      (error) => error.code === "COORDINATOR_ID_MISMATCH",
    );
  });
});

test("schema fencing rejects an old writer that does not register broker functions", async () => {
  await withEnvironment(async (root) => {
    const databasePath = path.join(root, "fenced.sqlite");
    const store = await new StateStore(databasePath).open();
    const job = createQueuedJob(store, "old-writer");
    store.close();
    const oldWriter = new DatabaseSync(databasePath);
    try {
      assert.throws(
        () => oldWriter.prepare("UPDATE jobs SET updated_at = updated_at WHERE id = ?").run(job.id),
        /oracle_writer_protocol|ORACLE_BROKER_FENCE/u,
      );
    } finally {
      oldWriter.close();
    }
  });
});

test("production migration backs up the untouched legacy schema before upgrading", async () => {
  await withEnvironment(async (root) => {
    const databasePath = path.join(root, "legacy.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
    `);
    legacy.close();
    const store = await new StateStore(databasePath, { brokerContext: brokerContext("migration-backup") }).open();
    store.close();
    const backupPath = `${databasePath}.pre-v7.bak`;
    assert.ok((await stat(backupPath)).size > 0);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT MAX(version) version FROM schema_migrations").get().version, 1);
      assert.equal(backup.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE name='broker_state'").get().count, 0);
    } finally {
      backup.close();
    }
  });
});

test("a schema-six successor takes ownership before touching fenced migration rows", async () => {
  await withEnvironment(async (root) => {
    const databasePath = path.join(root, "schema-six.sqlite");
    const coordinatorId = "schema-six-coordinator";
    const first = await new StateStore(databasePath, { brokerContext: brokerContext(coordinatorId) }).open();
    const job = createQueuedJob(first, "schema-six-upgrade");
    first.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (6, ?)")
      .run(new Date().toISOString());
    first.db.prepare("DELETE FROM schema_migrations WHERE version = 7").run();
    first.close();

    const successorContext = brokerContext(coordinatorId);
    const successor = await new StateStore(databasePath, { brokerContext: successorContext }).open();
    try {
      assert.equal(successor.db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version, 7);
      assert.equal(successor.requireJob(job.id).state, "queued");
      assert.equal(successorContext.leaseGeneration, 2);
      assert.equal(
        successor.db.prepare("SELECT current_instance_id FROM broker_state WHERE id = 1").get().current_instance_id,
        successorContext.instanceId,
      );
    } finally {
      successor.close();
    }
  });
});

test("a new broker generation fences stale execution claims and recovers only once", async () => {
  await withEnvironment(async (root) => {
    const databasePath = path.join(root, "generation.sqlite");
    const coordinatorId = "stable-coordinator";
    const first = await new StateStore(databasePath, { brokerContext: brokerContext(coordinatorId) }).open();
    const job = createQueuedJob(first, "generation");
    const staleClaim = first.claimRunnable(job.id);
    assert.ok(staleClaim);
    first.close();

    const second = await new StateStore(databasePath, { brokerContext: brokerContext(coordinatorId) }).open();
    try {
      assert.throws(() => second.assertExecution(staleClaim), (error) => error.code === "STALE_EXECUTION");
      assert.throws(
        () => second.transitionClaimed(staleClaim, "page_leased"),
        (error) => error.code === "STALE_EXECUTION",
      );
      assert.deepEqual(second.recoverInterruptedJobs().map((entry) => entry.action), ["requeued"]);
      assert.deepEqual(second.recoverInterruptedJobs(), []);
      assert.equal(second.requireJob(job.id).state, "queued");
    } finally {
      second.close();
    }
  });
});
