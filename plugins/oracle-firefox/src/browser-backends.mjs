import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";
import {
  browserProfileDirectory,
  configuredBrowserName,
  profileDirectory,
  resolveFirefoxPath,
} from "./config.mjs";
import { codedError } from "./errors.mjs";
import { launchFirefox, openChatGpt, probeLogin, waitForLogin } from "./firefox.mjs";
import { wrapOwnedBrowser } from "./owned-browser.mjs";
import { launchSafari } from "./safari-webdriver.mjs";

const execFileAsync = promisify(execFile);

const MAC_CHROME_BUNDLE_ID = "com.google.Chrome";
const MAC_CHROME_TEAM_ID = "EQHXZ8M8AV";
const MAC_SAFARI_BUNDLE_ID = "com.apple.Safari";

async function executable(candidate) {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    if (process.platform === "win32") return true;
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function appRootForExecutable(candidate) {
  const normalized = path.resolve(candidate);
  const marker = ".app/Contents/MacOS/";
  const index = normalized.indexOf(marker);
  return index < 0 ? null : normalized.slice(0, index + 4);
}

export function macChromePathRejectionReason(candidate, { homeDirectory = os.homedir() } = {}) {
  if (!candidate) return "Chrome executable path is empty.";
  const normalized = path.resolve(candidate);
  const lower = normalized.toLowerCase();
  const rejectedFragments = [
    "/applications (parallels)/",
    "/parallels desktop.app/",
    "/windows applications/",
    ".pvm/",
    "/volumes/",
  ];
  if (rejectedFragments.some((fragment) => lower.includes(fragment))) {
    return "The Chrome candidate is inside a VM, Parallels, Windows-app, or mounted-volume path.";
  }
  const allowedRoots = ["/Applications/", path.join(homeDirectory, "Applications") + path.sep];
  if (!allowedRoots.some((root) => normalized.startsWith(root))) {
    return "Native macOS Chrome must be installed under /Applications or the current user's Applications directory.";
  }
  if (!normalized.endsWith(".app/Contents/MacOS/Google Chrome")) {
    return "The candidate is not the Google Chrome executable inside a macOS app bundle.";
  }
  return null;
}

async function readBundleValue(appRoot, key) {
  const { stdout } = await execFileAsync("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    path.join(appRoot, "Contents", "Info.plist"),
  ], { timeout: 10_000 });
  return stdout.trim();
}

async function readSigningIdentity(appRoot) {
  const { stderr } = await execFileAsync("/usr/bin/codesign", ["-dv", "--verbose=2", appRoot], {
    timeout: 10_000,
  });
  const identifier = /^Identifier=(.+)$/mu.exec(stderr)?.[1]?.trim() || null;
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(stderr)?.[1]?.trim() || null;
  return { identifier, teamIdentifier };
}

