#!/usr/bin/env node
import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);

// src/cli.mjs
import { randomUUID as randomUUID6 } from "node:crypto";
import { spawn as spawn2 } from "node:child_process";

// src/broker-client.mjs
import { spawn } from "node:child_process";
import { createHash as createHash5, randomBytes as randomBytes2, randomUUID as randomUUID5 } from "node:crypto";
import { chmod as chmod3, link as link2, mkdir as mkdir4, open as open3, readFile as readFile3, rm as rm3 } from "node:fs/promises";
import path4 from "node:path";
import { fileURLToPath } from "node:url";

// src/generated-build-info.mjs
var GENERATED_BUILD_INFO = Object.freeze({
  "packageVersion": "1.7.0",
  "protocolVersion": 9,
  "minimumReaderProtocol": 8,
  "minimumWriterProtocol": 9,
  "schemaVersion": 8,
  "releaseSequence": 1700,
  "sourceDigest": "5a793ded893553106b214700d502a8bbe88af7e081571805b161c6afd7420ec9",
  "buildId": "oracle-firefox-1.7.0-5a793ded89355310"
});

// src/build-info.mjs
var ORACLE_FIREFOX_VERSION = GENERATED_BUILD_INFO.packageVersion;
var BROKER_PROTOCOL_VERSION = GENERATED_BUILD_INFO.protocolVersion;
var BROKER_MINIMUM_READER_PROTOCOL = GENERATED_BUILD_INFO.minimumReaderProtocol;
var BROKER_MINIMUM_WRITER_PROTOCOL = GENERATED_BUILD_INFO.minimumWriterProtocol;
var BROKER_SCHEMA_VERSION = GENERATED_BUILD_INFO.schemaVersion;
var BROKER_RELEASE_SEQUENCE = GENERATED_BUILD_INFO.releaseSequence;
var BROKER_BUILD_ID = GENERATED_BUILD_INFO.buildId;
var BROKER_SOURCE_DIGEST = GENERATED_BUILD_INFO.sourceDigest;

// src/atomic-json.mjs
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}
function jsonMac(value, token) {
  return createHmac("sha256", token).update(canonicalJson(value)).digest("hex");
}
function verifyJsonMac(value, token, expected) {
  const actual = Buffer.from(jsonMac(value, token));
  const candidate = Buffer.from(String(expected || ""));
  return actual.length === candidate.length && timingSafeEqual(actual, candidate);
}
async function readJson(target2) {
  return JSON.parse(await readFile(target2, "utf8"));
}
async function readSignedJson(target2, token) {
  const value = await readJson(target2);
  const unsigned = { ...value };
  const encoded = String(unsigned.mac || "");
  delete unsigned.mac;
  if (!encoded.startsWith("hmac-sha256:") || !verifyJsonMac(unsigned, token, encoded.slice(12))) {
    const error = new Error(`Invalid authenticated JSON at ${target2}`);
    error.code = "AUTHENTICATED_JSON_INVALID";
    throw error;
  }
  return value;
}

// src/broker-locator.mjs
async function readBrokerLocator(identity, token) {
  try {
    const locator = await readSignedJson(identity.locatorPath, token);
    if (locator.version !== 1 || locator.coordinatorId !== identity.coordinatorId || locator.endpoint?.path !== identity.endpoint) return null;
    return locator;
  } catch {
    return null;
  }
}

// src/broker-lease.mjs
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { lstat, mkdir as mkdir2 } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// src/errors.mjs
var OracleFirefoxError = class extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : void 0);
    this.name = "OracleFirefoxError";
    this.code = code;
    this.jobState = options.jobState ?? null;
    this.safeToRetry = options.safeToRetry ?? false;
    this.submissionMayHaveOccurred = options.submissionMayHaveOccurred ?? false;
    this.recoveryAction = options.recoveryAction ?? null;
    this.details = options.details ?? null;
  }
};
var CAPABILITY_PATTERN = /ofx1\.(?:session|read|control|subscription|receipt|admin)\.[^.\s]+\.[A-Za-z0-9_-]+/gu;
function redact(value) {
  if (typeof value === "string") return value.replace(CAPABILITY_PATTERN, "[REDACTED_CAPABILITY]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  }
  return value;
}
function structuredError(error, fallback = {}) {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    code: value.code || fallback.code || "ORACLE_FIREFOX_ERROR",
    message: redact(value.message),
    jobState: value.jobState ?? fallback.jobState ?? null,
    safeToRetry: value.safeToRetry ?? fallback.safeToRetry ?? false,
    submissionMayHaveOccurred: value.submissionMayHaveOccurred ?? fallback.submissionMayHaveOccurred ?? false,
    recoveryAction: redact(value.recoveryAction ?? fallback.recoveryAction ?? null),
    details: redact(value.details ?? fallback.details ?? null)
  };
}
function codedError(code, message, options) {
  return new OracleFirefoxError(code, message, options);
}

