import { createHash } from "node:crypto";
import { codedError } from "./errors.mjs";

export const LOCAL_DATA_SENTINEL = "ORACLE_LOCAL_DATA_REQUEST_V1";

export const LOCAL_DATA_PROTOCOL = `
When forming conclusions, label material claims as verified, inferred, or proposed.
Do not guess when a material conclusion depends on facts that are only available in the local workspace or runtime.
If local facts are required, stop and return exactly one ${LOCAL_DATA_SENTINEL} JSON block with this shape:
{
  "requestId": "short-stable-id",
  "requests": [
    { "id": "fact-id", "fact": "exact fact needed", "why": "why it changes the answer", "suggestedReadOnlyCheck": "a safe read-only check" }
  ]
}
Never request credentials, cookies, tokens, passwords, private keys, browser-profile contents, unrelated chats, or unrelated private files. Do not request writes or state changes.
`.trim();

export function withLocalDataProtocol(prompt) {
  return `${String(prompt).trim()}\n\n[ORACLE LOCAL DATA PROTOCOL]\n${LOCAL_DATA_PROTOCOL}`;
}

function extractJson(text) {
  const source = String(text ?? "");
  const marker = source.indexOf(LOCAL_DATA_SENTINEL);
  if (marker < 0) return null;
  const tail = source.slice(marker + LOCAL_DATA_SENTINEL.length);
  const fenced = tail.match(/^\s*```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = fenced?.[1] ?? tail.slice(tail.indexOf("{"));
  if (!candidate) return null;
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
      if (depth === 0) return candidate.slice(start, index + 1);
    }
  }
  return null;
}

export function parseLocalDataRequest(text) {
  const raw = extractJson(text);
  if (!raw) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw codedError("LOCAL_DATA_REQUEST_INVALID", `${LOCAL_DATA_SENTINEL} contained invalid JSON.`);
  }
  if (
    !value ||
    typeof value.requestId !== "string" ||
    !value.requestId.trim() ||
    !Array.isArray(value.requests) ||
    value.requests.length < 1 ||
    value.requests.length > 20
  ) {
    throw codedError("LOCAL_DATA_REQUEST_INVALID", `${LOCAL_DATA_SENTINEL} did not match the required schema.`);
  }
  const requests = value.requests.map((request) => {
    if (!request || ![request.id, request.fact, request.why, request.suggestedReadOnlyCheck].every((entry) => typeof entry === "string" && entry.trim())) {
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
  return { version: 1, requestId: value.requestId.trim(), requests, safeReadOnly: !unsafe, unsafeRequestId: unsafe?.id ?? null };
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
