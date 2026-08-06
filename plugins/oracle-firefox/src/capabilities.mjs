import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { codedError } from "./errors.mjs";

const CAPABILITY_VERSION = "ofx1";
const SECRET_BYTES = 32;
const KINDS = new Set(["session", "read", "control", "subscription", "admin"]);

function equalHex(left, right) {
  const a = Buffer.from(String(left || ""), "hex");
  const b = Buffer.from(String(right || ""), "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function hashCapabilitySecret(secret) {
  return createHash("sha256").update(String(secret), "utf8").digest("hex");
}

export function mintCapability(kind, subjectId) {
  if (!KINDS.has(kind)) throw new Error(`Unsupported Oracle capability kind: ${kind}`);
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return {
    kind,
    subjectId,
    secret,
    hash: hashCapabilitySecret(secret),
    handle: `${CAPABILITY_VERSION}.${kind}.${subjectId}.${secret}`,
  };
}

export function parseCapability(handle, expectedKind = null) {
  const value = String(handle || "");
  const [version, kind, subjectId, secret, ...extra] = value.split(".");
  if (
    version !== CAPABILITY_VERSION ||
    !KINDS.has(kind) ||
    !subjectId ||
    !secret ||
    extra.length ||
    (expectedKind && kind !== expectedKind)
  ) {
    return null;
  }
  return { kind, subjectId, secret, hash: hashCapabilitySecret(secret) };
}

export function verifyCapability(handle, expectedHash, { kind, subjectId } = {}) {
  const parsed = parseCapability(handle, kind);
  return Boolean(
    parsed &&
    (!subjectId || parsed.subjectId === subjectId) &&
    equalHex(parsed.hash, expectedHash),
  );
}

export function requireCapability(handle, expectedHash, options = {}) {
  if (!verifyCapability(handle, expectedHash, options)) {
    throw codedError("JOB_NOT_FOUND", "No accessible Oracle Firefox job matches that reference.");
  }
  return parseCapability(handle, options.kind);
}

export function redactCapabilityText(value) {
  return String(value ?? "").replace(/ofx1\.(?:session|read|control|subscription|admin)\.[^.\s]+\.[A-Za-z0-9_-]+/gu, "[REDACTED_CAPABILITY]");
}

export const CAPABILITY_SECRET_BYTES = SECRET_BYTES;
