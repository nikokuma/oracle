import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";
import { CHATGPT_URL, profileDirectory, resolveFirefoxPath } from "./config.mjs";
import {
  FILE_INPUT_SELECTORS,
  FINISHED_ACTIONS_SELECTOR,
  INPUT_SELECTORS,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTORS,
} from "./selectors.mjs";

const execFileAsync = promisify(execFile);

export const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeConversationTitle(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeConversationUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error(`Invalid ChatGPT conversation URL: ${value}`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "chatgpt.com" ||
    !/(^|\/)c\/[a-zA-Z0-9-]+(?:\/|$)/u.test(parsed.pathname)
  ) {
    throw new Error(
      "Conversation URL must be an https://chatgpt.com URL containing a /c/<conversation-id> path.",
    );
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

export async function findConversationCandidates(page, title, { visibleOnly = false } = {}) {
  const normalizedTitle = normalizeConversationTitle(title);
  if (!normalizedTitle) throw new Error("Chat title cannot be empty.");
  const candidates = await page.evaluate(
    ({ expectedTitle, requireVisible }) => {
      const normalize = (value) => String(value || "").replace(/\s+/gu, " ").trim();
      return Array.from(document.querySelectorAll("a"))
        .filter((anchor) => {
          if (normalize(anchor.textContent).toLowerCase() !== expectedTitle.toLowerCase()) return false;
          if (!requireVisible) return true;
          const rect = anchor.getBoundingClientRect();
          const style = window.getComputedStyle(anchor);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        })
        .map((anchor) => ({ title: normalize(anchor.textContent), url: anchor.href }));
    },
    { expectedTitle: normalizedTitle, requireVisible: visibleOnly },
  );
  const unique = new Map();
  for (const candidate of candidates) {
    try {
      const url = normalizeConversationUrl(candidate.url);
      unique.set(url, { title: candidate.title, url });
    } catch {
      // Ignore exact-title links that are not ChatGPT conversation URLs.
    }
  }
  return Array.from(unique.values());
}

export function selectUniqueConversationCandidate(candidates, title) {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(
      `More than one ChatGPT conversation is titled ${JSON.stringify(title)}. Use an exact conversationUrl instead.`,
    );
  }
  return null;
}

async function openChatSearch(page) {
  const handle = await page.evaluateHandle(() => {
    const normalize = (value) => String(value || "").replace(/\s+/gu, " ").trim().toLowerCase();
    return (
      Array.from(document.querySelectorAll("button")).find((button) => {
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        const label = normalize(button.getAttribute("aria-label"));
        const text = normalize(button.textContent);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          (label === "search" || text === "search")
        );
      }) || null
    );
  });
  const button = handle.asElement();
  if (!button) {
    await handle.dispose();
    throw new Error("ChatGPT's chat-search control was not found.");
  }
  try {
    await button.click();
  } finally {
    await handle.dispose();
  }
}

async function searchConversationByTitle(page, title, { timeoutMs = 15_000 } = {}) {
  await openChatSearch(page);
  const input = await page.waitForSelector("input[placeholder='Search'][aria-label='Search']", {
    visible: true,
    timeout: 10_000,
  });
  if (!input) throw new Error("ChatGPT's chat-search input was not found.");
  await input.click();
  await input.evaluate((node) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(node, "");
    else node.value = "";
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContent" }));
  });
  await page.keyboard.type(title);
  const deadline = Date.now() + timeoutMs;
  let candidates = [];
  while (Date.now() < deadline) {
    candidates = await findConversationCandidates(page, title, { visibleOnly: true });
    if (candidates.length) return candidates;
    await delay(250);
  }
  return candidates;
}

