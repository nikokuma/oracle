import test from "node:test";
import assert from "node:assert/strict";
import { BrowserManager } from "../src/browser-manager.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
