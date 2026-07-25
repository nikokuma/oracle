import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { browserDownloadStagingDirectory, browserOwnerPath, coordinatorDirectory, profileDirectory } from "./config.mjs";
import { launchFirefox, openChatGpt } from "./firefox.mjs";
import { codedError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function writeOwner(owner) {
  await mkdir(coordinatorDirectory(), { recursive: true, mode: 0o700 });
  const target = browserOwnerPath();
  const temporary = path.join(path.dirname(target), `.browser-owner.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, target);
}

async function readOwner() {
  try { return JSON.parse(await readFile(browserOwnerPath(), "utf8")); } catch { return null; }
}

async function verifiedOwnedFirefox(pid, expectedProfile) {
  if (process.platform === "win32") return false;
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    const command = stdout.trim();
    return command.includes("Firefox") && command.includes("--profile") && command.includes(expectedProfile);
  } catch { return false; }
}

async function stopOrphanedOwnedFirefox() {
  const owner = await readOwner();
  if (!owner?.browserPid || !owner?.brokerPid) return;
  if (Number(owner.brokerPid) === process.pid) return;
  if (pidAlive(owner.brokerPid)) {
    throw codedError("PROFILE_IN_USE_EXTERNALLY", "Another live Oracle broker owns the dedicated Firefox process.");
  }
  if (!pidAlive(owner.browserPid)) {
    await rm(browserOwnerPath(), { force: true });
    return;
  }
  const expectedProfile = profileDirectory();
  if (owner.profile !== expectedProfile || !(await verifiedOwnedFirefox(owner.browserPid, expectedProfile))) {
    throw codedError("PROFILE_IN_USE_EXTERNALLY", "The recorded Firefox process could not be proven to belong to the dead Oracle broker.");
  }
  process.kill(Number(owner.browserPid), "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (pidAlive(owner.browserPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (pidAlive(owner.browserPid)) process.kill(Number(owner.browserPid), "SIGKILL");
  await rm(browserOwnerPath(), { force: true });
}

export class BrowserManager {
  constructor({ maxPages = 5, maxDiscoveryPages = 2 } = {}) {
    this.maxPages = maxPages;
    this.maxDiscoveryPages = maxDiscoveryPages;
    this.browser = null;
    this.controlPage = null;
    this.leases = new Map();
    this.discoveryCount = 0;
    this.maintenance = false;
    this.ownerChecked = false;
    this.inputGate = Promise.resolve();
    this.downloadGate = Promise.resolve();
  }

  async ensureBrowser({ headless = false } = {}) {
    if (this.browser?.connected) return this.browser;
    if (!this.ownerChecked) {
      await stopOrphanedOwnedFirefox();
      this.ownerChecked = true;
    }
    const downloadPath = browserDownloadStagingDirectory();
    await mkdir(downloadPath, { recursive: true, mode: 0o700 });
    const browser = await launchFirefox({ headless, downloadPath });
    this.browser = browser;
    const browserPid = browser.process()?.pid;
    if (browserPid) await writeOwner({ brokerPid: process.pid, browserPid, profile: profileDirectory(), startedAt: new Date().toISOString() });
    browser.once("disconnected", () => {
      if (this.browser !== browser) return;
      this.browser = null;
      this.controlPage = null;
      this.leases.clear();
      this.discoveryCount = 0;
      rm(browserOwnerPath(), { force: true }).catch(() => undefined);
    });
    this.controlPage = await openChatGpt(browser, { newPage: false, foreground: false });
    return browser;
  }

  async leasePage(jobId, { discovery = false, headless = false } = {}) {
    if (this.maintenance) throw codedError("MAINTENANCE_ACTIVE", "Firefox maintenance is active; try again after it completes.");
    if (this.leases.has(jobId)) return this.leases.get(jobId);
    if (this.leases.size + 1 >= this.maxPages) throw codedError("PAGE_LIMIT_REACHED", `Oracle Firefox permits at most ${this.maxPages} pages.`);
    if (discovery && this.discoveryCount >= this.maxDiscoveryPages) throw codedError("DISCOVERY_LIMIT_REACHED", "Both read-only discovery pages are currently in use.");
    const browser = await this.ensureBrowser({ headless });
    const page = await openChatGpt(browser, { newPage: true, foreground: false });
    const lease = { jobId, page, discovery, leasedAt: new Date().toISOString() };
    this.leases.set(jobId, lease);
    if (discovery) this.discoveryCount += 1;
    return lease;
  }

  async releasePage(jobId) {
    const lease = this.leases.get(jobId);
    if (!lease) return;
    this.leases.delete(jobId);
    if (lease.discovery) this.discoveryCount = Math.max(0, this.discoveryCount - 1);
    await lease.page.close().catch(() => undefined);
  }

  async withInputFocus(page, callback) {
    const previous = this.inputGate;
    let release;
    this.inputGate = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      await page.bringToFront();
      return await callback();
    } finally {
      release();
    }
  }

  async withDownload(callback) {
    const previous = this.downloadGate;
    let release;
    this.downloadGate = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async withMaintenance(callback) {
    if (this.maintenance || this.leases.size > 0) {
      throw codedError("MAINTENANCE_BUSY", "Setup or cookie import requires all Oracle Firefox job pages to be idle.");
    }
    this.maintenance = true;
    try {
      await this.close();
      return await callback();
    } finally {
      this.maintenance = false;
    }
  }

  status() {
    return {
      browserRunning: Boolean(this.browser?.connected),
      pagesLeased: this.leases.size,
      discoveryPagesLeased: this.discoveryCount,
      maxPages: this.maxPages,
      maxDiscoveryPages: this.maxDiscoveryPages,
      maintenance: this.maintenance,
    };
  }

  async close() {
    for (const jobId of Array.from(this.leases.keys())) await this.releasePage(jobId);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.controlPage = null;
    await rm(browserOwnerPath(), { force: true });
  }
}
