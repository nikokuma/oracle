import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { launchSafari, shutdownSafariProcess } from "../src/safari-webdriver.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

test("Safari WebDriver adapter owns one session and isolates window routing", {
  skip: process.platform !== "darwin",
  timeout: 15_000,
}, async () => {
  const driverPath = path.resolve(root, "../test-support/fake-safaridriver.mjs");
  const browser = await launchSafari({ driverPath });
  try {
    const [first] = await browser.pages();
    assert.equal(first.url(), "about:blank");
    await first.goto("https://chatgpt.com/");
    assert.equal(first.url(), "https://chatgpt.com/");
    const second = await browser.newPage();
    await second.goto("https://chatgpt.com/c/fixture");
    assert.equal(second.url(), "https://chatgpt.com/c/fixture");
    await second.setCookie({
      name: "fixture",
      value: "private",
      domain: ".chatgpt.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    const cookies = await second.cookies();
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].name, "fixture");
    assert.equal(first.url(), "https://chatgpt.com/");
    assert.equal((await browser.pages()).length, 2);
  } finally {
    await browser.close();
  }
});

test("Safari fails closed when headless mode is requested", async () => {
  await assert.rejects(() => launchSafari({ headless: true }), (error) => error.code === "SAFARI_HEADLESS_UNSUPPORTED");
});

test("Safari shutdown is bounded and escalates only the exact owned driver process", async () => {
  class FakeChild extends EventEmitter {
    constructor(pid, exitOnTerm = false) {
      super();
      this.pid = pid;
      this.exitCode = null;
      this.signalCode = null;
      this.exitOnTerm = exitOnTerm;
      this.signals = [];
    }

    kill(signal) {
      this.signals.push(signal);
      if (signal === "SIGKILL" || this.exitOnTerm) {
        queueMicrotask(() => {
          this.signalCode = signal;
          this.emit("exit", null, signal);
        });
      }
      return true;
    }
  }

  const owned = new FakeChild(41001);
  const foreign = new FakeChild(41002);
  const started = Date.now();
  const result = await shutdownSafariProcess(owned, { termTimeoutMs: 20, killTimeoutMs: 20 });
  assert.equal(result.pid, 41001);
  assert.equal(result.escalated, true);
  assert.equal(result.exited, true);
  assert.deepEqual(owned.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(foreign.signals, []);
  assert.ok(Date.now() - started < 250);

  const graceful = new FakeChild(41003, true);
  const gracefulResult = await shutdownSafariProcess(graceful, { termTimeoutMs: 20, killTimeoutMs: 20 });
  assert.equal(gracefulResult.escalated, false);
  assert.deepEqual(graceful.signals, ["SIGTERM"]);
});
