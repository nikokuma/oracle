import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLocalDataReply,
  deriveLocalDataNonce,
  deriveEvidenceAuthorizationId,
  LOCAL_DATA_SENTINEL,
  parseLocalDataRequest,
  scanEvidenceForSecrets,
  withLocalDataProtocol,
} from "../src/evidence.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";

test("parses a strict safe local-data request", () => {
  const parsed = parseLocalDataRequest(`Need evidence.\nORACLE_LOCAL_DATA_REQUEST_V1\n\`\`\`json\n{"version":1,"oracleNonce":"${NONCE}","requestId":"r1","requests":[{"id":"node","fact":"Installed Node version","why":"Determines sqlite support","suggestedReadOnlyCheck":"node --version"}]}\n\`\`\``, { expectedNonce: NONCE });
  assert.equal(parsed.requestId, "r1");
  assert.equal(parsed.oracleNonce, NONCE);
  assert.equal(parsed.safeReadOnly, true);
  assert.equal(parsed.requests[0].id, "node");
});

test("flags credential and write requests for user approval", () => {
  const parsed = parseLocalDataRequest(`ORACLE_LOCAL_DATA_REQUEST_V1 {"requestId":"r2","requests":[{"id":"secret","fact":"API token","why":"auth","suggestedReadOnlyCheck":"read the secret token"}]}`);
  assert.equal(parsed.safeReadOnly, false);
  assert.equal(parsed.unsafeRequestId, "secret");
});

test("rejects empty request ids and duplicate fact ids", () => {
  const duplicate = `${LOCAL_DATA_SENTINEL}\n\n\`\`\`json\n${JSON.stringify({
    requestId: "round-a",
    requests: [
      { id: "same", fact: "first", why: "needed", suggestedReadOnlyCheck: "rg first" },
      { id: "same", fact: "second", why: "needed", suggestedReadOnlyCheck: "rg second" },
    ],
  })}\n\`\`\``;
  assert.throws(() => parseLocalDataRequest(duplicate), { code: "LOCAL_DATA_REQUEST_INVALID" });

  const empty = `${LOCAL_DATA_SENTINEL}\n\n\`\`\`json\n${JSON.stringify({
    requestId: "  ",
    requests: [{ id: "one", fact: "fact", why: "needed", suggestedReadOnlyCheck: "rg fact" }],
  })}\n\`\`\``;
  assert.throws(() => parseLocalDataRequest(empty), { code: "LOCAL_DATA_REQUEST_INVALID" });
});

test("secret scanning rejects evidence and authorizations are deterministic UUIDs", () => {
  assert.equal(scanEvidenceForSecrets({ value: "api_key=abcdefghijk12345" }), true);
  assert.equal(scanEvidenceForSecrets({ value: "github_pat_1234567890abcdefghijklmnop" }), true);
  const parent = crypto.randomUUID();
  const first = deriveEvidenceAuthorizationId(parent, 1);
  assert.equal(first, deriveEvidenceAuthorizationId(parent, 1));
  assert.match(first, /^[0-9a-f-]{36}$/u);
  assert.throws(() => buildLocalDataReply({ request: { requestId: "r" }, facts: [{ id: "x", value: "token=abcdefghijk12345" }] }));
});

test("initial prompts clearly install the local-data protocol", () => {
  const nonce = deriveLocalDataNonce(crypto.randomUUID());
  assert.match(withLocalDataProtocol("Review this", nonce), /ORACLE_LOCAL_DATA_REQUEST_V1/u);
  assert.match(withLocalDataProtocol("Review this", nonce), /Do not guess/u);
  assert.match(withLocalDataProtocol("Review this", nonce), new RegExp(nonce, "u"));
  assert.equal(nonce.length, 32);
});

test("ignores the echoed protocol template, nonterminal examples, and foreign nonces", () => {
  const echoedTemplate = `Explanation.\n${LOCAL_DATA_SENTINEL}\n\`\`\`json\n${JSON.stringify({
    version: 1,
    oracleNonce: NONCE,
    requestId: "short-stable-id",
    requests: [{
      id: "fact-id",
      fact: "exact fact needed",
      why: "why it changes the answer",
      suggestedReadOnlyCheck: "a safe read-only check",
    }],
  })}\n\`\`\``;
  assert.equal(parseLocalDataRequest(echoedTemplate, { expectedNonce: NONCE }), null);

  const concrete = `${LOCAL_DATA_SENTINEL}\n${JSON.stringify({
    version: 1,
    oracleNonce: NONCE,
    requestId: "runtime-check",
    requests: [{ id: "node", fact: "Node version", why: "SQLite support", suggestedReadOnlyCheck: "node --version" }],
  })}`;
  assert.equal(parseLocalDataRequest(`${concrete}\nThis block was only an example.`, { expectedNonce: NONCE }), null);
  assert.equal(parseLocalDataRequest(concrete, { expectedNonce: "fedcba9876543210fedcba9876543210" }), null);
});

test("legacy concrete requests remain readable without a nonce", () => {
  const parsed = parseLocalDataRequest(`${LOCAL_DATA_SENTINEL}\n{"requestId":"legacy-check","requests":[{"id":"runtime","fact":"Runtime version","why":"Compatibility","suggestedReadOnlyCheck":"node --version"}]}`);
  assert.equal(parsed.requestId, "legacy-check");
  assert.equal(parsed.oracleNonce, null);
});
