import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLocalDataReply,
  deriveEvidenceAuthorizationId,
  LOCAL_DATA_SENTINEL,
  parseLocalDataRequest,
  scanEvidenceForSecrets,
  withLocalDataProtocol,
} from "../src/evidence.mjs";

test("parses a strict safe local-data request", () => {
  const parsed = parseLocalDataRequest(`Need evidence.\nORACLE_LOCAL_DATA_REQUEST_V1\n\`\`\`json\n{"requestId":"r1","requests":[{"id":"node","fact":"Installed Node version","why":"Determines sqlite support","suggestedReadOnlyCheck":"node --version"}]}\n\`\`\``);
  assert.equal(parsed.requestId, "r1");
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
  assert.match(withLocalDataProtocol("Review this"), /ORACLE_LOCAL_DATA_REQUEST_V1/u);
  assert.match(withLocalDataProtocol("Review this"), /Do not guess/u);
});
