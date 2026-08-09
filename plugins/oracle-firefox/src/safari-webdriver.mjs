import { spawn } from "node:child_process";
import net from "node:net";
import { AsyncMutex } from "./async-lock.mjs";
import { CHATGPT_URL } from "./config.mjs";
import { codedError } from "./errors.mjs";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const KEY_VALUES = {
  Enter: "\uE007",
  Escape: "\uE00C",
  Shift: "\uE008",
  Tab: "\uE004",
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function safariChildExited(child) {
  return !child || child.exitCode !== null || child.signalCode != null;
}

async function waitForSafariChildExit(child, timeoutMs) {
  if (safariChildExited(child)) return true;
  let timer;
  let onExit;
  try {
    return await Promise.race([
      new Promise((resolve) => {
        onExit = () => resolve(true);
        child.once("exit", onExit);
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onExit && !safariChildExited(child)) child.off?.("exit", onExit);
  }
}

export async function shutdownSafariProcess(child, { termTimeoutMs = 2_000, killTimeoutMs = 1_000 } = {}) {
  if (!child || safariChildExited(child)) return { exited: true, escalated: false, pid: child?.pid ?? null };
  const ownedPid = child.pid;
  child.kill("SIGTERM");
  if (await waitForSafariChildExit(child, termTimeoutMs)) {
    return { exited: true, escalated: false, pid: ownedPid };
  }
  // child.kill targets only this exact spawned safaridriver child. Never use a
  // process-name lookup or a broad Safari kill at this ownership boundary.
  child.kill("SIGKILL");
  const exited = await waitForSafariChildExit(child, killTimeoutMs);
  return { exited, escalated: true, pid: ownedPid };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function webdriverError(value, fallback = "Safari WebDriver command failed.") {
  const details = value?.value || value;
  const message = details?.message || fallback;
  const error = codedError("SAFARI_WEBDRIVER_ERROR", message, {
    details: { webdriverError: details?.error || null },
  });
  error.webdriverError = details?.error || null;
  return error;
}

class WebDriverTransport {
  constructor(baseUrl, sessionId = null) {
    this.baseUrl = baseUrl;
    this.sessionId = sessionId;
  }

  async request(method, pathname, body, { timeoutMs = 120_000 } = {}) {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.value?.error) throw webdriverError(payload, `${method} ${pathname} failed.`);
    return payload?.value;
  }

  sessionPath(suffix = "") {
    return `/session/${encodeURIComponent(this.sessionId)}${suffix}`;
  }

  command(method, suffix = "", body, options) {
    return this.request(method, this.sessionPath(suffix), body, options);
  }
}

function encodeArgument(value) {
  if (value instanceof SafariElementHandle) return { [ELEMENT_KEY]: value.elementId };
  if (Array.isArray(value)) return value.map(encodeArgument);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeArgument(entry)]));
  }
  return value;
}

function returnedElementId(value) {
  return value && typeof value === "object" ? value[ELEMENT_KEY] || value.ELEMENT || null : null;
}

class SafariJSHandle {
  constructor(page, value) {
    this.page = page;
    this.value = value;
  }

  asElement() {
    return null;
  }

  async dispose() {}
}

class SafariElementHandle extends SafariJSHandle {
  constructor(page, elementId) {
    super(page, { [ELEMENT_KEY]: elementId });
    this.elementId = elementId;
  }

  asElement() {
    return this;
  }

  async evaluate(fn, ...args) {
    return this.page.evaluate(fn, this, ...args);
  }

  async click() {
    return this.page._run(async () => {
      await this.page.browser.transport.command("POST", `/element/${encodeURIComponent(this.elementId)}/click`, {});
      await this.page._refreshUrlUnlocked();
    });
  }

  async uploadFile(...paths) {
    const text = paths.join("\n");
    return this.page._run(() => this.page.browser.transport.command(
      "POST",
      `/element/${encodeURIComponent(this.elementId)}/value`,
      { text, value: Array.from(text) },
    ));
  }
}

class SafariKeyboard {
  constructor(page) {
    this.page = page;
  }

  async type(text) {
    return this.page._run(async () => {
      const active = await this.page.browser.transport.command("GET", "/element/active");
      const elementId = returnedElementId(active);
      if (!elementId) throw codedError("SAFARI_INPUT_NOT_FOCUSED", "Safari has no focused composer element.");
      await this.page.browser.transport.command("POST", `/element/${encodeURIComponent(elementId)}/value`, {
        text: String(text),
        value: Array.from(String(text)),
      });
    });
  }

  async _keyAction(type, key) {
    const value = KEY_VALUES[key] || key;
    return this.page._run(() => this.page.browser.transport.command("POST", "/actions", {
      actions: [{
        type: "key",
        id: "oracle-safari-keyboard",
        actions: [{ type, value }],
      }],
    }));
  }

  down(key) { return this._keyAction("keyDown", key); }
  up(key) { return this._keyAction("keyUp", key); }