// src/broker-lease.mjs
var execFileAsync = promisify(execFile);
async function assertLeaseTarget(pathname, label) {
  const info = await lstat(pathname).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (info && (info.isSymbolicLink() || !info.isFile())) {
    throw codedError("BROKER_LEASE_PATH_INVALID", `The ${label} lifetime lease path is not a regular file.`);
  }
}
function acquireDatabaseLease(databasePath, label) {
  let db;
  try {
    db = new DatabaseSync(databasePath);
    db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=0;
      CREATE TABLE IF NOT EXISTS lease_guard (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        marker INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO lease_guard(id, marker) VALUES (1, 0);
      BEGIN EXCLUSIVE;
      UPDATE lease_guard SET marker = marker WHERE id = 1;
    `);
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
    }
    throw codedError("BROKER_LEASE_HELD", `Another Oracle Firefox service holds the ${label} lifetime lease.`, {
      safeToRetry: true,
      details: { label },
      cause: error
    });
  }
}
var BrokerLaunchLease = class _BrokerLaunchLease {
  static async acquire(databasePath) {
    await mkdir2(path.dirname(databasePath), { recursive: true, mode: 448 });
    await assertLeaseTarget(databasePath, "broker launch");
    const db = acquireDatabaseLease(databasePath, "broker launch");
    return new _BrokerLaunchLease(db);
  }
  constructor(db) {
    this.db = db;
    this.released = false;
  }
  release() {
    if (this.released) return;
    this.released = true;
    try {
      this.db.exec("ROLLBACK");
    } catch {
    }
    try {
      this.db.close();
    } catch {
    }
  }
};

// src/config.mjs
import { createHash } from "node:crypto";
import os from "node:os";
import path2 from "node:path";
function oracleFirefoxHome() {
  const configured = process.env.ORACLE_FIREFOX_HOME?.trim();
  return configured ? path2.resolve(configured) : path2.join(os.homedir(), ".oracle-firefox");
}
function profileDirectory() {
  return path2.join(oracleFirefoxHome(), "profile");
}
var SUPPORTED_BROWSERS = Object.freeze(["firefox", "chrome", "safari"]);
function coordinatorDirectory() {
  const configured = process.env.ORACLE_FIREFOX_COORDINATOR_HOME?.trim();
  if (configured) return path2.resolve(configured);
  if (process.platform === "darwin") {
    return path2.join(os.homedir(), "Library", "Application Support", "oracle-firefox", "coordinator");
  }
  if (process.platform === "win32") {
    return path2.join(
      process.env.LOCALAPPDATA || path2.join(os.homedir(), "AppData", "Local"),
      "oracle-firefox",
      "coordinator"
    );
  }
  return path2.join(process.env.XDG_STATE_HOME || path2.join(os.homedir(), ".local", "state"), "oracle-firefox", "coordinator");
}
function brokerRuntimeRoot() {
  const configured = process.env.ORACLE_FIREFOX_RUNTIME_ROOT?.trim();
  return configured ? path2.resolve(configured) : "/tmp";
}
function brokerEndpoint(options = {}) {
  if (process.env.ORACLE_FIREFOX_BROKER_ENDPOINT?.trim()) {
    return process.env.ORACLE_FIREFOX_BROKER_ENDPOINT.trim();
  }
  if (process.platform === "win32") {
    const identity2 = options.coordinatorId || createHash("sha256").update(`${coordinatorDirectory()}\0${profileDirectory()}`).digest("hex");
    return `\\\\.\\pipe\\oracle-firefox-${identity2.slice(0, 24)}`;
  }
  if (options.runtimeDirectory) return path2.join(options.runtimeDirectory, "broker.sock");
  const uid = typeof process.getuid === "function" ? process.getuid() : process.env.USER || "user";
  const identity = createHash("sha256").update(`${path2.resolve(coordinatorDirectory())}\0${path2.resolve(profileDirectory())}`).digest("hex");
  return path2.join(brokerRuntimeRoot(), `oracle-firefox-${uid}-${identity.slice(0, 16)}`, "broker.sock");
}
function legacyBrokerEndpoints() {
  if (process.env.ORACLE_FIREFOX_BROKER_ENDPOINT?.trim() || process.env.ORACLE_FIREFOX_DISABLE_LEGACY_DISCOVERY === "1") return [];
  if (process.platform === "win32") {
    return [`\\\\.\\pipe\\oracle-firefox-${process.env.USERNAME || "user"}`];
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : process.env.USER || "user";
  const roots = ["/tmp", os.tmpdir(), process.env.TMPDIR].filter(Boolean).map((entry) => path2.resolve(entry));
  return [...new Set(roots.map((root) => path2.join(root, `oracle-firefox-${uid}`, "broker.sock")))];
}
function brokerCoordinatorIdPath() {
  return path2.join(coordinatorDirectory(), "coordinator.id");
}
function brokerLeaseDatabasePath() {
  return path2.join(coordinatorDirectory(), "broker.lease.sqlite");
}
function profileLeaseDatabasePath() {
  return path2.join(oracleFirefoxHome(), "profile.lease.sqlite");
}
function brokerLocatorPath() {
  return path2.join(coordinatorDirectory(), "broker.locator.json");
}
function brokerTokenPath() {
  return path2.join(coordinatorDirectory(), "broker.token");
}
function coordinatorDatabasePath() {
  return path2.join(coordinatorDirectory(), "coordinator.sqlite");
}
function coordinatorLogPath() {
  return path2.join(coordinatorDirectory(), "broker.log");
}
function brokerLaunchLockPath() {
  return path2.join(coordinatorDirectory(), "broker.start.v2.sqlite");
}
function brokerNodePath() {
  return process.env.ORACLE_FIREFOX_NODE_PATH?.trim() || process.execPath;
}

// src/coordinator-identity.mjs
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import { chmod as chmod2, link, lstat as lstat2, mkdir as mkdir3, open as open2, readFile as readFile2, realpath, rm as rm2, stat } from "node:fs/promises";
import os2 from "node:os";
import path3 from "node:path";
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function digest(value) {
  return createHash2("sha256").update(value).digest("hex");
}
async function ensurePrivateDirectory(directory) {
  await mkdir3(directory, { recursive: true, mode: 448 });
  const info = await lstat2(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw codedError("PRIVATE_DIRECTORY_INVALID", `${directory} must be a private real directory.`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw codedError("PRIVATE_DIRECTORY_OWNER_MISMATCH", `${directory} is not owned by the current user.`);
  }
  await chmod2(directory, 448);
  return realpath(directory);
}
async function canonicalPath(candidate, { directory = false } = {}) {
  if (directory) return ensurePrivateDirectory(candidate);
  const parent = await ensurePrivateDirectory(path3.dirname(candidate));
  return path3.join(parent, path3.basename(candidate));
}
async function canonicalProfilePath(candidate) {
  try {
    const info = await lstat2(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw codedError("PROFILE_PATH_INVALID", `${candidate} must be a private real directory.`);
    }
    return ensurePrivateDirectory(candidate);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return canonicalPath(candidate);
  }
}
async function canonicalRuntimeRoot(candidate) {
  await mkdir3(candidate, { recursive: true });
  const resolved = await realpath(candidate);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw codedError("RUNTIME_ROOT_INVALID", `${candidate} is not a directory.`);
  return resolved;
}
async function readOrCreateCoordinatorUuid() {
  const target2 = brokerCoordinatorIdPath();
  const readExisting = async () => {
    const value2 = (await readFile2(target2, "utf8")).trim();
    if (!UUID_PATTERN.test(value2)) throw codedError("COORDINATOR_ID_INVALID", `Oracle Firefox cannot trust ${target2}.`);
    return value2.toLowerCase();
  };
  try {
    return await readExisting();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw codedError("COORDINATOR_ID_INVALID", `Oracle Firefox cannot trust ${target2}.`, { cause: error });
    }
  }
  const value = randomUUID2();
  const temporary = `${target2}.${process.pid}.${randomUUID2()}.tmp`;
  const handle = await open2(temporary, "wx", 384);
  try {
    try {
      await handle.writeFile(`${value}
`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, target2);
      return value;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return await readExisting();
    }
  } catch (error) {
    try {
      await handle.close();
    } catch {
    }
    throw error;
  } finally {
    await rm2(temporary, { force: true }).catch(() => void 0);
  }
}
async function resolveCoordinatorIdentity() {
  const coordinatorPath = await canonicalPath(coordinatorDirectory(), { directory: true });
  const homePath = await canonicalPath(oracleFirefoxHome(), { directory: true });
  const profilePath = await canonicalProfilePath(profileDirectory());
  const coordinatorUuid = await readOrCreateCoordinatorUuid();
  const userIdentity = typeof process.getuid === "function" ? `uid:${process.getuid()}` : `user:${process.env.USERNAME || process.env.USER || os2.userInfo().username}`;
  const coordinatorId = digest(`${userIdentity}\0${coordinatorPath}\0${profilePath}\0${coordinatorUuid}`);
  const profileId = digest(`${userIdentity}\0${profilePath}`);
  const runtimeRoot = await canonicalRuntimeRoot(brokerRuntimeRoot());
  const runtimeDirectory = await canonicalPath(
    path3.join(runtimeRoot, `oracle-firefox-${userIdentity.replace(/[^a-z0-9_-]/giu, "-")}-${coordinatorId.slice(0, 16)}`),
    { directory: true }
  );
  const endpoint = brokerEndpoint({ runtimeDirectory, coordinatorId });
  if (process.platform !== "win32") {
    const maximumBytes = process.platform === "darwin" ? 103 : 107;
    if (Buffer.byteLength(endpoint) > maximumBytes) {
      throw codedError(
        "BROKER_ENDPOINT_TOO_LONG",
        `The canonical broker socket path is ${Buffer.byteLength(endpoint)} bytes; this platform permits at most ${maximumBytes}. Choose a shorter ORACLE_FIREFOX_RUNTIME_ROOT.`
      );
    }
  }
  const databaseExists = await stat(coordinatorDatabasePath()).then(() => true, () => false);
  return {
    version: 1,
    userIdentity,
    coordinatorUuid,
    coordinatorId,
    profileId,
    coordinatorPath,
    homePath,
    profilePath,
    runtimeRoot,
    runtimeDirectory,
    endpoint,
    legacyEndpoints: legacyBrokerEndpoints().filter((candidate) => candidate !== endpoint),
    locatorPath: brokerLocatorPath(),
    coordinatorLeasePath: brokerLeaseDatabasePath(),
    profileLeasePath: profileLeaseDatabasePath(),
    databasePath: coordinatorDatabasePath(),
    databaseExists
  };
}

// src/capabilities.mjs
import { createHash as createHash3, randomBytes, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
var CAPABILITY_VERSION = "ofx1";
var SECRET_BYTES = 32;
var KINDS = /* @__PURE__ */ new Set(["session", "read", "control", "subscription", "receipt", "admin"]);
function hashCapabilitySecret(secret) {
  return createHash3("sha256").update(String(secret), "utf8").digest("hex");
}
function mintCapability(kind, subjectId) {
  if (!KINDS.has(kind)) throw new Error(`Unsupported Oracle capability kind: ${kind}`);
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return {
    kind,
    subjectId,
    secret,
    hash: hashCapabilitySecret(secret),
    handle: `${CAPABILITY_VERSION}.${kind}.${subjectId}.${secret}`
  };
}
function parseCapability(handle, expectedKind = null) {
  const value = String(handle || "");
  const [version, kind, subjectId, secret, ...extra] = value.split(".");
  if (version !== CAPABILITY_VERSION || !KINDS.has(kind) || !subjectId || !secret || extra.length || expectedKind && kind !== expectedKind) {
    return null;
  }
  return { kind, subjectId, secret, hash: hashCapabilitySecret(secret) };
}

// src/protocol.mjs
import net from "node:net";
import { randomUUID as randomUUID3, timingSafeEqual as timingSafeEqual3 } from "node:crypto";
var BROKER_BUILD_VERSION = ORACLE_FIREFOX_VERSION;
var MAX_FRAME_BYTES = 8 * 1024 * 1024;
function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw codedError("FRAME_TOO_LARGE", `Broker frame exceeds ${MAX_FRAME_BYTES} bytes.`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}
function createFrameDecoder(onMessage, onError) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (length <= 0 || length > MAX_FRAME_BYTES) {
        onError(codedError("INVALID_FRAME", `Invalid broker frame length: ${length}.`));
        buffer = Buffer.alloc(0);
        return;
      }
      if (buffer.length < length + 4) return;
      const payload = buffer.subarray(4, length + 4);
      buffer = buffer.subarray(length + 4);
      try {
        onMessage(JSON.parse(payload.toString("utf8")));
      } catch (error) {
        onError(codedError("INVALID_JSON", "Broker received malformed JSON.", { cause: error }));
      }
    }
  };
}
function rpcRequest(endpoint, token, method, params = {}, options = {}) {
  const timeoutMs = Math.max(250, options.timeoutMs ?? 1e4);
  const id = randomUUID3();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    const timer = setTimeout(() => {
      finish(reject, codedError("BROKER_TIMEOUT", `Broker request ${method} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();
    const decoder = createFrameDecoder((response) => {
      if (response?.id !== id) return;
      if (response.ok) return finish(resolve, response.result);
      const value = response.error || {};
      finish(reject, codedError(value.code || "BROKER_ERROR", value.message || "Broker request failed.", value));
    }, (error) => finish(reject, error));
    socket.once("connect", () => {
      try {
        socket.write(encodeFrame({
          id,
          token,
          protocolVersion: options.protocolVersion ?? BROKER_PROTOCOL_VERSION,
          method,
          params,
          client: options.client ?? { pid: process.pid, buildVersion: BROKER_BUILD_VERSION }
        }), (error) => {
          if (error) finish(reject, error);
        });
      } catch (error) {
        finish(reject, error);
      }
    });
    socket.on("data", decoder);
    socket.once("error", (error) => finish(reject, error));
    socket.once("close", () => {
      if (!settled) finish(reject, codedError("BROKER_DISCONNECTED", "Broker disconnected before replying."));
    });
  });
}

