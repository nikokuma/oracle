import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AsyncMutex } from "./async-lock.mjs";
import { writeAtomicJson } from "./atomic-json.mjs";
import { processMatchesStartIdentity, processStartIdentity } from "./broker-lease.mjs";
import {
  browserDownloadStagingDirectory,
  browserOwnerPath,
  browserOwnersDirectory,
  browserProfileDirectory,
  browserSelectionPath,
  configuredBrowserName,
  normalizeBrowserName,
} from "./config.mjs";
import { launchBrowser } from "./browser-backends.mjs";
import { openChatGpt } from "./firefox.mjs";
import { codedError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

async function boundedClose(target, timeoutMs = 10_000) {
  if (!target?.close) return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve(target.close()),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Closing is best-effort; the browser-level owned-process wrapper provides
    // the final cleanup boundary for launched browser children.
  } finally {
    clearTimeout(timer);
  }
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function uniqueOwnerPath(owner, options = {}) {
  return path.join(options.ownersDirectory || browserOwnersDirectory(), `${owner.brokerInstanceId}.json`);
}

async function writeOwner(owner, options = {}) {
  const owners = options.ownersDirectory || browserOwnersDirectory();
  await mkdir(owners, { recursive: true, mode: 0o700 });
  await writeAtomicJson(uniqueOwnerPath(owner, options), owner);
  await writeAtomicJson(options.ownerPath || browserOwnerPath(), owner);
}

async function readOwner(options = {}) {
  try { return JSON.parse(await readFile(options.ownerPath || browserOwnerPath(), "utf8")); } catch { return null; }
}

function sameOwner(actual, expected) {
  return Boolean(
    actual && expected &&
    actual.brokerInstanceId === expected.brokerInstanceId &&
    Number(actual.leaseGeneration) === Number(expected.leaseGeneration) &&
    Number(actual.browserPid) === Number(expected.browserPid) &&
    Number(actual.browserGeneration) === Number(expected.browserGeneration)
  );
}

export async function removeOwnerIfOwned(expected, options = {}) {
  if (!expected) return false;
  const current = await readOwner(options);
  if (sameOwner(current, expected)) await rm(options.ownerPath || browserOwnerPath(), { force: true });
  await rm(uniqueOwnerPath(expected, options), { force: true });
  return sameOwner(current, expected);
}

async function verifiedOwnedBrowser(pid, browserName, expectedProfile) {
  if (process.platform === "win32") return false;
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    const command = stdout.trim();
    if (browserName === "firefox") {
      return /firefox/iu.test(command) && command.includes("--profile") && command.includes(expectedProfile);
    }
    if (browserName === "chrome") {
      return /Google Chrome/iu.test(command) && command.includes("--user-data-dir") && command.includes(expectedProfile);
    }
    return browserName === "safari" && /safaridriver/iu.test(command);
  } catch { return false; }
}

