import { createHash } from "node:crypto";
import { codedError } from "./errors.mjs";

export const LOCAL_DATA_SENTINEL = "ORACLE_LOCAL_DATA_REQUEST_V1";
export const LOCAL_DATA_PROTOCOL_VERSION = 1;

const LOCAL_DATA_NONCE_PATTERN = /^[a-f0-9]{32}$/u;
const LOCAL_DATA_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/iu;
const TEMPLATE_PLACEHOLDERS = new Set([
  "short-stable-id",
  "fact-id",
  "exact fact needed",
  "why it changes the answer",
  "a safe read-only check",
]);

export function deriveLocalDataNonce(rootAuthorizationId) {
  return createHash("sha256")
    .update(`oracle-local-data-nonce-v1:${String(rootAuthorizationId)}`)
    .digest("hex")
    .slice(0, 32);
}

export function localDataProtocol(nonce) {
  if (!LOCAL_DATA_NONCE_PATTERN.test(String(nonce || ""))) {
    throw codedError("LOCAL_DATA_NONCE_REQUIRED", "Oracle requires a per-job local-data nonce before preparing a prompt.");
  }
  return `
When forming conclusions, label material claims as verified, inferred, or proposed.
Do not guess when a material conclusion depends on facts that are only available in the local workspace or runtime.
If local facts are required, stop and end your response with exactly one ${LOCAL_DATA_SENTINEL} JSON block using this nonce and shape:
{
  "version": ${LOCAL_DATA_PROTOCOL_VERSION},
  "oracleNonce": "${nonce}",
  "requestId": "short-stable-id",
  "requests": [
    { "id": "fact-id", "fact": "exact fact needed", "why": "why it changes the answer", "suggestedReadOnlyCheck": "a safe read-only check" }
  ]
}
Replace every descriptive placeholder with a concrete value. Never repeat this example as an answer.
Never request credentials, cookies, tokens, passwords, private keys, browser-profile contents, unrelated chats, or unrelated private files. Do not request writes or state changes.
`.trim();
}

// Documentation/tests may inspect the canonical shape; live prompts always use a
// distinct derived nonce through withLocalDataProtocol().
export const LOCAL_DATA_PROTOCOL = localDataProtocol("00000000000000000000000000000000");

export function withLocalDataProtocol(prompt, nonce) {
  return `${String(prompt).trim()}\n\n[ORACLE LOCAL DATA PROTOCOL]\n${localDataProtocol(nonce)}`;
}

function extractTerminalJson(text) {
  const source = String(text ?? "").trimEnd();
  const marker = source.lastIndexOf(LOCAL_DATA_SENTINEL);
  if (marker < 0) return null;
  if (marker > 0 && source[marker - 1] !== "\n" && source[marker - 1] !== "\r") return null;
  const tail = source.slice(marker + LOCAL_DATA_SENTINEL.length);
  const fenced = tail.match(/^\s*```(?:json)?\s*([\s\S]*?)```\s*$/iu);
  if (fenced) return fenced[1];
  const firstBrace = tail.indexOf("{");
  if (firstBrace < 0 || tail.slice(0, firstBrace).trim()) return null;
  const candidate = tail.slice(firstBrace);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let index = 0; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (start < 0) {
      if (char === "{") { start = index; depth = 1; }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        if (candidate.slice(index + 1).trim()) return null;
        return candidate.slice(start, index + 1);
      }
    }
  }
  return candidate;
}

export function isTemplateLocalDataRequest(value) {
  if (!value || typeof value !== "object") return false;
  if (TEMPLATE_PLACEHOLDERS.has(String(value.requestId || "").trim().toLowerCase())) return true;
  return Array.isArray(value.requests) && value.requests.some((request) =>
    request && [request.id, request.fact, request.why, request.suggestedReadOnlyCheck]
      .some((entry) => TEMPLATE_PLACEHOLDERS.has(String(entry || "").trim().toLowerCase())),
  );
}

