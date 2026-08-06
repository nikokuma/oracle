import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function jsonMac(value, token) {
  return createHmac("sha256", token).update(canonicalJson(value)).digest("hex");
}

export function verifyJsonMac(value, token, expected) {
  const actual = Buffer.from(jsonMac(value, token));
  const candidate = Buffer.from(String(expected || ""));
  return actual.length === candidate.length && timingSafeEqual(actual, candidate);
}

export async function writeAtomicJson(target, value, { mode = 0o600 } = {}) {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
    await chmod(target, mode);
    const directoryHandle = await open(directory, "r").catch(() => null);
    try { await directoryHandle?.sync(); } finally { await directoryHandle?.close(); }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return target;
}

export async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

export async function writeSignedJson(target, value, token) {
  const unsigned = { ...value };
  delete unsigned.mac;
  return writeAtomicJson(target, { ...unsigned, mac: `hmac-sha256:${jsonMac(unsigned, token)}` });
}

export async function readSignedJson(target, token) {
  const value = await readJson(target);
  const unsigned = { ...value };
  const encoded = String(unsigned.mac || "");
  delete unsigned.mac;
  if (!encoded.startsWith("hmac-sha256:") || !verifyJsonMac(unsigned, token, encoded.slice(12))) {
    const error = new Error(`Invalid authenticated JSON at ${target}`);
    error.code = "AUTHENTICATED_JSON_INVALID";
    throw error;
  }
  return value;
}