// src/state-store.mjs
import { backup, DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { createHash as createHash4, randomUUID as randomUUID4 } from "node:crypto";

// src/evidence.mjs
var LOCAL_DATA_SENTINEL = "ORACLE_LOCAL_DATA_REQUEST_V1";
var LOCAL_DATA_PROTOCOL_VERSION = 1;
var LOCAL_DATA_NONCE_PATTERN = /^[a-f0-9]{32}$/u;
function localDataProtocol(nonce) {
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
var LOCAL_DATA_PROTOCOL = localDataProtocol("00000000000000000000000000000000");

// src/state-store.mjs
var JOB_STATES = Object.freeze([
  "accepted",
  "snapshotted",
  "queued",
  "page_leased",
  "target_verified",
  "attachment_processing",
  "composer_verified",
  "model_verified",
  "submit_intent",
  "user_turn_confirmed",
  "awaiting_response",
  "response_failed_detected",
  "response_confirmed",
  "completed",
  "cancelled_pre_submit",
  "failed_pre_submit",
  "submission_uncertain",
  "response_uncertain",
  "response_failed",
  "input_invalid",
  "quarantined"
]);
var STATE_INDEX = new Map(JOB_STATES.map((state, index) => [state, index]));
var SUBMIT_INDEX = STATE_INDEX.get("submit_intent");
var PRE_SUBMIT_JOB_STATES = new Set(JOB_STATES.slice(0, SUBMIT_INDEX));
function requestDigest(request) {
  const canonicalize2 = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize2);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value).filter((key) => value[key] !== void 0).sort().map((key) => [key, canonicalize2(value[key])])
      );
    }
    return value;
  };
  return createHash4("sha256").update(JSON.stringify(canonicalize2(request))).digest("hex");
}

