#!/usr/bin/env node
import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);

// src/cli.mjs
import { randomUUID as randomUUID2 } from "node:crypto";
import { spawn as spawn2 } from "node:child_process";

// src/broker-client.mjs
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path2 from "node:path";
import { spawn } from "node:child_process";

// src/config.mjs
import os from "node:os";
import path from "node:path";
function coordinatorDirectory() {
  const configured = process.env.ORACLE_FIREFOX_COORDINATOR_HOME?.trim();
  if (configured) return path.resolve(configured);
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "oracle-firefox", "coordinator");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "oracle-firefox",
      "coordinator"
    );
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "oracle-firefox", "coordinator");
}
function brokerEndpoint() {
  if (process.env.ORACLE_FIREFOX_BROKER_ENDPOINT?.trim()) {
    return process.env.ORACLE_FIREFOX_BROKER_ENDPOINT.trim();
  }
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\oracle-firefox-${process.env.USERNAME || "user"}`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : process.env.USER || "user";
  return path.join(process.env.TMPDIR || os.tmpdir(), `oracle-firefox-${uid}`, "broker.sock");
}
function brokerTokenPath() {
  return path.join(coordinatorDirectory(), "broker.token");
}
function coordinatorLogPath() {
  return path.join(coordinatorDirectory(), "broker.log");
}
function brokerLaunchLockPath() {
  return path.join(coordinatorDirectory(), "broker.start.lock");
}
function brokerNodePath() {
  return process.env.ORACLE_FIREFOX_NODE_PATH?.trim() || process.execPath;
}

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
function codedError(code, message, options) {
  return new OracleFirefoxError(code, message, options);
}

// src/protocol.mjs
import net from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
var BROKER_PROTOCOL_VERSION = 2;
var BROKER_BUILD_VERSION = "1.2.1";
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
  const id = randomUUID();
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
    const decoder = createFrameDecoder((response) => {
      if (response?.id !== id) return;
      if (response.ok) return finish(resolve, response.result);
      const value = response.error || {};
      finish(reject, codedError(value.code || "BROKER_ERROR", value.message || "Broker request failed.", value));
    }, (error) => finish(reject, error));
    socket.once("connect", () => {
      socket.write(encodeFrame({
        id,
        token,
        protocolVersion: BROKER_PROTOCOL_VERSION,
        method,
        params,
        client: options.client ?? { pid: process.pid, buildVersion: BROKER_BUILD_VERSION }
      }));
    });
    socket.on("data", decoder);
    socket.once("error", (error) => finish(reject, error));
    socket.once("close", () => {
      if (!settled) finish(reject, codedError("BROKER_DISCONNECTED", "Broker disconnected before replying."));
    });
  });
}

// src/broker-client.mjs
async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 448 });
  await chmod(directory, 448);
}
async function readOrCreateBrokerToken() {
  await ensurePrivateDirectory(coordinatorDirectory());
  const tokenPath = brokerTokenPath();
  try {
    return (await readFile(tokenPath, "utf8")).trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const candidate = randomBytes(32).toString("hex");
  try {
    const handle = await open(tokenPath, "wx", 384);
    try {
      await handle.writeFile(`${candidate}
`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return candidate;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return (await readFile(tokenPath, "utf8")).trim();
  }
}
async function brokerResponds(token, timeoutMs = 750) {
  try {
    return await rpcRequest(brokerEndpoint(), token, "broker.status", {}, { timeoutMs });
  } catch {
    return null;
  }
}
async function waitForBrokerRelease(token, { endpoint = brokerEndpoint(), timeoutMs = 3e4, probe = brokerResponds } = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    const responds = await probe(token, 500);
    let endpointExists = Boolean(responds);
    if (!responds && process.platform !== "win32") {
      endpointExists = await access(endpoint).then(() => true, () => false);
    }
    if (!responds && !endpointExists) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
async function startBrokerDetached() {
  const token = await readOrCreateBrokerToken();
  const existing = await brokerResponds(token);
  if (existing) return existing;
  if (process.platform !== "win32") await ensurePrivateDirectory(path2.dirname(brokerEndpoint()));
  await ensurePrivateDirectory(coordinatorDirectory());
  const lockPath = brokerLaunchLockPath();
  let ownsLock = false;
  try {
    try {
      await mkdir(lockPath, { mode: 448 });
      ownsLock = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 3e4) {
        await rm(lockPath, { recursive: true, force: true });
        await mkdir(lockPath, { mode: 448 });
        ownsLock = true;
      }
    }
    if (ownsLock) {
      const afterLock = await brokerResponds(token);
      if (afterLock) return afterLock;
      const log = await open(coordinatorLogPath(), "a", 384);
      try {
        const brokerEntry = new URL("./broker.mjs", import.meta.url);
        const child = spawn(brokerNodePath(), [brokerEntry.pathname, "--daemon"], {
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          env: { ...process.env, ORACLE_FIREFOX_BROKER_CHILD: "1" }
        });
        child.unref();
      } finally {
        await log.close();
      }
    }
    const deadline = Date.now() + 15e3;
    while (Date.now() < deadline) {
      const status = await brokerResponds(token, 750);
      if (status) return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw codedError("BROKER_START_FAILED", `Oracle Firefox broker did not start. See ${coordinatorLogPath()}.`);
  } finally {
    if (ownsLock) await rm(lockPath, { recursive: true, force: true }).catch(() => void 0);
  }
}
async function callBroker(method, params = {}, options = {}) {
  const token = await readOrCreateBrokerToken();
  let status = await brokerResponds(token);
  if (!status) status = await startBrokerDetached();
  if (status.protocolVersion !== BROKER_PROTOCOL_VERSION) {
    const shutdown = await rpcRequest(brokerEndpoint(), token, "broker.shutdownWhenIdle", {}, { timeoutMs: 2e3 }).catch(() => null);
    if (status.outstandingJobs === 0 && shutdown?.accepted) {
      const released = await waitForBrokerRelease(token);
      if (released) status = await startBrokerDetached();
    }
    if (status.protocolVersion !== BROKER_PROTOCOL_VERSION) {
      throw codedError(
        "BROKER_PROTOCOL_MISMATCH",
        `Running broker protocol ${status.protocolVersion} is incompatible. It will shut down after ${status.outstandingJobs} active job(s) finish; none were killed or resent.`,
        { details: status, recoveryAction: "retry after the active broker becomes idle" }
      );
    }
  }
  return rpcRequest(brokerEndpoint(), token, method, params, {
    timeoutMs: options.timeoutMs ?? 6e4,
    client: { pid: process.pid, harness: options.harness || "unknown", buildVersion: "1.2.1" }
  });
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
try {
  let result;
  if (command === "doctor") result = await callBroker("workflow.doctor", {}, { harness: "cli" });
  else if (command === "broker-status") result = await callBroker("broker.status", {}, { harness: "cli" });
  else if (command === "profiles") result = await callBroker("workflow.profiles", {}, { harness: "cli" });
  else if (command === "setup") result = await callBroker("workflow.setup", { timeoutSeconds: number(args, ["--timeout-seconds"], 300) }, { timeoutMs: 91e4, harness: "cli" });
  else if (command === "import-session") result = await callBroker("workflow.importSession", { sourceProfile: option(args, ["--source-profile"]), confirmImport: bool(args, "--confirm") }, { harness: "cli" });
  else if (command === "projects") result = await callBroker("workflow.listProjects", { query: option(args, ["-q", "--query"], ""), headless: bool(args, "--headless") }, { harness: "cli" });
  else if (command === "find-chats") result = await callBroker("workflow.findChats", { query: option(args, ["-q", "--query"]), ...target(args), timeoutSeconds: number(args, ["--timeout-seconds"], 15), headless: bool(args, "--headless") }, { harness: "cli" });
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
      { timeoutMs: command === "artifacts" ? 12e4 : 3e5, harness: "cli" }
    );
  } else if (command === "consult" || command === "consult-start") {
    const params = { authorizationId: option(args, ["--authorization-id"], command === "consult-start" ? void 0 : randomUUID2()), prompt: option(args, ["-p", "--prompt"]), files: repeated(args, ["-f", "--file"]), cwd: option(args, ["--cwd"]), delivery: option(args, ["--delivery"], "auto"), ...target(args), ...common(args) };
    result = await callBroker(command === "consult" ? "jobs.compatConsult" : "jobs.startConsult", params, { timeoutMs: command === "consult" ? 245e3 : 65e3, harness: "cli" });
  } else if (command === "continue-chat" || command === "continue-chat-start") {
    const params = { authorizationId: option(args, ["--authorization-id"], command === "continue-chat-start" ? void 0 : randomUUID2()), chatTitle: option(args, ["--title"]), conversationUrl: option(args, ["--url"]), prompt: option(args, ["-p", "--prompt"]), ...target(args), ...common(args) };
    result = await callBroker(command === "continue-chat" ? "jobs.compatContinue" : "jobs.startContinue", params, { timeoutMs: command === "continue-chat" ? 245e3 : 65e3, harness: "cli" });
  } else if (command === "status") result = await callBroker("jobs.status", { jobId: args[0], followRetries: !bool(args, "--no-follow-retries") }, { harness: "cli" });
  else if (command === "result") result = await callBroker("jobs.result", { jobId: args[0], followRetries: !bool(args, "--no-follow-retries") }, { harness: "cli" });
  else if (command === "jobs") result = await callBroker("jobs.list", { limit: number(args, ["--limit"], 50) }, { harness: "cli" });
  else if (command === "reconcile") result = await callBroker("jobs.reconcile", { jobId: args[0], conversationUrl: option(args, ["--url"]) }, { timeoutMs: 12e4, harness: "cli" });
  else if (command === "acknowledge") result = await callBroker("jobs.acknowledge", { jobId: args[0] }, { harness: "cli" });
  else if (command === "cancel") result = await callBroker("jobs.cancel", { jobId: args[0] }, { harness: "cli" });
  else if (command === "reply-local-data") result = await callBroker("jobs.replyWithLocalData", {
    jobId: args[0],
    facts: jsonOption(args, ["--facts-json"], []),
    unavailable: jsonOption(args, ["--unavailable-json"], []),
    responseTimeoutSeconds: number(args, ["--response-timeout-seconds"], 10800)
  }, { harness: "cli" });
  else if (command === "emergency-lock") result = await callBroker("broker.setEmergencyLock", { enabled: true }, { harness: "cli" });
  else if (command === "emergency-unlock") result = await callBroker("broker.setEmergencyLock", { enabled: false }, { harness: "cli" });
  else if (command === "watch") {
    const jobId = args.find((arg) => !arg.startsWith("-"));
    const jsonl = bool(args, "--jsonl");
    let lastVersion = "";
    for (; ; ) {
      result = await callBroker("jobs.wait", { jobId, timeoutSeconds: 55, followRetries: !bool(args, "--no-follow-retries") }, { timeoutMs: 6e4, harness: "cli-watch" });
      const key = `${result.state}:${result.updatedAt}`;
      if (jsonl && key !== lastVersion) process.stdout.write(`${JSON.stringify(result)}
`);
      lastVersion = key;
      if (result.terminal) break;
    }
    if (bool(args, "--notify")) await notify("Oracle Firefox", `Job ${jobId} ${result.state}`);
  } else {
    throw new Error("Usage: oracle-firefox doctor|broker-status|profiles|setup|import-session|projects|find-chats|artifacts --url URL|download-artifact --url URL --link-text TEXT|consult|consult-start|continue-chat|continue-chat-start [--response-failure-policy report|retry-once] [--completion-mode manual|notify|harness]|status <job-id>|result <job-id>|jobs|watch <job-id> [--jsonl|--notify|--no-follow-retries]|reconcile <job-id> [--url URL]|acknowledge <job-id>|cancel <job-id>|reply-local-data <job-id> --facts-json JSON [--unavailable-json JSON]|emergency-lock|emergency-unlock");
  }
  if (command !== "watch" || !bool(args, "--jsonl")) print(result);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: error.code || "ORACLE_FIREFOX_ERROR", message: error.message, recoveryAction: error.recoveryAction || null }, null, 2)}
`);
  process.exitCode = 1;
}
