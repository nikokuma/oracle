import net from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { codedError, structuredError } from "./errors.mjs";
import {
  BROKER_BUILD_ID,
  BROKER_MINIMUM_READER_PROTOCOL,
  BROKER_MINIMUM_WRITER_PROTOCOL,
  BROKER_PROTOCOL_VERSION,
  BROKER_RELEASE_SEQUENCE,
  ORACLE_FIREFOX_VERSION,
} from "./build-info.mjs";

export { BROKER_PROTOCOL_VERSION } from "./build-info.mjs";
export { BROKER_MINIMUM_READER_PROTOCOL, BROKER_MINIMUM_WRITER_PROTOCOL } from "./build-info.mjs";
export const BROKER_BUILD_VERSION = ORACLE_FIREFOX_VERSION;
export { BROKER_BUILD_ID, BROKER_RELEASE_SEQUENCE };
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const READ_COMPATIBLE_METHODS = new Set([
  "broker.hello",
  "broker.status",
  "broker.openSession",
  "workflow.doctor",
  "jobs.status",
  "jobs.wait",
  "jobs.result",
  "jobs.list",
  "jobs.listAttention",
  "jobs.inspectQuarantine",
  "jobs.inspectInputRequest",
]);

export function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw codedError("FRAME_TOO_LARGE", `Broker frame exceeds ${MAX_FRAME_BYTES} bytes.`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export function createFrameDecoder(onMessage, onError) {
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

export function tokensEqual(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function attachRpcServer(socket, { token, methods, serverInfo, socketTimeoutMs = 5 * 60_000 }) {
  socket.setNoDelay(true);
  const boundedSocketTimeoutMs = Math.max(1_000, Number(socketTimeoutMs) || 5 * 60_000);
  let connected = true;
  let writeQueue = Promise.resolve();
  const abandon = () => {
    connected = false;
  };
  const send = (value) => {
    if (!connected || socket.destroyed || !socket.writable) return Promise.resolve(false);
    let frame;
    try {
      frame = encodeFrame(value);
    } catch {
      return Promise.resolve(false);
    }
    const queued = writeQueue.then(() => new Promise((resolve) => {
      if (!connected || socket.destroyed || !socket.writable) return resolve(false);
      try {
        socket.write(frame, (error) => {
          if (error) abandon();
          resolve(!error && connected);
        });
      } catch {
        abandon();
        resolve(false);
      }
    }));
    writeQueue = queued.catch(() => false);
    return queued;
  };
  const handleRequest = async (request) => {
    const id = request?.id || randomUUID();
    try {
      if (!tokensEqual(request?.token, token)) {
        throw codedError("BROKER_UNAUTHORIZED", "Broker authentication failed.");
      }
      const clientProtocol = Number(request?.protocolVersion || 0);
      if (clientProtocol < BROKER_MINIMUM_READER_PROTOCOL || clientProtocol > BROKER_PROTOCOL_VERSION) {
        throw codedError(
          "BROKER_PROTOCOL_MISMATCH",
          `Client protocol ${request?.protocolVersion ?? "unknown"} is outside broker reader range ${BROKER_MINIMUM_READER_PROTOCOL}-${BROKER_PROTOCOL_VERSION}.`,
          { details: serverInfo },
        );
      }
      if (clientProtocol < BROKER_MINIMUM_WRITER_PROTOCOL && !READ_COMPATIBLE_METHODS.has(request?.method)) {
        throw codedError(
          "CLIENT_UPGRADE_REQUIRED",
          `Client protocol ${clientProtocol} may read from this broker but protocol ${BROKER_MINIMUM_WRITER_PROTOCOL} is required for mutations.`,
          {
            safeToRetry: false,
            recoveryAction: "reload this host with Oracle Firefox 1.7.0 or newer; the running broker was left unchanged",
            details: {
              clientProtocol,
              minimumReaderProtocol: BROKER_MINIMUM_READER_PROTOCOL,
              minimumWriterProtocol: BROKER_MINIMUM_WRITER_PROTOCOL,
              brokerProtocol: BROKER_PROTOCOL_VERSION,
            },
          },
        );
      }
      const handler = methods[request.method];
      if (!handler) throw codedError("METHOD_NOT_FOUND", `Unknown broker method: ${request.method}`);
      const result = await handler(request.params ?? {}, {
        requestId: id,
        client: request.client ?? null,
        protocolVersion: clientProtocol,
        readOnlyCompatibility: clientProtocol < BROKER_MINIMUM_WRITER_PROTOCOL,
      });
      await send({ id, ok: true, result, server: serverInfo });
    } catch (error) {
      await send({ id, ok: false, error: structuredError(error), server: serverInfo });
    }
  };
  const decoder = createFrameDecoder((request) => {
    // The handler owns its full lifecycle. A client disconnect only abandons
    // response delivery; it never cancels an accepted or committed operation.
    void handleRequest(request).catch(() => undefined);
  }, (error) => {
    void send({ id: null, ok: false, error: structuredError(error), server: serverInfo })
      .finally(() => socket.destroy());
  });
  socket.setTimeout(boundedSocketTimeoutMs);
  socket.on("data", decoder);
  socket.on("error", () => {
    abandon();
    if (!socket.destroyed) socket.destroy();
  });
  socket.on("close", abandon);
  socket.on("timeout", () => {
    abandon();
    socket.destroy();
  });
}

export function rpcRequest(endpoint, token, method, params = {}, options = {}) {
  const timeoutMs = Math.max(250, options.timeoutMs ?? 10_000);
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
          client: options.client ?? { pid: process.pid, buildVersion: BROKER_BUILD_VERSION },
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
