#!/usr/bin/env node
import net from "node:net";
import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { BrokerLifetimeLease, processStartIdentity } from "./broker-lease.mjs";
import { readOrCreateBrokerToken } from "./broker-client.mjs";
import { compareAndUnlinkEndpoint, endpointFileIdentity, readBrokerLocator, writeBrokerLocator } from "./broker-locator.mjs";
import { BrowserManager } from "./browser-manager.mjs";
import {
  BROKER_BUILD_ID,
  BROKER_PROTOCOL_VERSION,
  BROKER_RELEASE_SEQUENCE,
  BROKER_SCHEMA_VERSION,
  ORACLE_FIREFOX_VERSION,
} from "./build-info.mjs";
import { Coordinator } from "./coordinator.mjs";
import { resolveCoordinatorIdentity } from "./coordinator-identity.mjs";
import { codedError, structuredError } from "./errors.mjs";
import { attachRpcServer, rpcRequest } from "./protocol.mjs";
import { StateStore } from "./state-store.mjs";

const identity = await resolveCoordinatorIdentity();
const endpoint = identity.endpoint;
const token = await readOrCreateBrokerToken();

async function probe() {
  try {
    return { kind: "live", hello: await rpcRequest(endpoint, token, "broker.hello", {}, { timeoutMs: 750 }) };
  } catch (error) {
    if (error?.code === "BROKER_UNAUTHORIZED") return { kind: "auth-conflict", error };
    return { kind: "absent", error };
  }
}

if ((await probe()).kind === "live") process.exit(0);

let lifetimeLease;
try {
  lifetimeLease = await BrokerLifetimeLease.acquire(identity);
} catch (error) {
  if ((await probe()).kind === "live") process.exit(0);
  process.stderr.write(`${new Date().toISOString()} broker lease unavailable: ${error.message}\n`);
  process.exit(75);
}

const afterLeaseProbe = await probe();
if (afterLeaseProbe.kind === "live") {
  lifetimeLease.release();
  process.exit(0);
}
if (afterLeaseProbe.kind === "auth-conflict") {
  lifetimeLease.release();
  throw codedError("BROKER_ENDPOINT_CONFLICT", "The canonical Oracle Firefox endpoint is owned by a process with different authentication.");
}

