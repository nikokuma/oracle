import test from "node:test";
import assert from "node:assert/strict";
import { modelLabelIsProForTest } from "../src/model.mjs";
import {
  correlatedUserTurnIndex,
  normalizeSemanticText,
  semanticMismatchDetails,
  semanticTextHash,
} from "../src/firefox.mjs";
import { createSession, writeSessionFile } from "../src/sessions.mjs";
import { executeJob } from "../src/workflow.mjs";
import { StateStore } from "../src/state-store.mjs";
import { Coordinator } from "../src/coordinator.mjs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("semantic normalization preserves meaning while normalizing browser line boundaries", () => {
  const left = "cafe\u0301\r\nline\u00a0two";
  const right = "caf\u00e9\nline two";
  assert.equal(normalizeSemanticText(left), normalizeSemanticText(right));
  assert.equal(semanticTextHash(left), semanticTextHash(right));
  assert.equal(semanticTextHash("left\tcenter\tright"), semanticTextHash("left    center    right"));
  assert.notEqual(semanticTextHash("left\tcenter"), semanticTextHash("left   center"));
  assert.notEqual(semanticTextHash("full prompt"), semanticTextHash("full prom"));
  assert.deepEqual(semanticMismatchDetails("1. Alpha", "Alpha"), {
    exactMatch: false,
    firstMismatch: 0,
    expectedCodePoint: "31",
    observedCodePoint: "41",
    expectedNormalizedLength: 8,
    observedNormalizedLength: 5,
  });
});

test("exact-turn correlation accepts ID-only proof and refuses ambiguous hash fallback", () => {
  const turns = [
    { role: "user", id: "first-user", text: "duplicate", attachments: [] },
    { role: "assistant", id: "first-answer", text: "first" },
    { role: "user", id: "second-user", text: "duplicate", attachments: [] },
  ];
  assert.equal(correlatedUserTurnIndex(turns, { id: "second-user" }), 2);
  assert.equal(correlatedUserTurnIndex(turns, { hash: semanticTextHash("duplicate") }), -1);
  assert.equal(correlatedUserTurnIndex([
    { role: "user", id: null, text: "unique", attachments: ["oracle-context.md"] },
  ], {
    hash: semanticTextHash("unique"),
    attachments: ["oracle-context.md"],
  }), 0);
  assert.equal(correlatedUserTurnIndex([
    { role: "user", id: null, text: "unique", attachments: ["foreign.md"] },
  ], {
    hash: semanticTextHash("unique"),
    attachments: ["oracle-context.md"],
  }), -1);
});

test("Pro label verification rejects Thinking and legacy variants", () => {
  assert.equal(modelLabelIsProForTest("Pro"), true);
  assert.equal(modelLabelIsProForTest("GPT-5.5 Pro Extended"), true);
  assert.equal(modelLabelIsProForTest("Thinking Pro"), false);
  assert.equal(modelLabelIsProForTest("GPT-5.4 Pro"), false);
});

