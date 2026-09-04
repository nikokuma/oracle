import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";
import { wrapOwnedBrowser } from "./owned-browser.mjs";
import { CHATGPT_URL, profileDirectory, resolveFirefoxPath } from "./config.mjs";
import { codedError } from "./errors.mjs";
import {
  FILE_INPUT_SELECTORS,
  FINISHED_ACTIONS_SELECTOR,
  INPUT_SELECTORS,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTORS,
} from "./selectors.mjs";

const execFileAsync = promisify(execFile);
const ORACLE_APPROVED_ATTACHMENTS = new WeakMap();
const ORACLE_OWNED_DRAFTS = new WeakMap();
const CHATGPT_COOLDOWN_PATTERN = /(?:you(?:'|’)?re making )?too many requests(?: too quickly)?|temporarily rate[- ]limited|please try again (?:in a (?:few )?minutes?|later)|(?:you(?:'|’)?ve|you have) (?:reached|hit) (?:the |your )?(?:current )?(?:usage |message |pro )?limit|please wait before trying again/iu;

export const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function normalizeSemanticText(value) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ")
    // ChatGPT's contenteditable canonicalizes a literal tab to four spaces.
    // Normalize both the authorization and every pre/post-submit observation
    // the same way so the whole-message guard still catches any other change.
    .replace(/\t/gu, "    ")
    .normalize("NFC")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .trim();
}

export function semanticTextHash(value) {
  return createHash("sha256").update(normalizeSemanticText(value)).digest("hex");
}

function remoteThrottleEvidence(kind, identity, text) {
  const fingerprint = createHash("sha256")
    .update(["oracle-remote-throttle-v1", kind, identity || "", semanticTextHash(text)].join("\0"))
    .digest("hex");
  return { kind, fingerprint };
}

export function semanticMismatchDetails(expected, observed) {
  const expectedNormalized = normalizeSemanticText(expected);
  const observedNormalized = normalizeSemanticText(observed);
  let firstMismatch = 0;
  const length = Math.max(expectedNormalized.length, observedNormalized.length);
  while (
    firstMismatch < length &&
    expectedNormalized[firstMismatch] === observedNormalized[firstMismatch]
  ) firstMismatch += 1;
  const codePoint = (value) => value.codePointAt(firstMismatch)?.toString(16).toUpperCase() ?? "EOF";
  return {
    exactMatch: expectedNormalized === observedNormalized,
    firstMismatch,
    expectedCodePoint: codePoint(expectedNormalized),
    observedCodePoint: codePoint(observedNormalized),
    expectedNormalizedLength: expectedNormalized.length,
    observedNormalizedLength: observedNormalized.length,
  };
}

export function classifyAssistantResponseFailure(assistant) {
  if (!assistant) return null;
  const text = normalizeSemanticText(assistant.text).replace(/^ChatGPT said:\s*/iu, "");
  const compact = text.replace(/\s+/gu, " ").trim();
  const controls = [...new Set((assistant.errorIndicators ?? []).map((value) => normalizeSemanticText(value)).filter(Boolean))];
  const hasErrorUi = controls.length > 0;
  const exactStopped = /^(?:stopped reasoning|reasoning stopped|response stopped)[.!]?(?:\s+(?:retry|try again))?$/iu.test(compact);
  const transientPattern = /(?:something went wrong(?: while generating the response)?|there was an error generating (?:a|the) response|network error|failed to generate (?:a|the) response|unable to generate (?:a|the) response)/iu;
  const exactTransient = new RegExp(`^(?:${transientPattern.source})[.!]?(?:\\s+(?:retry|try again))?$`, "iu").test(compact);
  const authPattern = /(?:session expired|sign in to continue|authentication required)/iu;
  const unavailablePattern = /(?:selected model|chatgpt pro|pro model).*(?:unavailable|not available)|model is (?:currently )?unavailable/iu;
  let failure = null;
  if (exactStopped || (hasErrorUi && /stopped reasoning/iu.test(compact))) {
    failure = {
      code: "PRO_REASONING_STOPPED",
      disposition: "reasoning_stopped",
      retryable: true,
      message: "ChatGPT Pro stopped reasoning before producing a complete answer.",
    };
  } else if (exactTransient || (hasErrorUi && transientPattern.test(compact))) {
    failure = {
      code: "CHATGPT_TRANSIENT_FAILURE",
      disposition: "transient_failure",
      retryable: true,
      message: "ChatGPT reported a terminal response-generation failure.",
    };
  } else if (hasErrorUi && authPattern.test(compact)) {
    failure = {
      code: "CHATGPT_AUTH_FAILURE",
      disposition: "auth_failure",
      retryable: false,
      message: "ChatGPT reported an authentication failure while producing the response.",
    };
  } else if (hasErrorUi && unavailablePattern.test(compact)) {
    failure = {
      code: "CHATGPT_MODEL_UNAVAILABLE",
      disposition: "model_unavailable",
      retryable: false,
      message: "ChatGPT reported that the required model was unavailable.",
    };
  }
  if (!failure) return null;
  return {
    ...failure,
    classifierVersion: 1,
    assistantTurnId: assistant.id || null,
    normalizedText: compact,
    visibleErrorControls: controls,
  };
}

export function attachmentManifestKey(values = []) {
  return [...values]
    .map((value) => String(value).trim().replace(/\(\d+\)(?=\.[^.]+$)/u, ""))
    .sort()
    .join("\u0000");
}

function exactHashMatches(turns, expectedHash) {
  return turns.filter((turn) =>
    turn.role === "user" && semanticTextHash(turn.text) === expectedHash
  );
}

