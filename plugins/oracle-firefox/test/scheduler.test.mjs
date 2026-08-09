import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mintCapability } from "../src/capabilities.mjs";
import { Coordinator } from "../src/coordinator.mjs";
import { StateStore } from "../src/state-store.mjs";

const fakeBrowser = { close: async () => {}, status: () => ({ browserRunning: false }) };

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for scheduler test.");
}

function queue(store, key, operation = "continue_chat") {
  const created = store.createJob({
    authorizationId: crypto.randomUUID(),
    operation,
    request: {},
    conversationKey: key,
    sessionPath: "/tmp/test-session",
  }).job;
  store.transition(created.id, "snapshotted");
  return store.transition(created.id, "queued");
}

function terminalNotification(store, suffix, { harness = "claude-desktop-mcp", mode = "notify" } = {}) {
  const session = store.createOwnerSession({ harness });
  const caller = store.authenticateOwnerSession({
    sessionId: session.sessionId,
    sessionHandle: session.sessionHandle,
    harness,
  });
  const subscriptionId = crypto.randomUUID();
  const subscription = mintCapability("subscription", subscriptionId);
  const chainId = crypto.randomUUID();
  const read = mintCapability("read", chainId);
  const control = mintCapability("control", chainId);
  const job = store.createJob({
    id: chainId,
    authorizationId: crypto.randomUUID(),
    operation: "continue_chat",
    request: { completionMode: mode },
    conversationKey: `https://chatgpt.com/c/notification-${suffix}`,
    conversationUrl: `https://chatgpt.com/c/notification-${suffix}`,
    sessionPath: `/tmp/notification-${suffix}`,
    ownerSessionId: caller.id,
    subscriptionId,
    subscriptionCapabilityHash: subscription.hash,
    readCapabilityHash: read.hash,
    controlCapabilityHash: control.hash,
    completionMode: mode,
  }).job;
  store.transition(job.id, "completed", { result: { jobId: job.id, answer: `private-${suffix}` } });
  return { job, caller, subscription, subscriptionId };
}

