import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
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

export function sessionsDirectory() {
  return path.join(oracleFirefoxHome(), "sessions");
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

export function brokerEndpoint() {
  if (process.env.ORACLE_FIREFOX_BROKER_ENDPOINT?.trim()) {
    return process.env.ORACLE_FIREFOX_BROKER_ENDPOINT.trim();
  }
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\oracle-firefox-${process.env.USERNAME || "user"}`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : process.env.USER || "user";
  return path.join(process.env.TMPDIR || os.tmpdir(), `oracle-firefox-${uid}`, "broker.sock");
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

export function emergencyLockPath() {
  return path.join(coordinatorDirectory(), "emergency.lock");
}

export function brokerLaunchLockPath() {
  return path.join(coordinatorDirectory(), "broker.start.lock");
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
