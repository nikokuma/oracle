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
