import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  attachRpcServer,
  BROKER_PROTOCOL_VERSION,
  createFrameDecoder,
  encodeFrame,
  tokensEqual,
} from "../src/protocol.mjs";
import { canRequestIdleUpgrade, normalizeLegacyBrokerStatus } from "../src/broker-client.mjs";

const TOKEN = "protocol-test-token";

class FakeSocket extends EventEmitter {
  constructor({ backpressure = false } = {}) {
    super();
    this.backpressure = backpressure;
    this.destroyed = false;
    this.writable = true;
    this.frames = [];
  }

  setNoDelay() {}

  setTimeout(timeoutMs) {
    this.timeoutMs = timeoutMs;
  }

  write(frame, callback) {
    if (this.destroyed || !this.writable) {
      const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      queueMicrotask(() => callback?.(error));
      return false;
    }
    this.frames.push(Buffer.from(frame));
    queueMicrotask(() => callback?.(null));
    return !this.backpressure;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    queueMicrotask(() => this.emit("close"));
  }
}

function attachFake(methods, options = {}) {
  const socket = new FakeSocket(options);
  attachRpcServer(socket, {
    token: TOKEN,
    methods,
    serverInfo: { fixture: true },
    socketTimeoutMs: options.socketTimeoutMs,
  });
  return socket;
}

function requestFrame(method, params = {}, id = crypto.randomUUID()) {
  return encodeFrame({ id, token: TOKEN, protocolVersion: BROKER_PROTOCOL_VERSION, method, params });
}

async function responseFrom(socket, method, params = {}) {
  const id = crypto.randomUUID();
  socket.emit("data", requestFrame(method, params, id));
  while (!socket.frames.length) await new Promise((resolve) => setTimeout(resolve, 1));
  let observed = null;
  const decode = createFrameDecoder((value) => {
    if (value.id === id) observed = value;
  }, (error) => { throw error; });
  socket.frames.forEach((frame) => decode(frame));
  return observed;
}

test("length-prefixed JSON framing survives fragmented and combined chunks", () => {
  const observed = [];
  const decode = createFrameDecoder((value) => observed.push(value), (error) => { throw error; });
  const combined = Buffer.concat([encodeFrame({ one: 1 }), encodeFrame({ two: 2 })]);
  decode(combined.subarray(0, 3));
  decode(combined.subarray(3, 11));
  decode(combined.subarray(11));
  assert.deepEqual(observed, [{ one: 1 }, { two: 2 }]);
});

test("broker token comparison is constant-length and fail-closed", () => {
  assert.equal(tokensEqual("abc", "abc"), true);
  assert.equal(tokensEqual("abc", "abd"), false);
  assert.equal(tokensEqual("", ""), false);
});

test("known legacy status is normalized for directional upgrade without inventing a generation", () => {
  const normalized = normalizeLegacyBrokerStatus({
    protocolVersion: 6,
    buildVersion: "1.4.1",
    pid: 123,
    outstandingJobs: 2,
  }, "/tmp/legacy.sock");
  assert.deepEqual(normalized.protocol, { minimum: 6, maximum: 6 });
  assert.equal(normalized.releaseSequence, 1401);
  assert.equal(normalized.instanceId, "legacy:123:/tmp/legacy.sock");
  assert.equal(normalized.leaseGeneration, 0);
  assert.equal(normalized.legacy, true);
});

test("unknown legacy builds are not assigned an upgrade ordering", () => {
  assert.equal(normalizeLegacyBrokerStatus({ protocolVersion: 5, buildVersion: "dev" }, "fixture").releaseSequence, 0);
});

test("same-protocol upgrade waits for active browser work but preserves durable queued jobs", () => {
  const hello = { releaseSequence: 1600 };
  assert.equal(canRequestIdleUpgrade(hello, {
    activeJobCount: 0,
    outstandingJobs: 3,
    draining: false,
    browser: { pagesLeased: 0, maintenance: false },
  }), true);
  assert.equal(canRequestIdleUpgrade(hello, {
    activeJobCount: 1,
    outstandingJobs: 1,
    draining: false,
    browser: { pagesLeased: 1, maintenance: false },
  }), false);
  assert.equal(canRequestIdleUpgrade(hello, {
    activeJobCount: 0,
    outstandingJobs: 0,
    draining: false,
    browser: { pagesLeased: 0, maintenance: true },
  }), false);
  assert.equal(canRequestIdleUpgrade(hello, {
    activeJobCount: 0,
    outstandingJobs: 0,
    draining: true,
    browser: { pagesLeased: 0, maintenance: false },
  }), false);
});

test("disconnect after a committed start abandons only the late receipt response", async () => {
  let committed = 0;
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let completed;
  const completion = new Promise((resolve) => { completed = resolve; });
  const methods = {
    "jobs.start": async () => {
      committed += 1;
      await released;
      completed();
      return { jobId: crypto.randomUUID(), committed: true };
    },
    ping: () => ({ alive: true }),
  };
  const abandoned = attachFake(methods);
  abandoned.emit("data", requestFrame("jobs.start"));
  abandoned.destroy();
  assert.equal(committed, 1);
  release();
  await completion;
  const healthy = attachFake(methods);
  assert.deepEqual((await responseFrom(healthy, "ping")).result, { alive: true });
  assert.equal(committed, 1);
});

test("disconnect during job_wait does not cancel the waiter or terminate the RPC server", async () => {
  let waitFinished = false;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const methods = {
    "jobs.wait": async () => {
      await waiting;
      waitFinished = true;
      return { state: "completed" };
    },
    ping: () => "pong",
  };
  const abandoned = attachFake(methods);
  abandoned.emit("data", requestFrame("jobs.wait"));
  abandoned.destroy();
  release();
  while (!waitFinished) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal((await responseFrom(attachFake(methods), "ping")).result, "pong");
});

test("repeated EPIPE-style client churn and backpressured late replies never crash the broker", async () => {
  let invocations = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const methods = {
    churn: async () => {
      invocations += 1;
      await blocked;
      return { payload: "x".repeat(512 * 1024) };
    },
    ping: () => ({ alive: true }),
  };
  const churn = Array.from({ length: 24 }, (_, index) => {
    const socket = attachFake(methods, { backpressure: true });
    socket.emit("data", requestFrame("churn"));
    socket.emit("error", Object.assign(new Error("client reset"), {
      code: index % 2 ? "EPIPE" : "ECONNRESET",
    }));
    socket.destroy();
    return socket;
  });
  assert.equal(invocations, 24);
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(churn.every((socket) => socket.frames.length === 0), true);
  assert.deepEqual((await responseFrom(attachFake(methods), "ping")).result, { alive: true });
});

test("partial frames, malformed frames, and idle socket timeouts are isolated to their client", async () => {
  const methods = { ping: () => "pong" };
  const partial = attachFake(methods);
    partial.emit("data", Buffer.from([0, 0, 0, 20, 123, 34]));
    partial.destroy();

    const invalid = attachFake(methods);
    invalid.emit("data", Buffer.from([255, 255, 255, 255]));
    while (!invalid.destroyed) await new Promise((resolve) => setTimeout(resolve, 1));

    const idle = attachFake(methods, { socketTimeoutMs: 1_000 });
    idle.emit("timeout");
    assert.equal(idle.destroyed, true);
    assert.equal((await responseFrom(attachFake(methods), "ping")).result, "pong");
});