export async function openExistingConversation(page, { title, conversationUrl } = {}) {
  let candidate;
  if (conversationUrl) {
    candidate = { title: normalizeConversationTitle(title) || null, url: normalizeConversationUrl(conversationUrl) };
  } else {
    const normalizedTitle = normalizeConversationTitle(title);
    if (!normalizedTitle) throw new Error("Provide an exact chatTitle or conversationUrl.");
    await delay(1_000);
    let candidates = await findConversationCandidates(page, normalizedTitle);
    candidate = selectUniqueConversationCandidate(candidates, normalizedTitle);
    if (!candidate) {
      candidates = await searchConversationByTitle(page, normalizedTitle);
      candidate = selectUniqueConversationCandidate(candidates, normalizedTitle);
    }
    if (!candidate) {
      throw new Error(`No ChatGPT conversation was found with the exact title ${JSON.stringify(normalizedTitle)}.`);
    }
  }
  await page.goto(candidate.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForComposer(page, { timeoutMs: 60_000 });
  await waitForConversationHistoryStable(page, { timeoutMs: 30_000, stableMs: 2_500 });
  return {
    title: candidate.title,
    url: normalizeConversationUrl(page.url()),
  };
}

async function directoryExists(candidate) {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

export async function doctor() {
  const firefoxPath = await resolveFirefoxPath();
  let version = null;
  let launchError = null;
  if (firefoxPath) {
    try {
      const { stdout, stderr } = await execFileAsync(firefoxPath, ["--version"], { timeout: 10_000 });
      version = `${stdout}${stderr}`.trim() || null;
    } catch (error) {
      launchError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ready: Boolean(firefoxPath && version),
    firefoxPath,
    version,
    profileDirectory: profileDirectory(),
    profileInitialized: await directoryExists(profileDirectory()),
    launchError,
  };
}

export async function launchFirefox({ headless = false, profileDir = profileDirectory() } = {}) {
  const executablePath = await resolveFirefoxPath();
  if (!executablePath) {
    throw new Error(
      "Firefox was not found. Set ORACLE_FIREFOX_PATH to the Firefox executable and retry.",
    );
  }
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  return puppeteer.launch({
    browser: "firefox",
    protocol: "webDriverBiDi",
    executablePath,
    userDataDir: profileDir,
    headless,
    defaultViewport: { width: 1280, height: 900 },
    handleSIGINT: true,
    handleSIGTERM: true,
  });
}

export async function openChatGpt(browser) {
  const pages = await browser.pages();
  const page = pages.find((candidate) => candidate.url().includes("chatgpt.com")) ?? pages[0] ?? (await browser.newPage());
  page.setDefaultTimeout(30_000);
  if (!page.url().includes("chatgpt.com")) {
    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } else if (page.url() !== CHATGPT_URL) {
    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  await page.bringToFront();
  return page;
}

export async function probeLogin(page) {
  return page.evaluate(async () => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };
    let sessionStatus = 0;
    let sessionAuthenticated = false;
    try {
      const response = await fetch("/api/auth/session", {
        cache: "no-store",
        credentials: "include",
      });
      sessionStatus = response.status;
      if (response.ok) {
        const body = await response.json();
        sessionAuthenticated = Boolean(body?.user);
      }
    } catch {
      // DOM signals below provide a fallback when the endpoint is challenged.
    }
    const composerSelectors = [
      "#prompt-textarea",
      ".ProseMirror",
      'textarea[data-id="prompt-textarea"]',
      'textarea[name="prompt-textarea"]',
      '[contenteditable="true"][role="textbox"]',
    ];
    const composer = composerSelectors
      .map((selector) => document.querySelector(selector))
      .find((node) => visible(node));
    const accountSignal = Boolean(
      document.querySelector('[data-testid="accounts-profile-button"]') ||
        document.querySelector('[data-testid="profile-button"]') ||
        document.querySelector('[data-testid^="history-item-"]'),
    );
    const loginText = Array.from(document.querySelectorAll("a, button"))
      .filter((node) => visible(node))
      .map((node) => (node.textContent || node.getAttribute("aria-label") || "").trim().toLowerCase());
    const loginCta = loginText.some((text) =>
      ["log in", "login", "sign in", "signin", "sign up for free"].includes(text),
    );
    const cloudflare =
      document.title.toLowerCase().includes("just a moment") ||
      Boolean(document.querySelector('script[src*="/challenge-platform/"]'));
    return {
      authenticated: sessionAuthenticated || (Boolean(composer) && accountSignal && !loginCta),
      sessionAuthenticated,
      sessionStatus,
      composerVisible: Boolean(composer),
      accountSignal,
      loginCta,
      cloudflare,
      title: document.title,
      url: location.href,
    };
  });
}

export async function waitForLogin(browser, { timeoutMs = 300_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastProbe = null;
  while (Date.now() < deadline) {
    const pages = await browser.pages();
    const candidates = pages.filter((page) => page.url().includes("chatgpt.com"));
    for (const page of candidates.length ? candidates : pages) {
      try {
        lastProbe = await probeLogin(page);
        if (lastProbe.authenticated) return { page, probe: lastProbe };
      } catch {
        // Navigation during OAuth is expected; retry the next poll.
      }
    }
    await delay(1_000);
  }
  throw new Error(
    `Timed out waiting for ChatGPT login after ${Math.round(timeoutMs / 1000)} seconds. Last state: ${JSON.stringify(lastProbe)}`,
  );
}

export async function setupLogin({ timeoutMs = 300_000 } = {}) {
  const browser = await launchFirefox({ headless: false });
  try {
    const page = await openChatGpt(browser);
    const initial = await probeLogin(page);
    if (initial.authenticated) {
      return { authenticated: true, alreadyAuthenticated: true, url: page.url() };
    }
    const result = await waitForLogin(browser, { timeoutMs });
    return { authenticated: true, alreadyAuthenticated: false, url: result.page.url() };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function findVisibleHandle(page, selectors, { enabled = false } = {}) {
  for (const selector of selectors) {
    const handles = await page.$$(selector);
    for (const handle of handles) {
      const state = await handle.evaluate((node, requireEnabled) => {
        if (!(node instanceof HTMLElement)) return { visible: false, enabled: false };
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden";
        const disabled =
          node.getAttribute("aria-disabled") === "true" ||
          ("disabled" in node && Boolean(node.disabled));
        return { visible, enabled: !requireEnabled || !disabled };
      }, enabled);
      if (state.visible && state.enabled) return handle;
      await handle.dispose();
    }
  }
  return null;
}

export async function waitForComposer(page, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handle = await findVisibleHandle(page, INPUT_SELECTORS);
    if (handle) return handle;
    const state = await probeLogin(page).catch(() => null);
    if (state?.cloudflare) {
      throw new Error(
        "Cloudflare challenge detected. Run oracle_firefox_setup and complete the challenge in Firefox.",
      );
    }
    await delay(250);
  }
  throw new Error("ChatGPT prompt composer did not become available.");
}

export async function readComposerText(page) {
  return page.evaluate((selectors) => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const node = selectors
      .map((selector) => document.querySelector(selector))
      .find((candidate) => visible(candidate));
    if (!node) return "";
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return node.value;
    return node.innerText || node.textContent || "";
  }, INPUT_SELECTORS);
}

export async function insertComposerText(page, text) {
  const content = String(text);
  if (!content) throw new Error("Cannot submit an empty prompt.");
  const editor = await waitForComposer(page);
  await editor.click();
  await editor.evaluate((node, value) => {
    node.focus();
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(node, value);
      else node.value = value;
      node.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: value,
          inputType: "insertFromPaste",
        }),
      );
      node.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const selection = document.getSelection();
      const range = document.createRange();
      range.selectNodeContents(node);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand("insertText", false, value);
    }
  }, content);
  await delay(250);
  let observed = await readComposerText(page);
  if (observed.length < Math.max(1, content.length * 0.8)) {
    await editor.evaluate((node) => {
      node.focus();
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) node.value = "";
      else node.textContent = "";
      node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteByCut" }));
    });
    await page.keyboard.type(content);
    await delay(250);
    observed = await readComposerText(page);
  }
  if (observed.length < Math.max(1, content.length * 0.8)) {
    throw new Error(
      `Prompt insertion appears truncated (${observed.length}/${content.length} characters).`,
    );
  }
  return observed.length;
}