export function normalizeConversationTitle(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

export const normalizeProjectTitle = normalizeConversationTitle;

export function normalizeProjectUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error(`Invalid ChatGPT project URL: ${value}`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "chatgpt.com" ||
    !/^\/g\/g-p-[^/]+\/project\/?$/u.test(parsed.pathname)
  ) {
    throw new Error("Project URL must be an https://chatgpt.com/g/g-p-.../project URL.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
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
    !(
      /^\/c\/[a-zA-Z0-9-]+\/?$/u.test(parsed.pathname) ||
      /^\/g\/g-p-[^/]+\/c\/[a-zA-Z0-9-]+\/?$/u.test(parsed.pathname)
    )
  ) {
    throw new Error(
      "Conversation URL must be an https://chatgpt.com/c/... or https://chatgpt.com/g/g-p-.../c/... URL.",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

export function projectUrlFromConversationUrl(value) {
  const conversationUrl = new URL(normalizeConversationUrl(value));
  const match = conversationUrl.pathname.match(/^(\/g\/g-p-[^/]+)\/c\/[a-zA-Z0-9-]+$/u);
  if (!match) return null;
  return normalizeProjectUrl(`${conversationUrl.origin}${match[1]}/project`);
}

export function isNavigationTimeoutError(error) {
  return Boolean(
    error?.name === "TimeoutError" ||
    /Navigation timeout of \d+ ms exceeded|navigation timed out/iu.test(String(error?.message || "")),
  );
}

function pathnameFor(value) {
  try {
    return new URL(String(value)).pathname.replace(/\/+$/u, "") || "/";
  } catch {
    return null;
  }
}

async function navigationTimeoutObservation(page, targetUrl) {
  const target = new URL(targetUrl);
  let observed;
  try {
    observed = new URL(page.url());
  } catch {
    observed = null;
  }
  const documentState = await page.evaluate(() => ({
    readyState: document.readyState,
    bodyPresent: Boolean(document.body),
  })).catch(() => ({ readyState: null, bodyPresent: false }));
  const exactTarget = Boolean(
    observed &&
    observed.protocol === target.protocol &&
    observed.hostname === target.hostname &&
    pathnameFor(observed.href) === pathnameFor(target.href),
  );
  return {
    exactTarget,
    usable: exactTarget && documentState.bodyPresent && new Set(["interactive", "complete"]).has(documentState.readyState),
    targetPath: pathnameFor(target.href),
    observedPath: observed?.hostname === target.hostname ? pathnameFor(observed.href) : null,
    readyState: documentState.readyState,
    bodyPresent: documentState.bodyPresent,
  };
}

export async function navigateChatGpt(page, targetUrl, { timeoutMs = 60_000 } = {}) {
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    return { timedOut: false, recoveredFromDom: false };
  } catch (error) {
    if (!isNavigationTimeoutError(error)) throw error;
    const observation = await navigationTimeoutObservation(page, targetUrl);
    // Firefox BiDi can miss the lifecycle event even after the exact document
    // is interactive. Continue only when the URL and DOM independently prove
    // that the requested page is usable.
    if (observation.usable) {
      return { timedOut: true, recoveredFromDom: true, observation };
    }
    throw codedError(
      "CHATGPT_NAVIGATION_TIMEOUT",
      `ChatGPT did not finish opening the requested page within ${Math.round(timeoutMs / 1_000)} seconds.`,
      {
        submissionMayHaveOccurred: false,
        recoveryAction: "recycle the idle managed browser once, then inspect browser or ChatGPT availability if navigation still fails",
        details: observation,
        cause: error,
      },
    );
  }
}

function projectBasePath(value) {
  return new URL(normalizeProjectUrl(value)).pathname.replace(/\/project$/u, "");
}

function conversationMatchesProject(conversationUrl, projectUrl) {
  if (!projectUrl) return true;
  const pathname = new URL(normalizeConversationUrl(conversationUrl)).pathname;
  return pathname.startsWith(`${projectBasePath(projectUrl)}/c/`);
}

export async function findConversationCandidatesByQuery(
  page,
  query,
  { exact = false, visibleOnly = false, projectUrl = null } = {},
) {
  const normalizedQuery = normalizeConversationTitle(query);
  if (!normalizedQuery) throw new Error("Chat search query cannot be empty.");
  const candidates = await page.evaluate(
    ({ expectedQuery, requireExact, requireVisible }) => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/gu, " ")
          .trim();
      const titleFor = (anchor) => {
        const values = [
          anchor.getAttribute("aria-label"),
          anchor.getAttribute("title"),
          anchor.getAttribute("data-chat-title"),
          ...Array.from(anchor.querySelectorAll('[data-testid*="conversation-title"], [class*="truncate"], [title]'))
            .flatMap((node) => [node.getAttribute("title"), node.textContent]),
          ...Array.from(anchor.children).map((node) => node.textContent),
          anchor.textContent,
        ]
          .map(normalize)
          .filter(Boolean);
        const normalizedExpected = expectedQuery.toLowerCase();
        const matching = [...new Set(values)].filter((value) => {
          const normalized = value.toLowerCase();
          return requireExact ? normalized === normalizedExpected : normalized.includes(normalizedExpected);
        });
        return matching.sort((left, right) => left.length - right.length)[0] || "";
      };
      return Array.from(document.querySelectorAll("a"))
        .filter((anchor) => {
          if (!titleFor(anchor)) return false;
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
        .map((anchor) => ({
          title: titleFor(anchor),
          url: anchor.href,
        }));
    },
    { expectedQuery: normalizedQuery, requireExact: exact, requireVisible: visibleOnly },
  );
  const unique = new Map();
  for (const candidate of candidates) {
    try {
      const url = normalizeConversationUrl(candidate.url);
      if (!conversationMatchesProject(url, projectUrl)) continue;
      unique.set(url, {
        title: candidate.title,
        url,
        projectUrl: projectUrlFromConversationUrl(url),
      });
    } catch {
      // Ignore matching links that are not ChatGPT conversation URLs.
    }
  }
  return Array.from(unique.values());
}

export async function findConversationCandidates(page, title, options = {}) {
  return findConversationCandidatesByQuery(page, title, { ...options, exact: true });
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
  let button = null;
  try {
    button = await page.waitForSelector('nav button[aria-label="Search"]', {
      visible: true,
      timeout: 10_000,
    });
  } catch {
    // Fall through to the older text-only search control.
  }
  let fallbackHandle = null;
  if (!button) {
    fallbackHandle = await page.evaluateHandle(() => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/gu, " ")
          .trim()
          .toLowerCase();
      return (
        Array.from(document.querySelectorAll("button")).find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          const style = window.getComputedStyle(candidate);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            normalize(candidate.textContent) === "search"
          );
        }) || null
      );
    });
    button = fallbackHandle.asElement();
  }
  if (!button) {
    await fallbackHandle?.dispose();
    throw new Error("ChatGPT's chat-search control was not found.");
  }
  try {
    await button.click();
  } finally {
    if (fallbackHandle) await fallbackHandle.dispose();
    else await button.dispose();
  }
}

async function searchConversationCandidates(
  page,
  query,
  { exact = false, projectUrl = null, timeoutMs = 15_000 } = {},
) {
  await openChatSearch(page);
  const input = await page.waitForSelector(
    "[role='dialog'] input[placeholder='Search...'], input[placeholder='Search...'], input[placeholder='Search'][aria-label='Search']",
    { visible: true, timeout: 10_000 },
  );
  if (!input) throw new Error("ChatGPT's chat-search input was not found.");
  await input.click();
  await input.evaluate((node, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(node, value);
    else node.value = value;
    node.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: value,
      inputType: value ? "insertFromPaste" : "deleteContent",
    }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, query);
  const deadline = Date.now() + timeoutMs;
  let candidates = [];
  let lastKey = "";
  let unchangedSince = Date.now();
  while (Date.now() < deadline) {
    candidates = await findConversationCandidatesByQuery(page, query, {
      exact,
      visibleOnly: true,
      projectUrl,
    });
    const key = JSON.stringify(candidates);
    if (key !== lastKey) {
      lastKey = key;
      unchangedSince = Date.now();
    } else if (candidates.length > 0 && Date.now() - unchangedSince >= 750) {
      return candidates;
    }
    await delay(250);
  }
  return candidates;
}

async function searchConversationByTitle(page, title, options = {}) {
  return searchConversationCandidates(page, title, { ...options, exact: true });
}

export async function findProjectCandidates(
  page,
  query = "",
  { exact = false, visibleOnly = false } = {},
) {
  const normalizedQuery = normalizeProjectTitle(query);
  return page.evaluate(
    ({ expectedQuery, requireExact, requireVisible }) => {
      const prefix = "Open project options for ";
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/gu, " ")
          .trim();
      return Array.from(
        document.querySelectorAll('button[aria-label^="Open project options for "]'),
      )
        .map((button) => ({
          button,
          title: normalize(button.getAttribute("aria-label")).slice(prefix.length),
        }))
        .filter(({ button, title }) => {
          if (expectedQuery) {
            const normalizedTitle = title.toLowerCase();
            const normalizedExpected = expectedQuery.toLowerCase();
            if (
              requireExact
                ? normalizedTitle !== normalizedExpected
                : !normalizedTitle.includes(normalizedExpected)
            ) {
              return false;
            }
          }
          if (!requireVisible) return true;
          const rect = button.getBoundingClientRect();
          const style = window.getComputedStyle(button);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        })
        .map(({ title }) => ({ title }));
    },
    { expectedQuery: normalizedQuery, requireExact: exact, requireVisible: visibleOnly },
  );
}

export function selectUniqueProjectCandidate(candidates, title) {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(
      `More than one ChatGPT project is titled ${JSON.stringify(title)}. Use an exact projectUrl instead.`,
    );
  }
  return null;
}

async function waitForProjectControls(page, { timeoutMs = 15_000 } = {}) {
  await page.waitForFunction(
    () =>
      Boolean(document.querySelector('button[aria-label^="Open project options for "]')) ||
      Array.from(document.querySelectorAll("button")).some((button) => {
        const label = String(button.getAttribute("aria-label") || "")
          .trim()
          .toLowerCase();
        const text = String(button.textContent || "")
          .replace(/\s+/gu, " ")
          .trim()
          .toLowerCase();
        return label === "new project" || text === "new project";
      }),
    { timeout: timeoutMs },
  );
}

async function readActiveProjectTitle(page) {
  return page.evaluate(() => {
    const normalize = (value) =>
      String(value || "")
        .replace(/\s+/gu, " ")
        .trim();
    const trigger = document.querySelector('[data-testid="project-modal-trigger"]');
    return normalize(trigger?.textContent) || null;
  });
}