test("same-conversation jobs execute FIFO even with two write slots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-scheduler-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  const starts = [];
  let active = 0;
  let maxActive = 0;
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    writeConcurrency: 2,
    jobExecutor: async ({ jobId, store: state }) => {
      starts.push(jobId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      state.transition(jobId, "completed", { result: { jobId } });
    },
  });
  try {
    await coordinator.open();
    const first = queue(store, "https://chatgpt.com/c/same");
    const second = queue(store, "https://chatgpt.com/c/same");
    coordinator.schedule();
    await waitFor(() => store.requireJob(second.id).state === "completed");
    assert.deepEqual(starts, [first.id, second.id]);
    assert.equal(maxActive, 1);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("different conversations overlap only when the qualified concurrency flag is two", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-scheduler-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  let active = 0;
  let maxActive = 0;
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    writeConcurrency: 2,
    jobExecutor: async ({ jobId, store: state }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 50));
      active -= 1;
      state.transition(jobId, "completed", { result: { jobId } });
    },
  });
  try {
    await coordinator.open();
    const first = queue(store, "https://chatgpt.com/c/one");
    const second = queue(store, "https://chatgpt.com/c/two");
    coordinator.schedule();
    await waitFor(() => store.requireJob(first.id).state === "completed" && store.requireJob(second.id).state === "completed");
    assert.equal(maxActive, 2);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("five explicitly qualified conversation lanes overlap without weakening per-chat FIFO", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-scheduler-three-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  let active = 0;
  let maxActive = 0;
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    writeConcurrency: 5,
    legacyCompletionFiles: false,
    jobExecutor: async ({ jobId, store: state }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 60));
      active -= 1;
      state.transition(jobId, "completed", { result: { jobId } });
    },
  });
  try {
    await coordinator.open();
    assert.equal(coordinator.writeConcurrency, 5);
    assert.equal(store.accountState().effectiveConcurrency, 5);
    const jobs = ["a", "b", "c", "d", "e"].map((name) => queue(store, `https://chatgpt.com/c/${name}`));
    coordinator.schedule();
    await waitFor(() => jobs.every((job) => store.requireJob(job.id).state === "completed"));
    assert.equal(maxActive, 5);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("default scheduling admits a second chat after the first crosses submit-intent while pre-submit remains serial", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-response-monitor-overlap-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  const starts = [];
  let preSubmit = 0;
  let maxPreSubmit = 0;
  let releaseFirst;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    legacyCompletionFiles: false,
    jobExecutor: async ({ jobId, store: state }) => {
      starts.push(jobId);
      preSubmit += 1;
      maxPreSubmit = Math.max(maxPreSubmit, preSubmit);
      for (const next of ["page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
        state.transition(jobId, next);
      }
      preSubmit -= 1;
      state.transition(jobId, "user_turn_confirmed", {
        conversationUrl: state.requireJob(jobId).conversationKey,
        userTurnId: `turn-${jobId}`,
        userTurnHash: `hash-${jobId}`,
      });
      state.transition(jobId, "awaiting_response");
      if (starts.length === 1) await firstReleased;
      state.transition(jobId, "completed", { result: { jobId } });
    },
  });
  try {
    await coordinator.open();
    assert.equal(coordinator.writeConcurrency, 5);
    assert.equal(store.accountState().qualifiedConcurrency, 1);
    const first = queue(store, "https://chatgpt.com/c/monitor-one");
    const second = queue(store, "https://chatgpt.com/c/monitor-two");
    coordinator.schedule();
    await waitFor(() => starts.length === 2);
    assert.equal(store.requireJob(first.id).state, "awaiting_response");
    assert.equal(maxPreSubmit, 1);
    releaseFirst();
    await waitFor(() => store.requireJob(first.id).state === "completed" && store.requireJob(second.id).state === "completed");
  } finally {
    releaseFirst?.();
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the broker delivers one best-effort Desktop notification and leaves result acknowledgement explicit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-desktop-notify-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  const notifications = [];
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    legacyCompletionFiles: false,
    completionNotifier: async (delivery) => { notifications.push(delivery); return true; },
    jobExecutor: async ({ jobId, store: state }) => state.transition(jobId, "completed", { result: { jobId } }),
  });
  try {
    await coordinator.open();
    const session = store.createOwnerSession({ harness: "claude-desktop-mcp" });
    const caller = store.authenticateOwnerSession({ sessionId: session.sessionId, sessionHandle: session.sessionHandle });
    const subscriptionId = crypto.randomUUID();
    const subscription = mintCapability("subscription", subscriptionId);
    const job = store.createJob({
      authorizationId: crypto.randomUUID(),
      operation: "continue_chat",
      request: { completionMode: "notify" },
      conversationKey: "https://chatgpt.com/c/desktop-notify",
      conversationUrl: "https://chatgpt.com/c/desktop-notify",
      sessionPath: "/tmp/desktop-notify",
      ownerSessionId: caller.id,
      subscriptionId,
      subscriptionCapabilityHash: subscription.hash,
      completionMode: "notify",
    }).job;
    store.transition(job.id, "snapshotted");
    store.transition(job.id, "queued");
    coordinator.schedule();
    await waitFor(() => notifications.length === 1);
    const delivery = store.claimCompletion(subscription.handle, caller);
    assert.equal(delivery.deliveryState, "delivered");
    assert.equal(store.db.prepare("SELECT state FROM completion_subscriptions WHERE id=?").get(subscriptionId).state, "open");
    store.acknowledgeCompletion(subscription.handle, caller, delivery.deliveryId);
    assert.equal(store.db.prepare("SELECT state FROM completion_subscriptions WHERE id=?").get(subscriptionId).state, "closed");
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("notification failure is durably retried with bounded backoff and no private result data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-notify-retry-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  const deliveries = [];
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    legacyCompletionFiles: false,
    notificationRetryBaseMs: 10,
    notificationRetryMaximumMs: 20,
    notificationTimeoutMs: 200,
    completionNotifier: async (delivery) => {
      deliveries.push(delivery);
      return deliveries.length > 1;
    },
  });
  try {
    await coordinator.open();
    const created = terminalNotification(store, "retry");
    await waitFor(() => deliveries.length === 2);
    const row = store.db.prepare("SELECT state, attempt_count, last_error_json FROM completion_deliveries WHERE subscription_id=?").get(created.subscriptionId);
    assert.equal(row.state, "delivered");
    assert.equal(Number(row.attempt_count), 2);
    assert.equal(row.last_error_json, null);
    assert.equal(JSON.stringify(deliveries).includes("private-retry"), false);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("broker restart replays an expired claimed notification delivery", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-notify-restart-"));
  const databasePath = path.join(directory, "state.sqlite");
  let store = await new StateStore(databasePath).open();
  let coordinator = null;
  const notifications = [];
  try {
    const created = terminalNotification(store, "restart-claim");
    const abandoned = store.claimSystemNotification({ claimSeconds: 60 });
    assert.equal(abandoned.deliveryId > 0, true);
    store.db.prepare("UPDATE completion_deliveries SET claim_expires_at=? WHERE id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), abandoned.deliveryId);
    store.close();

    store = new StateStore(databasePath);
    coordinator = new Coordinator({
      store,
      browserManager: fakeBrowser,
      legacyCompletionFiles: false,
      completionNotifier: async (delivery) => { notifications.push(delivery); return true; },
    });
    await coordinator.open();
    await waitFor(() => store.db.prepare("SELECT state FROM completion_deliveries WHERE subscription_id=?").get(created.subscriptionId)?.state === "delivered");
    assert.equal(notifications.length, 1);
    const durable = store.db.prepare("SELECT state, attempt_count FROM completion_deliveries WHERE subscription_id=?").get(created.subscriptionId);
    assert.equal(durable.state, "delivered");
    assert.equal(Number(durable.attempt_count), 2);
  } finally {
    if (coordinator) await coordinator.close();
    else store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unexpired claimed retry wakes at claim expiry instead of its stale retry timestamp", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-notify-live-claim-"));
  const databasePath = path.join(directory, "state.sqlite");
  let store = await new StateStore(databasePath).open();
  try {
    terminalNotification(store, "live-retry-claim");
    const first = store.claimSystemNotification({ claimSeconds: 60 });
    store.retrySystemNotification(first.deliveryId, first.claimId, new Error("fixture retry"), {
      baseDelayMs: 1,
      maximumDelayMs: 1,
    });
    store.db.prepare("UPDATE completion_deliveries SET next_attempt_at=? WHERE id=?")
      .run(new Date(Date.now() - 60_000).toISOString(), first.deliveryId);
    const retried = store.claimSystemNotification({ claimSeconds: 60 });
    assert.equal(retried.deliveryId, first.deliveryId);
    store.db.prepare("UPDATE completion_deliveries SET next_attempt_at=? WHERE id=?")
      .run(new Date(Date.now() - 60_000).toISOString(), first.deliveryId);
    store.close();

    store = await new StateStore(databasePath).open();
    assert.equal(store.nextSystemNotificationAt(), retried.claimExpiresAt);
    assert.ok(Date.parse(store.nextSystemNotificationAt()) > Date.now() + 50_000);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup rebuilds a missing terminal completion delivery from SQLite chain authority", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-notify-rebuild-"));
  const databasePath = path.join(directory, "state.sqlite");
  let store = await new StateStore(databasePath).open();
  let coordinator = null;
  const notifications = [];
  try {
    const created = terminalNotification(store, "rebuild");
    store.db.prepare("DELETE FROM completion_deliveries WHERE subscription_id=?").run(created.subscriptionId);
    assert.equal(store.maxCompletionDeliveryId(), 0);
    store.close();

    store = new StateStore(databasePath);
    coordinator = new Coordinator({
      store,
      browserManager: fakeBrowser,
      legacyCompletionFiles: false,
      completionNotifier: async (delivery) => { notifications.push(delivery); return true; },
    });
    await coordinator.open();
    await waitFor(() => store.db.prepare("SELECT state FROM completion_deliveries WHERE subscription_id=?").get(created.subscriptionId)?.state === "delivered");
    assert.equal(notifications.length, 1);
    assert.equal(coordinator.deliveryRepair.deliveries, 1);
    assert.equal(store.db.prepare("SELECT state FROM completion_deliveries WHERE subscription_id=?").get(created.subscriptionId).state, "delivered");
  } finally {
    if (coordinator) await coordinator.close();
    else store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("system notifications use bounded independent workers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-notify-workers-"));
  const store = await new StateStore(path.join(directory, "state.sqlite")).open();
  let active = 0;
  let maxActive = 0;
  let delivered = 0;
  let coordinator = null;
  try {
    for (let index = 0; index < 5; index += 1) terminalNotification(store, `worker-${index}`);
    coordinator = new Coordinator({
      store,
      browserManager: fakeBrowser,
      legacyCompletionFiles: false,
      notificationConcurrency: 2,
      completionNotifier: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        delivered += 1;
        return true;
      },
    });
    await coordinator.open();
    await waitFor(() => delivered === 5);
    assert.equal(maxActive, 2);
  } finally {
    if (coordinator) await coordinator.close();
    else store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a broker-global profile conflict stops scheduling instead of hot-looping the claim", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-scheduler-fatal-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  let executions = 0;
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    jobExecutor: async () => {
      executions += 1;
      throw Object.assign(new Error("profile is owned elsewhere"), { code: "PROFILE_IN_USE_EXTERNALLY" });
    },
  });
  try {
    await coordinator.open();
    const job = queue(store, "https://chatgpt.com/c/profile-conflict");
    coordinator.schedule();
    await waitFor(() => coordinator.status().safeMode === true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const durable = store.requireJob(job.id);
    assert.equal(executions, 1);
    assert.equal(durable.executionEpoch, 1);
    assert.equal(durable.executionState, "backoff");
    assert.equal(coordinator.status().draining, true);
    assert.equal(coordinator.status().brokerFatalError.code, "PROFILE_IN_USE_EXTERNALLY");
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a same-generation executor that settles without a result is CAS-requeued and leaves no running claim", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-scheduler-settlement-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  let executions = 0;
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    legacyCompletionFiles: false,
    jobExecutor: async () => { executions += 1; },
  });
  try {
    await coordinator.open();
    const job = queue(store, "https://chatgpt.com/c/unsettled-executor");
    coordinator.schedule();
    await waitFor(() => store.requireJob(job.id).executionState === "backoff");
    const durable = store.requireJob(job.id);
    assert.equal(executions, 1);
    assert.equal(durable.state, "queued");
    assert.equal(durable.executionState, "backoff");
    assert.equal(durable.executionOwnerInstanceId, null);
    assert.equal(durable.executionLeaseGeneration, null);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-generation abandoned-claim sweeping never reclaims a live executor and requeues stale pre-submit work", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-scheduler-stale-pre-submit-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    legacyCompletionFiles: false,
    jobExecutor: async () => { throw new Error("swept fixture must not execute"); },
  });
  try {
    await coordinator.open();
    const job = queue(store, "https://chatgpt.com/c/stale-pre-submit");
    const claim = store.claimRunnable(job.id);
    coordinator.draining = true;
    const staleHeartbeat = new Date(Date.now() - 60_000).toISOString();
    store.db.prepare("UPDATE job_attempts SET execution_heartbeat_at=? WHERE job_id=?").run(staleHeartbeat, job.id);
    coordinator.active.set(job.id, Promise.resolve());
    assert.deepEqual(coordinator.sweepAbandonedExecutions(), []);
    assert.equal(store.assertExecution(claim), true, "the in-memory live executor set must win over a stale heartbeat");

    coordinator.active.delete(job.id);
    assert.deepEqual(coordinator.sweepAbandonedExecutions(), [{ id: job.id, action: "requeued-pre-submit" }]);
    const recovered = store.requireJob(job.id);
    assert.equal(recovered.state, "queued");
    assert.equal(recovered.executionState, "idle");
    assert.equal(recovered.executionKind, "pre_submit");
    assert.equal(recovered.executionEpoch, claim.executionEpoch + 1);
    assert.equal(recovered.submissionMayHaveOccurred, false);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-generation abandoned monitor claims resume monitoring without lifecycle regression", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-scheduler-stale-monitor-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    legacyCompletionFiles: false,
    jobExecutor: async () => { throw new Error("swept fixture must not execute"); },
  });
  try {
    await coordinator.open();
    const conversationUrl = "https://chatgpt.com/c/stale-monitor";
    const job = queue(store, conversationUrl);
    for (const state of ["page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
      store.transition(job.id, state);
    }
    store.transition(job.id, "user_turn_confirmed", {
      conversationUrl,
      userTurnId: "stale-monitor-user",
    });
    store.transition(job.id, "awaiting_response");
    const claim = store.claimRunnable(job.id);
    assert.equal(claim.executionKind, "monitor_only");
    coordinator.draining = true;
    store.db.prepare("UPDATE job_attempts SET execution_heartbeat_at=? WHERE job_id=?")
      .run(new Date(Date.now() - 60_000).toISOString(), job.id);

    assert.deepEqual(coordinator.sweepAbandonedExecutions(), [{ id: job.id, action: "resumed-monitor-only" }]);
    const recovered = store.requireJob(job.id);
    assert.equal(recovered.state, "awaiting_response");
    assert.notEqual(recovered.state, "queued");
    assert.equal(recovered.executionState, "idle");
    assert.equal(recovered.executionKind, "monitor_only");
    assert.equal(recovered.userTurnHash, null);
    assert.equal(store.getChain(job.chainId).state, "running");
    assert.equal(store.isRunnable(job.id), true);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a slow exact-turn probe releases and resumes only monitor-only execution", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-slow-monitor-probe-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  const executionKinds = [];
  let attempts = 0;
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    legacyCompletionFiles: false,
    jobExecutor: async ({ jobId, store: state, executionClaim }) => {
      executionKinds.push(executionClaim.executionKind);
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("exact probe timed out"), {
          code: "RESPONSE_MONITOR_STALLED",
          submissionMayHaveOccurred: true,
        });
      }
      state.transitionClaimed(executionClaim, "completed", { result: { jobId } });
    },
  });
  try {
    await coordinator.open();
    coordinator.draining = true;
    const scope = "https://chatgpt.com/c/slow-monitor-probe";
    const job = queue(store, scope);
    for (const state of ["page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
      store.transition(job.id, state, state === "submit_intent" ? { submittedMessageHash: "slow-hash" } : {});
    }
    store.transition(job.id, "user_turn_confirmed", {
      conversationUrl: scope,
      userTurnId: "slow-user",
      userTurnHash: "slow-hash",
    });
    store.transition(job.id, "awaiting_response");
    coordinator.draining = false;
    coordinator.schedule();
    await waitFor(() => store.requireJob(job.id).state === "completed");
    assert.deepEqual(executionKinds, ["monitor_only", "monitor_only"]);
    assert.equal(store.requireJob(job.id).executionFailureCount, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM submit_permits WHERE job_id=?").get(job.id).count, 0);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("new-chat qualification is exclusive, then other response lanes may overlap", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-creation-barrier-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  const starts = [];
  let releaseCreator;
  const creatorReleased = new Promise((resolve) => { releaseCreator = resolve; });
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    writeConcurrency: 3,
    legacyCompletionFiles: false,
    jobExecutor: async ({ jobId, store: state }) => {
      starts.push(jobId);
      const job = state.requireJob(jobId);
      if (job.conversationKey === "new-standalone") {
        await new Promise((resolve) => setTimeout(resolve, 30));
        state.transition(jobId, "target_verified", {
          conversationKey: "https://chatgpt.com/c/created-barrier",
          conversationUrl: "https://chatgpt.com/c/created-barrier",
        });
        await creatorReleased;
      }
      state.transition(jobId, "completed", { result: { jobId } });
    },
  });
  try {
    await coordinator.open();
    const creator = queue(store, "new-standalone", "consult");
    const existing = queue(store, "https://chatgpt.com/c/existing-barrier");
    coordinator.schedule();
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(starts, [creator.id]);
    await waitFor(() => starts.includes(existing.id));
    assert.equal(store.requireJob(creator.id).state, "target_verified");
    releaseCreator();
    await waitFor(() => store.requireJob(creator.id).state === "completed" && store.requireJob(existing.id).state === "completed");
  } finally {
    releaseCreator?.();
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a new chat's canonical URL remains leased until its response job finishes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-scheduler-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  const starts = [];
  let releaseCreator;
  const creatorReleased = new Promise((resolve) => { releaseCreator = resolve; });
  const canonicalUrl = "https://chatgpt.com/c/newly-created";
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    writeConcurrency: 2,
    jobExecutor: async ({ jobId, store: state }) => {
      starts.push(jobId);
      const job = state.requireJob(jobId);
      if (job.conversationKey === "new-standalone") {
        state.transition(jobId, "target_verified", { conversationKey: canonicalUrl, conversationUrl: canonicalUrl });
        await creatorReleased;
      }
      state.transition(jobId, "completed", { result: { jobId } });
    },
  });
  try {
    await coordinator.open();
    const creator = queue(store, "new-standalone", "consult");
    coordinator.schedule();
    await waitFor(() => store.requireJob(creator.id).conversationKey === canonicalUrl);

    const continuation = queue(store, canonicalUrl);
    coordinator.schedule();
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.deepEqual(starts, [creator.id]);

    releaseCreator();
    await waitFor(() => store.requireJob(continuation.id).state === "completed");
    assert.deepEqual(starts, [creator.id, continuation.id]);
  } finally {
    releaseCreator?.();
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser selection cannot race ahead of accepting a standalone job", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-selection-race-"));
  const previousHome = process.env.ORACLE_FIREFOX_HOME;
  process.env.ORACLE_FIREFOX_HOME = path.join(directory, "home");
  const store = new StateStore(path.join(directory, "state.sqlite"));
  let selected = false;
  let releaseExecution;
  const executionReleased = new Promise((resolve) => { releaseExecution = resolve; });
  const browserManager = {
    browserName: "firefox",
    async selectBrowser() { selected = true; return { browser: "chrome" }; },
    async close() {},
    status: () => ({ browserRunning: false, browserName: "firefox" }),
  };
  const coordinator = new Coordinator({
    store,
    browserManager,
    legacyCompletionFiles: false,
    jobExecutor: async ({ jobId, store: state }) => {
      await executionReleased;
      state.transition(jobId, "completed", { result: { jobId } });
    },
  });
  try {
    await coordinator.open();
    const start = coordinator.startJob("consult", {
      authorizationId: crypto.randomUUID(),
      prompt: "browser selection race fixture",
      responseTimeoutSeconds: 300,
      attachmentTimeoutSeconds: 300,
    });
    const selection = coordinator.selectBrowser("chrome").catch((error) => error);
    const receipt = await start;
    const error = await selection;
    assert.equal(receipt.browser, "firefox");
    assert.equal(error.code, "BROWSER_SELECTION_BUSY");
    assert.equal(selected, false);
  } finally {
    releaseExecution?.();
    await waitFor(() => store.listJobs({ limit: 1 })[0]?.state === "completed").catch(() => undefined);
    await coordinator.close();
    if (previousHome === undefined) delete process.env.ORACLE_FIREFOX_HOME;
    else process.env.ORACLE_FIREFOX_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test("retry-once creates one durable child continuation and one root completion record", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-"));
  const previousHome = process.env.ORACLE_FIREFOX_HOME;
  process.env.ORACLE_FIREFOX_HOME = path.join(directory, "home");
  const store = new StateStore(path.join(directory, "state.sqlite"));
  const sessionPath = path.join(directory, "session");
  await mkdir(sessionPath, { recursive: true });
  let rootJobId = null;
  let releaseRoot;
  const rootReleased = new Promise((resolve) => { releaseRoot = resolve; });
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    legacyCompletionFiles: true,
    jobExecutor: async ({ jobId, store: state }) => {
      if (jobId === rootJobId) await rootReleased;
      state.transition(jobId, "completed", { result: { jobId, state: "completed", status: "completed" } });
      return state.requireJob(jobId).result;
    },
  });
  try {
    await coordinator.open();
    const conversationUrl = "https://chatgpt.com/c/recovery-test";
    const root = store.createJob({
      authorizationId: crypto.randomUUID(),
      operation: "continue_chat",
      request: {
        prompt: "original request",
        responseFailurePolicy: "retry-once",
        completionMode: "manual",
        responseTimeoutSeconds: 300,
        attachmentTimeoutSeconds: 60,
        modelRequirement: "pro",
      },
      conversationKey: conversationUrl,
      conversationUrl,
      sessionPath,
      maxAutomaticEvidenceReplies: 3,
      maxAutomaticResponseRetries: 1,
    }).job;
    rootJobId = root.id;
    for (const state of [
      "snapshotted", "queued", "page_leased", "target_verified", "attachment_processing",
      "composer_verified", "model_verified", "submit_intent", "user_turn_confirmed", "awaiting_response",
    ]) {
      store.transition(root.id, state, state === "user_turn_confirmed"
        ? { userTurnId: "user-turn", userTurnHash: "hash" }
        : {});
    }
    const failure = {
      code: "PRO_REASONING_STOPPED",
      disposition: "reasoning_stopped",
      retryable: true,
      message: "ChatGPT Pro stopped reasoning before producing a complete answer.",
      normalizedText: "Stopped reasoning",
      classifierVersion: 1,
      assistantTurnId: "assistant-turn",
      visibleErrorControls: ["Try again"],
    };
    store.transition(root.id, "response_failed_detected", {
      responseDisposition: failure.disposition,
      responseFailure: failure,
      assistantDisposition: "response_failed",
      error: { code: failure.code, message: failure.message, safeToRetry: true },
    });
    await coordinator.finalizeResponseFailure(root.id, {
      jobId: root.id,
      rootJobId: root.id,
      state: "response_failed_detected",
      responseFailure: failure,
      responseDisposition: failure.disposition,
      conversationUrl,
      sessionPath,
      submissionCount: 1,
    });
    releaseRoot();
    const failedRoot = store.requireJob(root.id);
    assert.equal(failedRoot.state, "response_failed");
    assert.ok(failedRoot.replacementJobId);
    const recovery = store.requireJob(failedRoot.replacementJobId);
    assert.equal(recovery.parentJobId, root.id);
    assert.equal(recovery.rootJobId, root.id);
    assert.equal(recovery.retryAttempt, 1);
    assert.equal(recovery.request.responseFailurePolicy, "report");
    assert.match(recovery.request.prompt, /answer the original request in full/iu);
    await waitFor(() => store.requireJob(recovery.id).state === "completed");
    const followed = coordinator.result(root.id);
    assert.equal(followed.activeJobId, recovery.id);
    assert.deepEqual(followed.recoveryChain, [root.id, recovery.id]);
    await waitFor(() => coordinator.completionWrites.size === 0);
    const completion = JSON.parse(await readFile(path.join(directory, "completions", `${root.id}.json`), "utf8"));
    assert.equal(completion.rootJobId, root.id);
    assert.equal(completion.activeJobId, recovery.id);
    assert.equal(completion.state, "completed");
  } finally {
    releaseRoot?.();
    await coordinator.close();
    if (previousHome === undefined) delete process.env.ORACLE_FIREFOX_HOME;
    else process.env.ORACLE_FIREFOX_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});