test("session identifiers are opaque UUIDs and files are atomically private", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-session-home-"));
  const previous = process.env.ORACLE_FIREFOX_HOME;
  process.env.ORACLE_FIREFOX_HOME = root;
  try {
    const session = await createSession("this prompt must not appear");
    assert.match(session.id, /^[0-9a-f-]{36}$/u);
    assert.doesNotMatch(session.id, /prompt/u);
    const target = await writeSessionFile(session, "metadata.json", "{\"ok\":true}\n");
    assert.equal(await readFile(target, "utf8"), "{\"ok\":true}\n");
    assert.equal((await stat(session.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.ORACLE_FIREFOX_HOME;
    else process.env.ORACLE_FIREFOX_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a pre-lease navigation failure becomes one durable terminal result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-prelease-failure-"));
  const sessionPath = path.join(root, "session");
  const requestPath = path.join(sessionPath, "request.md");
  await mkdir(sessionPath, { recursive: true });
  await writeFile(requestPath, "authorized prompt\n");
  const store = await new StateStore(path.join(root, "state.sqlite")).open();
  let releases = 0;
  try {
    const created = store.createJob({
      authorizationId: crypto.randomUUID(),
      operation: "continue_chat",
      request: {
        requestPath,
        conversationUrl: "https://chatgpt.com/c/prelease-fixture",
        responseTimeoutSeconds: 600,
        attachmentTimeoutSeconds: 60,
        modelRequirement: "pro",
        zipAttachments: [],
      },
      conversationKey: "https://chatgpt.com/c/prelease-fixture",
      conversationUrl: "https://chatgpt.com/c/prelease-fixture",
      sessionPath,
    }).job;
    store.transition(created.id, "snapshotted");
    store.transition(created.id, "queued");
    const failure = Object.assign(new Error("browser recovery exhausted"), {
      code: "BROWSER_PAGE_OPEN_FAILED",
      safeToRetry: false,
      submissionMayHaveOccurred: false,
    });
    await assert.rejects(
      () => executeJob({
        jobId: created.id,
        store,
        browserManager: {
          async leasePage() { throw failure; },
          async releasePage() { releases += 1; },
        },
      }),
      (error) => error === failure,
    );
    const durable = store.requireJob(created.id);
    assert.equal(durable.state, "failed_pre_submit");
    assert.equal(durable.submissionMayHaveOccurred, false);
    assert.equal(durable.error.code, "BROWSER_PAGE_OPEN_FAILED");
    assert.equal(releases, 0);
    const metadata = JSON.parse(await readFile(path.join(sessionPath, "metadata.json"), "utf8"));
    assert.equal(metadata.state, "failed_pre_submit");
    assert.equal(metadata.error.code, "BROWSER_PAGE_OPEN_FAILED");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function createMonitorJob(store, { sessionPath, conversationUrl }) {
  const created = store.createJob({
    authorizationId: crypto.randomUUID(),
    operation: "continue_chat",
    request: {
      browser: "firefox",
      responseTimeoutSeconds: 300,
      attachmentTimeoutSeconds: 60,
      responseFailurePolicy: "report",
      zipAttachments: [],
    },
    conversationKey: conversationUrl,
    conversationUrl,
    sessionPath,
  }).job;
  for (const state of ["snapshotted", "queued", "page_leased", "target_verified", "attachment_processing", "composer_verified", "model_verified", "submit_intent"]) {
    store.transition(created.id, state, state === "submit_intent" ? { submittedMessageHash: "monitor-user-hash" } : {});
  }
  store.transition(created.id, "user_turn_confirmed", {
    userTurnId: "monitor-user-turn",
    userTurnHash: "monitor-user-hash",
  });
  store.transition(created.id, "awaiting_response");
  return store.requireJob(created.id);
}

test("monitor-only execution is isolated from every write path and performs zero Send calls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-monitor-isolation-"));
  const sessionPath = path.join(root, "session");
  await mkdir(sessionPath, { recursive: true });
  const store = await new StateStore(path.join(root, "state.sqlite")).open();
  let trustedActions = 0;
  let inputFocusActions = 0;
  let submitPermits = 0;
  let releases = 0;
  try {
    const job = await createMonitorJob(store, {
      sessionPath,
      conversationUrl: "https://chatgpt.com/c/monitor-isolation",
    });
    const claim = store.claimRunnable(job.id);
    assert.equal(claim.executionKind, "monitor_only");
    const result = await executeJob({
      jobId: job.id,
      store,
      executionClaim: claim,
      beforeSubmit: async () => { submitPermits += 1; throw new Error("submit permit reached"); },
      browserManager: {
        async leasePage() { return { page: {} }; },
        async releasePage() { releases += 1; },
        async withTrustedAction() { trustedActions += 1; throw new Error("Send reached"); },
        async withInputFocus() { inputFocusActions += 1; throw new Error("composer reached"); },
      },
      monitorDependencies: {
        authenticate: async () => {},
        openConversation: async () => ({ url: job.conversationUrl }),
        waitForResponse: async () => ({
          assistantTurn: { id: null, text: "Recovered exact answer." },
          text: "Recovered exact answer.",
          responseFailure: null,
          exactTurnBinding: true,
        }),
      },
    });
    assert.equal(result.state, "completed");
    assert.equal(store.requireJob(job.id).assistantTurnId, null);
    assert.equal(store.requireJob(job.id).assistantTurnHash, semanticTextHash("Recovered exact answer."));
    assert.equal(trustedActions, 0, "monitor recovery must make zero Send calls");
    assert.equal(inputFocusActions, 0);
    assert.equal(submitPermits, 0);
    assert.equal(releases, 1);
    assert.equal(await readFile(path.join(sessionPath, "response.md"), "utf8"), "Recovered exact answer.\n");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("expired monitor lease, authentication, and navigation failures do not consume final reconciliation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-monitor-backoff-"));
  const sessionPath = path.join(root, "session");
  await mkdir(sessionPath, { recursive: true });
  const store = await new StateStore(path.join(root, "state.sqlite")).open();
  let failureStage = "lease";
  let releases = 0;
  let reconciliationCalls = 0;
  try {
    const job = await createMonitorJob(store, {
      sessionPath,
      conversationUrl: "https://chatgpt.com/c/monitor-backoff",
    });
    const deadlineAt = new Date(Date.now() - 1_000).toISOString();
    store.db.prepare("UPDATE job_attempts SET monitor_deadline_at=? WHERE job_id=?").run(deadlineAt, job.id);
    const browserManager = {
      async leasePage() {
        if (failureStage === "lease") {
          throw Object.assign(new Error("transient lease failure"), { code: "BROWSER_PAGE_OPEN_FAILED", safeToRetry: true });
        }
        return { page: {} };
      },
      async releasePage() { releases += 1; },
      async withTrustedAction() { throw new Error("Send reached"); },
      async withInputFocus() { throw new Error("composer reached"); },
    };
    const monitorDependencies = {
      async authenticate() {
        if (failureStage === "authentication") {
          throw Object.assign(new Error("transient authentication failure"), { code: "AUTH_REQUIRED", safeToRetry: true });
        }
      },
      async openConversation() {
        if (failureStage === "navigation") {
          throw Object.assign(new Error("transient navigation failure"), { code: "CHAT_NAVIGATION_FAILED", safeToRetry: true });
        }
      },
      async reconcileResponse() {
        reconciliationCalls += 1;
        return null;
      },
    };
    for (const stage of ["lease", "authentication", "navigation"]) {
      failureStage = stage;
      const claim = store.claimRunnable(job.id);
      assert.equal(claim.executionKind, "monitor_only");
      let failure;
      try {
        await executeJob({
          jobId: job.id,
          store,
          browserManager,
          executionClaim: claim,
          monitorDependencies,
        });
      } catch (error) {
        failure = error;
      }
      assert.ok(failure);
      assert.equal(store.requireJob(job.id).finalReconciliationAttemptedAt, null, stage);
      store.releaseExecutionWithBackoff(claim, failure, { backoffDelays: [1] });
      assert.equal(store.requireJob(job.id).state, "awaiting_response");
      assert.notEqual(store.requireJob(job.id).state, "failed_pre_submit");
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    failureStage = null;
    const finalClaim = store.claimRunnable(job.id);
    await assert.rejects(() => executeJob({
      jobId: job.id,
      store,
      browserManager,
      executionClaim: finalClaim,
      monitorDependencies,
    }));
    const failed = store.requireJob(job.id);
    assert.equal(failed.state, "response_uncertain");
    assert.notEqual(failed.state, "failed_pre_submit");
    assert.ok(failed.finalReconciliationAttemptedAt);
    assert.equal(reconciliationCalls, 1);
    assert.equal(releases, 3);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup repairs terminal artifacts from atomic SQLite proof after the post-commit failpoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-artifact-repair-"));
  const sessionPath = path.join(root, "session");
  const databasePath = path.join(root, "state.sqlite");
  await mkdir(sessionPath, { recursive: true });
  let store = await new StateStore(databasePath).open();
  const priorFailpoint = process.env.ORACLE_FIREFOX_FAILPOINT;
  const priorFailpointMode = process.env.ORACLE_FIREFOX_FAILPOINT_MODE;
  try {
    const job = await createMonitorJob(store, {
      sessionPath,
      conversationUrl: "https://chatgpt.com/c/artifact-repair",
    });
    const claim = store.claimRunnable(job.id);
    process.env.ORACLE_FIREFOX_FAILPOINT = "after_terminal_commit";
    process.env.ORACLE_FIREFOX_FAILPOINT_MODE = "throw";
    await assert.rejects(() => executeJob({
      jobId: job.id,
      store,
      executionClaim: claim,
      browserManager: {
        async leasePage() { return { page: {} }; },
        async releasePage() {},
      },
      monitorDependencies: {
        authenticate: async () => {},
        openConversation: async () => {},
        waitForResponse: async () => ({
          assistantTurn: { id: "repair-assistant-turn", text: "Repair me from SQLite." },
          text: "Repair me from SQLite.",
          responseFailure: null,
          exactTurnBinding: true,
        }),
      },
    }), (error) => error.code === "TEST_FAILPOINT");
    assert.equal(store.requireJob(job.id).state, "completed");
    assert.equal(store.requireJob(job.id).executionState, "released");
    await assert.rejects(() => readFile(path.join(sessionPath, "response.md"), "utf8"), (error) => error.code === "ENOENT");
    store.close();
    if (priorFailpoint === undefined) delete process.env.ORACLE_FIREFOX_FAILPOINT;
    else process.env.ORACLE_FIREFOX_FAILPOINT = priorFailpoint;
    if (priorFailpointMode === undefined) delete process.env.ORACLE_FIREFOX_FAILPOINT_MODE;
    else process.env.ORACLE_FIREFOX_FAILPOINT_MODE = priorFailpointMode;

    store = new StateStore(databasePath);
    const coordinator = new Coordinator({
      store,
      legacyCompletionFiles: false,
      browserManager: { async close() {}, status: () => ({ browserRunning: false }) },
      jobExecutor: async () => { throw new Error("terminal job must not execute"); },
    });
    await coordinator.open();
    assert.equal(await readFile(path.join(sessionPath, "response.md"), "utf8"), "Repair me from SQLite.\n");
    const metadata = JSON.parse(await readFile(path.join(sessionPath, "metadata.json"), "utf8"));
    assert.equal(metadata.answer, "Repair me from SQLite.");
    assert.deepEqual(coordinator.artifactRepair.failed, []);
    assert.equal(coordinator.artifactRepair.repaired.length, 2);
    await coordinator.close();
    store = null;
  } finally {
    if (priorFailpoint === undefined) delete process.env.ORACLE_FIREFOX_FAILPOINT;
    else process.env.ORACLE_FIREFOX_FAILPOINT = priorFailpoint;
    if (priorFailpointMode === undefined) delete process.env.ORACLE_FIREFOX_FAILPOINT_MODE;
    else process.env.ORACLE_FIREFOX_FAILPOINT_MODE = priorFailpointMode;
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