async function stopOrphanedOwnedBrowser(brokerContext, browserName) {
  brokerContext.assertCurrentLease?.();
  const owner = await readOwner();
  if (!owner?.browserPid || !owner?.brokerPid) return;
  if (owner.brokerInstanceId === brokerContext.instanceId && Number(owner.leaseGeneration) === Number(brokerContext.leaseGeneration)) return;
  const liveBroker = pidAlive(owner.brokerPid) && await processMatchesStartIdentity(owner.brokerPid, owner.brokerProcessStartId);
  if (liveBroker) {
    throw codedError("PROFILE_IN_USE_EXTERNALLY", `Another live Oracle broker owns the dedicated ${owner.browserName || "Firefox"} process.`);
  }
  if (!pidAlive(owner.browserPid)) {
    await removeOwnerIfOwned(owner);
    return;
  }
  const recordedBrowser = owner.browserName || "firefox";
  const expectedProfile = recordedBrowser === "safari" ? null : browserProfileDirectory(recordedBrowser);
  if (
    owner.version !== 2 || !owner.browserProcessStartId ||
    !(await processMatchesStartIdentity(owner.browserPid, owner.browserProcessStartId)) ||
    owner.profile !== expectedProfile || !(await verifiedOwnedBrowser(owner.browserPid, recordedBrowser, expectedProfile))
  ) {
    throw codedError("PROFILE_IN_USE_EXTERNALLY", "The recorded browser process could not be proven to belong to the dead Oracle broker.");
  }
  process.kill(Number(owner.browserPid), "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (pidAlive(owner.browserPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (pidAlive(owner.browserPid)) process.kill(Number(owner.browserPid), "SIGKILL");
  await removeOwnerIfOwned(owner);
}

function configuredBrowserMode(explicit, browserName) {
  const supplied = explicit || process.env.ORACLE_FIREFOX_BROWSER_MODE;
  const value = supplied || (browserName === "safari" ? "visible" : "headless");
  if (!new Set(["headless", "visible"]).has(value)) {
    throw codedError("INVALID_BROWSER_MODE", 'ORACLE_FIREFOX_BROWSER_MODE must be "headless" or "visible".');
  }
  if (browserName === "safari" && value === "headless") {
    throw codedError("SAFARI_HEADLESS_UNSUPPORTED", "Safari requires visible browser mode. Unset ORACLE_FIREFOX_BROWSER_MODE or set it to visible.");
  }
  return value;
}

export class BrowserManager {
  constructor({
    maxPages = 6,
    maxDiscoveryPages = 2,
    browserName = configuredBrowserName(),
    browserMode,
    launcher = launchBrowser,
    pageOpener = openChatGpt,
    lockTimeoutMs = 30_000,
    pageCloseTimeoutMs = 10_000,
    browserCloseTimeoutMs = 12_000,
    ownerFileEnabled = true,
    brokerContext = null,
  } = {}) {
    this.maxPages = Math.max(2, maxPages);
    this.maxDiscoveryPages = Math.max(1, maxDiscoveryPages);
    this.browserName = normalizeBrowserName(browserName);
    this.browserModeSetting = browserMode || process.env.ORACLE_FIREFOX_BROWSER_MODE || null;
    this.browserMode = configuredBrowserMode(this.browserModeSetting, this.browserName);
    this.launcher = launcher;
    this.pageOpener = pageOpener;
    this.ownerFileEnabled = ownerFileEnabled;
    this.pageCloseTimeoutMs = Math.max(1, Number(pageCloseTimeoutMs) || 10_000);
    this.browserCloseTimeoutMs = Math.max(1, Number(browserCloseTimeoutMs) || 12_000);
    this.brokerContext = brokerContext || {
      instanceId: `test-browser-${randomUUID()}`,
      leaseGeneration: 1,
      coordinatorId: "test-browser",
      processStartId: "test-process",
      assertCurrentLease() { return true; },
    };
    this.currentOwner = null;
    this.browser = null;
    this.controlPage = null;
    this.leases = new Map();
    this.discoveryCount = 0;
    this.maintenance = false;
    this.ownerChecked = false;
    this.browserGeneration = 0;
    this.resourceGate = new AsyncMutex("browser-resource", { timeoutMs: lockTimeoutMs });
    this.trustedActionGate = new AsyncMutex("trusted-browser-action", { timeoutMs: lockTimeoutMs });
    this.downloadGate = new AsyncMutex("browser-download", { timeoutMs: lockTimeoutMs });
  }

  async ensureBrowser() {
    return this.resourceGate.run(() => this.ensureBrowserLocked(), { owner: "ensure-browser" });
  }

  async ensureBrowserLocked({ allowMaintenance = false, forceVisible = false } = {}) {
    this.brokerContext.assertCurrentLease?.();
    if (this.maintenance && !allowMaintenance) throw codedError("MAINTENANCE_ACTIVE", "Browser maintenance is active; try again after it completes.");
    if (this.browser?.connected) return this.browser;
    if (!this.ownerChecked && this.ownerFileEnabled) {
      await stopOrphanedOwnedBrowser(this.brokerContext, this.browserName);
      this.ownerChecked = true;
    }
    const downloadPath = browserDownloadStagingDirectory();
    await mkdir(downloadPath, { recursive: true, mode: 0o700 });
    const browser = await this.launcher({
      browserName: this.browserName,
      headless: forceVisible ? false : this.browserMode === "headless",
      profileDir: this.browserName === "safari" ? undefined : browserProfileDirectory(this.browserName),
      downloadPath,
    });
    this.browser = browser;
    this.browserGeneration += 1;
    const generation = this.browserGeneration;
    const browserPid = browser.process?.()?.pid;
    if (browserPid && this.ownerFileEnabled) {
      this.currentOwner = {
        version: 2,
        coordinatorId: this.brokerContext.coordinatorId,
        brokerInstanceId: this.brokerContext.instanceId,
        leaseGeneration: this.brokerContext.leaseGeneration,
        brokerPid: process.pid,
        brokerProcessStartId: this.brokerContext.processStartId || await processStartIdentity(process.pid),
        browserPid,
        browserProcessStartId: await processStartIdentity(browserPid),
        browserName: this.browserName,
        profile: this.browserName === "safari" ? null : browserProfileDirectory(this.browserName),
        mode: forceVisible ? "visible" : this.browserMode,
        browserGeneration: generation,
        startedAt: new Date().toISOString(),
      };
      await writeOwner(this.currentOwner);
    }
    browser.once?.("disconnected", () => {
      if (this.browser !== browser) return;
      this.browser = null;
      this.controlPage = null;
      this.browserGeneration += 1;
      for (const lease of this.leases.values()) lease.invalidated = true;
      this.leases.clear();
      this.discoveryCount = 0;
      if (this.ownerFileEnabled) removeOwnerIfOwned(this.currentOwner).catch(() => undefined);
      this.currentOwner = null;
    });
    try {
      this.controlPage = await this.pageOpener(browser, { newPage: false, foreground: false });
    } catch (error) {
      await Promise.resolve(browser.close?.()).catch(() => undefined);
      this.browser = null;
      this.controlPage = null;
      throw error;
    }
    return browser;
  }

  async leasePage(jobId, { discovery = false } = {}) {
    return this.resourceGate.run(async () => {
      this.brokerContext.assertCurrentLease?.();
      if (this.maintenance) throw codedError("MAINTENANCE_ACTIVE", "Browser maintenance is active; try again after it completes.");
      if (this.leases.has(jobId)) return this.leases.get(jobId);
      // maxPages is total top-level pages: one control/login page plus leases.
      if (this.leases.size >= this.maxPages - 1) {
        throw codedError("PAGE_LIMIT_REACHED", `Oracle permits at most ${this.maxPages} total ${this.browserName} pages, including its control page.`);
      }
      if (discovery && this.discoveryCount >= this.maxDiscoveryPages) {
        throw codedError("DISCOVERY_LIMIT_REACHED", "Both read-only discovery pages are currently in use.");
      }
      const browser = await this.ensureBrowserLocked();
      const generation = this.browserGeneration;
      const page = await this.pageOpener(browser, { newPage: true, foreground: false });
      if (generation !== this.browserGeneration || browser !== this.browser || !browser.connected) {
        await boundedClose(page, this.pageCloseTimeoutMs);
        throw codedError("BROWSER_EPOCH_CHANGED", `${this.browserName} restarted while a page was opening; the stale page was discarded.`, { safeToRetry: true });
      }
      const lease = {
        jobId,
        page,
        discovery,
        browserGeneration: generation,
        leaseId: randomUUID(),
        invalidated: false,
        leasedAt: new Date().toISOString(),
      };
      this.leases.set(jobId, lease);
      if (discovery) this.discoveryCount += 1;
      return lease;
    }, { owner: `lease:${jobId}` });
  }

  assertLease(lease) {
    if (
      !lease || lease.invalidated ||
      lease.browserGeneration !== this.browserGeneration ||
      this.leases.get(lease.jobId)?.leaseId !== lease.leaseId
    ) {
      throw codedError("STALE_PAGE_LEASE", `This ${this.browserName} page lease is stale. No browser action was attempted.`);
    }
    return true;
  }

  async releasePage(jobId) {
    return this.resourceGate.run(async () => {
      const lease = this.leases.get(jobId);
      if (!lease) return;
      this.leases.delete(jobId);
      lease.invalidated = true;
      if (lease.discovery) this.discoveryCount = Math.max(0, this.discoveryCount - 1);
      await boundedClose(lease.page, this.pageCloseTimeoutMs);
    }, { owner: `release:${jobId}` });
  }

  async withTrustedAction(leaseOrPage, callback, options = {}) {
    const lease = leaseOrPage?.jobId ? leaseOrPage : null;
    const page = lease ? lease.page : leaseOrPage;
    return this.trustedActionGate.run(async () => {
      this.brokerContext.assertCurrentLease?.();
      if (lease) this.assertLease(lease);
      await page.bringToFront();
      if (lease) this.assertLease(lease);
      return callback();
    }, { owner: options.owner || lease?.jobId || "unleased-page", timeoutMs: options.timeoutMs });
  }

  async withInputFocus(leaseOrPage, callback) {
    return this.withTrustedAction(leaseOrPage, callback, { owner: leaseOrPage?.jobId || "composer-input" });
  }

  async withDownload(callback) {
    return this.downloadGate.run(callback, { owner: "download" });
  }

  async withMaintenance(callback) {
    await this.resourceGate.run(async () => {
      if (this.maintenance || this.leases.size > 0) {
        throw codedError("MAINTENANCE_BUSY", "Setup, browser selection, or cookie import requires all Oracle job pages to be idle.");
      }
      this.maintenance = true;
      await this.closeLocked();
    }, { owner: "maintenance-start" });
    try {
      return await callback();
    } finally {
      await this.resourceGate.run(async () => { this.maintenance = false; }, { owner: "maintenance-end" });
    }
  }

  async withManagedSetup(callback) {
    await this.resourceGate.run(async () => {
      if (this.maintenance || this.leases.size > 0) {
        throw codedError("MAINTENANCE_BUSY", "Browser setup requires all Oracle job pages to be idle.");
      }
      this.maintenance = true;
      await this.closeLocked();
    }, { owner: "managed-setup-start" });
    try {
      const browser = await this.resourceGate.run(
        () => this.ensureBrowserLocked({ allowMaintenance: true, forceVisible: true }),
        { owner: "managed-setup-launch" },
      );
      return await callback(browser);
    } finally {
      await this.resourceGate.run(async () => { this.maintenance = false; }, { owner: "managed-setup-end" });
    }
  }

  status() {
    return {
      browserName: this.browserName,
      profileDirectory: this.browserName === "safari" ? null : browserProfileDirectory(this.browserName),
      browserRunning: Boolean(this.browser?.connected),
      browserMode: this.browserMode,
      browserGeneration: this.browserGeneration,
      pagesLeased: this.leases.size,
      totalPages: (this.browser?.connected ? 1 : 0) + this.leases.size,
      discoveryPagesLeased: this.discoveryCount,
      maxPages: this.maxPages,
      maxDiscoveryPages: this.maxDiscoveryPages,
      maintenance: this.maintenance,
      authenticationPersistence: this.browserName === "safari" ? "automation-session-only" : "profile",
      resourceLock: { pending: this.resourceGate.status().pending },
      trustedActionLock: { pending: this.trustedActionGate.status().pending },
    };
  }

  async closeLocked() {
    for (const lease of this.leases.values()) {
      lease.invalidated = true;
      await boundedClose(lease.page, this.pageCloseTimeoutMs);
    }
    this.leases.clear();
    this.discoveryCount = 0;
    const browser = this.browser;
    this.browser = null;
    this.controlPage = null;
    this.browserGeneration += 1;
    await boundedClose(browser, this.browserCloseTimeoutMs);
    if (this.ownerFileEnabled) await removeOwnerIfOwned(this.currentOwner);
    this.currentOwner = null;
  }

  async close() {
    return this.resourceGate.run(() => this.closeLocked(), { owner: "browser-close" });
  }

  async selectBrowser(browserName) {
    const selected = normalizeBrowserName(browserName);
    return this.resourceGate.run(async () => {
      const environmentBrowser = process.env.ORACLE_BROWSER?.trim() || process.env.ORACLE_FIREFOX_BROWSER?.trim();
      if (environmentBrowser && normalizeBrowserName(environmentBrowser) !== selected) {
        throw codedError(
          "BROWSER_SELECTION_ENV_LOCKED",
          `This broker is pinned to ${normalizeBrowserName(environmentBrowser)} by ORACLE_BROWSER. Remove that environment override before selecting ${selected}.`,
        );
      }
      if (this.maintenance || this.leases.size > 0) {
        throw codedError("BROWSER_SELECTION_BUSY", "Wait for all Oracle browser pages to become idle before switching browsers.");
      }
      if (selected === this.browserName) {
        return { changed: false, browser: selected, browserMode: this.browserMode };
      }
      const nextMode = configuredBrowserMode(this.browserModeSetting, selected);
      await this.closeLocked();
      this.browserName = selected;
      this.browserMode = nextMode;
      this.ownerChecked = false;
      await writeAtomicJson(browserSelectionPath(), {
        version: 1,
        browser: selected,
        selectedAt: new Date().toISOString(),
      });
      return {
        changed: true,
        browser: selected,
        browserMode: this.browserMode,
        profileDirectory: selected === "safari" ? null : browserProfileDirectory(selected),
      };
    }, { owner: "browser-select" });
  }
}