export async function openProject(page, { title, projectUrl } = {}) {
  const normalizedTitle = normalizeProjectTitle(title);
  if (normalizedTitle && projectUrl) {
    throw new Error("Provide either projectTitle or projectUrl, not both.");
  }
  if (!normalizedTitle && !projectUrl) {
    throw new Error("Provide an exact projectTitle or projectUrl.");
  }

  let expectedUrl = null;
  if (projectUrl) {
    expectedUrl = normalizeProjectUrl(projectUrl);
    await navigateChatGpt(page, expectedUrl);
  } else {
    await waitForProjectControls(page);
    const candidates = await findProjectCandidates(page, normalizedTitle, { exact: true });
    const candidate = selectUniqueProjectCandidate(candidates, normalizedTitle);
    if (!candidate) {
      throw new Error(
        `No ChatGPT project was found with the exact title ${JSON.stringify(normalizedTitle)}.`,
      );
    }
    const handle = await page.evaluateHandle((expectedTitle) => {
      const prefix = "Open project options for ";
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/gu, " ")
          .trim();
      const options = Array.from(
        document.querySelectorAll('button[aria-label^="Open project options for "]'),
      ).filter((button) => {
        const titleValue = normalize(button.getAttribute("aria-label")).slice(prefix.length);
        return titleValue.toLowerCase() === expectedTitle.toLowerCase();
      });
      if (options.length !== 1) return null;
      return (
        options[0].closest("li")?.querySelector('button[aria-label="Open project home"]') || null
      );
    }, normalizedTitle);
    const button = handle.asElement();
    if (!button) {
      await handle.dispose();
      throw new Error(
        `ChatGPT's project-home control was not found for ${JSON.stringify(normalizedTitle)}.`,
      );
    }
    try {
      await button.click();
    } finally {
      await handle.dispose();
    }
    await page.waitForFunction(() => /^\/g\/g-p-[^/]+\/project\/?$/u.test(location.pathname), {
      timeout: 30_000,
    });
  }

  await waitForComposerAfterNavigation(page, expectedUrl || page.url(), { timeoutMs: 60_000 });
  let observedUrl;
  try {
    observedUrl = normalizeProjectUrl(page.url());
  } catch {
    throw new Error("ChatGPT did not remain on the requested project home after navigation.");
  }
  if (expectedUrl && observedUrl !== expectedUrl) {
    throw new Error("ChatGPT redirected away from the requested project home.");
  }
  const observedTitle = await readActiveProjectTitle(page);
  return {
    title: observedTitle || normalizedTitle || null,
    url: observedUrl,
  };
}

export async function listProjects(page, query = "") {
  await waitForProjectControls(page);
  return findProjectCandidates(page, query);
}

export async function expandProjectConversationList(page, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  await page
    .waitForSelector("section > ol", {
      timeout: Math.min(5_000, timeoutMs),
    })
    .catch(() => null);
  while (Date.now() < deadline) {
    const handle = await page.evaluateHandle(() => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/gu, " ")
          .trim()
          .toLowerCase();
      return (
        Array.from(document.querySelectorAll("section > ol > button")).find(
          (button) => normalize(button.textContent) === "load more conversations",
        ) || null
      );
    });
    const button = handle.asElement();
    if (!button) {
      await handle.dispose();
      return;
    }
    const before = await page.$$eval("section a[href]", (anchors) => anchors.length);
    try {
      await button.click();
    } finally {
      await handle.dispose();
    }
    const changed = await page
      .waitForFunction(
        (previousCount) => {
          const normalize = (value) =>
            String(value || "")
              .replace(/\s+/gu, " ")
              .trim()
              .toLowerCase();
          const loadMore = Array.from(document.querySelectorAll("section > ol > button")).find(
            (candidate) => normalize(candidate.textContent) === "load more conversations",
          );
          return document.querySelectorAll("section a[href]").length > previousCount || !loadMore;
        },
        { timeout: Math.min(5_000, Math.max(250, deadline - Date.now())) },
        before,
      )
      .then(() => true)
      .catch(() => false);
    if (!changed) {
      throw new Error(
        "ChatGPT's project conversation list did not finish loading. Use an exact conversation URL.",
      );
    }
  }
  throw new Error(
    "ChatGPT's project conversation list exceeded the discovery timeout. Use an exact conversation URL.",
  );
}

export async function findChats(
  page,
  query,
  { projectTitle, projectUrl, timeoutMs = 15_000 } = {},
) {
  const normalizedQuery = normalizeConversationTitle(query);
  if (!normalizedQuery) throw new Error("A non-empty chat search query is required.");
  let project = null;
  if (normalizeProjectTitle(projectTitle) || projectUrl) {
    project = await openProject(page, { title: projectTitle, projectUrl });
    await expandProjectConversationList(page, { timeoutMs });
    const conversations = await findConversationCandidatesByQuery(page, normalizedQuery, {
      projectUrl: project.url,
    });
    return {
      query: normalizedQuery,
      project,
      conversations,
    };
  }
  const conversations = await searchConversationCandidates(page, normalizedQuery, {
    projectUrl: project?.url || null,
    timeoutMs,
  });
  return {
    query: normalizedQuery,
    project,
    conversations,
  };
}

export async function openExistingConversation(
  page,
  { title, conversationUrl, projectTitle, projectUrl } = {},
) {
  if (conversationUrl && (normalizeProjectTitle(projectTitle) || projectUrl)) {
    throw new Error(
      "A conversationUrl already identifies its project. Do not combine it with projectTitle or projectUrl.",
    );
  }
  let candidate;
  let project = null;
  if (conversationUrl) {
    const url = normalizeConversationUrl(conversationUrl);
    candidate = {
      title: normalizeConversationTitle(title) || null,
      url,
      projectUrl: projectUrlFromConversationUrl(url),
    };
  } else {
    const normalizedTitle = normalizeConversationTitle(title);
    if (!normalizedTitle) throw new Error("Provide an exact chatTitle or conversationUrl.");
    if (normalizeProjectTitle(projectTitle) || projectUrl) {
      project = await openProject(page, { title: projectTitle, projectUrl });
      await expandProjectConversationList(page);
    }
    await delay(1_000);
    let candidates = await findConversationCandidates(page, normalizedTitle, {
      projectUrl: project?.url || null,
    });
    candidate = selectUniqueConversationCandidate(candidates, normalizedTitle);
    if (!candidate) {
      if (project) {
        throw new Error(
          `No ChatGPT conversation was found with the exact title ${JSON.stringify(normalizedTitle)} inside project ${JSON.stringify(project.title || project.url)}.`,
        );
      }
      candidates = await searchConversationByTitle(page, normalizedTitle, {
        projectUrl: project?.url || null,
      });
      candidate = selectUniqueConversationCandidate(candidates, normalizedTitle);
    }
    if (!candidate) {
      throw new Error(
        `No ChatGPT conversation was found with the exact title ${JSON.stringify(normalizedTitle)}.`,
      );
    }
  }
  await navigateChatGpt(page, candidate.url);
  await waitForComposerAfterNavigation(page, candidate.url, { timeoutMs: 60_000 });
  await waitForConversationHistoryStable(page, { timeoutMs: 30_000, stableMs: 2_500 });
  const observedUrl = normalizeConversationUrl(page.url());
  const observedProjectUrl = projectUrlFromConversationUrl(observedUrl);
  if (project?.url && observedProjectUrl !== project.url) {
    throw new Error("The selected conversation did not open inside the requested project.");
  }
  return {
    title: candidate.title,
    url: observedUrl,
    projectTitle: project?.title || null,
    projectUrl: observedProjectUrl,
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
      const { stdout, stderr } = await execFileAsync(firefoxPath, ["--version"], {
        timeout: 10_000,
      });
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

export async function launchFirefox({ headless = false, profileDir = profileDirectory(), downloadPath } = {}) {
  const executablePath = await resolveFirefoxPath();
  if (!executablePath) {
    throw new Error(
      "Firefox was not found. Set ORACLE_FIREFOX_PATH to the Firefox executable and retry.",
    );
  }
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  return wrapOwnedBrowser(await puppeteer.launch({
    browser: "firefox",
    protocol: "webDriverBiDi",
    executablePath,
    userDataDir: profileDir,
    headless,
    args: ["-no-remote"],
    defaultViewport: { width: 1280, height: 900 },
    ...(downloadPath ? {
      extraPrefsFirefox: {
        "browser.download.folderList": 2,
        "browser.download.dir": downloadPath,
        "browser.download.useDownloadDir": true,
        "browser.download.alwaysOpenPanel": false,
        "browser.helperApps.neverAsk.saveToDisk": "application/octet-stream,application/zip,application/x-zip-compressed,text/plain,text/csv,application/json,application/pdf",
      },
    } : {}),
    handleSIGINT: false,
    handleSIGTERM: false,
  }));
}

export async function openChatGpt(browser, { newPage = false, foreground = true } = {}) {
  const pages = await browser.pages();
  const page = newPage
    ? await browser.newPage()
    : pages.find((candidate) => candidate.url().includes("chatgpt.com")) ??
      pages[0] ??
      (await browser.newPage());
  page.setDefaultTimeout(30_000);
  try {
    if (!page.url().includes("chatgpt.com")) {
      await navigateChatGpt(page, CHATGPT_URL);
    } else if (page.url() !== CHATGPT_URL) {
      await navigateChatGpt(page, CHATGPT_URL);
    }
  } catch (error) {
    // A failed new-page navigation must not leak an untracked page into the
    // persistent browser. The control page is owned by the browser lifecycle
    // and is cleaned up by its caller if initialization fails.
    if (newPage) await page.close().catch(() => undefined);
    throw error;
  }
  if (foreground) await page.bringToFront();
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
      .map((node) =>
        (node.textContent || node.getAttribute("aria-label") || "").trim().toLowerCase(),
      );
    const loginCta = loginText.some((text) =>
      ["log in", "login", "sign in", "signin", "sign up for free"].includes(text),
    );
    const pageText = String(document.body?.innerText || "")
      .replace(/\s+/gu, " ")
      .toLowerCase();
    const challengeText = [
      "verify you are human",
      "checking your browser",
      "performing security verification",
    ].some((text) => pageText.includes(text));
    const cloudflare =
      document.title.toLowerCase().includes("just a moment") ||
      (challengeText && Boolean(document.querySelector('script[src*="/challenge-platform/"]')));
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
  let lastState = null;
  while (Date.now() < deadline) {
    const handle = await findVisibleHandle(page, INPUT_SELECTORS);
    if (handle) {
      const ready = await handle.evaluate((node) => !String(node.className || "").includes("fallbackTextarea"));
      if (ready) {
        // ChatGPT can replace the real ProseMirror node once more immediately
        // after its fallback textarea disappears. Require the same node to
        // remain connected before delivering trusted keystrokes.
        await delay(750);
        const stable = await handle.evaluate((node) => node.isConnected).catch(() => false);
        if (stable) return handle;
      }
      await handle.dispose();
    }
    const state = await probeLogin(page).catch(() => null);
    lastState = state || lastState;
    if (state?.cloudflare) {
      throw codedError(
        "CHATGPT_CHALLENGE",
        "Cloudflare challenge detected. Run oracle_firefox_setup and complete the challenge in Firefox.",
      );
    }
    await delay(250);
  }
  throw codedError(
    "CHATGPT_COMPOSER_UNAVAILABLE",
    "ChatGPT prompt composer did not become available.",
    {
      submissionMayHaveOccurred: false,
      recoveryAction: "Oracle may reload this exact pre-submit target once; if it remains unavailable, inspect ChatGPT login or service health",
      details: {
        observedPath: pathnameFor(lastState?.url || page.url()),
        sessionStatus: lastState?.sessionStatus ?? null,
        sessionAuthenticated: lastState?.sessionAuthenticated ?? false,
        accountSignal: lastState?.accountSignal ?? false,
        loginCta: lastState?.loginCta ?? false,
        cloudflare: lastState?.cloudflare ?? false,
      },
    },
  );
}

export async function waitForComposerAfterNavigation(page, targetUrl, { timeoutMs = 60_000 } = {}) {
  try {
    return await waitForComposer(page, { timeoutMs });
  } catch (error) {
    if (error?.code !== "CHATGPT_COMPOSER_UNAVAILABLE") throw error;
  }
  // One exact pre-submit reload is safe. It never edits a composer or clicks
  // Send, and it avoids asking the caller to create a duplicate job for a
  // transiently incomplete ChatGPT shell.
  await navigateChatGpt(page, targetUrl, { timeoutMs });
  return waitForComposer(page, { timeoutMs });
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
    const blockTags = new Set([
      "P", "DIV", "LI", "UL", "OL", "DL", "DT", "DD", "PRE", "BLOCKQUOTE",
      "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "TABLE", "TR",
    ]);
    const blockDisplays = new Set(["block", "list-item", "table", "table-row", "table-row-group"]);
    const isStructuralBlock = (child) =>
      child instanceof HTMLElement &&
      (blockTags.has(child.tagName) || blockDisplays.has(window.getComputedStyle(child).display));
    const structuredText = (root) => {
      if (root.childNodes.length === 1 && root.firstChild instanceof HTMLBRElement) return "";
      const pieces = [];
      for (const child of root.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          pieces.push({ text: child.textContent || "", block: false });
        } else if (child instanceof HTMLBRElement) {
          pieces.push({ text: "\n", block: false });
        } else {
          pieces.push({ text: structuredText(child), block: isStructuralBlock(child) });
        }
      }
      let value = "";
      for (let index = 0; index < pieces.length; index += 1) {
        if (index > 0 && (pieces[index - 1].block || pieces[index].block)) value += "\n";
        value += pieces[index].text;
      }
      return value;
    };
    // Firefox/ProseMirror represents authorized line breaks as structural
    // boundaries at multiple nesting levels. Reconstruct those boundaries
    // recursively so a later list/container cannot flatten earlier paragraphs.
    return structuredText(node) || node.innerText || node.textContent || "";
  }, INPUT_SELECTORS);
}