  async press(key) {
    const value = KEY_VALUES[key] || key;
    return this.page._run(() => this.page.browser.transport.command("POST", "/actions", {
      actions: [{
        type: "key",
        id: "oracle-safari-keyboard",
        actions: [{ type: "keyDown", value }, { type: "keyUp", value }],
      }],
    }));
  }
}

class SafariPage {
  constructor(browser, handle, url = "about:blank") {
    this.browser = browser;
    this.handle = handle;
    this.cachedUrl = url;
    this.defaultTimeout = 30_000;
    this.closed = false;
    this.keyboard = new SafariKeyboard(this);
  }

  setDefaultTimeout(milliseconds) {
    this.defaultTimeout = Number(milliseconds) || 30_000;
  }

  url() {
    return this.cachedUrl;
  }

  async _switchUnlocked() {
    if (this.closed) throw codedError("SAFARI_WINDOW_CLOSED", "The Safari automation window is closed.");
    await this.browser.transport.command("POST", "/window", { handle: this.handle });
  }

  async _refreshUrlUnlocked() {
    this.cachedUrl = await this.browser.transport.command("GET", "/url");
    return this.cachedUrl;
  }

  async _run(callback) {
    return this.browser.commandGate.run(async () => {
      await this._switchUnlocked();
      return callback();
    }, { owner: `safari-window:${this.handle}`, timeoutMs: Math.max(this.defaultTimeout, 120_000) });
  }

  async bringToFront() {
    return this._run(async () => undefined);
  }

  async goto(url, { timeout = 60_000 } = {}) {
    return this._run(async () => {
      await this.browser.transport.command("POST", "/url", { url }, { timeoutMs: timeout });
      await this._refreshUrlUnlocked();
      return null;
    });
  }

  async _execute(fn, args, { handle = false } = {}) {
    const encoded = args.map(encodeArgument);
    const source = fn.toString();
    const asyncFunction = fn?.constructor?.name === "AsyncFunction";
    const value = await this._run(async () => {
      let result;
      if (asyncFunction) {
        const script = `const done = arguments[arguments.length - 1]; const values = Array.prototype.slice.call(arguments, 0, -1); Promise.resolve((${source}).apply(null, values)).then(done, error => done({__oracleSafariError: String(error && (error.stack || error.message) || error)}));`;
        result = await this.browser.transport.command("POST", "/execute/async", { script, args: encoded });
      } else {
        const script = `return (${source}).apply(null, arguments);`;
        result = await this.browser.transport.command("POST", "/execute/sync", { script, args: encoded });
      }
      if (result?.__oracleSafariError) throw codedError("SAFARI_SCRIPT_ERROR", result.__oracleSafariError);
      await this._refreshUrlUnlocked().catch(() => undefined);
      return result;
    });
    if (!handle) return value;
    const elementId = returnedElementId(value);
    return elementId ? new SafariElementHandle(this, elementId) : new SafariJSHandle(this, value);
  }

  evaluate(fn, ...args) {
    return this._execute(fn, args);
  }

  evaluateHandle(fn, ...args) {
    return this._execute(fn, args, { handle: true });
  }

  async waitForFunction(fn, options = {}, ...args) {
    const timeout = Number(options?.timeout) || this.defaultTimeout;
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(fn, ...args)) return new SafariJSHandle(this, true);
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw codedError("SAFARI_WAIT_TIMEOUT", `Safari waitForFunction timed out after ${timeout}ms.`, { cause: lastError });
  }

  async $(selector) {
    return this._run(async () => {
      try {
        const value = await this.browser.transport.command("POST", "/element", { using: "css selector", value: selector });
        const elementId = returnedElementId(value);
        return elementId ? new SafariElementHandle(this, elementId) : null;
      } catch (error) {
        if (error.webdriverError === "no such element") return null;
        throw error;
      }
    });
  }

  async $$(selector) {
    return this._run(async () => {
      const values = await this.browser.transport.command("POST", "/elements", { using: "css selector", value: selector });
      return (values || []).map(returnedElementId).filter(Boolean).map((id) => new SafariElementHandle(this, id));
    });
  }

  async $$eval(selector, fn, ...args) {
    const elements = await this.$$(selector);
    try {
      return await this.evaluate(fn, elements, ...args);
    } finally {
      await Promise.all(elements.map((element) => element.dispose()));
    }
  }

  async waitForSelector(selector, options = {}) {
    const timeout = Number(options.timeout) || this.defaultTimeout;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const element = await this.$(selector);
      if (element) {
        if (!options.visible || await element.evaluate((node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        })) return element;
        await element.dispose();
      }
      await delay(100);
    }
    return null;
  }

  async cookies() {
    return this._run(() => this.browser.transport.command("GET", "/cookie"));
  }

  async setCookie(...cookies) {
    return this._run(async () => {
      for (const input of cookies) {
        const cookie = {
          name: input.name,
          value: input.value,
          path: input.path || "/",
          ...(input.domain ? { domain: input.domain } : {}),
          ...(input.expires ? { expiry: Math.floor(input.expires) } : {}),
          ...(input.secure !== undefined ? { secure: Boolean(input.secure) } : {}),
          ...(input.httpOnly !== undefined ? { httpOnly: Boolean(input.httpOnly) } : {}),
          ...(input.sameSite ? { sameSite: input.sameSite } : {}),
        };
        await this.browser.transport.command("POST", "/cookie", { cookie });
      }
    });
  }

  async close() {
    if (this.closed) return;
    await this._run(async () => {
      await this.browser.transport.command("DELETE", "/window");
      this.closed = true;
      this.browser.pageMap.delete(this.handle);
    });
  }
}

