import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mintCapability } from "../src/capabilities.mjs";
import { Coordinator } from "../src/coordinator.mjs";
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

function makeResponseUncertain(store, job, messageHash = "submitted-hash") {
  for (const state of ["snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
    store.transition(job.id, state, state === "submit_intent"
      ? { submittedMessageHash: messageHash, attachmentManifest: [] }
      : {});
  }
  store.transition(job.id, "user_turn_confirmed", { userTurnId: "legacy-user-turn", userTurnHash: messageHash });
  store.transition(job.id, "awaiting_response");
  return store.markFailure(job.id, Object.assign(new Error("legacy response monitor ended"), { code: "RESPONSE_MONITOR_STALLED" }));
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

test("an exact fingerprint permits manual orphaned-quarantine acknowledgement without exposing the old job", async () => {
  await withStore(async (store) => {
    const ownerSession = store.createOwnerSession({ harness: "codex" });
    const recoverySession = store.createOwnerSession({ harness: "codex" });
    const owner = authenticate(store, ownerSession, "codex");
    const recovery = authenticate(store, recoverySession, "codex");
    const conversationUrl = "https://chatgpt.com/c/orphaned-ack";
    const owned = ownedJob(store, owner, { conversationKey: conversationUrl, conversationUrl });
    makeResponseUncertain(store, owned.job);

    assert.deepEqual(store.listJobsForSession(recovery.id), [], "the new task must not gain global job visibility");
    const view = store.quarantineView(conversationUrl);
    assert.equal(view.quarantined, true);
    assert.equal(view.conversationUrl, conversationUrl);
    assert.equal(view.canReconcileReadOnly, true);
    assert.equal("jobId" in view, false);
    assert.equal("sessionPath" in view, false);
    assert.throws(
      () => store.acknowledgeOrphanedQuarantine(conversationUrl, "0".repeat(64)),
      (error) => error.code === "QUARANTINE_CHANGED",
    );
    const acknowledged = store.acknowledgeOrphanedQuarantine(conversationUrl, view.fingerprint);
    assert.equal(acknowledged.acknowledged, true);
    assert.equal(acknowledged.messageSent, false);
    assert.equal(acknowledged.replacementAuthorized, false);
    assert.equal(store.quarantineView(conversationUrl).quarantined, false);
    assert.equal(store.listJobsForSession(recovery.id).length, 0, "acknowledgement alone must not adopt private history");
  });
});

test("orphaned acknowledgement requires both lost-capability and exact-chat manual-inspection confirmation", async () => {
  await withStore(async (store) => {
    const ownerSession = store.createOwnerSession({ harness: "codex" });
    const recoverySession = store.createOwnerSession({ harness: "codex" });
    const owner = authenticate(store, ownerSession, "codex");
    const recovery = authenticate(store, recoverySession, "codex");
    const conversationUrl = "https://chatgpt.com/c/orphaned-confirmation";
    const owned = ownedJob(store, owner, { conversationKey: conversationUrl, conversationUrl });
    makeResponseUncertain(store, owned.job);
    const inspected = store.quarantineView(conversationUrl);
    const coordinator = new Coordinator({ store, browserManager: { status: () => ({}) } });
    coordinator.callerFromContext = () => recovery;

    await assert.rejects(
      coordinator.recoverOrphanedQuarantine({
        conversationUrl,
        fingerprint: inspected.fingerprint,
        action: "acknowledge",
        confirmCapabilityUnavailable: false,
        confirmManualInspection: true,
      }, {}),
      (error) => error.code === "CAPABILITY_RECOVERY_CONFIRMATION_REQUIRED",
    );
    await assert.rejects(
      coordinator.recoverOrphanedQuarantine({
        conversationUrl,
        fingerprint: inspected.fingerprint,
        action: "acknowledge",
        confirmCapabilityUnavailable: true,
        confirmManualInspection: false,
      }, {}),
      (error) => error.code === "MANUAL_INSPECTION_REQUIRED",
    );
    assert.equal(store.quarantineView(conversationUrl).quarantined, true);
    const acknowledged = await coordinator.recoverOrphanedQuarantine({
      conversationUrl,
      fingerprint: inspected.fingerprint,
      action: "acknowledge",
      confirmCapabilityUnavailable: true,
      confirmManualInspection: true,
    }, {});
    assert.equal(acknowledged.acknowledged, true);
    assert.equal(acknowledged.messageSent, false);
  });
});

test("proven orphaned reconciliation rotates handles and grants only the recovering session", async () => {
  await withStore(async (store) => {
    const ownerSession = store.createOwnerSession({ harness: "codex" });
    const recoverySession = store.createOwnerSession({ harness: "claude" });
    const foreignSession = store.createOwnerSession({ harness: "codex" });
    const owner = authenticate(store, ownerSession, "codex");
    const recovery = authenticate(store, recoverySession, "claude");
    const foreign = authenticate(store, foreignSession, "codex");
    const conversationUrl = "https://chatgpt.com/c/orphaned-reconcile";
    const owned = ownedJob(store, owner, { conversationKey: conversationUrl, conversationUrl });
    makeResponseUncertain(store, owned.job);
    const inspected = store.quarantineView(conversationUrl);
    const read = mintCapability("read", owned.job.chainId);
    const control = mintCapability("control", owned.job.chainId);
    const subscriptionId = crypto.randomUUID();
    const subscription = mintCapability("subscription", subscriptionId);

    const reopened = store.recoverOrphanedQuarantineForMonitoring({
      scopeKey: conversationUrl,
      fingerprint: inspected.fingerprint,
      caller: recovery,
      userTurnId: "proven-user-turn",
      userTurnHash: "submitted-hash",
      readCapabilityHash: read.hash,
      controlCapabilityHash: control.hash,
      subscriptionId,
      subscriptionCapabilityHash: subscription.hash,
      completionMode: "harness",
    });
    assert.equal(reopened.state, "queued");
    assert.equal(store.quarantineView(conversationUrl).quarantined, false);
    assert.equal(store.authorizeJob({ jobId: owned.job.id, caller: recovery, control: true }).job.id, owned.job.id);
    assert.throws(
      () => store.authorizeJob({ jobId: owned.job.id, jobHandle: owned.control.handle, caller: foreign, control: true }),
      (error) => error.code === "JOB_NOT_FOUND",
      "the reported-lost capability must be invalidated by recovery",
    );
    assert.equal(store.authorizeJob({ jobId: owned.job.id, jobHandle: control.handle, caller: foreign, control: true }).job.id, owned.job.id);
    const replacementSubscription = store.db.prepare("SELECT * FROM completion_subscriptions WHERE id=?").get(subscriptionId);
    assert.equal(replacementSubscription.owner_session_id, recovery.id);
    assert.equal(replacementSubscription.mode, "harness");
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

test("manual completion does not accumulate a delivery and closes at terminal state", async () => {
  await withStore(async (store) => {
    const session = store.createOwnerSession({ harness: "codex" });
    const caller = authenticate(store, session, "codex");
    const owned = ownedJob(store, caller, { completionMode: "manual" });
    store.transition(owned.job.id, "completed", { result: { answer: "private" } });
    assert.equal(store.maxCompletionDeliveryId(), 0);
    const parsedId = owned.subscription.handle.split(".")[2];
    assert.equal(store.db.prepare("SELECT state FROM completion_subscriptions WHERE id=?").get(parsedId).state, "closed");
    assert.equal(store.claimCompletion(owned.subscription.handle, caller), null);
  });
});

test("Desktop harness completions are eligible for one broker-owned notification", async () => {
  await withStore(async (store) => {
    const session = store.createOwnerSession({ harness: "claude-desktop-mcp" });
    const caller = authenticate(store, session, "claude-desktop-mcp");
    const owned = ownedJob(store, caller, { completionMode: "harness" });
    store.transition(owned.job.id, "completed", { result: { answer: "private" } });
    const pending = store.pendingSystemNotifications(0);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].harness, "claude-desktop-mcp");
    assert.equal(store.markSystemNotificationDelivered(pending[0].deliveryId), true);
    const delivered = store.claimCompletion(owned.subscription.handle, caller);
    assert.equal(delivered.deliveryState, "delivered");
    store.acknowledgeCompletion(owned.subscription.handle, caller, delivered.deliveryId);
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