export async function inspectComposerState(page) {
  return page.evaluate(
    ({ inputSelectors, fileSelectors }) => {
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const composer = inputSelectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .find(visible);
      const root = composer?.closest('[data-testid*="composer"]') || composer?.closest("form") || composer?.parentElement || document.body;
      let text = "";
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        text = composer.value;
      } else if (composer) {
        const blockTags = new Set([
          "P", "DIV", "LI", "UL", "OL", "DL", "DT", "DD", "PRE", "BLOCKQUOTE",
          "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "TABLE", "TR",
        ]);
        const blockDisplays = new Set(["block", "list-item", "table", "table-row", "table-row-group"]);
        const isStructuralBlock = (child) =>
          child instanceof HTMLElement &&
          (blockTags.has(child.tagName) || blockDisplays.has(window.getComputedStyle(child).display));
        const structuredText = (root) => {
          if (root.childNodes.length === 1 && root.firstChild instanceof HTMLBRElement) return "";
          const pieces = [];
          for (const child of root.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
              pieces.push({ text: child.textContent || "", block: false });
            } else if (child instanceof HTMLBRElement) {
              pieces.push({ text: "\n", block: false });
            } else {
              pieces.push({ text: structuredText(child), block: isStructuralBlock(child) });
            }
          }
          let value = "";
          for (let index = 0; index < pieces.length; index += 1) {
            if (index > 0 && (pieces[index - 1].block || pieces[index].block)) value += "\n";
            value += pieces[index].text;
          }
          return value;
        };
        text = structuredText(composer) || composer.innerText || composer.textContent || "";
      }
      const filenames = new Set();
      for (const input of fileSelectors.flatMap((selector) => Array.from(root.querySelectorAll(selector)))) {
        if (input instanceof HTMLInputElement) {
          for (const file of Array.from(input.files || [])) filenames.add(file.name);
        }
      }
      for (const node of root.querySelectorAll('[data-testid*="attachment"], [data-testid*="file"], [aria-label*="Remove attachment" i], [title*="attachment" i]')) {
        const value = node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent || "";
        const match = value.match(/(?:remove\s+(?:attachment|file)\s*)?[“"']?([^\n“”"']+\.[a-z0-9]{1,12})/iu);
        if (match) filenames.add(match[1].trim());
      }
      const uploading = Array.from(root.querySelectorAll('[data-state], [data-testid*="upload"], [aria-label*="upload" i]')).some((node) => {
        const value = `${node.getAttribute("data-state") || ""} ${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`.toLowerCase();
        return /\b(uploading|processing|pending)\b/u.test(value);
      });
      return { text, attachments: Array.from(filenames).sort(), uploading };
    },
    { inputSelectors: INPUT_SELECTORS, fileSelectors: FILE_INPUT_SELECTORS },
  );
}

async function clearComposerText(page) {
  const editor = await waitForComposer(page);
  await editor.click();
  await editor.evaluate((node) => {
    node.focus();
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      const prototype = node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(node, "");
      else node.value = "";
    } else {
      node.replaceChildren();
    }
    node.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: null,
      inputType: "deleteContentBackward",
    }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await delay(250);
}

