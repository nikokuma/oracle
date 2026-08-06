import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeAtomicJson } from "../src/atomic-json.mjs";
import { BrowserManager, removeOwnerIfOwned } from "../src/browser-manager.mjs";
import { AsyncMutex } from "../src/async-lock.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("a timed-out middle mutex waiter never releases the active holder", async () => {
  const mutex = new AsyncMutex("timeout-order", { timeoutMs: 20 });
  let active = 0;
  let maximum = 0;
  const run = (wait, timeoutMs) => mutex.run(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await delay(wait);
    active -= 1;
  }, { timeoutMs });
  const first = run(80, 500);
  await delay(5);
  const middle = run(1, 15).catch((error) => error.code);
  await delay(25);
  const third = run(1, 500);
  assert.equal(await middle, "LOCK_TIMEOUT");
  await Promise.all([first, third]);
  assert.equal(maximum, 1);
});

test("serializes trusted keyboard focus across different leased pages", async () => {
  const manager = new BrowserManager();
  const events = [];
  let active = 0;
  const page = (name) => ({
    async bringToFront() { events.push(`${name}:front`); },
  });

  const run = (name, wait) => manager.withInputFocus(page(name), async () => {
    active += 1;
    assert.equal(active, 1);
    events.push(`${name}:start`);
    await delay(wait);
    events.push(`${name}:end`);
    active -= 1;
  });

  await Promise.all([run("first", 30), run("second", 0)]);
  assert.deepEqual(events, [
    "first:front",
    "first:start",
    "first:end",
    "second:front",
    "second:start",
    "second:end",
  ]);
});

test("releases the input-focus mutex when insertion fails", async () => {
  const manager = new BrowserManager();
  const page = { async bringToFront() {} };
  await assert.rejects(
    () => manager.withInputFocus(page, async () => { throw new Error("fixture failure"); }),
    /fixture failure/u,
  );
  await assert.doesNotReject(() => manager.withInputFocus(page, async () => undefined));
});

test("serializes browser download controls across agents and releases after failure", async () => {
  const manager = new BrowserManager();
  const events = [];
  let active = 0;
  const run = (name, wait, fail = false) => manager.withDownload(async () => {
    active += 1;
    assert.equal(active, 1);
    events.push(`${name}:start`);
    await delay(wait);
    events.push(`${name}:end`);
    active -= 1;
    if (fail) throw new Error(`${name} failed`);
  });

  const first = run("first", 20, true).catch((error) => error.message);
  const second = run("second", 0);
  assert.equal(await first, "first failed");
  await second;
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

function fakeBrowserHarness() {
  let launches = 0;
  let pages = 0;
  const disconnectListeners = [];
  const browser = {
    connected: true,
    process() { return null; },
    once(event, callback) { if (event === "disconnected") disconnectListeners.push(callback); },
    async close() { this.connected = false; for (const callback of disconnectListeners) callback(); },
  };
  return {
    browser,
    counts: () => ({ launches, pages }),
    async launcher({ headless }) {
      launches += 1;
      assert.equal(headless, true);
      await delay(20);
      browser.connected = true;
      return browser;
    },
    async opener() {
      pages += 1;
      await delay(5);
      return {
        async bringToFront() {},
        async close() {},
      };
    },
  };
}

test("concurrent first leases single-flight Firefox launch and reserve exact page slots", async () => {
  const fixture = fakeBrowserHarness();
  const manager = new BrowserManager({
    maxPages: 6,
    browserMode: "headless",
    launcher: fixture.launcher,
    pageOpener: fixture.opener,
    ownerFileEnabled: false,
  });
  const leases = await Promise.all([
    manager.leasePage("one"),
    manager.leasePage("two"),
    manager.leasePage("three"),
    manager.leasePage("four"),
    manager.leasePage("five"),
  ]);
  assert.equal(fixture.counts().launches, 1);
  assert.equal(fixture.counts().pages, 6, "one control page plus five execution pages");
  assert.equal(new Set(leases.map((lease) => lease.leaseId)).size, 5);
  await assert.rejects(() => manager.leasePage("six"), (error) => error.code === "PAGE_LIMIT_REACHED");
  await manager.close();
});

test("maintenance and page leases are mutually exclusive", async () => {
  const fixture = fakeBrowserHarness();
  const manager = new BrowserManager({
    launcher: fixture.launcher,
    pageOpener: fixture.opener,
    ownerFileEnabled: false,
  });
  const lease = await manager.leasePage("active");
  await assert.rejects(() => manager.withMaintenance(async () => undefined), (error) => error.code === "MAINTENANCE_BUSY");
  await manager.releasePage(lease.jobId);
  let inside = false;
  await manager.withMaintenance(async () => {
    inside = true;
    await assert.rejects(() => manager.leasePage("racing"), (error) => error.code === "MAINTENANCE_ACTIVE");
  });
  assert.equal(inside, true);
  await manager.close();
});

test("stale leases cannot perform trusted actions after a browser generation change", async () => {
  const fixture = fakeBrowserHarness();
  const manager = new BrowserManager({
    launcher: fixture.launcher,
    pageOpener: fixture.opener,
    ownerFileEnabled: false,
  });
  const lease = await manager.leasePage("stale");
  await manager.close();
  await assert.rejects(
    () => manager.withTrustedAction(lease, async () => undefined),
    (error) => error.code === "STALE_PAGE_LEASE",
  );
});

test("a stale browser callback cannot remove a newer broker's owner record", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-owner-"));
  const ownerPath = path.join(directory, "browser-owner.json");
  const ownersDirectory = path.join(directory, "owners");
  const oldOwner = {
    brokerInstanceId: "old-broker",
    leaseGeneration: 4,
    browserPid: 111,
    browserGeneration: 2,
  };
  const currentOwner = {
    brokerInstanceId: "new-broker",
    leaseGeneration: 5,
    browserPid: 222,
    browserGeneration: 1,
  };
  try {
    await writeAtomicJson(ownerPath, currentOwner);
    const removed = await removeOwnerIfOwned(oldOwner, { ownerPath, ownersDirectory });
    assert.equal(removed, false);
    assert.deepEqual(JSON.parse(await readFile(ownerPath, "utf8")), currentOwner);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