export async function uploadContextFile(page, filePath, { timeoutMs = 60_000 } = {}) {
  let input = null;
  for (const selector of FILE_INPUT_SELECTORS) {
    input = await page.$(selector);
    if (input) break;
  }
  if (!input) {
    throw new Error(
      "ChatGPT file input was not found. Retry with delivery=inline or update the selector set.",
    );
  }
  await input.uploadFile(filePath);
  const filename = path.basename(filePath);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate((expectedName) => {
      const bodyText = document.body?.innerText || "";
      const send = Array.from(
        document.querySelectorAll(
          'button[data-testid="send-button"], button[data-testid*="composer-send"], form button[type="submit"]',
        ),
      ).find((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const disabled =
          node.getAttribute("aria-disabled") === "true" ||
          ("disabled" in node && Boolean(node.disabled));
        return rect.width > 0 && rect.height > 0 && !disabled;
      });
      return bodyText.includes(expectedName) && Boolean(send);
    }, filename);
    if (ready) return filename;
    await delay(500);
  }
  throw new Error(`Attachment did not become ready before timeout: ${filename}`);
}

export async function assistantSnapshot(page) {
  return page.evaluate(
    ({ finishedSelector, stopSelectors }) => {
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      };
      const roleNodes = Array.from(
        document.querySelectorAll(
          '[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant"]',
        ),
      );
      const turns = [];
      const seen = new Set();
      for (const node of roleNodes) {
        const turn =
          node.closest('[data-testid^="conversation-turn"]') ||
          node.closest("article") ||
          node;
        if (!seen.has(turn)) {
          seen.add(turn);
          turns.push(turn);
        }
      }
      const last = turns.at(-1) || null;
      const userRoleNodes = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      const userTurns = [];
      const seenUserTurns = new Set();
      for (const node of userRoleNodes) {
        const turn =
          node.closest('[data-testid^="conversation-turn"]') ||
          node.closest("article") ||
          node;
        if (!seenUserTurns.has(turn)) {
          seenUserTurns.add(turn);
          userTurns.push(turn);
        }
      }
      const lastUser = userTurns.at(-1) || null;
      const text = (last?.innerText || last?.textContent || "").trim();
      const stopVisible = stopSelectors.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some((node) => visible(node)),
      );
      const completionVisible = Boolean(last?.querySelector(finishedSelector));
      return {
        count: turns.length,
        userCount: userTurns.length,
        lastUserText: (lastUser?.innerText || lastUser?.textContent || "").trim(),
        text,
        html: last?.innerHTML || "",
        stopVisible,
        completionVisible,
        url: location.href,
      };
    },
    { finishedSelector: FINISHED_ACTIONS_SELECTOR, stopSelectors: STOP_BUTTON_SELECTORS },
  );
}

