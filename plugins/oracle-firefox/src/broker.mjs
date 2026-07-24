#!/usr/bin/env node
import net from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { brokerEndpoint } from "./config.mjs";
import { Coordinator } from "./coordinator.mjs";
import { attachRpcServer, BROKER_BUILD_VERSION, BROKER_PROTOCOL_VERSION, rpcRequest } from "./protocol.mjs";
import { readOrCreateBrokerToken } from "./broker-client.mjs";

const endpoint = brokerEndpoint();
const token = await readOrCreateBrokerToken();

async function existingBroker() {
  try {
    return await rpcRequest(endpoint, token, "broker.status", {}, { timeoutMs: 750 });
  } catch {
    return null;
  }
}

if (await existingBroker()) process.exit(0);
if (process.platform !== "win32") {
  await mkdir(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  await rm(endpoint, { force: true });
}

const coordinator = await new Coordinator().open();
const methods = await coordinator.methods();
let shutdownRequested = false;
methods["broker.shutdownWhenIdle"] = async () => {
  shutdownRequested = true;
  const status = await coordinator.statusAsync();
  if (status.outstandingJobs === 0) setTimeout(() => void shutdown("protocol-upgrade"), 25);
  return {
    accepted: true,
    outstandingJobs: status.outstandingJobs,
    action: status.outstandingJobs === 0 ? "shutting down now" : "will shut down after all active jobs become terminal",
  };
};
const serverInfo = {
  name: "oracle-firefox-broker",
  protocolVersion: BROKER_PROTOCOL_VERSION,
  buildVersion: BROKER_BUILD_VERSION,
  pid: process.pid,
};
const server = net.createServer((socket) => attachRpcServer(socket, { token, methods, serverInfo }));
server.on("error", (error) => {
  process.stderr.write(`${new Date().toISOString()} broker error: ${error.message}\n`);
  process.exitCode = 1;
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(endpoint, resolve);
});
if (process.platform !== "win32") await chmod(endpoint, 0o600);
process.stdout.write(`${new Date().toISOString()} oracle-firefox broker ready pid=${process.pid}\n`);

const idleShutdownPoll = setInterval(async () => {
  if (!shutdownRequested || closing) return;
  const status = await coordinator.statusAsync();
  if (status.outstandingJobs === 0) void shutdown("protocol-upgrade-idle");
}, 1_000);
idleShutdownPoll.unref();

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  clearInterval(idleShutdownPoll);
  process.stdout.write(`${new Date().toISOString()} broker stopping signal=${signal}\n`);
  await new Promise((resolve) => server.close(resolve));
  await coordinator.close();
  if (process.platform !== "win32") await rm(endpoint, { force: true }).catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
