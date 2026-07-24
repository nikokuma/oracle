import { launchFirefox, openChatGpt } from "./firefox.mjs";
import { codedError } from "./errors.mjs";

export class BrowserManager {
  constructor({ maxPages = 5, maxDiscoveryPages = 2 } = {}) {
    this.maxPages = maxPages;
    this.maxDiscoveryPages = maxDiscoveryPages;
    this.browser = null;
    this.controlPage = null;
    this.leases = new Map();
    this.discoveryCount = 0;
    this.maintenance = false;
  }

  async ensureBrowser({ headless = false } = {}) {
    if (this.browser?.connected) return this.browser;
    this.browser = await launchFirefox({ headless });
    this.browser.once("disconnected", () => {
      this.browser = null;
      this.controlPage = null;
      this.leases.clear();
      this.discoveryCount = 0;
    });
    this.controlPage = await openChatGpt(this.browser, { newPage: false, foreground: false });
    return this.browser;
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
  }
}
