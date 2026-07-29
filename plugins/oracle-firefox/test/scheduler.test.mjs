import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

function queue(store, key) {
  const created = store.createJob({
    authorizationId: crypto.randomUUID(),
    operation: "continue_chat",
    request: {},
    conversationKey: key,
    sessionPath: "/tmp/test-session",
  }).job;
  store.transition(created.id, "snapshotted");
  return store.transition(created.id, "queued");
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
    const creator = queue(store, "new-standalone");
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

test("retry-once creates one durable child continuation and one root completion record", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  const sessionPath = path.join(directory, "session");
  await mkdir(sessionPath, { recursive: true });
  const coordinator = new Coordinator({
    store,
    browserManager: fakeBrowser,
    jobExecutor: async ({ jobId, store: state }) => {
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
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
