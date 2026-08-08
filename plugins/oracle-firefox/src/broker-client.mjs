import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  BROKER_BUILD_ID,
  BROKER_PROTOCOL_VERSION,
  BROKER_RELEASE_SEQUENCE,
  ORACLE_FIREFOX_VERSION,
} from "./build-info.mjs";
import { readBrokerLocator } from "./broker-locator.mjs";
import { BrokerLaunchLease } from "./broker-lease.mjs";
import { brokerLaunchLockPath, brokerNodePath, brokerTokenPath, coordinatorDirectory, coordinatorLogPath } from "./config.mjs";
import { resolveCoordinatorIdentity } from "./coordinator-identity.mjs";
import { codedError } from "./errors.mjs";
import { rpcRequest } from "./protocol.mjs";

const clientInstanceId = randomUUID();
const clientSessions = new Map();
const KNOWN_RELEASE_SEQUENCES = new Map([
  ["1.2.1", 1201],
  ["1.3.0", 1300],
  ["1.4.0", 1400],
  ["1.4.1", 1401],
  [ORACLE_FIREFOX_VERSION, BROKER_RELEASE_SEQUENCE],
]);

function processIsAlive(pid) {
  const value = Number(pid);
  if (!Number.isSafeInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    // Permission denial still proves that a process occupies the PID. A PID
    // reused during this bounded wait only delays the upgrade, which is the
    // fail-closed direction.
    return error?.code !== "ESRCH";
  }
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function readOrCreateBrokerToken() {
  await ensurePrivateDirectory(coordinatorDirectory());
  const tokenPath = brokerTokenPath();
  const readExisting = async () => {
    const value = (await readFile(tokenPath, "utf8")).trim();
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
  const candidate = randomBytes(32).toString("hex");
  const temporary = `${tokenPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(`${candidate}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await link(temporary, tokenPath);
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return await readExisting();
    }
  } catch (error) {
    try { await handle.close(); } catch {}
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function clientMetadata(harness, hostSessionHint = null, session = null) {
  return {
    pid: process.pid,
    harness,
    clientInstanceId,
    buildVersion: ORACLE_FIREFOX_VERSION,
    buildId: BROKER_BUILD_ID,
    releaseSequence: BROKER_RELEASE_SEQUENCE,
    hostSessionHint,
    sessionId: session?.sessionId,
    sessionHandle: session?.sessionHandle,
  };
}

export function normalizeLegacyBrokerStatus(status, endpoint) {
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
    legacy: true,
  };
}

export function canRequestIdleUpgrade(hello, status) {
  return Boolean(
    status && !status.draining &&
    BROKER_RELEASE_SEQUENCE > Number(hello?.releaseSequence || 0) &&
    Number(status.activeJobCount || 0) === 0 &&
    Number(status.browser?.pagesLeased || 0) === 0 &&
    status.browser?.maintenance !== true
  );
}

async function probeBroker(identity, token, timeoutMs = 750, endpointOverride = null) {
  const locator = endpointOverride ? null : await readBrokerLocator(identity, token);
  const endpoint = endpointOverride || locator?.endpoint?.path || identity.endpoint;
  try {
    const hello = await rpcRequest(endpoint, token, "broker.hello", {}, {
      timeoutMs,
      client: clientMetadata("broker-probe"),
    });
    return { kind: hello.state === "starting" ? "starting" : "live", hello, endpoint };
  } catch (error) {
    if (error?.code === "BROKER_UNAUTHORIZED") return { kind: "auth-conflict", error, endpoint };
    if (new Set(["METHOD_NOT_FOUND", "BROKER_PROTOCOL_MISMATCH"]).has(error?.code)) {
      try {
        const status = await rpcRequest(endpoint, token, "broker.status", {}, {
          timeoutMs,
          client: clientMetadata("legacy-broker-probe"),
        });
        return { kind: "live", hello: normalizeLegacyBrokerStatus(status, endpoint), endpoint };
      } catch (legacyError) {
        if (legacyError?.code === "BROKER_UNAUTHORIZED") return { kind: "auth-conflict", error: legacyError, endpoint };
        if (!new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "EPIPE"]).has(legacyError?.code)) {
          return { kind: "timeout", error: legacyError, endpoint };
        }
      }
    }
    if (new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "EPIPE"]).has(error?.code)) {
      return { kind: "absent", error, endpoint };
    }
    return { kind: "timeout", error, endpoint };
  }
}