export function parseLocalDataRequest(text, { expectedNonce = null } = {}) {
  const raw = extractTerminalJson(text);
  if (!raw) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw codedError("LOCAL_DATA_REQUEST_INVALID", `${LOCAL_DATA_SENTINEL} contained invalid JSON.`);
  }
  if (!value || typeof value !== "object") {
    throw codedError("LOCAL_DATA_REQUEST_INVALID", `${LOCAL_DATA_SENTINEL} did not match the required schema.`);
  }
  // The protocol contains a descriptive example. An echoed example is ordinary
  // assistant prose, never a durable request that may occupy a conversation lane.
  if (isTemplateLocalDataRequest(value)) return null;
  if (expectedNonce && (
    value.version !== LOCAL_DATA_PROTOCOL_VERSION ||
    value.oracleNonce !== expectedNonce
  )) return null;
  if (value.oracleNonce != null && !LOCAL_DATA_NONCE_PATTERN.test(String(value.oracleNonce))) {
    throw codedError("LOCAL_DATA_REQUEST_INVALID", `${LOCAL_DATA_SENTINEL} contained an invalid Oracle nonce.`);
  }
  if (
    typeof value.requestId !== "string" ||
    !value.requestId.trim() ||
    !LOCAL_DATA_ID_PATTERN.test(value.requestId.trim()) ||
    !Array.isArray(value.requests) ||
    value.requests.length < 1 ||
    value.requests.length > 20
  ) {
    throw codedError("LOCAL_DATA_REQUEST_INVALID", `${LOCAL_DATA_SENTINEL} did not match the required schema.`);
  }
  const requests = value.requests.map((request) => {
    if (
      !request ||
      ![request.id, request.fact, request.why, request.suggestedReadOnlyCheck].every((entry) => typeof entry === "string" && entry.trim()) ||
      !LOCAL_DATA_ID_PATTERN.test(request.id.trim())
    ) {
      throw codedError("LOCAL_DATA_REQUEST_INVALID", `${LOCAL_DATA_SENTINEL} contains an incomplete fact request.`);
    }
    return {
      id: request.id.trim(),
      fact: request.fact.trim(),
      why: request.why.trim(),
      suggestedReadOnlyCheck: request.suggestedReadOnlyCheck.trim(),
    };
  });
  const requestIds = requests.map((request) => request.id);
  if (new Set(requestIds).size !== requestIds.length) {
    throw codedError("LOCAL_DATA_REQUEST_INVALID", `${LOCAL_DATA_SENTINEL} contains duplicate fact ids.`);
  }
  const prohibited = /\b(password|credential|cookie|token|private key|secret|browser profile|unrelated chat|write|delete|modify|install|send)\b/iu;
  const unsafe = requests.find((request) => prohibited.test(`${request.fact} ${request.suggestedReadOnlyCheck}`));
  return {
    version: LOCAL_DATA_PROTOCOL_VERSION,
    oracleNonce: value.oracleNonce ?? null,
    requestId: value.requestId.trim(),
    requests,
    safeReadOnly: !unsafe,
    unsafeRequestId: unsafe?.id ?? null,
  };
}

export function scanEvidenceForSecrets(value) {
  const serialized = JSON.stringify(value);
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/u,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
    /\bAIza[A-Za-z0-9_-]{30,}\b/u,
    /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/u,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/u,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
    /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/iu,
    /\b(?:session|auth)[_-]?cookie\s*[:=]/iu,
  ];
  return patterns.some((pattern) => pattern.test(serialized));
}

export function buildLocalDataReply({ request, facts = [], unavailable = [] }) {
  if (!request?.requestId) throw codedError("LOCAL_DATA_REQUEST_REQUIRED", "A parsed local-data request is required.");
  const payload = {
    protocol: "ORACLE_LOCAL_DATA_RESPONSE_V1",
    ...(request.oracleNonce ? { oracleNonce: request.oracleNonce } : {}),
    requestId: request.requestId,
    facts: facts.map((fact) => ({ id: String(fact.id), value: fact.value, source: String(fact.source || "read-only local check") })),
    unavailable: unavailable.map((item) => ({ id: String(item.id), reason: String(item.reason) })),
  };
  if (scanEvidenceForSecrets(payload)) {
    throw codedError("SENSITIVE_EVIDENCE_REJECTED", "Local evidence appears to contain a secret or credential and was not sent.");
  }
  return `ORACLE_LOCAL_DATA_RESPONSE_V1\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

export function deriveEvidenceAuthorizationId(parentAuthorizationId, round) {
  const hex = createHash("sha256").update(`${parentAuthorizationId}:evidence:${round}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function deriveResponseRecoveryAuthorizationId(rootAuthorizationId, attempt) {
  const hex = createHash("sha256").update(`${rootAuthorizationId}:response-recovery:${attempt}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
