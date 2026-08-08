import test from "node:test";
import assert from "node:assert/strict";
import { modelLabelIsProForTest } from "../src/model.mjs";
import { normalizeSemanticText, semanticMismatchDetails, semanticTextHash } from "../src/firefox.mjs";
import { createSession, writeSessionFile } from "../src/sessions.mjs";
import { executeJob } from "../src/workflow.mjs";
import { StateStore } from "../src/state-store.mjs";
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
