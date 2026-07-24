import test from "node:test";
import assert from "node:assert/strict";
import { modelLabelIsProForTest } from "../src/model.mjs";
import { normalizeSemanticText, semanticTextHash } from "../src/firefox.mjs";
import { createSession, writeSessionFile } from "../src/sessions.mjs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("semantic normalization preserves meaning while normalizing browser line boundaries", () => {
  const left = "cafe\u0301\r\nline\u00a0two";
  const right = "caf\u00e9\nline two";
  assert.equal(normalizeSemanticText(left), normalizeSemanticText(right));
  assert.equal(semanticTextHash(left), semanticTextHash(right));
  assert.notEqual(semanticTextHash("full prompt"), semanticTextHash("full prom"));
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
