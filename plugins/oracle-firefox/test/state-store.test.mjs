import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state-store.mjs";

async function withStore(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-state-"));
  const store = await new StateStore(path.join(directory, "state.sqlite")).open();
  try {
    return await callback(store, directory);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function input(overrides = {}) {
  return {
    authorizationId: crypto.randomUUID(),
    operation: "consult",
    request: { responseTimeoutSeconds: 300 },
    conversationKey: "new-standalone",
    sessionPath: "/tmp/session",
    ...overrides,
  };
}

test("SQLite jobs are idempotent by authorization and reject changed reuse", async () => {
  await withStore(async (store) => {
    const request = input();
    const first = store.createJob(request);
    const second = store.createJob(request);
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(first.job.id, second.job.id);
    assert.throws(
      () => store.createJob({ ...request, request: { changed: true } }),
      (error) => error.code === "AUTHORIZATION_REUSED",
    );
  });
});

test("pre-submit failures stay retry-classified and never claim submission", async () => {
  await withStore(async (store) => {
    const created = store.createJob(input()).job;
    store.transition(created.id, "snapshotted");
    store.transition(created.id, "queued");
    const failed = store.markFailure(created.id, Object.assign(new Error("no model"), { code: "MODEL_REQUIREMENT_NOT_MET", safeToRetry: true }));
    assert.equal(failed.state, "failed_pre_submit");
    assert.equal(failed.submissionMayHaveOccurred, false);
    assert.equal(failed.error.safeToRetry, true);
  });
});

test("submitIntentAt is the sole failure-classification boundary despite stray legacy turn fields", async () => {
  await withStore(async (store) => {
    const preSubmit = store.createJob(input({ conversationKey: "legacy-pre-submit" })).job;
    store.transition(preSubmit.id, "snapshotted");
    store.transition(preSubmit.id, "queued");
    store.db.prepare(`
      UPDATE jobs SET user_turn_id='stray-user', user_turn_hash='stray-user-hash',
        assistant_turn_id='stray-assistant', assistant_turn_hash='stray-assistant-hash',
        submission_may_have_happened=1 WHERE id=?
    `).run(preSubmit.id);
    const failedPreSubmit = store.markFailure(preSubmit.id, new Error("legacy debris"));
    assert.equal(failedPreSubmit.state, "failed_pre_submit");
    assert.equal(failedPreSubmit.submissionMayHaveOccurred, false);

    const uncertainUrl = "https://chatgpt.com/c/submitted-without-user-proof";
    const uncertain = store.createJob(input({ conversationKey: uncertainUrl, conversationUrl: uncertainUrl })).job;
    for (const state of ["snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
      store.transition(uncertain.id, state);
    }
    store.db.prepare(`
      UPDATE jobs SET assistant_turn_id='stray-assistant', assistant_turn_hash='stray-assistant-hash'
      WHERE id=?
    `).run(uncertain.id);
    assert.equal(store.markFailure(uncertain.id, new Error("no canonical user proof")).state, "submission_uncertain");

    const provenUrl = "https://chatgpt.com/c/submitted-with-id-proof";
    const proven = store.createJob(input({ conversationKey: provenUrl, conversationUrl: provenUrl })).job;
    for (const state of ["snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
      store.transition(proven.id, state);
    }
    store.transition(proven.id, "user_turn_confirmed", { userTurnId: "id-only-user-proof" });
    store.transition(proven.id, "awaiting_response");
    assert.equal(store.markFailure(proven.id, new Error("monitor lost")).state, "response_uncertain");
  });
});

test("submit-intent failures quarantine the exact scope", async () => {
  await withStore(async (store) => {
    const original = input({ conversationKey: "https://chatgpt.com/c/example" });
    const created = store.createJob(original).job;
    for (const state of ["snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
      store.transition(created.id, state, state === "submit_intent" ? { submittedMessageHash: "abc" } : {});
    }
    const failed = store.markFailure(created.id, new Error("lost page"));
    assert.equal(failed.state, "submission_uncertain");
    assert.equal(failed.submissionMayHaveOccurred, true);
    assert.throws(
      () => store.createJob(input({ conversationKey: original.conversationKey })),
      (error) => error.code === "CONVERSATION_QUARANTINED",
    );
    store.acknowledge(created.id);
    const replacement = store.createJob(input({ conversationKey: original.conversationKey })).job;
    store.transition(replacement.id, "snapshotted");
    store.transition(replacement.id, "queued");
    assert.equal(store.isRunnable(replacement.id), true, "an acknowledged terminal chain must not occupy the FIFO lane");
  });
});

test("response-monitor failures quarantine only their exact conversation", async () => {
  await withStore(async (store) => {
    const conversationKey = "https://chatgpt.com/c/response-stalled";
    const created = store.createJob(input({ conversationKey, conversationUrl: conversationKey })).job;
    for (const state of ["snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
      store.transition(created.id, state, state === "submit_intent" ? { submittedMessageHash: "abc" } : {});
    }
    store.transition(created.id, "user_turn_confirmed", { userTurnId: "turn", userTurnHash: "abc" });
    store.transition(created.id, "awaiting_response");
    const failed = store.markFailure(created.id, Object.assign(new Error("probe stalled"), { code: "RESPONSE_MONITOR_STALLED" }));
    assert.equal(failed.state, "response_uncertain");
    assert.match(failed.recoveryAction, /reconcile_job/u);
    assert.throws(
      () => store.createJob(input({ conversationKey, conversationUrl: conversationKey })),
      (error) => error.code === "CONVERSATION_QUARANTINED",
    );
    store.reopenForMonitoring(created.id, { userTurnId: "turn", userTurnHash: "abc" });
    store.acknowledge(created.id);
    assert.equal(store.getChain(created.chainId).state, "running");
    assert.equal(store.requireJob(created.id).state, "awaiting_response");
    assert.equal(store.requireJob(created.id).executionKind, "monitor_only");
    assert.equal(store.isRunnable(created.id), true);
    const different = store.createJob(input({ conversationKey: "https://chatgpt.com/c/different" })).job;
    assert.equal(different.state, "accepted");
  });
});

test("database reopen backfills only missing legacy uncertainty quarantines", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-state-"));
  const databasePath = path.join(directory, "state.sqlite");
  let store = await new StateStore(databasePath).open();
  try {
    const conversationKey = "https://chatgpt.com/c/legacy-response-uncertain";
    const created = store.createJob(input({ conversationKey, conversationUrl: conversationKey })).job;
    for (const state of ["snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) store.transition(created.id, state);
    store.transition(created.id, "user_turn_confirmed", { userTurnId: "turn", userTurnHash: "hash" });
    store.transition(created.id, "awaiting_response");
    store.markFailure(created.id, new Error("legacy response timeout"));
    store.db.prepare("DELETE FROM quarantines WHERE job_id=?").run(created.id);
    store.close();
    store = await new StateStore(databasePath).open();
    assert.throws(
      () => store.createJob(input({ conversationKey, conversationUrl: conversationKey })),
      (error) => error.code === "CONVERSATION_QUARANTINED",
    );
    store.acknowledge(created.id);
    store.close();
    store = await new StateStore(databasePath).open();
    const acknowledged = store.db.prepare("SELECT active FROM quarantines WHERE job_id=?").get(created.id);
    assert.equal(acknowledged.active, 0, "an acknowledged quarantine must not be reactivated");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("running execution heartbeats advance under the exact fenced claim", async () => {
  await withStore(async (store) => {
    const created = store.createJob(input()).job;
    store.transition(created.id, "snapshotted");
    store.transition(created.id, "queued");
    const claim = store.beginExecution(created.id);
    const before = store.db.prepare("SELECT execution_heartbeat_at FROM job_attempts WHERE job_id=?").get(created.id).execution_heartbeat_at;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const heartbeat = store.heartbeatExecution(claim);
    assert.ok(heartbeat > before);
    assert.equal(store.db.prepare("SELECT execution_heartbeat_at FROM job_attempts WHERE job_id=?").get(created.id).execution_heartbeat_at, heartbeat);
  });
});

test("post-click account cooldown remains conservative without losing its cause", async () => {
  await withStore(async (store) => {
    const created = store.createJob(input({ conversationKey: "new-standalone:cooldown" })).job;
    for (const state of ["snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
      store.transition(created.id, state);
    }
    const error = Object.assign(new Error("ChatGPT account cooldown"), {
      code: "ACCOUNT_COOLDOWN",
      submissionMayHaveOccurred: false,
      recoveryAction: "wait for the ChatGPT account cooldown before starting a newly authorized job",
    });
    const failed = store.markFailure(created.id, error);
    assert.equal(failed.state, "submission_uncertain");
    assert.equal(failed.error.code, "ACCOUNT_COOLDOWN");
    assert.equal(failed.error.submissionMayHaveOccurred, true);
    assert.equal(failed.error.recoveryAction, error.recoveryAction);
    assert.match(failed.recoveryAction, /reconcile_job/u);
  });
});

test("restart recovery requeues pre-submit work and quarantines unproven sends", async () => {
  await withStore(async (store) => {
    const safe = store.createJob(input()).job;
    store.transition(safe.id, "snapshotted");
    store.transition(safe.id, "queued");
    store.transition(safe.id, "page_leased");
    const uncertain = store.createJob(input({ conversationKey: "new-project:test" })).job;
    for (const state of ["snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) store.transition(uncertain.id, state);
    const recovered = store.recoverInterruptedJobs();
    assert.deepEqual(recovered.map((entry) => entry.action).sort(), ["quarantined", "requeued"]);
    assert.equal(store.requireJob(safe.id).state, "queued");
    assert.equal(store.requireJob(uncertain.id).state, "submission_uncertain");
  });
});

test("every durable crash phase recovers without creating a second submission", async () => {
  await withStore(async (store) => {
    const linear = [
      "accepted",
      "snapshotted",
      "queued",
      "page_leased",
      "target_verified",
      "attachment_processing",
      "composer_verified",
      "model_verified",
      "submit_intent",
      "user_turn_confirmed",
      "awaiting_response",
      "response_confirmed",
    ];
    const jobs = [];
    for (let targetIndex = 0; targetIndex < linear.length; targetIndex += 1) {
      const created = store.createJob(input({ conversationKey: `phase-${targetIndex}` })).job;
      for (let index = 1; index <= targetIndex; index += 1) {
        const state = linear[index];
        const patch = state === "submit_intent"
          ? { submittedMessageHash: `hash-${targetIndex}` }
          : state === "user_turn_confirmed"
            ? { userTurnId: `turn-${targetIndex}`, userTurnHash: `hash-${targetIndex}`, conversationUrl: `https://chatgpt.com/c/phase-${targetIndex}` }
            : {};
        store.transition(created.id, state, patch);
      }
      jobs.push({ id: created.id, crashedAt: linear[targetIndex] });
    }
    store.recoverInterruptedJobs();
    for (const entry of jobs) {
      const recovered = store.requireJob(entry.id);
      if (["accepted", "snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified"].includes(entry.crashedAt)) {
        assert.equal(recovered.state, "queued", entry.crashedAt);
        assert.equal(recovered.submissionMayHaveOccurred, false, entry.crashedAt);
      } else if (entry.crashedAt === "submit_intent") {
        assert.equal(recovered.state, "submission_uncertain");
        assert.equal(recovered.submissionMayHaveOccurred, true);
      } else {
        assert.equal(recovered.state, entry.crashedAt, entry.crashedAt);
        assert.equal(recovered.recoveryAction, "reattach submitted turn without resending");
        assert.equal(recovered.executionKind, "monitor_only");
        assert.ok(recovered.userTurnHash);
      }
    }
  });
});

test("restart recovery ignores stray proof before submit intent and accepts canonical ID-only proof after it", async () => {
  await withStore(async (store) => {
    const preSubmit = store.createJob(input({ conversationKey: "legacy-restart-pre-submit" })).job;
    for (const state of ["snapshotted", "queued"]) store.transition(preSubmit.id, state);
    store.db.prepare(`
      UPDATE jobs SET user_turn_id='stray-user', user_turn_hash='stray-hash',
        assistant_turn_id='stray-assistant', assistant_turn_hash='stray-assistant-hash',
        submission_may_have_happened=1 WHERE id=?
    `).run(preSubmit.id);

    const monitorUrl = "https://chatgpt.com/c/restart-id-only";
    const monitor = store.createJob(input({ conversationKey: monitorUrl, conversationUrl: monitorUrl })).job;
    for (const state of ["snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
      store.transition(monitor.id, state);
    }
    store.transition(monitor.id, "user_turn_confirmed", { userTurnId: "restart-id-only-user" });
    store.transition(monitor.id, "awaiting_response");

    store.recoverInterruptedJobs();
    const recoveredPreSubmit = store.requireJob(preSubmit.id);
    assert.equal(recoveredPreSubmit.state, "queued");
    assert.equal(recoveredPreSubmit.submissionMayHaveOccurred, false);
    assert.equal(recoveredPreSubmit.userTurnId, null);
    assert.equal(recoveredPreSubmit.assistantTurnHash, null);
    const recoveredMonitor = store.requireJob(monitor.id);
    assert.equal(recoveredMonitor.state, "awaiting_response");
    assert.equal(recoveredMonitor.executionKind, "monitor_only");
    assert.equal(recoveredMonitor.userTurnHash, null);
  });
});

test("failure classification uses immutable submission proof from awaiting and response-confirmed states", async () => {
  await withStore(async (store) => {
    for (const finalState of ["awaiting_response", "response_confirmed"]) {
      const conversationUrl = `https://chatgpt.com/c/proof-${finalState.replaceAll("_", "-")}`;
      const created = store.createJob(input({ conversationKey: conversationUrl, conversationUrl })).job;
      for (const state of ["snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
        store.transition(created.id, state, state === "submit_intent" ? { submittedMessageHash: `hash-${finalState}` } : {});
      }
      store.transition(created.id, "user_turn_confirmed", {
        userTurnId: `user-${finalState}`,
        userTurnHash: `hash-${finalState}`,
      });
      store.transition(created.id, "awaiting_response");
      if (finalState === "response_confirmed") {
        store.transition(created.id, "response_confirmed", {
          assistantTurnId: `assistant-${finalState}`,
          assistantTurnHash: `assistant-hash-${finalState}`,
        });
      }
      const failed = store.markFailure(created.id, Object.assign(new Error("executor disconnected"), { code: "EXECUTOR_DISCONNECTED" }));
      assert.equal(failed.state, "response_uncertain");
      assert.notEqual(failed.state, "failed_pre_submit");
    }
  });
});

test("terminal response commit is atomic with proof, claim release, chain events, and completion outbox", async () => {
  await withStore(async (store) => {
    const owner = store.createOwnerSession({ harness: "codex" });
    const subscriptionId = crypto.randomUUID();
    const created = store.createJob(input({
      conversationKey: "https://chatgpt.com/c/atomic",
      conversationUrl: "https://chatgpt.com/c/atomic",
      ownerSessionId: owner.sessionId,
      completionMode: "notify",
      subscriptionId,
      subscriptionCapabilityHash: "fixture-capability-hash",
    })).job;
    store.transition(created.id, "snapshotted");
    store.transition(created.id, "queued");
    const claim = store.beginExecution(created.id);
    for (const state of ["page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
      store.transitionClaimed(claim, state, state === "submit_intent" ? { submittedMessageHash: "atomic-user-hash" } : {});
    }
    store.transitionClaimed(claim, "user_turn_confirmed", {
      userTurnId: "atomic-user",
      userTurnHash: "atomic-user-hash",
    });
    store.transitionClaimed(claim, "awaiting_response");
    store.db.exec(`
      CREATE TRIGGER fail_atomic_completion BEFORE INSERT ON completion_deliveries
      BEGIN SELECT RAISE(ABORT, 'ATOMIC_COMPLETION_FAILPOINT'); END;
    `);
    assert.throws(
      () => store.completeResponseClaimed(claim, {
        assistantTurnId: "atomic-assistant",
        assistantTurnHash: "atomic-assistant-hash",
        assistantDisposition: "final",
        result: { jobId: created.id, state: "completed", answer: "atomic answer" },
      }),
      /ATOMIC_COMPLETION_FAILPOINT/u,
    );
    let durable = store.requireJob(created.id);
    assert.equal(durable.state, "awaiting_response");
    assert.equal(durable.assistantTurnId, null);
    assert.equal(durable.executionState, "running");
    assert.equal(store.maxCompletionDeliveryId(), 0);
    store.db.exec("DROP TRIGGER fail_atomic_completion");

    durable = store.completeResponseClaimed(claim, {
      assistantTurnId: "atomic-assistant",
      assistantTurnHash: "atomic-assistant-hash",
      assistantDisposition: "final",
      result: { jobId: created.id, state: "completed", answer: "atomic answer" },
    });
    assert.equal(durable.state, "completed");
    assert.equal(durable.executionState, "released");
    assert.equal(durable.assistantTurnId, "atomic-assistant");
    assert.equal(store.getChain(created.chainId).state, "completed");
    assert.equal(store.eventsAfter(created.id).at(-1).state, "completed");
    assert.equal(store.maxCompletionDeliveryId(), 1);
  });
});

test("uncertainty blocks an already accepted same-conversation successor until acknowledgement", async () => {
  await withStore(async (store) => {
    const conversationUrl = "https://chatgpt.com/c/accepted-successor";
    const first = store.createJob(input({ conversationKey: conversationUrl, conversationUrl })).job;
    for (const state of ["snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
      store.transition(first.id, state, state === "submit_intent" ? { submittedMessageHash: "submitted" } : {});
    }
    const successor = store.createJob(input({ conversationKey: conversationUrl, conversationUrl })).job;
    store.transition(successor.id, "snapshotted");
    store.transition(successor.id, "queued");
    store.markFailure(first.id, new Error("lost exact user-turn proof"));
    assert.equal(store.isRunnable(successor.id), false);
    assert.equal(store.claimRunnable(successor.id), null);
    store.acknowledge(first.id);
    assert.equal(store.isRunnable(successor.id), true);
  });
});

test("one-send guard consumes exactly one permit and monitor execution cannot consume another", async () => {
  await withStore(async (store) => {
    const conversationUrl = "https://chatgpt.com/c/one-send";
    const job = store.createJob(input({ conversationKey: conversationUrl, conversationUrl })).job;
    for (const state of ["snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified"]) {
      store.transition(job.id, state);
    }
    const permit = store.issueSubmitPermit(job.id, { minimumIntervalMs: 1 });
    store.consumeSubmitPermit(job.id, permit.id, { submittedMessageHash: "one-send-hash" });
    await new Promise((resolve) => setTimeout(resolve, 3));
    const duplicate = store.issueSubmitPermit(job.id, { minimumIntervalMs: 1 });
    assert.throws(
      () => store.consumeSubmitPermit(job.id, duplicate.id),
      (error) => error.code === "SUBMIT_PERMIT_INVALID",
    );
    store.transition(job.id, "user_turn_confirmed", { userTurnId: "one-send-user", userTurnHash: "one-send-hash" });
    store.transition(job.id, "awaiting_response");
    const consumed = store.db.prepare("SELECT COUNT(*) count FROM submit_permits WHERE job_id=? AND consumed_at IS NOT NULL").get(job.id);
    assert.equal(Number(consumed.count), 1);
    assert.equal(store.requireJob(job.id).executionKind, "monitor_only");
  });
});

test("state waiters sleep until a committed change instead of polling", async () => {
  await withStore(async (store) => {
    const created = store.createJob(input()).job;
    const waiting = store.waitForChange(2_000);
    setTimeout(() => store.transition(created.id, "snapshotted"), 25);
    const changed = await waiting;
    assert.equal(changed.id, created.id);
    assert.equal(changed.state, "snapshotted");
  });
});

test("response recovery linkage and retry limits survive a database reopen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-state-"));
  const databasePath = path.join(directory, "state.sqlite");
  let store = await new StateStore(databasePath).open();
  try {
    const root = store.createJob(input({
      request: { responseFailurePolicy: "retry-once" },
      maxAutomaticResponseRetries: 1,
    })).job;
    const child = store.createJob(input({
      parentJobId: root.id,
      rootJobId: root.id,
      retryAttempt: 1,
      maxAutomaticResponseRetries: 0,
    })).job;
    store.transition(root.id, "response_failed", {
      replacementJobId: child.id,
      responseDisposition: "reasoning_stopped",
      responseFailure: { code: "PRO_REASONING_STOPPED", retryable: true },
    });
    store.close();
    store = await new StateStore(databasePath).open();
    const reopened = store.requireJob(root.id);
    assert.equal(reopened.replacementJobId, child.id);
    assert.equal(reopened.maxAutomaticResponseRetries, 1);
    assert.equal(store.activeJob(root.id).id, child.id);
    assert.deepEqual(store.jobChain(root.id).map((job) => job.id), [root.id, child.id]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