export async function inspectNativeMacChrome(candidate, options = {}) {
  const reason = macChromePathRejectionReason(candidate, options);
  if (reason) return { accepted: false, path: candidate, reason };
  try {
    if ((await lstat(candidate)).isSymbolicLink()) {
      return { accepted: false, path: candidate, reason: "The Chrome executable path is a symbolic link." };
    }
  } catch {
    return { accepted: false, path: candidate, reason: "The Chrome executable is missing or unreadable." };
  }
  if (!(await executable(candidate))) {
    return { accepted: false, path: candidate, reason: "The Chrome executable is missing or not executable." };
  }
  const resolved = await realpath(candidate);
  const resolvedReason = macChromePathRejectionReason(resolved, options);
  if (resolvedReason) return { accepted: false, path: resolved, reason: resolvedReason };
  const appRoot = appRootForExecutable(resolved);
  try {
    const [bundleIdentifier, signing] = await Promise.all([
      readBundleValue(appRoot, "CFBundleIdentifier"),
      readSigningIdentity(appRoot),
    ]);
    if (bundleIdentifier !== MAC_CHROME_BUNDLE_ID || signing.identifier !== MAC_CHROME_BUNDLE_ID) {
      return { accepted: false, path: resolved, reason: `Expected bundle id ${MAC_CHROME_BUNDLE_ID}.` };
    }
    if (signing.teamIdentifier !== MAC_CHROME_TEAM_ID) {
      return { accepted: false, path: resolved, reason: `Expected Google signing team ${MAC_CHROME_TEAM_ID}.` };
    }
    return {
      accepted: true,
      path: resolved,
      appRoot,
      bundleIdentifier,
      teamIdentifier: signing.teamIdentifier,
      source: "native-macos-application",
    };
  } catch (error) {
    return {
      accepted: false,
      path: resolved,
      reason: `Chrome bundle identity could not be verified: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function resolveChromePath({
  platform = process.platform,
  configured = process.env.ORACLE_CHROME_PATH?.trim() || process.env.ORACLE_FIREFOX_CHROME_PATH?.trim(),
  homeDirectory = os.homedir(),
  inspectMac = inspectNativeMacChrome,
} = {}) {
  const candidates = configured
    ? [configured]
    : platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          path.join(homeDirectory, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
        ]
      : platform === "win32"
        ? [
            path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"];

  const rejected = [];
  for (const candidate of candidates) {
    if (platform === "darwin") {
      const inspected = await inspectMac(candidate, { homeDirectory });
      if (inspected.accepted) return { path: inspected.path, identity: inspected, rejected };
      rejected.push({ path: candidate, reason: inspected.reason });
    } else if (await executable(candidate)) {
      return { path: candidate, identity: { accepted: true, path: candidate, source: "platform-executable" }, rejected };
    }
  }
  return { path: null, identity: null, rejected };
}

export async function inspectNativeSafari({
  appRoot = "/Applications/Safari.app",
  driverPath = process.env.ORACLE_SAFARI_DRIVER_PATH?.trim() || "/usr/bin/safaridriver",
} = {}) {
  if (process.platform !== "darwin") {
    return { accepted: false, appRoot, driverPath, reason: "Safari automation is supported only on macOS." };
  }
  try {
    const [bundleIdentifier, driverReady] = await Promise.all([
      readBundleValue(appRoot, "CFBundleIdentifier"),
      executable(driverPath),
    ]);
    if (bundleIdentifier !== MAC_SAFARI_BUNDLE_ID) {
      return { accepted: false, appRoot, driverPath, reason: `Expected bundle id ${MAC_SAFARI_BUNDLE_ID}.` };
    }
    if (!driverReady) return { accepted: false, appRoot, driverPath, reason: "safaridriver is missing or not executable." };
    return { accepted: true, appRoot, driverPath, bundleIdentifier };
  } catch (error) {
    return { accepted: false, appRoot, driverPath, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function commandVersion(executablePath, args = ["--version"]) {
  if (!executablePath) return { version: null, launchError: null };
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, { timeout: 10_000 });
    return { version: `${stdout}${stderr}`.trim() || null, launchError: null };
  } catch (error) {
    return { version: null, launchError: error instanceof Error ? error.message : String(error) };
  }
}

export async function browserDoctor(browser = configuredBrowserName()) {
  const selectedBrowser = configuredBrowserName(browser);
  const firefoxPath = await resolveFirefoxPath();
  const chrome = await resolveChromePath();
  const safari = await inspectNativeSafari();
  const [firefoxVersion, chromeVersion, safariVersion] = await Promise.all([
    commandVersion(firefoxPath),
    commandVersion(chrome.path),
    safari.accepted ? commandVersion(safari.driverPath) : Promise.resolve({ version: null, launchError: safari.reason || null }),
  ]);
  const browsers = {
    firefox: {
      installed: Boolean(firefoxPath),
      ready: Boolean(firefoxPath && firefoxVersion.version),
      executablePath: firefoxPath,
      profileDirectory: profileDirectory(),
      version: firefoxVersion.version,
      launchError: firefoxVersion.launchError,
      automation: "WebDriver BiDi through Puppeteer",
      authenticationPersistence: "profile",
      headless: true,
    },
    chrome: {
      installed: Boolean(chrome.path),
      ready: Boolean(chrome.path && chromeVersion.version),
      executablePath: chrome.path,
      profileDirectory: browserProfileDirectory("chrome"),
      version: chromeVersion.version,
      launchError: chromeVersion.launchError,
      identity: chrome.identity,
      rejectedCandidates: chrome.rejected,
      automation: "Chrome DevTools Protocol through Puppeteer",
      authenticationPersistence: "profile",
      headless: true,
    },
    safari: {
      installed: Boolean(safari.accepted),
      ready: Boolean(safari.accepted && safariVersion.version),
      executablePath: safari.appRoot,
      driverPath: safari.driverPath,
      profileDirectory: null,
      version: safariVersion.version,
      launchError: safari.accepted ? safariVersion.launchError : safari.reason,
      automation: "W3C WebDriver",
      authenticationPersistence: "automation-session-only",
      headless: false,
      constraints: [
        "Safari remote automation must be enabled manually.",
        "Safari automation windows are isolated from the normal Safari profile.",
        "Only one Safari WebDriver session is allowed at a time.",
      ],
    },
  };
  const selected = browsers[selectedBrowser];
  return {
    ready: selected.ready,
    browser: selectedBrowser,
    browserPath: selected.executablePath,
    firefoxPath,
    version: selected.version,
    profileDirectory: selected.profileDirectory,
    profileInitialized: selected.profileDirectory ? await stat(selected.profileDirectory).then((value) => value.isDirectory(), () => false) : false,
    launchError: selected.launchError,
    browsers,
  };
}

async function configureChromeDownloads(browser, downloadPath) {
  if (!downloadPath) return;
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  try {
    const session = await page.createCDPSession();
    await session.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath,
      eventsEnabled: true,
    });
    await session.detach();
  } catch {
    // DOM-correlated direct downloads still work. Behavior-only downloads fail closed later.
  }
}

export async function launchChrome({ headless = false, profileDir = browserProfileDirectory("chrome"), downloadPath } = {}) {
  const resolved = await resolveChromePath();
  if (!resolved.path) {
    const details = resolved.rejected.map((entry) => `${entry.path}: ${entry.reason}`).join("; ");
    throw codedError(
      "CHROME_NOT_FOUND",
      `Native Google Chrome was not found or could not be verified.${details ? ` ${details}` : ""}`,
    );
  }
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const browser = wrapOwnedBrowser(await puppeteer.launch({
    browser: "chrome",
    protocol: "cdp",
    executablePath: resolved.path,
    userDataDir: profileDir,
    headless,
    defaultViewport: { width: 1280, height: 900 },
    handleSIGINT: false,
    handleSIGTERM: false,
    args: ["--no-first-run", "--no-default-browser-check"],
  }));
  await configureChromeDownloads(browser, downloadPath);
  return browser;
}

export async function launchBrowser({ browserName = configuredBrowserName(), ...options } = {}) {
  const selected = configuredBrowserName(browserName);
  if (selected === "firefox") {
    return launchFirefox({ ...options, profileDir: options.profileDir || browserProfileDirectory("firefox") });
  }
  if (selected === "chrome") {
    return launchChrome({ ...options, profileDir: options.profileDir || browserProfileDirectory("chrome") });
  }
  return launchSafari(options);
}

export async function setupBrowserLogin({ browser = null, browserName = configuredBrowserName(), timeoutMs = 300_000 } = {}) {
  const selected = configuredBrowserName(browserName);
  const ownedBrowser = browser || await launchBrowser({ browserName: selected, headless: false });
  try {
    const page = await openChatGpt(ownedBrowser);
    const initial = await probeLogin(page);
    if (initial.authenticated) {
      return {
        authenticated: true,
        alreadyAuthenticated: true,
        browser: selected,
        authenticationPersistence: selected === "safari" ? "automation-session-only" : "profile",
        url: page.url(),
      };
    }
    const result = await waitForLogin(ownedBrowser, { timeoutMs });
    return {
      authenticated: true,
      alreadyAuthenticated: false,
      browser: selected,
      authenticationPersistence: selected === "safari" ? "automation-session-only" : "profile",
      url: result.page.url(),
    };
  } finally {
    if (!browser) await ownedBrowser.close().catch(() => undefined);
  }
}
