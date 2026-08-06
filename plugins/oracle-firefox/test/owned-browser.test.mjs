import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { wrapOwnedBrowser } from "../src/owned-browser.mjs";

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("browser close terminates only its exact lingering Puppeteer child", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const browser = wrapOwnedBrowser({
    process: () => child,
    async close() {},
  }, { gracefulCloseMs: 10, terminateMs: 250 });
  try {
    assert.equal(alive(child.pid), true);
    await browser.close();
    assert.equal(alive(child.pid), false);
  } finally {
    if (alive(child.pid)) process.kill(child.pid, "SIGKILL");
  }
});