// src/broker-client.mjs
var clientInstanceId = randomUUID5();
var clientSessions = /* @__PURE__ */ new Map();
var processScopedClientIdentities = /* @__PURE__ */ new Map();
var START_OPERATIONS = /* @__PURE__ */ new Map([
  ["jobs.startConsult", "consult"],
  ["jobs.startContinue", "continue_chat"]
]);
var KNOWN_RELEASE_SEQUENCES = /* @__PURE__ */ new Map([
  ["1.2.1", 1201],
  ["1.3.0", 1300],
  ["1.4.0", 1400],
  ["1.4.1", 1401],
  ["1.6.9", 1610],
  [ORACLE_FIREFOX_VERSION, BROKER_RELEASE_SEQUENCE]
]);
function processIsAlive(pid) {
  const value = Number(pid);
  if (!Number.isSafeInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}
async function ensurePrivateDirectory2(directory) {
  await mkdir4(directory, { recursive: true, mode: 448 });
  await chmod3(directory, 448);
}
async function writeExclusivePrivateJson(target2, value) {
  const handle = await open3(target2, "wx", 384);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}
`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open3(path4.dirname(target2), "r").catch(() => null);
  try {
    await directory?.sync();
  } finally {
    await directory?.close();
  }
}
async function readOrCreateBrokerToken() {
  await ensurePrivateDirectory2(coordinatorDirectory());
  const tokenPath = brokerTokenPath();
  const readExisting = async () => {
    const value = (await readFile3(tokenPath, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/u.test(value)) {
      throw codedError("BROKER_TOKEN_INVALID", "The Oracle Firefox broker token file is empty or invalid; it was not replaced automatically.");
    }
    return value;
  };
  try {
    return await readExisting();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const candidate = randomBytes2(32).toString("hex");
  const temporary = `${tokenPath}.${process.pid}.${randomUUID5()}.tmp`;
  const handle = await open3(temporary, "wx", 384);
  try {
    try {
      await handle.writeFile(`${candidate}
`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link2(temporary, tokenPath);
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return await readExisting();
    }
  } catch (error) {
    try {
      await handle.close();
    } catch {
    }
    throw error;
  } finally {
    await rm3(temporary, { force: true }).catch(() => void 0);
  }
}
function clientMetadata(harness2, hostSessionHint = null, session = null) {
  return {
    pid: process.pid,
    harness: harness2,
    clientInstanceId,
    buildVersion: ORACLE_FIREFOX_VERSION,
    buildId: BROKER_BUILD_ID,
    releaseSequence: BROKER_RELEASE_SEQUENCE,
    hostSessionHint,
    sessionId: session?.sessionId,
    sessionHandle: session?.sessionHandle
  };
}
function stableClientIdentityPath(identity, harness2, hostSessionHint) {
  if (hostSessionHint == null) {
    throw codedError("CLIENT_IDENTITY_INVALID", "A durable Oracle Firefox client identity requires a stable host-session identity.");
  }
  const key = createHash5("sha256").update([
    "oracle-firefox-host-session-v1",
    identity.coordinatorId,
    String(harness2 || "unknown"),
    String(hostSessionHint)
  ].join("\0")).digest("hex");
  return path4.join(identity.coordinatorPath || coordinatorDirectory(), "client-sessions", `${key}.json`);
}
function processScopedClientIdentity(identity, harness2) {
  const normalizedHarness = String(harness2 || "unknown");
  const key = [identity.coordinatorId, normalizedHarness].join(":");
  let value = processScopedClientIdentities.get(key);
  if (value) return value;
  const sessionId = randomUUID5();
  const capability = mintCapability("session", sessionId);
  value = {
    version: 1,
    coordinatorId: identity.coordinatorId,
    harness: normalizedHarness,
    hostSessionHint: null,
    sessionId,
    sessionHandle: capability.handle,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    durable: false
  };
  processScopedClientIdentities.set(key, value);
  return value;
}
async function readStableClientIdentity(target2, expected) {
  const value = JSON.parse(await readFile3(target2, "utf8"));
  const parsed = parseCapability(value.sessionHandle, "session");
  if (value.version !== 1 || value.coordinatorId !== expected.coordinatorId || value.harness !== expected.harness || (value.hostSessionHint ?? null) !== expected.hostSessionHint || !parsed || parsed.subjectId !== value.sessionId) {
    throw codedError("CLIENT_IDENTITY_INVALID", "The durable Oracle Firefox host-session identity is invalid and was not replaced automatically.");
  }
  return value;
}
async function readOrCreateStableClientIdentity(identity, harness2, hostSessionHint) {
  const normalized = {
    coordinatorId: identity.coordinatorId,
    harness: String(harness2 || "unknown"),
    hostSessionHint: hostSessionHint == null ? null : String(hostSessionHint)
  };
  const target2 = stableClientIdentityPath(identity, normalized.harness, normalized.hostSessionHint);
  try {
    return { ...await readStableClientIdentity(target2, normalized), target: target2 };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await ensurePrivateDirectory2(path4.dirname(target2));
  const sessionId = randomUUID5();
  const capability = mintCapability("session", sessionId);
  const candidate = {
    version: 1,
    ...normalized,
    sessionId,
    sessionHandle: capability.handle,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  try {
    await writeExclusivePrivateJson(target2, candidate);
    return { ...candidate, target: target2 };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return { ...await readStableClientIdentity(target2, normalized), target: target2 };
  }
}
async function clientIdentity(identity, harness2, hostSessionHint) {
  if (hostSessionHint == null) return processScopedClientIdentity(identity, harness2);
  return readOrCreateStableClientIdentity(identity, harness2, hostSessionHint);
}
function pendingReceiptPath(identity, stableIdentity, authorizationId) {
  const receiptKey = createHash5("sha256").update(String(authorizationId)).digest("hex");
  return path4.join(
    identity.coordinatorPath || coordinatorDirectory(),
    "pending-start-receipts",
    stableIdentity.sessionId,
    `${receiptKey}.json`
  );
}
async function readOrCreatePendingReceipt(identity, stableIdentity, authorizationId, digest2) {
  const target2 = pendingReceiptPath(identity, stableIdentity, authorizationId);
  const readExisting = async () => {
    const value = JSON.parse(await readFile3(target2, "utf8"));
    const parsed = parseCapability(value.recoveryHandle, "receipt");
    if (value.version !== 1 || value.coordinatorId !== identity.coordinatorId || value.ownerSessionId !== stableIdentity.sessionId || value.authorizationId !== authorizationId || value.requestDigest !== digest2 || !parsed || parsed.subjectId !== authorizationId) {
      throw codedError("START_RECEIPT_RECOVERY_INVALID", "The pending Oracle Firefox start receipt does not match this exact request and stable caller.");
    }
    return value;
  };
  try {
    return { ...await readExisting(), target: target2, existing: true };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await ensurePrivateDirectory2(path4.dirname(target2));
  const recovery = mintCapability("receipt", authorizationId);
  const candidate = {
    version: 1,
    coordinatorId: identity.coordinatorId,
    ownerSessionId: stableIdentity.sessionId,
    authorizationId,
    requestDigest: digest2,
    recoveryHandle: recovery.handle,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  try {
    await writeExclusivePrivateJson(target2, candidate);
    return { ...candidate, target: target2, existing: false };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return { ...await readExisting(), target: target2, existing: true };
  }
}
function transportUncertain(error) {
  return (/* @__PURE__ */ new Set([
    "BROKER_TIMEOUT",
    "BROKER_DISCONNECTED",
    "EPIPE",
    "ECONNRESET",
    "ECONNABORTED",
    "ETIMEDOUT"
  ])).has(error?.code);
}
function unresolvedReceiptError(error) {
  return codedError(
    "RECEIPT_MAY_EXIST",
    "Oracle Firefox could not prove whether the preserved start was committed. Recover the receipt; do not resubmit the request.",
    {
      cause: error,
      safeToRetry: false,
      submissionMayHaveOccurred: true,
      recoveryAction: "call recover_start_receipt with the preserved authorizationId, requestDigest, and receiptRecoveryHandle; do not create a new authorization",
      details: { causeCode: error?.code || null }
    }
  );
}
function normalizeLegacyBrokerStatus(status, endpoint) {
  const protocolVersion = Number(status?.protocolVersion || status?.protocol?.minimum || 0);
  const buildVersion = status?.buildVersion || "unknown";
  return {
    ...status,
    coordinatorId: status?.coordinatorId || null,
    instanceId: status?.brokerInstanceId || `legacy:${status?.pid || "unknown"}:${endpoint}`,
    leaseGeneration: Number(status?.leaseGeneration || 0),
    state: status?.draining ? "draining" : "ready",
    protocol: { minimum: protocolVersion, maximum: protocolVersion },
    releaseSequence: KNOWN_RELEASE_SEQUENCES.get(buildVersion) || 0,
    buildVersion,
    legacy: true
  };
}
function canRequestIdleUpgrade(hello, status) {
  return Boolean(
    status && !status.draining && BROKER_RELEASE_SEQUENCE > Number(hello?.releaseSequence || 0) && Number(status.activeJobCount || 0) === 0 && Number(status.browser?.pagesLeased || 0) === 0 && status.browser?.maintenance !== true
  );
}
async function probeBroker(identity, token, timeoutMs = 750, endpointOverride = null) {
  const locator = endpointOverride ? null : await readBrokerLocator(identity, token);
  const endpoint = endpointOverride || locator?.endpoint?.path || identity.endpoint;
  try {
    const hello = await rpcRequest(endpoint, token, "broker.hello", {}, {
      timeoutMs,
      client: clientMetadata("broker-probe")
    });
    return { kind: hello.state === "starting" ? "starting" : "live", hello, endpoint };
  } catch (error) {
    if (error?.code === "BROKER_UNAUTHORIZED") return { kind: "auth-conflict", error, endpoint };
    if ((/* @__PURE__ */ new Set(["METHOD_NOT_FOUND", "BROKER_PROTOCOL_MISMATCH"])).has(error?.code)) {
      try {
        const status = await rpcRequest(endpoint, token, "broker.status", {}, {
          timeoutMs,
          client: clientMetadata("legacy-broker-probe")
        });
        return { kind: "live", hello: normalizeLegacyBrokerStatus(status, endpoint), endpoint };
      } catch (legacyError) {
        if (legacyError?.code === "BROKER_UNAUTHORIZED") return { kind: "auth-conflict", error: legacyError, endpoint };
        if (!(/* @__PURE__ */ new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "EPIPE"])).has(legacyError?.code)) {
          return { kind: "timeout", error: legacyError, endpoint };
        }
      }
    }
    if ((/* @__PURE__ */ new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "EPIPE"])).has(error?.code)) {
      return { kind: "absent", error, endpoint };
    }
    return { kind: "timeout", error, endpoint };
  }
}
async function waitForBrokerRelease(token, { identity = null, expectedInstanceId = null, timeoutMs = 3e4, probe = null } = {}) {
  const resolved = identity || await resolveCoordinatorIdentity();
  const inspect = probe || ((auth, wait) => probeBroker(resolved, auth, wait));
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    const result = await inspect(token, 500);
    if (!result || result.kind === "absent" || !result.hello) {
      const locator = await readBrokerLocator(resolved, token).catch(() => null);
      if (expectedInstanceId && locator?.instanceId && locator.instanceId !== expectedInstanceId) return true;
      const sameLocator = Boolean(expectedInstanceId && locator?.instanceId === expectedInstanceId);
      const sameLifetimeOwner = Boolean(sameLocator && locator?.pid && processIsAlive(locator.pid));
      if (sameLocator && !sameLifetimeOwner) return true;
      if (!result || result.kind === "absent" && !locator) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    const hello = result.hello || result;
    if (expectedInstanceId && hello.instanceId && hello.instanceId !== expectedInstanceId) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
async function startBrokerDetached(identity = null, token = null) {
  const resolved = identity || await resolveCoordinatorIdentity();
  const auth = token || await readOrCreateBrokerToken();
  const deadline = Date.now() + 2e4;
  let launchLease = null;
  try {
    while (!launchLease && Date.now() < deadline) {
      const existing = await probeBroker(resolved, auth);
      if (existing.kind === "live") return existing.hello;
      if (existing.kind === "auth-conflict") {
        throw codedError("BROKER_ENDPOINT_CONFLICT", "The canonical Oracle Firefox endpoint rejected this coordinator token.");
      }
      try {
        launchLease = await BrokerLaunchLease.acquire(brokerLaunchLockPath());
      } catch (error) {
        if (error?.code !== "BROKER_LEASE_HELD") throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      if (existing.kind === "timeout") {
        throw codedError("BROKER_UNRESPONSIVE", "A broker endpoint or lifetime owner exists but did not answer. Oracle Firefox refused to launch a competitor.", {
          safeToRetry: true,
          details: { probeCode: existing.error?.code || null, probeMessage: existing.error?.message || null }
        });
      }
    }
    if (!launchLease) throw codedError("BROKER_START_BUSY", "Another client is still coordinating broker startup.", { safeToRetry: true });
    const afterLease = await probeBroker(resolved, auth);
    if ((/* @__PURE__ */ new Set(["live", "starting"])).has(afterLease.kind)) return afterLease.hello;
    if (afterLease.kind === "auth-conflict") throw codedError("BROKER_ENDPOINT_CONFLICT", "The broker endpoint changed authentication while starting.");
    if (afterLease.kind === "timeout") throw codedError("BROKER_UNRESPONSIVE", "The canonical broker endpoint is occupied but unresponsive; no competitor was launched.", {
      safeToRetry: true,
      details: { probeCode: afterLease.error?.code || null, probeMessage: afterLease.error?.message || null }
    });
    const log = await open3(coordinatorLogPath(), "a", 384);
    try {
      const brokerEntry = fileURLToPath(new URL("./broker.mjs", import.meta.url));
      const child = spawn(brokerNodePath(), [brokerEntry, "--daemon"], {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: { ...process.env, ORACLE_FIREFOX_BROKER_CHILD: "1" }
      });
      child.unref();
    } finally {
      await log.close();
    }
    while (Date.now() < deadline) {
      const result = await probeBroker(resolved, auth, 750);
      if (result.kind === "live") return result.hello;
      if (result.kind === "auth-conflict") throw codedError("BROKER_ENDPOINT_CONFLICT", "The broker endpoint changed authentication while starting.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw codedError("BROKER_START_FAILED", `Oracle Firefox broker did not start. See ${coordinatorLogPath()}.`);
  } finally {
    launchLease?.release();
  }
}
async function compatibleBroker(identity, token) {
  let observed = await probeBroker(identity, token);
  if (observed.kind === "absent") {
    for (const candidate of identity.legacyEndpoints || []) {
      const legacy = await probeBroker(identity, token, 750, candidate);
      if (!(/* @__PURE__ */ new Set(["live", "starting"])).has(legacy.kind)) continue;
      observed = legacy;
      break;
    }
    if (observed.kind === "absent") {
      const started = await startBrokerDetached(identity, token);
      observed = {
        kind: started?.state === "starting" ? "starting" : "live",
        hello: started,
        endpoint: identity.endpoint
      };
    }
  }
  if (observed.kind === "timeout") {
    const started = await startBrokerDetached(identity, token);
    observed = {
      kind: started?.state === "starting" ? "starting" : "live",
      hello: started,
      endpoint: identity.endpoint
    };
  }
  if (observed.kind === "auth-conflict") throw codedError("BROKER_ENDPOINT_CONFLICT", "The broker endpoint rejected this coordinator token.");
  if (observed.kind === "starting") {
    const deadline = Date.now() + 2e4;
    while (Date.now() < deadline && observed.kind === "starting") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      observed = await probeBroker(identity, token, 1e3);
    }
    if (observed.kind !== "live") {
      throw codedError("BROKER_START_FAILED", "The Oracle Firefox lifetime owner did not reach ready state; no competitor was launched.", { safeToRetry: true });
    }
  }
  const hello = observed.hello;
  const acceptsProtocol = Number(hello?.protocol?.minimum) <= BROKER_PROTOCOL_VERSION && Number(hello?.protocol?.maximum) >= BROKER_PROTOCOL_VERSION;
  const observedReleaseSequence = Number(hello?.releaseSequence || 0);
  if (acceptsProtocol) {
    if (observedReleaseSequence > 0 && BROKER_RELEASE_SEQUENCE > observedReleaseSequence) {
      const status = await rpcRequest(observed.endpoint, token, "broker.status", {}, {
        timeoutMs: 2e3,
        client: clientMetadata("broker-upgrade-check")
      }).catch(() => null);
      const safelyIdle = canRequestIdleUpgrade(hello, status);
      if (safelyIdle) {
        const upgrade = await rpcRequest(observed.endpoint, token, "broker.requestUpgrade", {
          expectedInstanceId: hello.instanceId,
          expectedLeaseGeneration: hello.leaseGeneration,
          requesterReleaseSequence: BROKER_RELEASE_SEQUENCE,
          requesterBuildId: BROKER_BUILD_ID,
          requesterProtocolMinimum: BROKER_PROTOCOL_VERSION,
          requesterProtocolMaximum: BROKER_PROTOCOL_VERSION
        }, {
          timeoutMs: 2e3,
          client: clientMetadata("broker-upgrade")
        }).catch(() => null);
        if (upgrade?.accepted) {
          const released = await waitForBrokerRelease(token, {
            identity,
            expectedInstanceId: hello.instanceId,
            probe: (auth, wait) => probeBroker(identity, auth, wait, observed.endpoint)
          });
          if (released) return { hello: await startBrokerDetached(identity, token), endpoint: identity.endpoint };
          throw codedError("BROKER_UPGRADE_PENDING", "The idle Oracle Firefox broker accepted an upgrade but did not release its lifetime lease in time.", {
            safeToRetry: true
          });
        }
      }
    }
    return { hello, endpoint: observed.endpoint };
  }
  if (observedReleaseSequence > 0 && BROKER_RELEASE_SEQUENCE > observedReleaseSequence) {
    const upgradeParams = {
      expectedInstanceId: hello.instanceId,
      expectedLeaseGeneration: hello.leaseGeneration,
      requesterReleaseSequence: BROKER_RELEASE_SEQUENCE,
      requesterBuildId: BROKER_BUILD_ID,
      requesterProtocolMinimum: BROKER_PROTOCOL_VERSION,
      requesterProtocolMaximum: BROKER_PROTOCOL_VERSION
    };
    const upgrade = await rpcRequest(
      observed.endpoint,
      token,
      hello.legacy ? "broker.shutdownWhenIdle" : "broker.requestUpgrade",
      upgradeParams,
      { timeoutMs: 2e3, client: clientMetadata("broker-upgrade") }
    ).catch((error) => ({ accepted: false, error: { code: error.code, message: error.message } }));
    if (upgrade?.accepted) {
      const released = await waitForBrokerRelease(token, {
        identity,
        expectedInstanceId: hello.instanceId,
        probe: (auth, wait) => probeBroker(identity, auth, wait, observed.endpoint)
      });
      if (released) return { hello: await startBrokerDetached(identity, token), endpoint: identity.endpoint };
    }
  }
  throw codedError(
    Number(hello?.releaseSequence || 0) > BROKER_RELEASE_SEQUENCE ? "CLIENT_UPGRADE_REQUIRED" : "BROKER_PROTOCOL_MISMATCH",
    `Running Oracle Firefox broker ${hello?.buildVersion || "unknown"} uses protocol ${hello?.protocol?.minimum || "unknown"}. This client did not stop or downgrade it.`,
    { details: hello, recoveryAction: "reload this host with the current Oracle Firefox package" }
  );
}
async function callBroker(method, params = {}, options = {}) {
  const identity = await resolveCoordinatorIdentity();
  const token = await readOrCreateBrokerToken();
  const { endpoint } = await compatibleBroker(identity, token);
  const harness2 = options.harness || "unknown";
  const normalizedHostSessionHint = options.hostSessionHint == null ? null : String(options.hostSessionHint).trim();
  const hostSessionHint = normalizedHostSessionHint || null;
  const ownerIdentity = await clientIdentity(identity, harness2, hostSessionHint);
  const sessionKey = [identity.coordinatorId, harness2, ownerIdentity.sessionId].join(":");
  let session = clientSessions.get(sessionKey);
  const openSession = async () => rpcRequest(endpoint, token, "broker.openSession", {
    harness: harness2,
    clientInstanceId,
    hostSessionHint,
    stableSessionId: ownerIdentity.sessionId,
    stableSessionHandle: ownerIdentity.sessionHandle
  }, {
    timeoutMs: 1e4,
    client: clientMetadata(harness2, hostSessionHint)
  });
  if (!session) {
    session = await openSession();
    clientSessions.set(sessionKey, session);
  }
  const invoke = async (rpcMethod, rpcParams, timeoutMs = options.timeoutMs ?? 6e4) => {
    const request = () => rpcRequest(endpoint, token, rpcMethod, rpcParams, {
      timeoutMs,
      client: clientMetadata(harness2, hostSessionHint, session)
    });
    try {
      return await request();
    } catch (error) {
      if (!(/* @__PURE__ */ new Set(["CLIENT_SESSION_REQUIRED", "OWNER_SESSION_NOT_FOUND"])).has(error?.code)) throw error;
      clientSessions.delete(sessionKey);
      session = await openSession();
      clientSessions.set(sessionKey, session);
      return request();
    }
  };
  const operation = START_OPERATIONS.get(method);
  if (!operation || !params.authorizationId) return invoke(method, params);
  const digest2 = requestDigest({ operation, ...params, authorizationId: void 0 });
  const pending = await readOrCreatePendingReceipt(
    identity,
    ownerIdentity,
    params.authorizationId,
    digest2
  );
  const recover = () => invoke("jobs.recoverStartReceipt", {
    authorizationId: params.authorizationId,
    requestDigest: digest2,
    recoveryHandle: pending.recoveryHandle
  }, Math.max(1e4, options.timeoutMs ?? 6e4));
  if (pending.existing) {
    try {
      const recovered = await recover();
      await rm3(pending.target, { force: true });
      return recovered;
    } catch (error) {
      throw unresolvedReceiptError(error);
    }
  }
  try {
    const result = await invoke(method, { ...params, _receiptRecoveryHandle: pending.recoveryHandle });
    await rm3(pending.target, { force: true });
    return result;
  } catch (error) {
    if (!transportUncertain(error)) {
      if (error?.submissionMayHaveOccurred !== true && error?.details?.startReceiptCommitted !== true && error?.code !== "START_RECEIPT_NOT_FOUND") {
        await rm3(pending.target, { force: true });
      }
      throw error;
    }
    try {
      const recovered = await recover();
      await rm3(pending.target, { force: true });
      return recovered;
    } catch (recoveryError) {
      throw unresolvedReceiptError(recoveryError);
    }
  }
}

// src/coordinator-diagnostics.mjs
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";
import { readFile as readFile4, stat as stat2 } from "node:fs/promises";
async function fileStatus(pathname) {
  try {
    const info = await stat2(pathname);
    return { path: pathname, exists: true, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() };
  } catch (error) {
    if (error?.code === "ENOENT") return { path: pathname, exists: false };
    throw error;
  }
}
async function inspectCoordinatorDatabase(databasePath = coordinatorDatabasePath()) {
  const database = await fileStatus(databasePath);
  const backup2 = await fileStatus(`${databasePath}.pre-v${BROKER_SCHEMA_VERSION}.bak`);
  const coordinatorUuid = await readFile4(brokerCoordinatorIdPath(), "utf8").then((value) => value.trim() || null, () => null);
  if (!database.exists) {
    return { database, backup: backup2, coordinatorUuidPresent: Boolean(coordinatorUuid), readable: true, initialized: false };
  }
  let db;
  try {
    db = new DatabaseSync3(databasePath, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
    const schemaVersion = Number(db.prepare("SELECT COALESCE(MAX(version), 0) version FROM schema_migrations").get()?.version || 0);
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check || "unknown";
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
    let broker = null;
    if (schemaVersion >= 6) {
      const row = db.prepare(`
        SELECT coordinator_id, current_instance_id, current_lease_generation,
               minimum_reader_protocol, minimum_writer_protocol,
               qualified_concurrency, updated_at
        FROM broker_state WHERE id=1
      `).get();
      broker = row ? {
        coordinatorId: row.coordinator_id,
        currentInstanceId: row.current_instance_id,
        leaseGeneration: row.current_lease_generation,
        minimumReaderProtocol: row.minimum_reader_protocol,
        minimumWriterProtocol: row.minimum_writer_protocol,
        qualifiedConcurrency: row.qualified_concurrency,
        updatedAt: row.updated_at
      } : null;
    }
    return {
      database,
      backup: backup2,
      coordinatorUuidPresent: Boolean(coordinatorUuid),
      readable: true,
      initialized: true,
      schemaVersion,
      expectedSchemaVersion: BROKER_SCHEMA_VERSION,
      integrity,
      foreignKeyViolations,
      broker,
      repairRequired: integrity !== "ok" || foreignKeyViolations > 0 || schemaVersion > BROKER_SCHEMA_VERSION
    };
  } catch (error) {
    return {
      database,
      backup: backup2,
      coordinatorUuidPresent: Boolean(coordinatorUuid),
      readable: false,
      error: {
        code: "COORDINATOR_DATABASE_UNAVAILABLE",
        message: "The coordinator database could not be inspected read-only. A live broker may hold it exclusively, or it may require offline repair.",
        cause: error.message
      }
    };
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}

// src/cli.mjs
function option(args2, names, fallback) {
  const index = args2.findIndex((value) => names.includes(value));
  return index >= 0 ? args2[index + 1] : fallback;
}
function repeated(args2, names) {
  return args2.flatMap((value, index) => names.includes(value) && args2[index + 1] ? [args2[index + 1]] : []);
}
function bool(args2, name) {
  return args2.includes(name);
}
function number(args2, names, fallback) {
  return Number(option(args2, names, String(fallback)));
}
function jsonOption(args2, names, fallback) {
  const value = option(args2, names);
  return value === void 0 ? fallback : JSON.parse(value);
}
function common(args2) {
  return {
    modelRequirement: option(args2, ["--model"], "pro"),
    responseTimeoutSeconds: number(args2, ["--response-timeout-seconds", "--timeout-seconds"], 10800),
    attachmentTimeoutSeconds: number(args2, ["--attachment-timeout-seconds"], 600),
    maxAutomaticEvidenceReplies: number(args2, ["--max-evidence-replies"], 3),
    responseFailurePolicy: option(args2, ["--response-failure-policy"], "report"),
    completionMode: option(args2, ["--completion-mode"], "manual"),
    headless: bool(args2, "--headless")
  };
}
function target(args2) {
  return {
    projectTitle: option(args2, ["--project-title"]),
    projectUrl: option(args2, ["--project-url"])
  };
}
function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}
`);
}
async function notify(title, body) {
  if (process.platform !== "darwin") return;
  const child = spawn2("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body], { stdio: "ignore" });
  child.unref();
}
var [, , command = "doctor", ...args] = process.argv;
var harness = process.env.ORACLE_FIREFOX_HARNESS || "cli";
var jobReference = () => ({ jobId: args[0], jobHandle: option(args, ["--handle"]) });
try {
  let result;
  if (command === "version" || command === "--version" || command === "-v") result = { version: ORACLE_FIREFOX_VERSION };
  else if (command === "coordinator-inspect") result = await inspectCoordinatorDatabase();
  else if (command === "doctor") result = await callBroker("workflow.doctor", {}, { harness });
  else if (command === "browser-select") result = await callBroker("workflow.selectBrowser", { browser: args[0] }, { harness });
  else if (command === "broker-status") result = await callBroker("broker.status", {}, { harness });
  else if (command === "profiles") result = await callBroker("workflow.profiles", {}, { harness });
  else if (command === "setup") result = await callBroker("workflow.setup", { timeoutSeconds: number(args, ["--timeout-seconds"], 300) }, { timeoutMs: 91e4, harness });
  else if (command === "import-session") result = await callBroker("workflow.importSession", { sourceProfile: option(args, ["--source-profile"]), confirmImport: bool(args, "--confirm") }, { harness });
  else if (command === "projects") result = await callBroker("workflow.listProjects", { query: option(args, ["-q", "--query"], ""), headless: bool(args, "--headless") }, { harness });
  else if (command === "find-chats") result = await callBroker("workflow.findChats", { query: option(args, ["-q", "--query"]), ...target(args), timeoutSeconds: number(args, ["--timeout-seconds"], 15), headless: bool(args, "--headless") }, { harness });
  else if (command === "artifacts" || command === "download-artifact") {
    const params = {
      chatTitle: option(args, ["--title"]),
      conversationUrl: option(args, ["--url"]),
      ...target(args),
      scope: option(args, ["--scope"], "last-assistant"),
      timeoutSeconds: number(args, ["--timeout-seconds"], 30),
      headless: bool(args, "--headless")
    };
    if (command === "download-artifact") {
      params.linkText = option(args, ["--link-text"]);
      params.maxBytes = number(args, ["--max-bytes"], 1e8);
    }
    result = await callBroker(
      command === "artifacts" ? "workflow.listChatArtifacts" : "workflow.downloadChatArtifact",
      params,
      { timeoutMs: command === "artifacts" ? 12e4 : 3e5, harness }
    );
  } else if (command === "consult" || command === "consult-start") {
    const params = { authorizationId: option(args, ["--authorization-id"], command === "consult-start" ? void 0 : randomUUID6()), prompt: option(args, ["-p", "--prompt"]), files: repeated(args, ["-f", "--file"]), zipFiles: repeated(args, ["--zip-file", "--zip"]), cwd: option(args, ["--cwd"]), delivery: option(args, ["--delivery"], "auto"), ...target(args), ...common(args) };
    result = await callBroker(command === "consult" ? "jobs.compatConsult" : "jobs.startConsult", params, { timeoutMs: command === "consult" ? 245e3 : 65e3, harness });
  } else if (command === "continue-chat" || command === "continue-chat-start") {
    const params = { authorizationId: option(args, ["--authorization-id"], command === "continue-chat-start" ? void 0 : randomUUID6()), chatTitle: option(args, ["--title"]), conversationUrl: option(args, ["--url"]), prompt: option(args, ["-p", "--prompt"]), zipFiles: repeated(args, ["--zip-file", "--zip"]), cwd: option(args, ["--cwd"]), ...target(args), ...common(args) };
    result = await callBroker(command === "continue-chat" ? "jobs.compatContinue" : "jobs.startContinue", params, { timeoutMs: command === "continue-chat" ? 245e3 : 65e3, harness });
  } else if (command === "recover-start-receipt") result = await callBroker("jobs.recoverStartReceipt", {
    authorizationId: option(args, ["--authorization-id"]),
    requestDigest: option(args, ["--request-digest"]),
    recoveryHandle: option(args, ["--receipt-recovery-handle"])
  }, { harness });
  else if (command === "status") result = await callBroker("jobs.status", { ...jobReference(), followRetries: !bool(args, "--no-follow-retries") }, { harness });
  else if (command === "result") result = await callBroker("jobs.result", { ...jobReference(), followRetries: !bool(args, "--no-follow-retries") }, { harness });
  else if (command === "jobs") result = await callBroker("jobs.list", { limit: number(args, ["--limit"], 50) }, { harness });
  else if (command === "list-attention" || command === "attention") result = await callBroker("jobs.listAttention", {}, { harness });
  else if (command === "quarantine-inspect") result = await callBroker("jobs.inspectQuarantine", {
    conversationUrl: option(args, ["--url"])
  }, { harness });
  else if (command === "input-request-inspect") result = await callBroker("jobs.inspectInputRequest", {
    conversationUrl: option(args, ["--url"])
  }, { harness });
  else if (command === "abandon-input") result = await callBroker("jobs.abandonInputRequest", {
    ...jobReference(),
    confirmAbandon: bool(args, "--confirm-abandon"),
    reason: option(args, ["--reason"], "user-declined")
  }, { harness });
  else if (command === "input-request-recover") result = await callBroker("jobs.abandonOrphanedInputRequest", {
    conversationUrl: option(args, ["--url"]),
    fingerprint: option(args, ["--fingerprint"]),
    confirmCapabilityUnavailable: bool(args, "--confirm-capability-unavailable"),
    confirmAbandon: bool(args, "--confirm-abandon"),
    reason: option(args, ["--reason"], "user-declined")
  }, { harness });
  else if (command === "quarantine-recover") result = await callBroker("jobs.recoverOrphanedQuarantine", {
    conversationUrl: option(args, ["--url"]),
    fingerprint: option(args, ["--fingerprint"]),
    action: option(args, ["--action"], "reconcile"),
    confirmCapabilityUnavailable: bool(args, "--confirm-capability-unavailable"),
    confirmManualInspection: bool(args, "--confirm-manual-inspection"),
    completionMode: option(args, ["--completion-mode"], "manual")
  }, { timeoutMs: 12e4, harness });
  else if (command === "reconcile") result = await callBroker("jobs.reconcile", { ...jobReference(), conversationUrl: option(args, ["--url"]) }, { timeoutMs: 12e4, harness });
  else if (command === "acknowledge") result = await callBroker("jobs.acknowledge", jobReference(), { harness });
  else if (command === "cancel") result = await callBroker("jobs.cancel", jobReference(), { harness });
  else if (command === "reply-local-data") result = await callBroker("jobs.replyWithLocalData", {
    ...jobReference(),
    facts: jsonOption(args, ["--facts-json"], []),
    unavailable: jsonOption(args, ["--unavailable-json"], []),
    responseTimeoutSeconds: number(args, ["--response-timeout-seconds"], 10800)
  }, { harness });
  else if (command === "completion-claim") result = await callBroker("completion.claim", {
    completionHandle: option(args, ["--completion-handle"]),
    claimSeconds: number(args, ["--claim-seconds"], 90)
  }, { harness });
  else if (command === "completion-wait") result = await callBroker("completion.wait", {
    completionHandle: option(args, ["--completion-handle"]),
    timeoutSeconds: number(args, ["--timeout-seconds"], 55),
    claimSeconds: number(args, ["--claim-seconds"], 90)
  }, { timeoutMs: 6e4, harness });
  else if (command === "completion-delivered") result = await callBroker("completion.delivered", {
    completionHandle: option(args, ["--completion-handle"]),
    deliveryId: number(args, ["--delivery-id"], 0),
    claimId: option(args, ["--claim-id"])
  }, { harness });
  else if (command === "completion-ack") result = await callBroker("completion.acknowledge", {
    completionHandle: option(args, ["--completion-handle"]),
    deliveryId: number(args, ["--delivery-id"], 0)
  }, { harness });
  else if (command === "emergency-lock") result = await callBroker("broker.setEmergencyLock", { enabled: true }, { harness });
  else if (command === "emergency-unlock") result = await callBroker("broker.setEmergencyLock", { enabled: false }, { harness });
  else if (command === "watch") {
    const jobId = args.find((arg) => !arg.startsWith("-"));
    const jsonl = bool(args, "--jsonl");
    const completionHandle = option(args, ["--completion-handle"]);
    let lastVersion = "";
    if (completionHandle) {
      for (; ; ) {
        const waited = await callBroker("completion.wait", {
          completionHandle,
          timeoutSeconds: 55,
          claimSeconds: 90
        }, { timeoutMs: 6e4, harness: `${harness}-watch` });
        if (!waited.delivery) continue;
        result = waited;
        if (jsonl) process.stdout.write(`${JSON.stringify(result)}
`);
        if (bool(args, "--notify")) await notify("Oracle Firefox", `Logical chain ${waited.delivery.state}`);
        await callBroker("completion.delivered", {
          completionHandle,
          deliveryId: waited.delivery.deliveryId,
          claimId: waited.delivery.claimId
        }, { harness: `${harness}-watch` });
        break;
      }
    } else {
      for (; ; ) {
        result = await callBroker("jobs.wait", { jobId, jobHandle: option(args, ["--handle"]), timeoutSeconds: 55, followRetries: !bool(args, "--no-follow-retries") }, { timeoutMs: 6e4, harness: `${harness}-watch` });
        const key = `${result.state}:${result.updatedAt}`;
        if (jsonl && key !== lastVersion) process.stdout.write(`${JSON.stringify(result)}
`);
        lastVersion = key;
        if (result.terminal) break;
      }
      if (bool(args, "--notify")) await notify("Oracle Firefox", `Job ${jobId} ${result.state}`);
    }
  } else {
    throw new Error("Usage: oracle-firefox version|coordinator-inspect|doctor|browser-select firefox|chrome|safari|broker-status|profiles|setup|import-session|projects|find-chats|artifacts|download-artifact|consult|consult-start|continue-chat|continue-chat-start|recover-start-receipt --authorization-id UUID --request-digest SHA256 --receipt-recovery-handle HANDLE|status <job-id> [--handle HANDLE]|result <job-id> [--handle HANDLE]|jobs|list-attention|watch <job-id> [--handle HANDLE]|input-request-inspect --url URL|abandon-input <job-id> --handle HANDLE --confirm-abandon|input-request-recover --url URL --fingerprint HASH --confirm-capability-unavailable --confirm-abandon|quarantine-inspect --url URL|quarantine-recover --url URL --fingerprint HASH --confirm-capability-unavailable [--action reconcile|acknowledge]|reconcile|acknowledge|cancel|reply-local-data|completion-claim|completion-delivered|completion-ack|emergency-lock|emergency-unlock");
  }
  if (command !== "watch" || !bool(args, "--jsonl")) print(result);
} catch (error) {
  process.stderr.write(`${JSON.stringify(structuredError(error), null, 2)}
`);
  process.exitCode = 1;
}
