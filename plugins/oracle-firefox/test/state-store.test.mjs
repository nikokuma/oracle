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
    assert.doesNotThrow(() => store.createJob(input({ conversationKey: original.conversationKey })));
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
        assert.equal(recovered.state, "queued", entry.crashedAt);
        assert.equal(recovered.recoveryAction, "reattach submitted turn without resending");
        assert.ok(recovered.userTurnHash);
      }
    }
  });
});