export async function waitForConversationHistoryStable(
  page,
  { timeoutMs = 30_000, stableMs = 2_500 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastKey = "";
  let unchangedSince = Date.now();
  let latest = null;
  while (Date.now() < deadline) {
    latest = await assistantSnapshot(page);
    const key = `${latest.count}:${latest.userCount}:${latest.text}:${latest.lastUserText}`;
    if (key !== lastKey) {
      lastKey = key;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= stableMs) {
      return latest;
    }
    await delay(250);
  }
  throw new Error(
    `ChatGPT conversation history did not stabilize before timeout. Last state: ${JSON.stringify({ assistantCount: latest?.count, userCount: latest?.userCount })}`,
  );
}

export async function waitForUserMessage(
  page,
  baselineCount,
  expectedText,
  { timeoutMs = 30_000 } = {},
) {
  const normalize = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
  const expected = normalize(expectedText);
  const expectedPrefix = expected.slice(0, Math.min(expected.length, 200));
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await assistantSnapshot(page);
    const observed = normalize(latest.lastUserText);
    if (latest.userCount > baselineCount && observed.includes(expectedPrefix)) return latest;
    await delay(250);
  }
  throw new Error(
    `The new user message could not be confirmed in the target conversation. Refusing to retry automatically. Last state: ${JSON.stringify({ userCount: latest?.userCount, baselineCount })}`,
  );
}

export async function submitComposer(page) {
  const button = await findVisibleHandle(page, SEND_BUTTON_SELECTORS, { enabled: true });
  if (button) {
    await button.click();
    return "button";
  }
  await page.keyboard.press("Enter");
  return "enter";
}

function isPlaceholder(text) {
  const normalized = String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return (
    !normalized ||
    normalized === "chatgpt said:" ||
    normalized === "chatgpt said" ||
    (normalized.includes("answer now") && normalized.includes("pro thinking"))
  );
}

export async function waitForAssistant(page, baselineCount, { timeoutMs = 600_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastKey = "";
  let lastChangeAt = Date.now();
  let terminalCycles = 0;
  while (Date.now() < deadline) {
    const snapshot = await assistantSnapshot(page);
    const key = `${snapshot.count}:${snapshot.text}`;
    if (key !== lastKey) {
      lastKey = key;
      lastChangeAt = Date.now();
      terminalCycles = 0;
    }
    const candidate = snapshot.count > baselineCount && !isPlaceholder(snapshot.text);
    if (candidate && snapshot.completionVisible && !snapshot.stopVisible) {
      terminalCycles += 1;
      if (terminalCycles >= 3 && Date.now() - lastChangeAt >= 1_200) {
        return snapshot;
      }
    } else {
      terminalCycles = 0;
    }
    await delay(500);
  }
  throw new Error(
    "ChatGPT response could not be confirmed complete before timeout; refusing to return a possibly incomplete answer.",
  );
}
