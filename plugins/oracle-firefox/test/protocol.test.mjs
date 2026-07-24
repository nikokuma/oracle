import test from "node:test";
import assert from "node:assert/strict";
import { createFrameDecoder, encodeFrame, tokensEqual } from "../src/protocol.mjs";

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