export async function waitForBrokerRelease(
  token,
  { identity = null, expectedInstanceId = null, timeoutMs = 30_000, probe = null } = {},
) {
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
      // The old broker closes its RPC socket before the lifetime lease is
      // released. Do not launch its successor during that narrow shutdown
      // window; wait until the exact owning process has exited instead.
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

export async function startBrokerDetached(identity = null, token = null) {
  const resolved = identity || await resolveCoordinatorIdentity();
  const auth = token || await readOrCreateBrokerToken();
  const deadline = Date.now() + 20_000;
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
          details: { probeCode: existing.error?.code || null, probeMessage: existing.error?.message || null },
        });
      }
    }
    if (!launchLease) throw codedError("BROKER_START_BUSY", "Another client is still coordinating broker startup.", { safeToRetry: true });

    const afterLease = await probeBroker(resolved, auth);
    if (new Set(["live", "starting"]).has(afterLease.kind)) return afterLease.hello;
    if (afterLease.kind === "auth-conflict") throw codedError("BROKER_ENDPOINT_CONFLICT", "The broker endpoint changed authentication while starting.");
    if (afterLease.kind === "timeout") throw codedError("BROKER_UNRESPONSIVE", "The canonical broker endpoint is occupied but unresponsive; no competitor was launched.", {
      safeToRetry: true,
      details: { probeCode: afterLease.error?.code || null, probeMessage: afterLease.error?.message || null },
    });

    const log = await open(coordinatorLogPath(), "a", 0o600);
    try {
      // fileURLToPath is required for install roots containing spaces.
      const brokerEntry = fileURLToPath(new URL("./broker.mjs", import.meta.url));
      const child = spawn(brokerNodePath(), [brokerEntry, "--daemon"], {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: { ...process.env, ORACLE_FIREFOX_BROKER_CHILD: "1" },
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
      // A legacy endpoint was global per OS user. A different coordinator's
      // token rejection or stale socket does not establish shared identity.
      if (!new Set(["live", "starting"]).has(legacy.kind)) continue;
      observed = legacy;
      break;
    }
    if (observed.kind === "absent") {
      const started = await startBrokerDetached(identity, token);
      observed = {
        kind: started?.state === "starting" ? "starting" : "live",
        hello: started,
        endpoint: identity.endpoint,
      };
    }
  }
  if (observed.kind === "timeout") {
    const started = await startBrokerDetached(identity, token);
    observed = {
      kind: started?.state === "starting" ? "starting" : "live",
      hello: started,
      endpoint: identity.endpoint,
    };
  }
  if (observed.kind === "auth-conflict") throw codedError("BROKER_ENDPOINT_CONFLICT", "The broker endpoint rejected this coordinator token.");
  if (observed.kind === "starting") {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && observed.kind === "starting") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      observed = await probeBroker(identity, token, 1_000);
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
        timeoutMs: 2_000,
        client: clientMetadata("broker-upgrade-check"),
      }).catch(() => null);
      const safelyIdle = canRequestIdleUpgrade(hello, status);
      if (safelyIdle) {
        const upgrade = await rpcRequest(observed.endpoint, token, "broker.requestUpgrade", {
          expectedInstanceId: hello.instanceId,
          expectedLeaseGeneration: hello.leaseGeneration,
          requesterReleaseSequence: BROKER_RELEASE_SEQUENCE,
          requesterBuildId: BROKER_BUILD_ID,
          requesterProtocolMinimum: BROKER_PROTOCOL_VERSION,
          requesterProtocolMaximum: BROKER_PROTOCOL_VERSION,
        }, {
          timeoutMs: 2_000,
          client: clientMetadata("broker-upgrade"),
        }).catch(() => null);
        if (upgrade?.accepted) {
          const released = await waitForBrokerRelease(token, {
            identity,
            expectedInstanceId: hello.instanceId,
            probe: (auth, wait) => probeBroker(identity, auth, wait, observed.endpoint),
          });
          if (released) return { hello: await startBrokerDetached(identity, token), endpoint: identity.endpoint };
          throw codedError("BROKER_UPGRADE_PENDING", "The idle Oracle Firefox broker accepted an upgrade but did not release its lifetime lease in time.", {
            safeToRetry: true,
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
      requesterProtocolMaximum: BROKER_PROTOCOL_VERSION,
    };
    const upgrade = await rpcRequest(
      observed.endpoint,
      token,
      hello.legacy ? "broker.shutdownWhenIdle" : "broker.requestUpgrade",
      upgradeParams,
      { timeoutMs: 2_000, client: clientMetadata("broker-upgrade") },
    ).catch((error) => ({ accepted: false, error: { code: error.code, message: error.message } }));
    if (upgrade?.accepted) {
      const released = await waitForBrokerRelease(token, {
        identity,
        expectedInstanceId: hello.instanceId,
        probe: (auth, wait) => probeBroker(identity, auth, wait, observed.endpoint),
      });
      if (released) return { hello: await startBrokerDetached(identity, token), endpoint: identity.endpoint };
    }
  }
  throw codedError(
    Number(hello?.releaseSequence || 0) > BROKER_RELEASE_SEQUENCE ? "CLIENT_UPGRADE_REQUIRED" : "BROKER_PROTOCOL_MISMATCH",
    `Running Oracle Firefox broker ${hello?.buildVersion || "unknown"} uses protocol ${hello?.protocol?.minimum || "unknown"}. This client did not stop or downgrade it.`,
    { details: hello, recoveryAction: "reload this host with the current Oracle Firefox package" },
  );
}

export async function callBroker(method, params = {}, options = {}) {
  const identity = await resolveCoordinatorIdentity();
  const token = await readOrCreateBrokerToken();
  const { hello, endpoint } = await compatibleBroker(identity, token);
  const harness = options.harness || "unknown";
  const hostSessionHint = options.hostSessionHint || null;
  const sessionKey = [identity.coordinatorId, hello.instanceId, harness, hostSessionHint || ""].join(":");
  let session = clientSessions.get(sessionKey);
  const openSession = async () => rpcRequest(endpoint, token, "broker.openSession", {
    harness,
    clientInstanceId,
    hostSessionHint,
  }, {
    timeoutMs: 10_000,
    client: clientMetadata(harness, hostSessionHint),
  });
  if (!session) {
    session = await openSession();
    clientSessions.set(sessionKey, session);
  }
  const invoke = () => rpcRequest(endpoint, token, method, params, {
    timeoutMs: options.timeoutMs ?? 60_000,
    client: clientMetadata(harness, hostSessionHint, session),
  });
  try {
    return await invoke();
  } catch (error) {
    if (!new Set(["CLIENT_SESSION_REQUIRED", "OWNER_SESSION_NOT_FOUND"]).has(error?.code)) throw error;
    clientSessions.delete(sessionKey);
    session = await openSession();
    clientSessions.set(sessionKey, session);
    return invoke();
  }
}
