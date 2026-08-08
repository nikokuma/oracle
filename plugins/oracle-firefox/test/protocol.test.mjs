import test from "node:test";
import assert from "node:assert/strict";
import { createFrameDecoder, encodeFrame, tokensEqual } from "../src/protocol.mjs";
import { canRequestIdleUpgrade, normalizeLegacyBrokerStatus } from "../src/broker-client.mjs";

test("length-prefixed JSON framing survives fragmented and combined chunks", () => {
  const observed = [];
  const decode = createFrameDecoder((value) => observed.push(value), (error) => { throw error; });
  const combined = Buffer.concat([encodeFrame({ one: 1 }), encodeFrame({ two: 2 })]);
  decode(combined.subarray(0, 3));
  decode(combined.subarray(3, 11));
  decode(combined.subarray(11));
  assert.deepEqual(observed, [{ one: 1 }, { two: 2 }]);
});

test("broker token comparison is constant-length and fail-closed", () => {
  assert.equal(tokensEqual("abc", "abc"), true);
  assert.equal(tokensEqual("abc", "abd"), false);
  assert.equal(tokensEqual("", ""), false);
});

test("known legacy status is normalized for directional upgrade without inventing a generation", () => {
  const normalized = normalizeLegacyBrokerStatus({
    protocolVersion: 6,
    buildVersion: "1.4.1",
    pid: 123,
    outstandingJobs: 2,
  }, "/tmp/legacy.sock");
  assert.deepEqual(normalized.protocol, { minimum: 6, maximum: 6 });
  assert.equal(normalized.releaseSequence, 1401);
  assert.equal(normalized.instanceId, "legacy:123:/tmp/legacy.sock");
  assert.equal(normalized.leaseGeneration, 0);
  assert.equal(normalized.legacy, true);
});

test("unknown legacy builds are not assigned an upgrade ordering", () => {
  assert.equal(normalizeLegacyBrokerStatus({ protocolVersion: 5, buildVersion: "dev" }, "fixture").releaseSequence, 0);
});

test("same-protocol upgrade waits for active browser work but preserves durable queued jobs", () => {
  const hello = { releaseSequence: 1600 };
  assert.equal(canRequestIdleUpgrade(hello, {
    activeJobCount: 0,
    outstandingJobs: 3,
    draining: false,
    browser: { pagesLeased: 0, maintenance: false },
  }), true);
  assert.equal(canRequestIdleUpgrade(hello, {
    activeJobCount: 1,
    outstandingJobs: 1,
    draining: false,
    browser: { pagesLeased: 1, maintenance: false },
  }), false);
  assert.equal(canRequestIdleUpgrade(hello, {
    activeJobCount: 0,
    outstandingJobs: 0,
    draining: false,
    browser: { pagesLeased: 0, maintenance: true },
  }), false);
  assert.equal(canRequestIdleUpgrade(hello, {
    activeJobCount: 0,
    outstandingJobs: 0,
    draining: true,
    browser: { pagesLeased: 0, maintenance: false },
  }), false);
});
