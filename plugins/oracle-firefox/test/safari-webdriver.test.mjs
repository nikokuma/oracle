import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { launchSafari } from "../src/safari-webdriver.mjs";

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
