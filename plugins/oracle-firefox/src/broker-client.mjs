import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  brokerEndpoint,
  brokerLaunchLockPath,
  brokerNodePath,
  brokerTokenPath,
  coordinatorDirectory,
  coordinatorLogPath,
} from "./config.mjs";
import { codedError } from "./errors.mjs";
import { BROKER_PROTOCOL_VERSION, rpcRequest } from "./protocol.mjs";

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function readOrCreateBrokerToken() {
  await ensurePrivateDirectory(coordinatorDirectory());
  const tokenPath = brokerTokenPath();
  try {
    return (await readFile(tokenPath, "utf8")).trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const candidate = randomBytes(32).toString("hex");
  try {
    const handle = await open(tokenPath, "wx", 0o600);
    try {
      await handle.writeFile(`${candidate}\n`, "utf8");
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

export async function startBrokerDetached() {
  const token = await readOrCreateBrokerToken();
  const existing = await brokerResponds(token);
  if (existing) return existing;
  if (process.platform !== "win32") await ensurePrivateDirectory(path.dirname(brokerEndpoint()));
  await ensurePrivateDirectory(coordinatorDirectory());
  const lockPath = brokerLaunchLockPath();
  let ownsLock = false;
  try {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      ownsLock = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 30_000) {
        await rm(lockPath, { recursive: true, force: true });
        await mkdir(lockPath, { mode: 0o700 });
        ownsLock = true;
      }
    }
    if (ownsLock) {
      const afterLock = await brokerResponds(token);
      if (afterLock) return afterLock;
      const log = await open(coordinatorLogPath(), "a", 0o600);
      try {
        const brokerEntry = new URL("./broker.mjs", import.meta.url);
        const child = spawn(brokerNodePath(), [brokerEntry.pathname, "--daemon"], {
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          env: { ...process.env, ORACLE_FIREFOX_BROKER_CHILD: "1" },
        });
        child.unref();
      } finally {
        await log.close();
      }
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const status = await brokerResponds(token, 750);
      if (status) return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw codedError("BROKER_START_FAILED", `Oracle Firefox broker did not start. See ${coordinatorLogPath()}.`);
  } finally {
    if (ownsLock) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function callBroker(method, params = {}, options = {}) {
  const token = await readOrCreateBrokerToken();
  let status = await brokerResponds(token);
  if (!status) status = await startBrokerDetached();
  if (status.protocolVersion !== BROKER_PROTOCOL_VERSION) {
    const shutdown = await rpcRequest(brokerEndpoint(), token, "broker.shutdownWhenIdle", {}, { timeoutMs: 2_000 }).catch(() => null);
    if (status.outstandingJobs === 0 && shutdown?.accepted) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await brokerResponds(token, 500))) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      status = await startBrokerDetached();
    }
    if (status.protocolVersion !== BROKER_PROTOCOL_VERSION) {
      throw codedError(
        "BROKER_PROTOCOL_MISMATCH",
        `Running broker protocol ${status.protocolVersion} is incompatible. It will shut down after ${status.outstandingJobs} active job(s) finish; none were killed or resent.`,
        { details: status, recoveryAction: "retry after the active broker becomes idle" },
      );
    }
  }
  return rpcRequest(brokerEndpoint(), token, method, params, {
    timeoutMs: options.timeoutMs ?? 60_000,
    client: { pid: process.pid, harness: options.harness || "unknown", buildVersion: "1.2.0" },
  });
}
