import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mintCapability } from "../src/capabilities.mjs";
import { StateStore } from "../src/state-store.mjs";

async function withStore(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-coordination-"));
  const databasePath = path.join(directory, "state.sqlite");
  const store = await new StateStore(databasePath).open();
  try {
    return await callback(store, databasePath);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function authenticate(store, session, harness) {
  return store.authenticateOwnerSession({
    sessionId: session.sessionId,
    sessionHandle: session.sessionHandle,
    harness,
  });
}

function ownedJob(store, caller, overrides = {}) {
  const id = crypto.randomUUID();
  const read = mintCapability("read", id);
  const control = mintCapability("control", id);
  const subscriptionId = crypto.randomUUID();
  const subscription = mintCapability("subscription", subscriptionId);
  const created = store.createJob({
    id,
    authorizationId: crypto.randomUUID(),
    operation: "continue_chat",
    request: { completionMode: "harness", responseTimeoutSeconds: 300 },
    conversationKey: "https://chatgpt.com/c/owned",
    conversationUrl: "https://chatgpt.com/c/owned",
    sessionPath: "/tmp/owned-session",
    ownerSessionId: caller.id,
    readCapabilityHash: read.hash,
    controlCapabilityHash: control.hash,
    subscriptionId,
    subscriptionCapabilityHash: subscription.hash,
    completionMode: "harness",
    ...overrides,
  });
  return { ...created, read, control, subscription };
}

test("capability-owned chains hide foreign UUIDs and permit explicit resume", async () => {
  await withStore(async (store) => {
    const aSession = store.createOwnerSession({ harness: "codex" });
    const bSession = store.createOwnerSession({ harness: "claude" });
    const a = authenticate(store, aSession, "codex");
    const b = authenticate(store, bSession, "claude");
    const owned = ownedJob(store, a);

    assert.equal(store.authorizeJob({ jobId: owned.job.id, caller: a }).job.id, owned.job.id);
    assert.throws(
      () => store.authorizeJob({ jobId: owned.job.id, caller: b }),
      (error) => error.code === "JOB_NOT_FOUND",
    );
    assert.throws(
      () => store.authorizeJob({ jobId: owned.job.id, jobHandle: owned.read.handle, caller: b, control: true }),
      (error) => error.code === "JOB_NOT_FOUND",
    );
    assert.equal(
      store.authorizeJob({ jobId: owned.job.id, jobHandle: owned.control.handle, caller: b, control: true }).job.id,
      owned.job.id,
    );
    assert.equal(store.authorizeJob({ jobId: owned.job.id, caller: b, control: true }).job.id, owned.job.id);
    assert.deepEqual(store.listJobsForSession(a.id).map((job) => job.id), [owned.job.id]);
    assert.deepEqual(store.listJobsForSession(b.id).map((job) => job.id), [owned.job.id]);
  });
});

test("evidence and recovery attempts inherit one root, owner, lane ticket, and completion policy", async () => {
  await withStore(async (store) => {
    const session = store.createOwnerSession({ harness: "codex" });
    const caller = authenticate(store, session, "codex");
    const root = ownedJob(store, caller);
    store.transition(root.job.id, "completed", {
      assistantDisposition: "local_data_request",
      localDataRequest: { safeReadOnly: true, requests: [{ id: "one" }] },
      result: { answer: "request" },
    });
    const rootChain = store.getChain(root.job.chainId);
    assert.equal(rootChain.state, "input_required");

    const child = store.createJob({
      authorizationId: crypto.randomUUID(),
      operation: "continue_chat",
      request: { completionMode: "harness" },
      conversationKey: root.job.conversationKey,
      conversationUrl: root.job.conversationUrl,
      sessionPath: "/tmp/evidence-child",
      parentJobId: root.job.id,
      rootJobId: crypto.randomUUID(),
      ownerSessionId: caller.id,
      evidenceRound: 1,
      attemptKind: "evidence_reply",
    }).job;

    assert.equal(child.chainId, root.job.chainId);
    assert.equal(child.rootJobId, root.job.id);
    assert.equal(child.attemptKind, "evidence_reply");
    assert.equal(store.getChain(child.chainId).originSessionId, caller.id);
    assert.equal(store.getChain(child.chainId).acceptedSequence, rootChain.acceptedSequence);
    assert.equal(store.getChain(child.chainId).completionMode, "harness");
    assert.deepEqual(store.jobChain(root.job.id).map((job) => job.id), [root.job.id, child.id]);
  });
});

test("completion outbox is exact-subscription, claimable, delivered, and acknowledged without answer data", async () => {
  await withStore(async (store) => {
    const session = store.createOwnerSession({ harness: "codex" });
    const caller = authenticate(store, session, "codex");
    const owned = ownedJob(store, caller);
    store.transition(owned.job.id, "completed", { result: { answer: "private answer" } });

    const claimed = store.claimCompletion(owned.subscription.handle, caller);
    assert.equal(claimed.chainId, owned.job.chainId);
    assert.equal(claimed.state, "completed");
    assert.equal(claimed.deliveryState, "claimed");
    assert.equal(JSON.stringify(claimed).includes("private answer"), false);
    assert.deepEqual(
      store.markCompletionDelivered(owned.subscription.handle, caller, claimed.deliveryId, claimed.claimId),
      { deliveryId: claimed.deliveryId, delivered: true, acknowledged: false },
    );
    assert.deepEqual(
      store.acknowledgeCompletion(owned.subscription.handle, caller, claimed.deliveryId),
      { deliveryId: claimed.deliveryId, delivered: true, acknowledged: true },
    );
    assert.equal(store.claimCompletion(owned.subscription.handle, caller), null);
  });
});

test("durable account cooldown invalidates open permits across database reopen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-account-gate-"));
  const databasePath = path.join(directory, "state.sqlite");
  let store = await new StateStore(databasePath).open();
  try {
    const job = store.createJob({
      authorizationId: crypto.randomUUID(),
      operation: "consult",
      request: {},
      conversationKey: "new-standalone",
      sessionPath: "/tmp/cooldown",
    }).job;
    const permit = store.issueSubmitPermit(job.id, { minimumIntervalMs: 1 });
    const cooldown = store.recordAccountCooldown({ code: "ACCOUNT_COOLDOWN" }, { minimumMs: 60_000 });
    assert.ok(Date.parse(cooldown.cooldownUntil) > Date.now());
    assert.equal(cooldown.effectiveConcurrency, 0);
    assert.throws(
      () => store.consumeSubmitPermit(job.id, permit.id),
      (error) => error.code === "SUBMIT_PERMIT_INVALID",
    );
    store.close();
    store = await new StateStore(databasePath).open();
    assert.equal(store.accountState().cooldownCode, "ACCOUNT_COOLDOWN");
    assert.throws(
      () => store.issueSubmitPermit(job.id),
      (error) => error.code === "ACCOUNT_COOLDOWN",
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a logical child retains the lane ahead of a later external same-chat chain", async () => {
  await withStore(async (store) => {
    const root = store.createJob({
      authorizationId: crypto.randomUUID(), operation: "continue_chat", request: {},
      conversationKey: "https://chatgpt.com/c/fifo", sessionPath: "/tmp/root",
    }).job;
    store.transition(root.id, "completed", { result: { answer: "needs evidence" } });
    const external = store.createJob({
      authorizationId: crypto.randomUUID(), operation: "continue_chat", request: {},
      conversationKey: root.conversationKey, sessionPath: "/tmp/external",
    }).job;
    store.transition(external.id, "snapshotted");
    store.transition(external.id, "queued");
    const child = store.createJob({
      authorizationId: crypto.randomUUID(), operation: "continue_chat", request: {},
      conversationKey: root.conversationKey, sessionPath: "/tmp/child", parentJobId: root.id,
    }).job;
    store.transition(child.id, "snapshotted");
    store.transition(child.id, "queued");
    assert.equal(store.isRunnable(child.id), true);
    assert.equal(store.isRunnable(external.id), false);
  });
});

test("migration repairs unambiguous historical evidence roots without inventing capabilities", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-legacy-migration-"));
  const databasePath = path.join(directory, "state.sqlite");
  let store = await new StateStore(databasePath).open();
  try {
    const root = store.createJob({
      authorizationId: crypto.randomUUID(), operation: "continue_chat",
      request: { completionMode: "harness" }, conversationKey: "https://chatgpt.com/c/legacy",
      sessionPath: "/tmp/legacy-root",
    }).job;
    const child = store.createJob({
      authorizationId: crypto.randomUUID(), operation: "continue_chat",
      request: { completionMode: "manual" }, conversationKey: root.conversationKey,
      sessionPath: "/tmp/legacy-child", parentJobId: root.id, rootJobId: root.id,
      evidenceRound: 1,
    }).job;
    store.transition(root.id, "completed", { result: { answer: "local data requested" } });
    store.transition(child.id, "snapshotted");
    store.transition(child.id, "queued");
    store.close();

    const db = new DatabaseSync(databasePath);
    const broker = db.prepare("SELECT current_instance_id, current_lease_generation FROM broker_state WHERE id=1").get();
    db.function("oracle_writer_protocol", () => 7);
    db.function("oracle_broker_instance", () => broker.current_instance_id);
    db.function("oracle_lease_generation", () => broker.current_lease_generation);
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
    const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'oracle_%'").all();
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
    db.prepare("UPDATE jobs SET root_job_id = id WHERE id = ?").run(child.id);
    db.exec(`
      DELETE FROM completion_deliveries;
      DELETE FROM completion_subscriptions;
      DELETE FROM chain_events;
      DELETE FROM chain_session_grants;
      DELETE FROM job_attempts;
      DELETE FROM job_chains;
      DELETE FROM owner_sessions;
      DELETE FROM broker_instances;
      DELETE FROM broker_state;
      DELETE FROM schema_migrations WHERE version >= 4;
      COMMIT;
    `);
    db.close();

    store = await new StateStore(databasePath).open();
    const migrated = store.requireJob(child.id);
    const chain = store.getChain(migrated.chainId);
    assert.equal(migrated.rootJobId, root.id, "unambiguous historical lineage is repaired");
    assert.equal(chain.rootJobId, root.id, "logical root is reconstructed from the parent edge");
    assert.equal(chain.completionMode, "harness", "root completion policy wins");
    assert.equal(chain.legacyMode, "unclaimed");
    assert.equal(store.chainAccessRow(chain.id).read_cap_hash, null);
    assert.deepEqual(store.jobChain(root.id).map((job) => job.id), [root.id, child.id]);
    assert.equal(store.checkInvariants().ok, true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a running execution cannot be reclaimed by a second scheduler", async () => {
  await withStore(async (store) => {
    const job = store.createJob({
      authorizationId: crypto.randomUUID(), operation: "continue_chat", request: {},
      conversationKey: "https://chatgpt.com/c/epoch", sessionPath: "/tmp/epoch",
    }).job;
    store.transition(job.id, "snapshotted");
    store.transition(job.id, "queued");
    const first = store.beginExecution(job.id);
    assert.equal(store.assertExecution(first), true);
    const second = store.beginExecution(job.id);
    assert.equal(second, null);
    assert.equal(store.assertExecution(first), true);
  });
});