export async function insertComposerText(page, text, {
  expectedAttachments,
  discardExistingDraft = false,
} = {}) {
  const content = String(text);
  if (!content) throw new Error("Cannot submit an empty prompt.");
  const before = await inspectComposerState(page);
  const expected = [...(expectedAttachments ?? ORACLE_APPROVED_ATTACHMENTS.get(page) ?? [])].sort();
  if (before.attachments.join("\u0000") !== expected.join("\u0000")) {
    throw new Error(`ChatGPT composer already contains foreign attachments: ${before.attachments.join(", ")}.`);
  }
  if (normalizeSemanticText(before.text)) {
    if (discardExistingDraft !== true) {
      throw codedError(
        "COMPOSER_DRAFT_PRESENT",
        "ChatGPT composer contains an existing draft. Explicit user authorization is required to discard it.",
        {
          safeToRetry: false,
          recoveryAction: "Ask the user to clear the draft manually or explicitly authorize discardExistingDraft for one new start.",
          details: { discardExistingDraftAvailable: true },
        },
      );
    }
    await clearComposerText(page);
    const cleared = await inspectComposerState(page);
    if (normalizeSemanticText(cleared.text)) {
      throw codedError(
        "COMPOSER_CLEAR_FAILED",
        "The explicitly authorized composer draft could not be cleared; no message was sent.",
        { safeToRetry: false },
      );
    }
    if (cleared.attachments.join("\u0000") !== expected.join("\u0000")) {
      throw codedError(
        "ATTACHMENT_MISMATCH",
        "The composer attachment set changed while clearing the explicitly authorized text draft; no message was sent.",
        { safeToRetry: false },
      );
    }
  }
  const editor = await waitForComposer(page);
  await editor.click();
  const editorKind = await editor.evaluate((node) =>
    node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement ? "value" : "contenteditable",
  );
  let insertedFingerprint;
  if (editorKind === "value") {
    insertedFingerprint = await editor.evaluate((node, value) => {
      node.focus();
      const prototype =
        node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
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
      return node.value;
    }, content);
  } else {
    const inserted = await editor.evaluate((node, value) => {
      node.focus();
      const selection = window.getSelection();
      if (!selection?.rangeCount || !node.contains(selection.anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(node);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      // Insert the complete authorized value as one edit. Per-character key
      // events let ProseMirror consume prefixes such as `1. ` or `- ` as
      // Markdown shortcuts, changing the draft before the exact-text guard.
      const accepted = document.execCommand("insertText", false, value);
      return { accepted, fingerprint: node.innerHTML };
    }, content);
    if (!inserted.accepted) {
      throw codedError(
        "COMPOSER_INSERT_FAILED",
        "Firefox refused the atomic composer insertion; no message was sent.",
        { safeToRetry: true },
      );
    }
    insertedFingerprint = inserted.fingerprint;
  }
  ORACLE_OWNED_DRAFTS.set(page, { editor, fingerprint: insertedFingerprint });
  await delay(250);
  const observed = await readComposerText(page);
  const expectedNormalized = normalizeSemanticText(content);
  const observedNormalized = normalizeSemanticText(observed);
  if (observedNormalized !== expectedNormalized) {
    throw codedError(
      "COMPOSER_MISMATCH",
      `Prompt insertion did not match the whole authorized message (${observed.length}/${content.length} characters).`,
      {
        safeToRetry: true,
        details: semanticMismatchDetails(content, observed),
      },
    );
  }
  return observed.length;
}

// Roll back only an unchanged, text-only edit made by this page execution.
// No durable claim is inferred from matching prompt text in a later job.
export async function clearOwnedComposerDraft(page) {
  const owned = ORACLE_OWNED_DRAFTS.get(page);
  ORACLE_OWNED_DRAFTS.delete(page);
  if (!owned) return false;
  try {
    return await owned.editor.evaluate((node, fingerprint) => {
      if (!node.isConnected || ("value" in node ? node.value : node.innerHTML) !== fingerprint) return false;
      const root = node.closest('[data-testid*="composer"]') || node.closest("form") || node.parentElement;
      if (!root || root.querySelector('[data-testid*="attachment"], [data-testid*="file"], [aria-label*="Remove attachment" i], [title*="attachment" i]')) return false;
      if (Array.from(root.querySelectorAll('input[type="file"]')).some((input) => input.files?.length)) return false;
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
        const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(node, "");
        else node.value = "";
      } else {
        node.replaceChildren();
      }
      node.dispatchEvent(new InputEvent("input", { bubbles: true, data: null, inputType: "deleteContentBackward" }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, owned.fingerprint);
  } finally {
    await owned.editor.dispose().catch(() => undefined);
  }
}

export async function uploadAttachmentFiles(page, filePaths, { timeoutMs = 600_000 } = {}) {
  const boundedTimeout = Math.max(1_000, Math.min(1_800_000, timeoutMs));
  const testReadyDelayMs = Math.max(0, Number(process.env.ORACLE_FIREFOX_TEST_ATTACHMENT_READY_DELAY_MS) || 0);
  const uploadStartedAt = Date.now();
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  if (paths.length < 1) throw codedError("ATTACHMENT_REQUIRED", "At least one attachment path is required.");
  const filenames = paths.map((filePath) => path.basename(filePath));
  if (new Set(filenames.map((name) => name.toLocaleLowerCase("en-US"))).size !== filenames.length) {
    throw codedError("ATTACHMENT_FILENAME_DUPLICATE", "Attachment filenames must be unique.");
  }
  const initial = await inspectComposerState(page);
  if (initial.attachments.length > 0) {
    throw new Error(`ChatGPT composer already contains foreign attachments: ${initial.attachments.join(", ")}.`);
  }
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
  await input.uploadFile(...paths);
  const deadline = Date.now() + boundedTimeout;
  while (Date.now() < deadline) {
    const state = await inspectComposerState(page);
    const send = await findVisibleHandle(page, SEND_BUTTON_SELECTORS, { enabled: true });
    if (send) await send.dispose();
    const exactAttachments =
      state.attachments.length === filenames.length &&
      attachmentManifestKey(state.attachments) === attachmentManifestKey(filenames);
    if (exactAttachments && !state.uploading && Boolean(send) && Date.now() - uploadStartedAt >= testReadyDelayMs) {
      ORACLE_APPROVED_ATTACHMENTS.set(page, filenames);
      return filenames;
    }
    await delay(500);
  }
  throw new Error(
    `Attachments did not become ready before the ${Math.round(boundedTimeout / 1000)}-second timeout: ${filenames.join(", ")}`,
  );
}

export async function uploadContextFile(page, filePath, options = {}) {
  const [filename] = await uploadAttachmentFiles(page, [filePath], options);
  return filename;
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
      const roleNodes = Array.from(document.querySelectorAll('[data-message-author-role], [data-turn="assistant"], [data-turn="user"]'));
      const orderedTurns = [];
      const seen = new Set();
      for (const roleNode of roleNodes) {
        const turn = roleNode.closest('[data-testid^="conversation-turn"]') || roleNode.closest("article") || roleNode;
        if (seen.has(turn)) continue;
        seen.add(turn);
        const explicitRole = roleNode.getAttribute("data-message-author-role") || roleNode.getAttribute("data-turn");
        if (explicitRole !== "assistant" && explicitRole !== "user") continue;
        const contentNode = explicitRole === "assistant"
          ? turn.querySelector(".markdown, [data-message-content]") || roleNode
          : turn.querySelector('[data-testid="collapsible-user-message-content"], .whitespace-pre-wrap, [data-message-content], [data-testid*="user-message-content"]') || roleNode;
        const serializeUserSource = (node) => {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
          if (!(node instanceof HTMLElement)) return "";
          if (node instanceof HTMLBRElement) return "\n";
          if (node instanceof HTMLPreElement) {
            const code = node.querySelector(":scope > code");
            const source = String(code?.textContent || node.textContent || "").replace(/\n+$/u, "");
            return `\`\`\`${source}\n\`\`\``;
          }
          if (node.tagName === "CODE") {
            const source = node.textContent || "";
            const longestRun = Math.max(0, ...Array.from(source.matchAll(/`+/gu), (match) => match[0].length));
            const delimiter = "`".repeat(longestRun + 1);
            return `${delimiter}${source}${delimiter}`;
          }
          return Array.from(node.childNodes, serializeUserSource).join("");
        };
        const text = (explicitRole === "user"
          ? serializeUserSource(contentNode)
          : (contentNode.innerText || contentNode.textContent || "")).trim();
        const id = turn.getAttribute("data-message-id") || roleNode.getAttribute("data-message-id") || turn.getAttribute("data-testid") || turn.id || null;
        const attachments = Array.from(turn.querySelectorAll('[data-testid*="attachment"], [data-testid*="file"], a[download], [role="group"][aria-label]'))
          .map((node) => (node.getAttribute("download") || node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent || "").trim())
          .flatMap((value) => {
            const match = value.match(/([^/\\\n]+\.[a-z0-9]{1,12})/iu);
            return match ? [match[1].trim()] : [];
          });
        const errorIndicators = Array.from(turn.querySelectorAll('[role="alert"], [data-testid*="error"], button'))
          .filter((node) => {
            if (!visible(node)) return false;
            if (node.matches('[role="alert"], [data-testid*="error"]')) return true;
            const label = String(node.getAttribute("aria-label") || node.textContent || "")
              .replace(/\s+/gu, " ")
              .trim();
            return /^(?:retry|try again|regenerate|report)$/iu.test(label);
          })
          .map((node) => String(node.getAttribute("aria-label") || node.textContent || "").replace(/\s+/gu, " ").trim())
          .filter(Boolean);
        orderedTurns.push({
          role: explicitRole,
          id,
          text,
          html: turn.innerHTML || "",
          attachments,
          errorIndicators,
          completionVisible: explicitRole === "assistant" && Boolean(turn.querySelector(finishedSelector)),
        });
      }
      const turns = orderedTurns.filter((turn) => turn.role === "assistant");
      const userTurns = orderedTurns.filter((turn) => turn.role === "user");
      const last = turns.at(-1) || null;
      const lastUser = userTurns.at(-1) || null;
      const stopVisible = stopSelectors.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some((node) => visible(node)),
      );
      const completionVisible = Boolean(last?.completionVisible);
      return {
        count: turns.length,
        userCount: userTurns.length,
        lastUserText: lastUser?.text || "",
        text: last?.text || "",
        html: last?.html || "",
        turns: orderedTurns,
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
  { timeoutMs = 30_000, expectedAttachments = [], requireCanonicalUrl = true, baselineTurnIds = [] } = {},
) {
  const expectedHash = semanticTextHash(expectedText);
  const expectedManifest = [...expectedAttachments].sort();
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  const knownTurnIds = new Set(baselineTurnIds.filter(Boolean));
  while (Date.now() < deadline) {
    latest = await assistantSnapshot(page);
    const cooldownNotice = await readChatGptCooldownNotice(page);
    if (cooldownNotice) {
      throw codedError("ACCOUNT_COOLDOWN", "ChatGPT rejected the submission attempt because the account is temporarily rate-limited. Oracle did not retry.", {
        submissionMayHaveOccurred: false,
        recoveryAction: "wait for the ChatGPT account cooldown before starting a newly authorized job",
        details: {
          remoteThrottleEvidence: remoteThrottleEvidence("visible_notice", cooldownNotice.id, cooldownNotice.text),
        },
      });
    }
    const users = latest.turns.filter((turn) => turn.role === "user");
    // ChatGPT virtualizes long conversations and can render fewer turns after
    // submission than were present in the baseline. Prefer durable turn IDs;
    // count slicing is only a fallback for fixtures/legacy DOMs without IDs.
    const unseenById = knownTurnIds.size
      ? users.filter((turn) => turn.id && !knownTurnIds.has(turn.id))
      : [];
    const countTail = users.slice(baselineCount);
    const newUsers = knownTurnIds.size ? Array.from(new Set([...unseenById, ...countTail])) : countTail;
    const matchIndex = correlatedUserTurnIndex(newUsers, {
      hash: expectedHash,
      attachments: expectedManifest,
    });
    let match = matchIndex >= 0 ? newUsers[matchIndex] : null;
    let attachmentEvidence = match ? "rendered_manifest" : null;
    if (!match && expectedManifest.length > 0) {
      // ChatGPT intermittently omits attachment chips from the submitted user
      // turn even though the exact manifest was verified upload-ready before
      // the one authorized click. Accept only one exact new text turn whose
      // rendered manifest is absent; a visible foreign/different manifest
      // still fails closed.
      const missingManifestMatches = exactHashMatches(newUsers, expectedHash)
        .filter((turn) => Array.isArray(turn.attachments) && turn.attachments.length === 0);
      if (missingManifestMatches.length === 1) {
        [match] = missingManifestMatches;
        attachmentEvidence = "pre_submit_verified_post_submit_unavailable";
      }
    }
    if (match) {
      if (!requireCanonicalUrl) {
        return { ...latest, userTurn: { ...match, hash: expectedHash, attachmentEvidence } };
      }
      try {
        normalizeConversationUrl(latest.url);
        return { ...latest, userTurn: { ...match, hash: expectedHash, attachmentEvidence } };
      } catch {
        // New project/standalone chats can render the submitted turn before
        // ChatGPT's SPA exposes the canonical /c/ URL. Keep observing without
        // clicking or resending until both proofs exist.
      }
    }
    await delay(250);
  }
  let conversationUrl = null;
  try {
    conversationUrl = normalizeConversationUrl(latest?.url || page.url());
  } catch {
    // A canonical URL may not exist yet for a failed new-chat submission.
  }
  const users = latest?.turns?.filter((turn) => turn.role === "user") || [];
  const unseenById = knownTurnIds.size
    ? users.filter((turn) => turn.id && !knownTurnIds.has(turn.id))
    : [];
  const countTail = users.slice(baselineCount);
  const newUsers = knownTurnIds.size ? Array.from(new Set([...unseenById, ...countTail])) : countTail;
  const closest = newUsers.find((turn) =>
    attachmentManifestKey(turn.attachments) === attachmentManifestKey(expectedManifest)
  ) || newUsers.at(-1) || null;
  throw codedError(
    "SUBMISSION_UNCERTAIN",
    `The new user message could not be confirmed in the target conversation. Refusing to retry automatically. Last state: ${JSON.stringify({ userCount: latest?.userCount, baselineCount })}`,
    {
      submissionMayHaveOccurred: true,
      details: {
        conversationUrl,
        observedUserCount: latest?.userCount ?? null,
        baselineCount,
        candidateCount: newUsers.length,
        mismatch: closest ? semanticMismatchDetails(expectedText, closest.text) : null,
      },
    },
  );
}

export async function submitComposer(page) {
  const button = await findVisibleHandle(page, SEND_BUTTON_SELECTORS, { enabled: true });
  if (!button) {
    throw new Error("A visible, enabled ChatGPT Send button was not found. No submission was attempted.");
  }
  // Once the trusted click can occur, a draft must never be rolled back.
  const owned = ORACLE_OWNED_DRAFTS.get(page);
  ORACLE_OWNED_DRAFTS.delete(page);
  await owned?.editor.dispose().catch(() => undefined);
  await button.click();
  await button.dispose();
  return "button";
}

function isPlaceholder(text) {
  const normalized = String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return (
    !normalized ||
    normalized === "chatgpt said:" ||
    normalized === "chatgpt said" ||
    (normalized.includes("answer now") && normalized.includes("pro thinking"))
  );
}

export async function waitForAssistant(page, baselineCount, { timeoutMs = 600_000, probeTimeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastKey = "";
  let lastChangeAt = Date.now();
  let terminalCycles = 0;
  while (Date.now() < deadline) {
    const snapshot = await boundedAssistantSnapshot(page, Math.min(probeTimeoutMs, Math.max(1, deadline - Date.now())));
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
  throw codedError(
    "RESPONSE_TIMEOUT",
    "ChatGPT response could not be confirmed complete before timeout; refusing to return a possibly incomplete answer.",
    { submissionMayHaveOccurred: true, recoveryAction: "inspect the exact conversation and reconcile this job without resending" },
  );
}

async function boundedAssistantSnapshot(page, probeTimeoutMs = 30_000) {
  let timer;
  try {
    return await Promise.race([
      assistantSnapshot(page),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(codedError(
          "RESPONSE_MONITOR_STALLED",
          `The browser stopped responding for ${probeTimeoutMs}ms while Oracle monitored the submitted turn. Oracle did not retry or resend.`,
          {
            submissionMayHaveOccurred: true,
            safeToRetry: false,
            recoveryAction: "inspect the exact conversation and reconcile this job without resending",
            details: { probeTimeoutMs },
          },
        )), Math.max(1, probeTimeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function correlatedUserTurnIndex(turns, userTurn) {
  if (!Array.isArray(turns) || (!userTurn?.id && !userTurn?.hash)) return -1;
  if (userTurn.id) {
    const exactIdIndex = turns.findIndex((turn) => turn.role === "user" && turn.id === userTurn.id);
    if (exactIdIndex >= 0) return exactIdIndex;
  }
  if (!userTurn.hash) return -1;
  const hashMatches = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.role === "user" && semanticTextHash(turn.text) === userTurn.hash) hashMatches.push(index);
  }
  if (hashMatches.length !== 1) return -1;
  const [matchIndex] = hashMatches;
  const match = turns[matchIndex];
  if (
    Array.isArray(userTurn.attachments) &&
    Array.isArray(match.attachments) &&
    attachmentManifestKey(match.attachments) !== attachmentManifestKey(userTurn.attachments)
  ) return -1;
  return matchIndex;
}

function assistantBoundToUserTurn(turns, userIndex) {
  if (userIndex < 0) return null;
  const following = turns.slice(userIndex + 1);
  const nextUserIndex = following.findIndex((turn) => turn.role === "user");
  const responseSegment = nextUserIndex >= 0 ? following.slice(0, nextUserIndex) : following;
  const assistants = responseSegment.filter((turn) => turn.role === "assistant");
  return assistants.length === 1 ? assistants[0] : null;
}

export async function probeAssistantAfterTurn(page, userTurn, { includeContent = false } = {}) {
  const startedAt = performance.now();
  const probe = await page.evaluate(async ({ expected, include, finishedSelector, stopSelectors }) => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const normalize = (value) => String(value || "")
      .replace(/\r\n?/gu, "\n")
      .replace(/\u00a0/gu, " ")
      .replace(/\t/gu, "    ")
      .normalize("NFC")
      .replace(/[ \t]+\n/gu, "\n")
      .replace(/\n[ \t]+/gu, "\n")
      .trim();
    const hash = async (value) => {
      const bytes = new TextEncoder().encode(normalize(value));
      if (globalThis.crypto?.subtle) {
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      }
      const words = [];
      const hashWords = [];
      const constants = [];
      const composite = {};
      let primeCount = 0;
      for (let candidate = 2; primeCount < 64; candidate += 1) {
        if (composite[candidate]) continue;
        for (let multiple = candidate * candidate; multiple < 313; multiple += candidate) composite[multiple] = true;
        hashWords[primeCount] = (Math.sqrt(candidate) * 0x100000000) | 0;
        constants[primeCount] = (Math.cbrt(candidate) * 0x100000000) | 0;
        primeCount += 1;
      }
      const bitLength = bytes.length * 8;
      const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
      const padded = new Uint8Array(paddedLength);
      padded.set(bytes);
      padded[bytes.length] = 0x80;
      const view = new DataView(padded.buffer);
      view.setUint32(paddedLength - 4, bitLength >>> 0, false);
      view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
      const rotate = (word, amount) => (word >>> amount) | (word << (32 - amount));
      for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let index = 0; index < 16; index += 1) words[index] = view.getInt32(offset + index * 4, false);
        for (let index = 16; index < 64; index += 1) {
          const left = words[index - 15];
          const right = words[index - 2];
          const sigma0 = rotate(left, 7) ^ rotate(left, 18) ^ (left >>> 3);
          const sigma1 = rotate(right, 17) ^ rotate(right, 19) ^ (right >>> 10);
          words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) | 0;
        }
        let [a, b, c, d, e, f, g, h] = hashWords;
        for (let index = 0; index < 64; index += 1) {
          const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
          const choice = (e & f) ^ (~e & g);
          const temp1 = (h + sum1 + choice + constants[index] + words[index]) | 0;
          const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
          const majority = (a & b) ^ (a & c) ^ (b & c);
          const temp2 = (sum0 + majority) | 0;
          h = g; g = f; f = e; e = (d + temp1) | 0;
          d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }
        const next = [a, b, c, d, e, f, g, h];
        for (let index = 0; index < 8; index += 1) hashWords[index] = (hashWords[index] + next[index]) | 0;
      }
      return hashWords.slice(0, 8).map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
    };
    const serializeUserSource = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
      if (!(node instanceof HTMLElement)) return "";
      if (node instanceof HTMLBRElement) return "\n";
      if (node instanceof HTMLPreElement) {
        const code = node.querySelector(":scope > code");
        const source = String(code?.textContent || node.textContent || "").replace(/\n+$/u, "");
        return `\`\`\`${source}\n\`\`\``;
      }
      if (node.tagName === "CODE") {
        const source = node.textContent || "";
        const longestRun = Math.max(0, ...Array.from(source.matchAll(/`+/gu), (match) => match[0].length));
        const delimiter = "`".repeat(longestRun + 1);
        return `${delimiter}${source}${delimiter}`;
      }
      return Array.from(node.childNodes, serializeUserSource).join("");
    };
    const roleNodes = Array.from(document.querySelectorAll('[data-message-author-role], [data-turn="assistant"], [data-turn="user"]'));
    const turns = [];
    const seen = new Set();
    for (const roleNode of roleNodes) {
      const turn = roleNode.closest('[data-testid^="conversation-turn"]') || roleNode.closest("article") || roleNode;
      if (seen.has(turn)) continue;
      seen.add(turn);
      const role = roleNode.getAttribute("data-message-author-role") || roleNode.getAttribute("data-turn");
      if (role !== "assistant" && role !== "user") continue;
      turns.push({ role, roleNode, turn });
    }
    const attachmentNames = (turn) => Array.from(turn.querySelectorAll('[data-testid*="attachment"], [data-testid*="file"], a[download], [role="group"][aria-label]'))
      .map((node) => (node.getAttribute("download") || node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent || "").trim())
      .flatMap((value) => {
        const match = value.match(/([^/\\\n]+\.[a-z0-9]{1,12})/iu);
        return match ? [match[1].trim()] : [];
      })
      .sort();
    const expectedAttachments = Array.isArray(expected.attachments) ? [...expected.attachments].sort() : null;
    const matches = [];
    if (expected.id) {
      for (let index = 0; index < turns.length; index += 1) {
        const item = turns[index];
        if (item.role !== "user") continue;
        const id = item.turn.getAttribute("data-message-id") || item.roleNode.getAttribute("data-message-id") ||
          item.turn.getAttribute("data-testid") || item.turn.id || null;
        if (id === expected.id) matches.push(index);
      }
    }
    if (matches.length === 0 && expected.hash) {
      for (let index = 0; index < turns.length; index += 1) {
        const item = turns[index];
        if (item.role !== "user") continue;
        const content = item.turn.querySelector('[data-testid="collapsible-user-message-content"], .whitespace-pre-wrap, [data-message-content], [data-testid*="user-message-content"]') || item.roleNode;
        if (await hash(serializeUserSource(content)) !== expected.hash) continue;
        const attachments = attachmentNames(item.turn);
        if (expectedAttachments && attachments.join("\0") !== expectedAttachments.join("\0")) continue;
        matches.push(index);
      }
    }
    if (matches.length !== 1) {
      return { userMatchCount: matches.length, assistantCount: 0, assistant: null, stopVisible: false };
    }
    const following = turns.slice(matches[0] + 1);
    const nextUser = following.findIndex((item) => item.role === "user");
    const segment = nextUser >= 0 ? following.slice(0, nextUser) : following;
    const assistants = segment.filter((item) => item.role === "assistant");
    const stopVisible = stopSelectors.some((selector) =>
      Array.from(document.querySelectorAll(selector)).some((node) => visible(node)),
    );
    if (assistants.length !== 1) {
      return { userMatchCount: 1, assistantCount: assistants.length, assistant: null, stopVisible };
    }
    const item = assistants[0];
    const content = item.turn.querySelector(".markdown, [data-message-content]") || item.roleNode;
    const text = (content.innerText || content.textContent || "").trim();
    const id = item.turn.getAttribute("data-message-id") || item.roleNode.getAttribute("data-message-id") ||
      item.turn.getAttribute("data-testid") || item.turn.id || null;
    const errorIndicators = Array.from(item.turn.querySelectorAll('[role="alert"], [data-testid*="error"], button'))
      .filter((node) => {
        if (!visible(node)) return false;
        if (node.matches('[role="alert"], [data-testid*="error"]')) return true;
        const label = String(node.getAttribute("aria-label") || node.textContent || "").replace(/\s+/gu, " ").trim();
        return /^(?:retry|try again|regenerate|report)$/iu.test(label);
      })
      .map((node) => String(node.getAttribute("aria-label") || node.textContent || "").replace(/\s+/gu, " ").trim())
      .filter(Boolean)
      .slice(0, 8);
    const textHash = await hash(text);
    return {
      userMatchCount: 1,
      assistantCount: 1,
      stopVisible,
      assistant: {
        id,
        hash: textHash,
        textLength: text.length,
        completionVisible: Boolean(item.turn.querySelector(finishedSelector)),
        errorIndicators,
        ...(include ? { text, html: item.turn.innerHTML || "" } : {}),
      },
    };
  }, {
    expected: userTurn,
    include: includeContent,
    finishedSelector: FINISHED_ACTIONS_SELECTOR,
    stopSelectors: STOP_BUTTON_SELECTORS,
  });
  const payloadBytes = Buffer.byteLength(JSON.stringify(probe), "utf8");
  return { ...probe, latencyMs: performance.now() - startedAt, payloadBytes };
}

async function boundedAssistantTurnProbe(page, userTurn, options, probeTimeoutMs) {
  let timer;
  try {
    return await Promise.race([
      probeAssistantAfterTurn(page, userTurn, options),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(codedError(
          "RESPONSE_MONITOR_STALLED",
          `The exact-turn browser probe exceeded ${probeTimeoutMs}ms. Oracle released only the monitor execution and did not resend.`,
          {
            submissionMayHaveOccurred: true,
            safeToRetry: false,
            recoveryAction: "resume monitor-only execution for the exact submitted turn",
            details: { probeTimeoutMs, monitorOnly: true },
          },
        )), Math.max(1, probeTimeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForAssistantAfterTurn(
  page,
  userTurn,
  { timeoutMs = 10_800_000, stableMs = 2_500, probeTimeoutMs = 30_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastKey = "";
  let stableSince = Date.now();
  let terminalCycles = 0;
  let cachedAssistant = null;
  let terminalContentKey = "";
  const monitorMetrics = { probeCount: 0, contentFetchCount: 0, maxProbeLatencyMs: 0, maxProbePayloadBytes: 0 };
  while (Date.now() < deadline) {
    const boundedTimeout = Math.min(probeTimeoutMs, Math.max(1, deadline - Date.now()));
    const probe = await boundedAssistantTurnProbe(page, userTurn, { includeContent: false }, boundedTimeout);
    monitorMetrics.probeCount += 1;
    monitorMetrics.maxProbeLatencyMs = Math.max(monitorMetrics.maxProbeLatencyMs, probe.latencyMs);
    monitorMetrics.maxProbePayloadBytes = Math.max(monitorMetrics.maxProbePayloadBytes, probe.payloadBytes);
    const key = probe.assistant ? `${probe.assistant.id || ""}:${probe.assistant.hash}` : "";
    const terminalHint = Boolean(probe.assistant &&
      (probe.assistant.completionVisible || probe.assistant.errorIndicators.length) && !probe.stopVisible);
    if (key !== lastKey) {
      lastKey = key;
      stableSince = Date.now();
      terminalCycles = 0;
    }
    if (terminalHint && Date.now() - stableSince >= stableMs && terminalContentKey !== key) {
      const content = await boundedAssistantTurnProbe(page, userTurn, { includeContent: true }, boundedTimeout);
      monitorMetrics.contentFetchCount += 1;
      monitorMetrics.maxProbeLatencyMs = Math.max(monitorMetrics.maxProbeLatencyMs, content.latencyMs);
      monitorMetrics.maxProbePayloadBytes = Math.max(monitorMetrics.maxProbePayloadBytes, content.payloadBytes);
      const contentKey = content.assistant ? `${content.assistant.id || ""}:${content.assistant.hash}` : "";
      if (contentKey !== key || content.stopVisible ||
        !(content.assistant?.completionVisible || content.assistant?.errorIndicators?.length)) {
        cachedAssistant = null;
        terminalContentKey = "";
        terminalCycles = 0;
        stableSince = Date.now();
        await delay(Math.min(500, Math.max(0, deadline - Date.now())));
        continue;
      }
      cachedAssistant = content.assistant;
      if (content.assistant) terminalContentKey = key;
    }
    const assistant = cachedAssistant ? {
      ...cachedAssistant,
      text: cachedAssistant.text || "",
      html: cachedAssistant.html || "",
    } : null;
    const responseFailure = classifyAssistantResponseFailure(assistant);
    const terminal = terminalHint && terminalContentKey === key && assistant && !isPlaceholder(assistant.text) &&
      (assistant.completionVisible || responseFailure);
    if (terminal) {
      terminalCycles += 1;
      if (terminalCycles >= 3 && Date.now() - stableSince >= stableMs) {
        if (isChatGptCooldownText(assistant.text)) {
          throw codedError("ACCOUNT_COOLDOWN", "ChatGPT rejected the submitted turn because the account is temporarily rate-limited. Oracle did not retry.", {
            submissionMayHaveOccurred: true,
            recoveryAction: "wait for the ChatGPT account cooldown before starting a newly authorized job",
            details: {
              remoteThrottleEvidence: remoteThrottleEvidence("assistant_turn", assistant.id || userTurn.id, assistant.text),
            },
          });
        }
        return {
          assistantTurn: assistant,
          text: assistant.text,
          html: assistant.html,
          responseFailure,
          exactTurnBinding: true,
          monitorMetrics,
        };
      }
    } else {
      terminalCycles = 0;
    }
    await delay(Math.min(terminalHint ? 500 : 2_000, Math.max(0, deadline - Date.now())));
  }
  throw codedError(
    "RESPONSE_TIMEOUT",
    "The assistant response bound to the submitted user turn could not be confirmed complete before timeout.",
    { submissionMayHaveOccurred: true, recoveryAction: "inspect the exact conversation and reconcile this job without resending" },
  );
}

export async function reconcileAssistantAfterTurn(page, userTurn) {
  if (!userTurn?.id && !userTurn?.hash) {
    throw codedError(
      "EXACT_TURN_PROOF_REQUIRED",
      "Final response reconciliation requires an exact user-turn id or unambiguous semantic hash.",
      { submissionMayHaveOccurred: true },
    );
  }
  const probe = await boundedAssistantTurnProbe(page, userTurn, { includeContent: false }, 30_000);
  if (probe.userMatchCount !== 1 || probe.assistantCount !== 1 || !probe.assistant) return null;
  const content = await boundedAssistantTurnProbe(page, userTurn, { includeContent: true }, 30_000);
  const assistant = content.assistant;
  const responseFailure = classifyAssistantResponseFailure(assistant);
  const terminal = assistant && !isPlaceholder(assistant.text) &&
    (assistant.completionVisible || responseFailure) && !probe.stopVisible && !content.stopVisible &&
    assistant.id === probe.assistant.id && assistant.hash === probe.assistant.hash;
  if (!terminal) return null;
  if (isChatGptCooldownText(assistant.text)) {
    throw codedError("ACCOUNT_COOLDOWN", "ChatGPT rejected the submitted turn because the account is temporarily rate-limited. Oracle did not retry.", {
      submissionMayHaveOccurred: true,
      recoveryAction: "wait for the ChatGPT account cooldown before starting a newly authorized job",
      details: {
        remoteThrottleEvidence: remoteThrottleEvidence("assistant_turn", assistant.id || userTurn.id, assistant.text),
      },
    });
  }
  return {
    assistantTurn: assistant,
    text: assistant.text,
    html: assistant.html,
    responseFailure,
    exactTurnBinding: true,
    monitorMetrics: {
      probeCount: 2,
      contentFetchCount: 1,
      maxProbeLatencyMs: Math.max(probe.latencyMs, content.latencyMs),
      maxProbePayloadBytes: Math.max(probe.payloadBytes, content.payloadBytes),
    },
  };
}

function isChatGptCooldownText(value) {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  return CHATGPT_COOLDOWN_PATTERN.test(normalized);
}

export async function installChatGptCooldownObserver(page) {
  await page.evaluate(({ patternSource, patternFlags }) => {
    const key = "__oracleFirefoxCooldownObserverV1";
    const existing = globalThis[key];
    existing?.observer?.disconnect?.();
    const pattern = new RegExp(patternSource, patternFlags);
    const state = { notices: [], observer: null };
    const noticeContainer = (element) => element.closest([
      '[role="alert"]',
      '[role="status"]',
      '[aria-live]',
      '[data-sonner-toast]',
      '[data-testid*="toast"]',
      '[data-testid*="error"]',
      '[class*="toast"]',
      '[class*="notification"]',
    ].join(","));
    const record = (node) => {
      const element = node instanceof HTMLElement
        ? node
        : node?.parentElement instanceof HTMLElement ? node.parentElement : null;
      if (!element || element.closest('[data-message-author-role], [data-turn], [data-testid^="conversation-turn"]')) return;
      const container = noticeContainer(element) || element;
      const style = getComputedStyle(container);
      if (!noticeContainer(element) && style.position !== "fixed" && style.position !== "absolute") return;
      const text = String(container.innerText || container.textContent || "").replace(/\s+/gu, " ").trim();
      if (!text || !pattern.test(text)) return;
      state.notices.push({
        id: container.getAttribute("data-testid") || container.getAttribute("data-sonner-toast") || container.id || null,
        text: text.slice(0, 500),
      });
      if (state.notices.length > 8) state.notices.shift();
    };
    state.observer = new MutationObserver((records) => {
      for (const recordEntry of records) {
        for (const node of recordEntry.addedNodes) record(node);
      }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
    globalThis[key] = state;
  }, { patternSource: CHATGPT_COOLDOWN_PATTERN.source, patternFlags: CHATGPT_COOLDOWN_PATTERN.flags });
}

async function readChatGptCooldownNotice(page) {
  return page.evaluate(({ patternSource, patternFlags }) => {
    const pattern = new RegExp(patternSource, patternFlags);
    const captured = globalThis.__oracleFirefoxCooldownObserverV1?.notices?.at(-1) || null;
    if (captured) return captured;
    const visible = (node) =>
      node instanceof HTMLElement &&
      node.getBoundingClientRect().width > 0 &&
      node.getBoundingClientRect().height > 0;
    const notices = Array.from(
      document.querySelectorAll('[role="alert"], [role="status"], [aria-live], [data-sonner-toast], [data-testid*="toast"], [data-testid*="error"], [class*="toast"], [class*="notification"]'),
    ).filter(visible);
    const matched = notices
      .filter((node) => !node.closest('[data-message-author-role], [data-turn], [data-testid^="conversation-turn"]'))
      .map((node) => ({
        id: node.getAttribute("data-testid") || node.getAttribute("data-sonner-toast") || node.id || null,
        text: (node.innerText || node.textContent || "").replace(/\s+/gu, " ").trim(),
      }))
      .find((notice) => pattern.test(notice.text));
    return matched || null;
  }, { patternSource: CHATGPT_COOLDOWN_PATTERN.source, patternFlags: CHATGPT_COOLDOWN_PATTERN.flags });
}