if (process.platform !== "win32") {
  await mkdir(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  const priorLocator = await readBrokerLocator(identity, token);
  const existingEndpoint = await endpointFileIdentity(endpoint).catch(() => null);
  if (existingEndpoint) {
    const removed = priorLocator && await compareAndUnlinkEndpoint(identity, token, {
      instanceId: priorLocator.instanceId,
      leaseGeneration: priorLocator.leaseGeneration,
      endpointDevice: priorLocator.endpoint?.device,
      endpointInode: priorLocator.endpoint?.inode,
    });
    if (!removed) {
      lifetimeLease.release();
      throw codedError("BROKER_ENDPOINT_CONFLICT", "Oracle Firefox found an unverified endpoint and refused to unlink it.");
    }
  }
}

const instanceId = randomUUID();
const processStartId = await processStartIdentity(process.pid);
let phase = "starting";
let coordinator = null;
let store = null;
let closing = false;
let shutdownRequested = false;
let locatorBase = null;
let heartbeat = null;
let drainPoll = null;

const serverInfo = {
  name: "oracle-firefox-broker",
  protocolVersion: BROKER_PROTOCOL_VERSION,
  buildVersion: ORACLE_FIREFOX_VERSION,
  buildId: BROKER_BUILD_ID,
  releaseSequence: BROKER_RELEASE_SEQUENCE,
  schemaVersion: BROKER_SCHEMA_VERSION,
  coordinatorId: identity.coordinatorId,
  instanceId,
  leaseGeneration: 0,
  pid: process.pid,
};

const hello = () => ({
  coordinatorId: identity.coordinatorId,
  profileId: identity.profileId,
  instanceId,
  leaseGeneration: serverInfo.leaseGeneration,
  state: phase,
  endpoint,
  protocol: { minimum: BROKER_PROTOCOL_VERSION, maximum: BROKER_PROTOCOL_VERSION },
  schemaVersion: BROKER_SCHEMA_VERSION,
  minimumWriterProtocol: BROKER_PROTOCOL_VERSION,
  releaseSequence: BROKER_RELEASE_SEQUENCE,
  buildVersion: ORACLE_FIREFOX_VERSION,
  buildId: BROKER_BUILD_ID,
});

const methods = {
  "broker.hello": hello,
  "broker.status": hello,
  "broker.requestUpgrade": () => ({ accepted: false, code: "BROKER_STARTING", state: phase }),
  "broker.shutdownWhenIdle": () => ({ accepted: false, code: "BROKER_DOWNGRADE_FORBIDDEN" }),
};
const server = net.createServer((socket) => attachRpcServer(socket, { token, methods, serverInfo }));
server.on("error", (error) => {
  process.stderr.write(`${new Date().toISOString()} broker error: ${error.message}\n`);
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  if (process.platform !== "win32") await chmod(endpoint, 0o600);
  const endpointIdentity = await endpointFileIdentity(endpoint).catch(() => ({ device: null, inode: null }));
  locatorBase = {
    instanceId,
    leaseGeneration: 0,
    state: "starting",
    pid: process.pid,
    processStartId,
    endpoint: {
      kind: process.platform === "win32" ? "named_pipe" : "unix",
      path: endpoint,
      device: endpointIdentity.device,
      inode: endpointIdentity.inode,
    },
    protocol: { minimum: BROKER_PROTOCOL_VERSION, maximum: BROKER_PROTOCOL_VERSION },
    releaseSequence: BROKER_RELEASE_SEQUENCE,
    buildVersion: ORACLE_FIREFOX_VERSION,
    buildId: BROKER_BUILD_ID,
    schemaVersion: BROKER_SCHEMA_VERSION,
    startedAt: new Date().toISOString(),
    readyAt: null,
    heartbeatAt: new Date().toISOString(),
  };
  await writeBrokerLocator(identity, token, locatorBase);

  const brokerContext = {
    coordinatorId: identity.coordinatorId,
    profileId: identity.profileId,
    instanceId,
    leaseGeneration: 0,
    protocolVersion: BROKER_PROTOCOL_VERSION,
    releaseSequence: BROKER_RELEASE_SEQUENCE,
    buildVersion: ORACLE_FIREFOX_VERSION,
    buildId: BROKER_BUILD_ID,
    pid: process.pid,
    processStartId,
    endpoint,
    endpointKind: process.platform === "win32" ? "named_pipe" : "unix",
    endpointDevice: endpointIdentity.device,
    endpointInode: endpointIdentity.inode,
    assertCurrentLease() {
      lifetimeLease.assertHeld();
      store?.assertCurrentBroker();
      return true;
    },
  };
  store = await new StateStore(identity.databasePath, { brokerContext }).open();
  serverInfo.leaseGeneration = brokerContext.leaseGeneration;
  const browserManager = new BrowserManager({ brokerContext });
  coordinator = await new Coordinator({ store, browserManager, brokerContext }).open();
  Object.assign(methods, await coordinator.methods());
  methods["broker.hello"] = hello;
  methods["broker.status"] = () => coordinator.statusAsync();
  store.markBrokerReady();
  phase = "ready";
  locatorBase = {
    ...locatorBase,
    leaseGeneration: brokerContext.leaseGeneration,
    state: "ready",
    readyAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  await writeBrokerLocator(identity, token, locatorBase);

  methods["broker.requestUpgrade"] = async (params = {}) => {
    if (
      params.expectedInstanceId && params.expectedInstanceId !== instanceId ||
      params.expectedLeaseGeneration && Number(params.expectedLeaseGeneration) !== Number(brokerContext.leaseGeneration)
    ) return { accepted: false, code: "BROKER_INSTANCE_CHANGED", hello: hello() };
    const requester = Number(params.requesterReleaseSequence || 0);
    if (!requester || requester <= BROKER_RELEASE_SEQUENCE) {
      return {
        accepted: false,
        code: requester === BROKER_RELEASE_SEQUENCE ? "UPGRADE_NOT_NEEDED" : "BROKER_DOWNGRADE_FORBIDDEN",
        hello: hello(),
      };
    }
    shutdownRequested = true;
    phase = "draining";
    coordinator.beginDrain(`upgrade to release sequence ${requester}`);
    await writeBrokerLocator(identity, token, { ...locatorBase, state: phase, heartbeatAt: new Date().toISOString() });
    return { accepted: true, state: phase, activeExecutors: coordinator.active.size };
  };
  methods["broker.shutdownWhenIdle"] = (_params, context) => methods["broker.requestUpgrade"]({
    expectedInstanceId: instanceId,
    expectedLeaseGeneration: brokerContext.leaseGeneration,
    requesterReleaseSequence: context?.client?.releaseSequence || 0,
  });
  process.stdout.write(`${new Date().toISOString()} oracle-firefox broker ready pid=${process.pid} instance=${instanceId}\n`);
} catch (error) {
  phase = "failed";
  process.stderr.write(`${new Date().toISOString()} broker startup failed: ${JSON.stringify(structuredError(error))}\n`);
  await shutdown("startup-failure", { exitCode: 1 });
}

heartbeat = setInterval(async () => {
  if (closing || !coordinator || !store) return;
  try {
    lifetimeLease.assertHeld();
    const heartbeatAt = store.heartbeatBroker();
    await writeBrokerLocator(identity, token, { ...locatorBase, state: phase, heartbeatAt });
  } catch (error) {
    process.stderr.write(`${new Date().toISOString()} broker lease heartbeat failed: ${error.message}\n`);
    void shutdown("lease-lost", { exitCode: 1 });
  }
}, 5_000);
heartbeat.unref();

drainPoll = setInterval(() => {
  if (shutdownRequested && coordinator?.active.size === 0) void shutdown("upgrade-drained");
}, 250);
drainPoll.unref();

async function shutdown(reason, { exitCode = 0 } = {}) {
  if (closing) return;
  closing = true;
  phase = phase === "failed" ? "failed" : "draining";
  if (heartbeat) clearInterval(heartbeat);
  if (drainPoll) clearInterval(drainPoll);
  coordinator?.beginDrain(reason);
  await new Promise((resolve) => server.close(resolve)).catch(() => undefined);
  await coordinator?.close().catch(() => undefined);
  if (!coordinator && store) {
    store.markBrokerReleased?.(reason);
    store.close();
  }
  const expected = {
    instanceId,
    leaseGeneration: serverInfo.leaseGeneration,
    endpointDevice: locatorBase?.endpoint?.device,
    endpointInode: locatorBase?.endpoint?.inode,
  };
  await compareAndUnlinkEndpoint(identity, token, expected).catch(() => false);
  await writeBrokerLocator(identity, token, {
    ...locatorBase,
    state: phase === "failed" ? "failed" : "released",
    heartbeatAt: new Date().toISOString(),
    releasedAt: new Date().toISOString(),
    exitReason: reason,
  }).catch(() => undefined);
  lifetimeLease?.release();
  process.exit(exitCode);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
