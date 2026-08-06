import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CHATGPT_URL = "https://chatgpt.com/";

export function oracleFirefoxHome() {
  const configured = process.env.ORACLE_FIREFOX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".oracle-firefox");
}

export function profileDirectory() {
  return path.join(oracleFirefoxHome(), "profile");
}

export const SUPPORTED_BROWSERS = Object.freeze(["firefox", "chrome", "safari"]);

export function browserSelectionPath() {
  return path.join(coordinatorDirectory(), "browser-selection.json");
}

export function normalizeBrowserName(value, fallback = "firefox") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (!SUPPORTED_BROWSERS.includes(normalized)) {
    throw new Error(`Unsupported Oracle browser ${JSON.stringify(value)}. Choose firefox, chrome, or safari.`);
  }
  return normalized;
}

export function configuredBrowserName(explicit) {
  if (explicit) return normalizeBrowserName(explicit);
  const environment = process.env.ORACLE_BROWSER?.trim() || process.env.ORACLE_FIREFOX_BROWSER?.trim();
  if (environment) return normalizeBrowserName(environment);
  try {
    const persisted = JSON.parse(readFileSync(browserSelectionPath(), "utf8"));
    return normalizeBrowserName(persisted?.browser);
  } catch {
    return "firefox";
  }
}

export function browserProfileDirectory(browser = configuredBrowserName()) {
  const normalized = normalizeBrowserName(browser);
  // Preserve the original authenticated Firefox profile in place.
  if (normalized === "firefox") return profileDirectory();
  return path.join(oracleFirefoxHome(), "browser-profiles", normalized);
}

export function sessionsDirectory() {
  return path.join(oracleFirefoxHome(), "sessions");
}

export function downloadsDirectory() {
  return path.join(oracleFirefoxHome(), "downloads");
}

export function browserDownloadStagingDirectory() {
  return path.join(downloadsDirectory(), ".browser-staging");
}

export function coordinatorDirectory() {
  const configured = process.env.ORACLE_FIREFOX_COORDINATOR_HOME?.trim();
  if (configured) return path.resolve(configured);
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "oracle-firefox", "coordinator");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "oracle-firefox",
      "coordinator",
    );
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "oracle-firefox", "coordinator");
}

export function brokerRuntimeRoot() {
  const configured = process.env.ORACLE_FIREFOX_RUNTIME_ROOT?.trim();
  return configured ? path.resolve(configured) : "/tmp";
}

export function brokerEndpoint(options = {}) {
  if (process.env.ORACLE_FIREFOX_BROKER_ENDPOINT?.trim()) {
    return process.env.ORACLE_FIREFOX_BROKER_ENDPOINT.trim();
  }
  if (process.platform === "win32") {
    const identity = options.coordinatorId || createHash("sha256").update(`${coordinatorDirectory()}\0${profileDirectory()}`).digest("hex");
    return `\\\\.\\pipe\\oracle-firefox-${identity.slice(0, 24)}`;
  }
  if (options.runtimeDirectory) return path.join(options.runtimeDirectory, "broker.sock");
  const uid = typeof process.getuid === "function" ? process.getuid() : process.env.USER || "user";
  const identity = createHash("sha256").update(`${path.resolve(coordinatorDirectory())}\0${path.resolve(profileDirectory())}`).digest("hex");
  return path.join(brokerRuntimeRoot(), `oracle-firefox-${uid}-${identity.slice(0, 16)}`, "broker.sock");
}

export function legacyBrokerEndpoints() {
  if (
    process.env.ORACLE_FIREFOX_BROKER_ENDPOINT?.trim() ||
    process.env.ORACLE_FIREFOX_DISABLE_LEGACY_DISCOVERY === "1"
  ) return [];
  if (process.platform === "win32") {
    return [`\\\\.\\pipe\\oracle-firefox-${process.env.USERNAME || "user"}`];
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : process.env.USER || "user";
  const roots = ["/tmp", os.tmpdir(), process.env.TMPDIR].filter(Boolean).map((entry) => path.resolve(entry));
  return [...new Set(roots.map((root) => path.join(root, `oracle-firefox-${uid}`, "broker.sock")))];
}

export function brokerCoordinatorIdPath() {
  return path.join(coordinatorDirectory(), "coordinator.id");
}

export function brokerLeaseDatabasePath() {
  return path.join(coordinatorDirectory(), "broker.lease.sqlite");
}

export function profileLeaseDatabasePath() {
  return path.join(oracleFirefoxHome(), "profile.lease.sqlite");
}

export function brokerLocatorPath() {
  return path.join(coordinatorDirectory(), "broker.locator.json");
}

export function brokerTokenPath() {
  return path.join(coordinatorDirectory(), "broker.token");
}

export function coordinatorDatabasePath() {
  return path.join(coordinatorDirectory(), "coordinator.sqlite");
}

export function coordinatorLogPath() {
  return path.join(coordinatorDirectory(), "broker.log");
}

export function completionRecordsDirectory() {
  return path.join(coordinatorDirectory(), "completions");
}

export function browserOwnerPath() {
  return path.join(coordinatorDirectory(), "browser-owner.json");
}

export function browserOwnersDirectory() {
  return path.join(coordinatorDirectory(), "browser-owners");
}

export function emergencyLockPath() {
  return path.join(coordinatorDirectory(), "emergency.lock");
}

export function brokerLaunchLockPath() {
  return path.join(coordinatorDirectory(), "broker.start.v2.sqlite");
}

export function brokerNodePath() {
  return process.env.ORACLE_FIREFOX_NODE_PATH?.trim() || process.execPath;
}

export async function resolveFirefoxPath() {
  const configured = process.env.ORACLE_FIREFOX_PATH?.trim();
  const candidates = configured
    ? [configured]
    : process.platform === "darwin"
      ? ["/Applications/Firefox.app/Contents/MacOS/firefox"]
      : process.platform === "win32"
        ? [
            path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Mozilla Firefox", "firefox.exe"),
            path.join(
              process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
              "Mozilla Firefox",
              "firefox.exe",
            ),
          ]
        : ["/usr/bin/firefox", "/usr/local/bin/firefox", "/snap/bin/firefox"];

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next known location.
    }
  }
  return null;
}

export function readPositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}
