import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  browserDoctor,
  inspectNativeMacChrome,
  launchChrome,
  macChromePathRejectionReason,
  resolveChromePath,
} from "../src/browser-backends.mjs";
import { BrowserManager } from "../src/browser-manager.mjs";

test("rejects Parallels, mounted-volume, and non-app Chrome paths before identity checks", () => {
  assert.match(
    macChromePathRejectionReason("/Applications (Parallels)/Google Chrome.app/Contents/MacOS/Google Chrome"),
    /VM|Parallels/iu,
  );
  assert.match(
    macChromePathRejectionReason("/Applications/Parallels Desktop.app/Contents/Windows Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    /VM|Parallels/iu,
  );
  assert.match(
    macChromePathRejectionReason("/Volumes/Windows/Google Chrome.app/Contents/MacOS/Google Chrome"),
    /mounted-volume/iu,
  );
  assert.match(macChromePathRejectionReason("/usr/local/bin/google-chrome"), /Applications/iu);
  assert.equal(
    macChromePathRejectionReason("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    null,
  );
});

test("macOS Chrome discovery accepts only a positively inspected native candidate", async () => {
  const inspected = [];
  const result = await resolveChromePath({
    platform: "darwin",
    configured: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    inspectMac: async (candidate) => {
      inspected.push(candidate);
      return {
        accepted: true,
        path: candidate,
        bundleIdentifier: "com.google.Chrome",
        teamIdentifier: "EQHXZ8M8AV",
      };
    },
  });
  assert.deepEqual(inspected, ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
  assert.equal(result.path, inspected[0]);
  assert.equal(result.identity.bundleIdentifier, "com.google.Chrome");
});

test("browser selection closes the old backend, persists the choice, and refuses active leases", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-selection-"));
  const previousCoordinator = process.env.ORACLE_FIREFOX_COORDINATOR_HOME;
  process.env.ORACLE_FIREFOX_COORDINATOR_HOME = directory;
  let launches = 0;
  const browser = {
    connected: true,
    process() { return null; },
    once() {},
    async close() { this.connected = false; },
  };
  const manager = new BrowserManager({
    browserName: "firefox",
    browserMode: "visible",
    launcher: async () => { launches += 1; browser.connected = true; return browser; },
    pageOpener: async () => ({ bringToFront: async () => {}, close: async () => {} }),
    ownerFileEnabled: false,
  });
  try {
    const lease = await manager.leasePage("active");
    await assert.rejects(() => manager.selectBrowser("chrome"), (error) => error.code === "BROWSER_SELECTION_BUSY");
    await manager.releasePage(lease.jobId);
    const selected = await manager.selectBrowser("chrome");
    assert.equal(selected.changed, true);
    assert.equal(selected.browser, "chrome");
    assert.equal(manager.status().browserName, "chrome");
    assert.equal(launches, 1);
  } finally {
    await manager.close();
    if (previousCoordinator === undefined) delete process.env.ORACLE_FIREFOX_COORDINATOR_HOME;
    else process.env.ORACLE_FIREFOX_COORDINATOR_HOME = previousCoordinator;
    await rm(directory, { recursive: true, force: true });
  }
});

test("native macOS Chrome identity is Google-signed and launches a private headless fixture", {
  skip: process.platform !== "darwin",
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-native-chrome-fixture-"));
  let browser;
  try {
    const resolved = await resolveChromePath();
    assert.equal(resolved.path, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    assert.equal(resolved.identity.bundleIdentifier, "com.google.Chrome");
    assert.equal(resolved.identity.teamIdentifier, "EQHXZ8M8AV");
    assert.equal((await inspectNativeMacChrome(resolved.path)).accepted, true);
    browser = await launchChrome({ headless: true, profileDir: path.join(directory, "profile") });
    const page = await browser.newPage();
    await page.goto("data:text/html,<title>native-mac-chrome</title><main id='ok'>yes</main>");
    assert.equal(await page.$eval("#ok", (node) => node.textContent), "yes");
  } finally {
    await browser?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor reports all targets and keeps Firefox as the compatibility default", async () => {
  const result = await browserDoctor("firefox");
  assert.equal(result.browser, "firefox");
  assert.deepEqual(Object.keys(result.browsers), ["firefox", "chrome", "safari"]);
  assert.equal(result.browsers.safari.authenticationPersistence, "automation-session-only");
});