class SafariBrowser {
  constructor({ child, transport, sessionId, capabilities }) {
    this.child = child;
    this.transport = transport;
    this.sessionId = sessionId;
    this.capabilities = capabilities;
    this.connected = true;
    this.commandGate = new AsyncMutex("safari-webdriver-command", { timeoutMs: 120_000 });
    this.pageMap = new Map();
    this.disconnectListeners = [];
    child.once("exit", () => this._disconnected());
  }

  _disconnected() {
    if (!this.connected) return;
    this.connected = false;
    for (const listener of this.disconnectListeners.splice(0)) listener();
  }

  once(event, callback) {
    if (event === "disconnected") this.disconnectListeners.push(callback);
  }

  process() {
    return this.child;
  }

  async pages() {
    return this.commandGate.run(async () => {
      const handles = await this.transport.command("GET", "/window/handles");
      const pages = [];
      for (const handle of handles || []) {
        let page = this.pageMap.get(handle);
        if (!page) {
          page = new SafariPage(this, handle);
          this.pageMap.set(handle, page);
        }
        await page._switchUnlocked();
        await page._refreshUrlUnlocked();
        pages.push(page);
      }
      return pages;
    }, { owner: "safari-pages" });
  }

  async newPage() {
    return this.commandGate.run(async () => {
      const value = await this.transport.command("POST", "/window/new", { type: "tab" });
      const handle = value?.handle;
      if (!handle) throw codedError("SAFARI_NEW_WINDOW_FAILED", "Safari did not return a new window handle.");
      const page = new SafariPage(this, handle);
      this.pageMap.set(handle, page);
      await page._switchUnlocked();
      await page._refreshUrlUnlocked();
      return page;
    }, { owner: "safari-new-page" });
  }

  async close() {
    if (this.connected) {
      await this.transport.request(
        "DELETE",
        `/session/${encodeURIComponent(this.sessionId)}`,
        undefined,
        { timeoutMs: 2_000 },
      ).catch(() => undefined);
    }
    await shutdownSafariProcess(this.child);
    this._disconnected();
  }
}

async function waitForDriver(transport, child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw codedError("SAFARI_DRIVER_EXITED", `safaridriver exited with code ${child.exitCode}.`);
    }
    try {
      await transport.request("GET", "/status", undefined, { timeoutMs: 1_000 });
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw codedError("SAFARI_DRIVER_START_TIMEOUT", "Timed out starting safaridriver.", { cause: lastError });
}

export async function launchSafari({
  headless = false,
  driverPath = process.env.ORACLE_SAFARI_DRIVER_PATH?.trim() || "/usr/bin/safaridriver",
} = {}) {
  if (process.platform !== "darwin") {
    throw codedError("SAFARI_UNSUPPORTED_PLATFORM", "Safari automation is supported only on macOS.");
  }
  if (headless) {
    throw codedError("SAFARI_HEADLESS_UNSUPPORTED", "Safari does not provide a headless WebDriver mode. Select visible browser mode.");
  }
  const port = await freePort();
  const child = spawn(driverPath, ["--port", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
  });
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-4_000);
  });
  const transport = new WebDriverTransport(`http://127.0.0.1:${port}`);
  try {
    await waitForDriver(transport, child);
    let session;
    try {
      session = await transport.request("POST", "/session", {
        capabilities: {
          alwaysMatch: {
            browserName: "safari",
            pageLoadStrategy: "normal",
          },
        },
      }, { timeoutMs: 120_000 });
    } catch (error) {
      const message = `${error.message} ${diagnostics}`.toLowerCase();
      if (message.includes("remote automation") || message.includes("enable")) {
        throw codedError(
          "SAFARI_REMOTE_AUTOMATION_DISABLED",
          "Safari remote automation is disabled. Enable Develop > Developer Settings > Allow remote automation, then retry. Oracle will not change this setting automatically.",
          { cause: error },
        );
      }
      throw error;
    }
    const sessionId = session?.sessionId;
    if (!sessionId) throw codedError("SAFARI_SESSION_FAILED", "safaridriver did not return a session id.");
    transport.sessionId = sessionId;
    const browser = new SafariBrowser({ child, transport, sessionId, capabilities: session.capabilities || {} });
    const pages = await browser.pages();
    if (!pages.length) {
      const page = await browser.newPage();
      await page.goto(CHATGPT_URL);
    }
    return browser;
  } catch (error) {
    await shutdownSafariProcess(child);
    throw error;
  }
}
