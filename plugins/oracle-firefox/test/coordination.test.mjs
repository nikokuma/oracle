import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mintCapability, redactCapabilityText } from "../src/capabilities.mjs";
import { Coordinator } from "../src/coordinator.mjs";
import { structuredError } from "../src/errors.mjs";
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
    assert.equal(view.blockers.length, 1);
    assert.deepEqual(Object.keys(view.blockers[0]).sort(), ["ageSeconds", "fingerprint", "state", "type"]);
    assert.equal("conversationUrl" in view, false);
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
    coordinator.draining = true;
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
      userTurnId: "legacy-user-turn",
      userTurnHash: "submitted-hash",
      readCapabilityHash: read.hash,
      controlCapabilityHash: control.hash,
      subscriptionId,
      subscriptionCapabilityHash: subscription.hash,
      completionMode: "harness",
    });
    assert.equal(reopened.state, "awaiting_response");
    assert.equal(reopened.executionKind, "monitor_only");
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

test("orphan reconciliation enforces exact zero, one, and multiple match collection cardinality", async () => {
  await withStore(async (store) => {
    const ownerSession = store.createOwnerSession({ harness: "codex" });
    const recoverySession = store.createOwnerSession({ harness: "claude" });
    const owner = authenticate(store, ownerSession, "codex");
    const recovery = authenticate(store, recoverySession, "claude");
    const scope = "https://chatgpt.com/c/orphan-cardinality";
    const owned = ownedJob(store, owner, { conversationKey: scope, conversationUrl: scope });
    makeResponseUncertain(store, owned.job);
    const coordinator = new Coordinator({ store, browserManager: { status: () => ({}) } });
    coordinator.draining = true;
    coordinator.callerFromContext = () => recovery;
    const fingerprint = store.quarantineView(scope).fingerprint;
    const base = {
      conversationUrl: scope,
      fingerprint,
      action: "reconcile",
      confirmCapabilityUnavailable: true,
    };

    coordinator.findSubmittedTurnMatches = async () => ({ matches: [], candidateCount: 3, mismatch: null });
    const none = await coordinator.recoverOrphanedQuarantine(base, {});
    assert.equal(none.observedMatches, 0);
    assert.equal(none.candidateCount, 3);

    coordinator.findSubmittedTurnMatches = async () => ({
      matches: [{ id: "one" }, { id: "two" }],
      candidateCount: 2,
      mismatch: null,
    });
    const multiple = await coordinator.recoverOrphanedQuarantine(base, {});
    assert.equal(multiple.observedMatches, 2);
    assert.match(multiple.reason, /more than one/iu);

    coordinator.findSubmittedTurnMatches = async () => ({ matches: [{ id: "legacy-user-turn" }], candidateCount: 1, mismatch: null });
    const one = await coordinator.recoverOrphanedQuarantine(base, {});
    assert.equal(one.reconciled, true);
    assert.equal(one.adoptedForMonitoring, true);
    assert.equal(store.requireJob(owned.job.id).executionKind, "monitor_only");
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

test("capability-owned input abandonment preserves the result and releases same-chat FIFO", async () => {
  await withStore(async (store) => {
    const session = store.createOwnerSession({ harness: "codex" });
    const caller = authenticate(store, session, "codex");
    const conversationUrl = "https://chatgpt.com/c/abandon-input";
    const owned = ownedJob(store, caller, { conversationKey: conversationUrl, conversationUrl });
    const localDataRequest = {
      version: 1,
      requestId: "runtime-check",
      requests: [{ id: "node", fact: "Node version", why: "SQLite support", suggestedReadOnlyCheck: "node --version" }],
      safeReadOnly: true,
      unsafeRequestId: null,
    };
    const later = store.createJob({
      authorizationId: crypto.randomUUID(),
      operation: "continue_chat",
      request: {},
      conversationKey: conversationUrl,
      conversationUrl,
      sessionPath: "/tmp/later-after-input",
    }).job;
    store.transition(later.id, "snapshotted");
    store.transition(later.id, "queued");
    store.transition(owned.job.id, "completed", {
      assistantDisposition: "local_data_request",
      localDataRequest,
      result: { answer: "Need one local fact." },
      recoveryAction: "reply_with_local_data",
    });
    assert.equal(store.getChain(owned.job.chainId).state, "input_required");
    assert.equal(store.isRunnable(later.id), false);

    const released = store.abandonInputRequest(owned.job.id, { reason: "not-needed" });
    assert.equal(released.chain.state, "completed");
    assert.equal(released.reason, "not-needed");
    assert.equal(store.requireJob(owned.job.id).localDataRequest.requestId, "runtime-check");
    assert.equal(store.isRunnable(later.id), true);
    assert.equal(store.jobChain(owned.job.id).length, 1, "abandonment must not create or send a child job");

    const again = store.abandonInputRequest(owned.job.id, { reason: "false-positive" });
    assert.equal(again.idempotent, true);
    assert.equal(again.reason, "not-needed", "the original audit reason is immutable");
  });
});

test("orphaned input recovery is exact-URL fingerprinted, sanitized, and confirmation-gated", async () => {
  await withStore(async (store) => {
    const ownerSession = store.createOwnerSession({ harness: "codex" });
    const recoverySession = store.createOwnerSession({ harness: "claude" });
    const owner = authenticate(store, ownerSession, "codex");
    const recovery = authenticate(store, recoverySession, "claude");
    const conversationUrl = "https://chatgpt.com/c/orphaned-input";
    const owned = ownedJob(store, owner, { conversationKey: conversationUrl, conversationUrl });
    store.transition(owned.job.id, "completed", {
      assistantDisposition: "local_data_request",
      localDataRequest: {
        version: 1,
        requestId: "short-stable-id",
        requests: [{
          id: "fact-id",
          fact: "exact fact needed",
          why: "why it changes the answer",
          suggestedReadOnlyCheck: "a safe read-only check",
        }],
        safeReadOnly: true,
      },
      result: { answer: "private answer must not be exposed" },
    });
    const view = store.inputRequestView(conversationUrl);
    assert.equal(view.inputRequired, true);
    assert.equal(view.blockers.length, 1);
    assert.deepEqual(Object.keys(view.blockers[0]).sort(), ["ageSeconds", "fingerprint", "state", "type"]);
    assert.equal("jobId" in view, false);
    assert.equal("localDataRequest" in view, false);
    assert.equal(JSON.stringify(view).includes("private answer"), false);
    assert.throws(
      () => store.abandonOrphanedInputRequest(conversationUrl, "0".repeat(64), { reason: "false-positive" }),
      (error) => error.code === "INPUT_REQUEST_CHANGED",
    );

    const coordinator = new Coordinator({ store, browserManager: { status: () => ({}) } });
    coordinator.callerFromContext = () => recovery;
    assert.throws(
      () => coordinator.abandonOrphanedInputRequest({
        conversationUrl,
        fingerprint: view.fingerprint,
        confirmCapabilityUnavailable: false,
        confirmAbandon: true,
        reason: "false-positive",
      }, {}),
      (error) => error.code === "CAPABILITY_RECOVERY_CONFIRMATION_REQUIRED",
    );
    assert.throws(
      () => coordinator.abandonOrphanedInputRequest({
        conversationUrl,
        fingerprint: view.fingerprint,
        confirmCapabilityUnavailable: true,
        confirmAbandon: false,
        reason: "false-positive",
      }, {}),
      (error) => error.code === "INPUT_REQUEST_ABANDON_CONFIRMATION_REQUIRED",
    );
    const released = coordinator.abandonOrphanedInputRequest({
      conversationUrl,
      fingerprint: view.fingerprint,
      confirmCapabilityUnavailable: true,
      confirmAbandon: true,
      reason: "false-positive",
    }, {});
    assert.equal(released.laneReleased, true);
    assert.equal(released.messageSent, false);
    assert.equal(released.replacementAuthorized, false);
    assert.deepEqual(store.listJobsForSession(recovery.id), [], "orphan recovery must not expose or adopt private history");
    assert.equal(store.inputRequestView(conversationUrl).inputRequired, false);
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
    const deliveredRow = store.db.prepare(`
      SELECT state, claim_id, claimed_at, claim_kind, claim_expires_at
      FROM completion_deliveries WHERE id=?
    `).get(claimed.deliveryId);
    assert.deepEqual({ ...deliveredRow }, {
      state: "delivered",
      claim_id: null,
      claimed_at: null,
      claim_kind: null,
      claim_expires_at: null,
    });
    assert.deepEqual(
      store.acknowledgeCompletion(owned.subscription.handle, caller, claimed.deliveryId),
      { deliveryId: claimed.deliveryId, delivered: true, acknowledged: true },
    );
    const acknowledgedRow = store.db.prepare(`
      SELECT state, claim_id, claimed_at, claim_kind, claim_expires_at
      FROM completion_deliveries WHERE id=?
    `).get(claimed.deliveryId);
    assert.deepEqual({ ...acknowledgedRow }, {
      state: "acknowledged",
      claim_id: null,
      claimed_at: null,
      claim_kind: null,
      claim_expires_at: null,
    });
    assert.equal(store.claimCompletion(owned.subscription.handle, caller), null);
  });
});

test("acknowledging an active subscriber claim clears all durable claim ownership", async () => {
  await withStore(async (store) => {
    const session = store.createOwnerSession({ harness: "codex" });
    const caller = authenticate(store, session, "codex");
    const owned = ownedJob(store, caller);
    store.transition(owned.job.id, "completed", { result: { answer: "private answer" } });
    const claimed = store.claimCompletion(owned.subscription.handle, caller);

    assert.deepEqual(
      store.acknowledgeCompletion(owned.subscription.handle, caller, claimed.deliveryId),
      { deliveryId: claimed.deliveryId, delivered: false, acknowledged: true },
    );
    const row = store.db.prepare(`
      SELECT state, claim_id, claimed_at, claim_kind, claim_expires_at
      FROM completion_deliveries WHERE id=?
    `).get(claimed.deliveryId);
    assert.deepEqual({ ...row }, {
      state: "acknowledged",
      claim_id: null,
      claimed_at: null,
      claim_kind: null,
      claim_expires_at: null,
    });
    store.db.prepare(`
      UPDATE completion_deliveries
      SET claim_id='legacy-claim', claimed_at=?, claim_kind='system', claim_expires_at=?
      WHERE id=?
    `).run(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), claimed.deliveryId);
    store.acknowledgeCompletion(owned.subscription.handle, caller, claimed.deliveryId);
    const repeated = store.db.prepare(`
      SELECT claim_id, claimed_at, claim_kind, claim_expires_at
      FROM completion_deliveries WHERE id=?
    `).get(claimed.deliveryId);
    assert.deepEqual({ ...repeated }, {
      claim_id: null,
      claimed_at: null,
      claim_kind: null,
      claim_expires_at: null,
    });
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
    const systemClaim = store.claimSystemNotification();
    assert.equal(systemClaim.deliveryId, pending[0].deliveryId);
    assert.equal(store.markSystemNotificationDelivered(systemClaim.deliveryId, systemClaim.claimId), true);
    const deliveredRow = store.db.prepare(`
      SELECT claim_id, claimed_at, claim_kind, claim_expires_at
      FROM completion_deliveries WHERE id=?
    `).get(systemClaim.deliveryId);
    assert.deepEqual({ ...deliveredRow }, {
      claim_id: null,
      claimed_at: null,
      claim_kind: null,
      claim_expires_at: null,
    });
    const delivered = store.claimCompletion(owned.subscription.handle, caller);
    assert.equal(delivered.deliveryState, "delivered");
    store.acknowledgeCompletion(owned.subscription.handle, caller, delivered.deliveryId);
    assert.equal(store.claimCompletion(owned.subscription.handle, caller), null);
  });
});

test("a private start-receipt capability reissues handles without duplicating the committed job", async () => {
  await withStore(async (store) => {
    const session = store.createOwnerSession({ harness: "codex", hostSessionHint: "stable-task" });
    const caller = authenticate(store, session, "codex");
    const authorizationId = crypto.randomUUID();
    const recovery = mintCapability("receipt", authorizationId);
    const owned = ownedJob(store, caller, {
      authorizationId,
      startReceiptCapabilityHash: recovery.hash,
    });

    const first = store.recoverStartReceipt({
      authorizationId,
      digest: owned.job.requestDigest,
      recoveryHandle: recovery.handle,
      caller,
    });
    assert.equal(first.job.id, owned.job.id);
    assert.equal(store.listJobsForSession(caller.id).length, 1);
    const resumeSession = store.createOwnerSession({ harness: "claude", hostSessionHint: "resume-1" });
    const resumeCaller = authenticate(store, resumeSession, "claude");
    assert.throws(
      () => store.authorizeJob({ jobId: owned.job.id, jobHandle: owned.control.handle, caller: resumeCaller, control: true }),
      (error) => error.code === "JOB_NOT_FOUND",
      "receipt recovery rotates the lost response's handles",
    );
    assert.equal(store.authorizeJob({ jobId: owned.job.id, jobHandle: first.jobHandle, caller: resumeCaller, control: true }).job.id, owned.job.id);

    const second = store.recoverStartReceipt({
      authorizationId,
      digest: owned.job.requestDigest,
      recoveryHandle: recovery.handle,
      caller,
    });
    assert.equal(second.job.id, owned.job.id);
    assert.equal(store.listJobsForSession(caller.id).length, 1, "repeated recovery never creates a second job");
    const secondResumeSession = store.createOwnerSession({ harness: "claude", hostSessionHint: "resume-2" });
    const secondResumeCaller = authenticate(store, secondResumeSession, "claude");
    assert.throws(
      () => store.authorizeJob({ jobId: owned.job.id, jobHandle: first.jobHandle, caller: secondResumeCaller, control: true }),
      (error) => error.code === "JOB_NOT_FOUND",
    );
    assert.equal(store.authorizeJob({ jobId: owned.job.id, jobHandle: second.jobHandle, caller: secondResumeCaller, control: true }).job.id, owned.job.id);
  });
});

test("start-receipt recovery fails closed for foreign callers, digests, and capabilities", async () => {
  await withStore(async (store) => {
    const ownerSession = store.createOwnerSession({ harness: "codex", hostSessionHint: "owner-task" });
    const foreignSession = store.createOwnerSession({ harness: "codex", hostSessionHint: "foreign-task" });
    const owner = authenticate(store, ownerSession, "codex");
    const foreign = authenticate(store, foreignSession, "codex");
    const authorizationId = crypto.randomUUID();
    const recovery = mintCapability("receipt", authorizationId);
    const owned = ownedJob(store, owner, {
      authorizationId,
      startReceiptCapabilityHash: recovery.hash,
    });
    const attempts = [
      { caller: foreign, digest: owned.job.requestDigest, recoveryHandle: recovery.handle },
      { caller: owner, digest: "0".repeat(64), recoveryHandle: recovery.handle },
      { caller: owner, digest: owned.job.requestDigest, recoveryHandle: mintCapability("receipt", authorizationId).handle },
    ];
    for (const attempt of attempts) {
      assert.throws(
        () => store.recoverStartReceipt({ authorizationId, ...attempt }),
        (error) => error.code === "START_RECEIPT_NOT_FOUND" && !JSON.stringify(error).includes(owned.job.id),
      );
    }
    assert.equal(store.listJobsForSession(foreign.id).length, 0);
  });
});

test("private receipt capabilities are redacted from structured failures", () => {
  const receipt = mintCapability("receipt", crypto.randomUUID());
  const error = Object.assign(new Error(`lost ${receipt.handle}`), {
    code: "FIXTURE",
    details: { recoveryHandle: receipt.handle },
  });
  const value = structuredError(error);
  assert.equal(JSON.stringify(value).includes(receipt.handle), false);
  assert.equal(value.message, "lost [REDACTED_CAPABILITY]");
  assert.equal(redactCapabilityText(`lost ${receipt.handle}`), "lost [REDACTED_CAPABILITY]");
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
    const cooldown = store.recordAccountCooldown({
      code: "ACCOUNT_COOLDOWN",
      details: { remoteThrottleEvidence: { kind: "assistant_turn", fingerprint: "a".repeat(64) } },
    }, { minimumMs: 60_000 });
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

test("logical queue counts are mutually exclusive per chain across attention and uncertainty FIFO", async () => {
  await withStore(async (store) => {
    const queue = (scope) => {
      const job = store.createJob({
        authorizationId: crypto.randomUUID(),
        operation: "continue_chat",
        request: { responseTimeoutSeconds: 300 },
        conversationKey: scope,
        conversationUrl: scope,
        sessionPath: `/tmp/${scope.split("/").at(-1)}`,
      }).job;
      store.transition(job.id, "snapshotted");
      store.transition(job.id, "queued");
      return job;
    };
    const executing = queue("https://chatgpt.com/c/count-executing");
    store.claimRunnable(executing.id);

    const monitoring = queue("https://chatgpt.com/c/count-monitoring");
    for (const state of ["page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
      store.transition(monitoring.id, state, state === "submit_intent" ? { submittedMessageHash: "monitor-hash" } : {});
    }
    store.transition(monitoring.id, "user_turn_confirmed", { userTurnId: "monitor-user", userTurnHash: "monitor-hash" });
    store.transition(monitoring.id, "awaiting_response");
    store.claimRunnable(monitoring.id);

    queue("https://chatgpt.com/c/count-runnable");

    const attentionScope = "https://chatgpt.com/c/count-attention";
    const attention = queue(attentionScope);
    const attentionSuccessor = queue(attentionScope);
    store.transition(attention.id, "completed", {
      assistantDisposition: "local_data_request",
      localDataRequest: { version: 1, requestId: "facts", requests: [{ id: "one" }], safeReadOnly: true },
      result: { answer: "private" },
    });

    const uncertaintyScope = "https://chatgpt.com/c/count-uncertainty";
    const uncertainty = queue(uncertaintyScope);
    for (const state of ["page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
      store.transition(uncertainty.id, state, state === "submit_intent" ? { submittedMessageHash: "uncertain-hash" } : {});
    }
    const uncertaintySuccessor = queue(uncertaintyScope);
    store.markFailure(uncertainty.id, new Error("lost turn proof"));

    const counts = store.logicalQueueCounts();
    assert.deepEqual(counts, {
      executing: 1,
      monitoring: 1,
      runnableQueued: 1,
      blockedAttention: 2,
      blockedUncertainty: 2,
      logicalOutstanding: 7,
    });
    assert.equal(
      counts.executing + counts.monitoring + counts.runnableQueued + counts.blockedAttention + counts.blockedUncertainty,
      counts.logicalOutstanding,
    );
    assert.equal(store.logicalStateForJob(attentionSuccessor.id), "blocked_attention");
    assert.equal(store.logicalStateForJob(uncertaintySuccessor.id), "blocked_uncertainty");
  });
});

test("an existing canonical input request rejects a new start with only sanitized blockers", async () => {
  await withStore(async (store) => {
    const scope = "https://chatgpt.com/c/input-blocking";
    const job = store.createJob({
      authorizationId: crypto.randomUUID(),
      operation: "continue_chat",
      request: { prompt: "foreign private prompt" },
      conversationKey: scope,
      conversationUrl: scope,
      sessionPath: "/tmp/foreign-private-path",
    }).job;
    store.transition(job.id, "completed", {
      assistantDisposition: "local_data_request",
      localDataRequest: { version: 1, requestId: "private", requests: [{ id: "private" }], safeReadOnly: true },
      result: { answer: "foreign private answer" },
    });
    assert.throws(
      () => store.createJob({
        authorizationId: crypto.randomUUID(),
        operation: "continue_chat",
        request: {},
        conversationKey: scope,
        conversationUrl: scope,
        sessionPath: "/tmp/new-owner",
      }),
      (error) => {
        assert.equal(error.code, "INPUT_REQUIRED_BLOCKING");
        assert.deepEqual(Object.keys(error.details.blockers[0]).sort(), ["ageSeconds", "fingerprint", "state", "type"]);
        const serialized = JSON.stringify(error.details);
        for (const secret of [job.id, scope, "foreign private prompt", "foreign private answer", "/tmp/foreign-private-path"]) {
          assert.equal(serialized.includes(secret), false);
        }
        return true;
      },
    );
  });
});

test("a successor accepted before canonical re-keying becomes blocked_attention instead of queued", async () => {
  await withStore(async (store) => {
    const canonical = "https://chatgpt.com/c/rekeyed-attention";
    const creator = store.createJob({
      authorizationId: crypto.randomUUID(),
      operation: "consult",
      request: {},
      conversationKey: `new-standalone:${crypto.randomUUID()}`,
      sessionPath: "/tmp/rekey-creator",
    }).job;
    store.transition(creator.id, "snapshotted");
    store.transition(creator.id, "queued");
    const successor = store.createJob({
      authorizationId: crypto.randomUUID(),
      operation: "continue_chat",
      request: {},
      conversationKey: canonical,
      conversationUrl: canonical,
      sessionPath: "/tmp/rekey-successor",
    }).job;
    store.transition(successor.id, "snapshotted");
    store.transition(successor.id, "queued");
    store.transition(creator.id, "completed", {
      conversationKey: canonical,
      conversationUrl: canonical,
      assistantDisposition: "local_data_request",
      localDataRequest: { version: 1, requestId: "facts", requests: [{ id: "one" }], safeReadOnly: true },
      result: { answer: "private" },
    });
    assert.equal(store.logicalStateForJob(successor.id), "blocked_attention");
    assert.equal(store.isRunnable(successor.id), false);
  });
});

test("input requests become durably attention-required after thirty minutes without releasing the lane", async () => {
  await withStore(async (store) => {
    const session = store.createOwnerSession({ harness: "codex" });
    const caller = authenticate(store, session, "codex");
    const owned = ownedJob(store, caller, { completionMode: "manual", request: { completionMode: "manual" } });
    store.transition(owned.job.id, "completed", {
      assistantDisposition: "local_data_request",
      localDataRequest: { version: 1, requestId: "facts", requests: [{ id: "one" }], safeReadOnly: true },
      result: { answer: "private" },
    });
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    store.db.prepare("UPDATE job_chains SET updated_at=? WHERE id=?").run(old, owned.job.chainId);
    const marked = store.sweepAttentionRequired();
    assert.equal(marked.length, 1);
    assert.equal(store.getChain(owned.job.chainId).state, "input_required");
    assert.ok(store.getChain(owned.job.chainId).attentionRequiredAt);
    assert.equal(store.isRunnable(owned.job.id), false);
    const delivery = store.claimCompletion(owned.subscription.handle, caller);
    assert.equal(delivery.state, "attention_required");
    assert.equal(store.sweepAttentionRequired().length, 0, "attention marking and notification are idempotent");

    const child = store.createJob({
      authorizationId: crypto.randomUUID(),
      operation: "continue_chat",
      request: {},
      conversationKey: owned.job.conversationKey,
      conversationUrl: owned.job.conversationUrl,
      sessionPath: "/tmp/attention-child",
      parentJobId: owned.job.id,
    }).job;
    assert.equal(store.getChain(child.chainId).attentionRequiredAt, null, "a new active evidence attempt gets its own attention clock");
  });
});

test("multiple legacy blockers remain sanitized, owner-scoped, stable, and exactly selectable", async () => {
  await withStore(async (store) => {
    const ownerSession = store.createOwnerSession({ harness: "codex" });
    const foreignSession = store.createOwnerSession({ harness: "claude" });
    const owner = authenticate(store, ownerSession, "codex");
    const foreign = authenticate(store, foreignSession, "claude");
    const scope = "https://chatgpt.com/c/legacy-multiple";
    const first = ownedJob(store, owner, { conversationKey: `${scope}-one`, conversationUrl: `${scope}-one` });
    const second = ownedJob(store, owner, { conversationKey: `${scope}-two`, conversationUrl: `${scope}-two` });
    for (const [entry, answer] of [[first, "private one"], [second, "private two"]]) {
      store.transition(entry.job.id, "completed", {
        assistantDisposition: "local_data_request",
        localDataRequest: { version: 1, requestId: answer, requests: [{ id: "one" }], safeReadOnly: true },
        result: { answer },
      });
      store.db.prepare("UPDATE job_chains SET conversation_key=?, canonical_url=? WHERE id=?")
        .run(scope, scope, entry.job.chainId);
    }
    const view = store.inputRequestView(scope);
    assert.equal(view.blockers.length, 2);
    assert.equal(new Set(view.blockers.map((blocker) => blocker.fingerprint)).size, 2);
    assert.equal(store.attentionForSession(owner.id).length, 2);
    assert.deepEqual(store.attentionForSession(foreign.id), []);
    for (const blocker of view.blockers) {
      assert.deepEqual(Object.keys(blocker).sort(), ["ageSeconds", "fingerprint", "state", "type"]);
      assert.ok(store.requireMatchingInputRequest(scope, blocker.fingerprint));
    }
    const before = view.blockers.map((blocker) => blocker.fingerprint);
    store.sweepAttentionRequired({ nowMs: Date.now() + 31 * 60_000 });
    assert.deepEqual(store.inputRequestView(scope).blockers.map((blocker) => blocker.fingerprint), before);
    const serialized = JSON.stringify(view);
    for (const privateValue of [first.job.id, second.job.id, scope, "private one", "private two", first.control.handle]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  });
});

test("five observers record one durable remote cooldown incident and local gates never extend it", async () => {
  await withStore(async (store) => {
    const error = {
      code: "ACCOUNT_COOLDOWN",
      details: { remoteThrottleEvidence: { kind: "assistant_turn", fingerprint: "5".repeat(64) } },
    };
    const observations = Array.from({ length: 5 }, () => store.recordAccountCooldown(error, { minimumMs: 60_000 }));
    assert.equal(observations.filter((entry) => entry.incidentRecorded).length, 1);
    const state = store.accountState();
    assert.equal(state.cooldownCount, 1);
    assert.equal(state.cooldownIncidentCount, 1);
    const incident = store.db.prepare("SELECT observer_count FROM cooldown_incidents").get();
    assert.equal(Number(incident.observer_count), 5);
    const until = state.cooldownUntil;
    const gate = store.recordAccountCooldown({ code: "ACCOUNT_COOLDOWN", details: { existingLocalGate: true } }, { minimumMs: 60_000 });
    assert.equal(gate.incidentRecorded, false);
    assert.equal(store.accountState().cooldownUntil, until);
    assert.equal(store.accountState().cooldownCount, 1);
  });
});

test("submission pacing waits outside the trusted-action phase and the cooldown fence is revalidated", async () => {
  await withStore(async (store) => {
    const scope = "https://chatgpt.com/c/pacing-fence";
    const job = store.createJob({
      authorizationId: crypto.randomUUID(),
      operation: "continue_chat",
      request: {},
      conversationKey: scope,
      conversationUrl: scope,
      sessionPath: "/tmp/pacing-fence",
    }).job;
    for (const state of ["snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified"]) {
      store.transition(job.id, state);
    }
    const coordinator = new Coordinator({ store, browserManager: { status: () => ({}) }, minimumSubmissionIntervalMs: 2_000 });
    store.db.prepare("UPDATE account_state SET next_submit_not_before=? WHERE id=1")
      .run(new Date(Date.now() + 250).toISOString());
    const started = Date.now();
    await assert.rejects(
      () => coordinator.beforeSubmit(job.id, { waitOnly: false }),
      (error) => error.code === "SUBMIT_PACING_WAIT",
    );
    assert.ok(Date.now() - started < 100, "permit issuance must not sleep while the trusted action is held");
    await coordinator.beforeSubmit(job.id, { waitOnly: true });
    const permit = await coordinator.beforeSubmit(job.id, { waitOnly: false });
    const cooldown = store.recordAccountCooldown({
      code: "ACCOUNT_COOLDOWN",
      details: { remoteThrottleEvidence: { kind: "visible_notice", fingerprint: "9".repeat(64) } },
    }, { minimumMs: 60_000 });
    assert.notEqual(cooldown.gateVersion, permit.gateVersion);
    assert.throws(
      () => store.consumeSubmitPermit(job.id, permit.id),
      (error) => error.code === "SUBMIT_PERMIT_INVALID",
    );
    assert.equal(store.requireJob(job.id).submitIntentAt, null);
  });
});
