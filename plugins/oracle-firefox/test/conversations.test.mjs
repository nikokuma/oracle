import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findConversationCandidates,
  launchFirefox,
  normalizeConversationUrl,
  selectUniqueConversationCandidate,
} from "../src/firefox.mjs";

test("normalizes and validates ChatGPT conversation URLs", () => {
  assert.equal(
    normalizeConversationUrl(
      "https://chatgpt.com/c/6a628f53-0450-83ea-94d9-c0626ccf2cdc?messageId=finalAgentTurnStart",
    ),
    "https://chatgpt.com/c/6a628f53-0450-83ea-94d9-c0626ccf2cdc",
  );
  assert.throws(() => normalizeConversationUrl("https://example.com/c/not-chatgpt"), /must be an/);
});

test("finds only exact existing-chat titles and fails closed on ambiguity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-conversations-"));
  const browser = await launchFirefox({ headless: true, profileDir: path.join(directory, "profile") });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <a href="https://chatgpt.com/c/first-id"> Firefox compatibility   plan </a>
      <a href="https://chatgpt.com/c/second-id">Firefox compatibility planning</a>`);
    let candidates = await findConversationCandidates(page, "Firefox compatibility plan");
    assert.deepEqual(candidates, [
      { title: "Firefox compatibility plan", url: "https://chatgpt.com/c/first-id" },
    ]);
    assert.deepEqual(selectUniqueConversationCandidate(candidates, "Firefox compatibility plan"), candidates[0]);

    await page.evaluate(() => {
      const duplicate = document.createElement("a");
      duplicate.href = "https://chatgpt.com/c/duplicate-id";
      duplicate.textContent = "Firefox compatibility plan";
      document.body.appendChild(duplicate);
    });
    candidates = await findConversationCandidates(page, "Firefox compatibility plan");
    assert.throws(
      () => selectUniqueConversationCandidate(candidates, "Firefox compatibility plan"),
      /More than one ChatGPT conversation/,
    );
  } finally {
    await browser.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
