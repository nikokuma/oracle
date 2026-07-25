import net from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { codedError, structuredError } from "./errors.mjs";

export const BROKER_PROTOCOL_VERSION = 1;
export const BROKER_BUILD_VERSION = "1.1.0";
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

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

export function attachRpcServer(socket, { token, methods, serverInfo }) {
  socket.setNoDelay(true);
  const send = (value) => socket.write(encodeFrame(value));
  const decoder = createFrameDecoder(async (request) => {
    const id = request?.id || randomUUID();
    try {
      if (!tokensEqual(request?.token, token)) {
        throw codedError("BROKER_UNAUTHORIZED", "Broker authentication failed.");
      }
      const crossVersionMethod = new Set(["broker.status", "broker.shutdownWhenIdle"]).has(request?.method);
      if (request?.protocolVersion !== BROKER_PROTOCOL_VERSION && !crossVersionMethod) {
        throw codedError(
          "BROKER_PROTOCOL_MISMATCH",
          `Client protocol ${request?.protocolVersion ?? "unknown"} is incompatible with broker protocol ${BROKER_PROTOCOL_VERSION}.`,
          { details: serverInfo },
        );
      }
      const handler = methods[request.method];
      if (!handler) throw codedError("METHOD_NOT_FOUND", `Unknown broker method: ${request.method}`);
      const result = await handler(request.params ?? {}, { requestId: id, client: request.client ?? null });
      send({ id, ok: true, result, server: serverInfo });
    } catch (error) {
      send({ id, ok: false, error: structuredError(error), server: serverInfo });
    }
  }, (error) => {
    send({ id: null, ok: false, error: structuredError(error), server: serverInfo });
    socket.destroy();
  });
  socket.on("data", decoder);
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
        client: options.client ?? { pid: process.pid, buildVersion: BROKER_BUILD_VERSION },
      }));
    });
    socket.on("data", decoder);
    socket.once("error", (error) => finish(reject, error));
    socket.once("close", () => {
      if (!settled) finish(reject, codedError("BROKER_DISCONNECTED", "Broker disconnected before replying."));
    });
  });
}
