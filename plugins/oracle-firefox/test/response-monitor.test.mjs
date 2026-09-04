import test from "node:test";
import assert from "node:assert/strict";
import { waitForAssistantAfterTurn } from "../src/firefox.mjs";

test("three hours of unfinished reasoning stays bounded and never fetches response content", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let probes = 0;
  let contentReads = 0;
  const page = { evaluate: async (_fn, options) => {
    probes += 1;
    if (options.include) contentReads += 1;
    return {
      userMatchCount: 1, assistantCount: 1, stopVisible: true,
      assistant: { id: "answer", hash: `stream-${probes}`, textLength: probes, completionVisible: false, errorIndicators: [] },
    };
  } };
  let finished = false;
  const result = assert.rejects(
    waitForAssistantAfterTurn(page, { id: "submitted-user" }),
    (error) => error.code === "RESPONSE_TIMEOUT" && error.submissionMayHaveOccurred,
  ).finally(() => { finished = true; });
  for (let seconds = 0; !finished && seconds <= 10_810; seconds += 2) {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    t.mock.timers.tick(2_000);
  }
  assert.equal(finished, true);
  await result;
  assert.ok(probes >= 5_000 && probes <= 5_401, `unexpected probe count: ${probes}`);
  assert.equal(contentReads, 0);
});
