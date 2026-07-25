import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { browserDownloadStagingDirectory, downloadsDirectory } from "./config.mjs";
import { codedError } from "./errors.mjs";

const CHATGPT_DOWNLOAD_BASE_URL = "https://chatgpt.com/";
const MAX_REDIRECTS = 5;
export const DEFAULT_DOWNLOAD_MAX_BYTES = 100_000_000;
export const ABSOLUTE_DOWNLOAD_MAX_BYTES = 250_000_000;

function normalizeLabel(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function normalizedMatch(value) {
  return normalizeLabel(value).toLocaleLowerCase("en-US");
}

function isAllowedChatGptHost(hostname) {
  const value = String(hostname ?? "").toLowerCase();
  return value === "chatgpt.com" || value === "chat.openai.com";
}

function isSafeSandboxPath(value) {
  const pathname = String(value ?? "");
  return (
    pathname.startsWith("/mnt/data/") &&
    !pathname.includes("\\") &&
    !pathname.includes("\0") &&
    !pathname.split("/").includes("..")
  );
}

function isKnownChatGptDownloadUrl(url) {
  const pathname = url.pathname.toLowerCase();
  if (pathname === "/backend-api/sandbox/download") {
    return isSafeSandboxPath(url.searchParams.get("path"));
  }
  if (/^\/backend-api\/files\/[^/]+\/(?:download|content)\/?$/u.test(pathname)) return true;
  return pathname === "/backend-api/estuary/content" && String(url.searchParams.get("id") ?? "").startsWith("file_");
}

function sandboxPath(value) {
  const raw = String(value ?? "").trim();
  if (!raw.startsWith("sandbox:/mnt/data/")) return null;
  let pathname;
  try { pathname = decodeURI(new URL(raw).pathname); }
  catch { pathname = raw.slice("sandbox:".length); }
  return isSafeSandboxPath(pathname) ? pathname : null;
}

function safeBasename(value) {
  try { return decodeURIComponent(path.posix.basename(value)); }
  catch { return path.posix.basename(value); }
}

export function normalizeChatGptDownloadSource(value) {
  const raw = String(value ?? "").trim();
  const safeSandboxPath = sandboxPath(raw);
  if (safeSandboxPath) {
    const url = new URL("/backend-api/sandbox/download", CHATGPT_DOWNLOAD_BASE_URL);
    url.searchParams.set("path", safeSandboxPath);
    return {
      downloadUrl: url.href,
      sourceKind: "sandbox",
      sourceFilename: path.posix.basename(safeSandboxPath),
    };
  }
  if (!raw || raw.startsWith("blob:") || raw.startsWith("data:")) return null;
  let url;
  try { url = new URL(raw, CHATGPT_DOWNLOAD_BASE_URL); }
  catch { return null; }
  if (
    url.protocol !== "https:" ||
    url.port ||
    !isAllowedChatGptHost(url.hostname) ||
    !isKnownChatGptDownloadUrl(url)
  ) return null;
  return {
    downloadUrl: url.href,
    sourceKind: "chatgpt-file-endpoint",
    sourceFilename: safeBasename(url.pathname),
  };
}

function sanitizeFilename(value, fallback = "artifact.bin") {
  let filename = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[\\/]/gu, "_")
    .trim()
    .replace(/^\.+/u, "");
  if (!filename || filename === "." || filename === "..") filename = fallback;
  if (filename.length > 180) {
    const extension = path.extname(filename).slice(0, 24);
    filename = `${path.basename(filename, path.extname(filename)).slice(0, 180 - extension.length)}${extension}`;
  }
  return filename;
}

function filenameFromContentDisposition(value) {
  const header = String(value ?? "");
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(header)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.trim().replace(/^"|"$/gu, "")); }
    catch { return encoded.trim().replace(/^"|"$/gu, ""); }
  }
  return /filename="?([^";]+)"?/iu.exec(header)?.[1]?.trim() ?? null;
}

function extensionForMimeType(value) {
  const mime = String(value ?? "").toLowerCase();
  if (mime.includes("zip")) return ".zip";
  if (mime.includes("json")) return ".json";
  if (mime.includes("csv")) return ".csv";
  if (mime.includes("markdown")) return ".md";
  if (mime.startsWith("text/")) return ".txt";
  return "";
}

function publicCandidate(candidate) {
  return {
    linkId: candidate.linkId,
    linkText: candidate.label,
    filename: candidate.filename,
    sourceKind: candidate.source.sourceKind,
    assistantTurnId: candidate.assistantTurnId,
    assistantTurnIndex: candidate.assistantTurnIndex,
  };
}

const CONTROL_SELECTOR = [
  "a[href]",
  "a[download]",
  "button",
  '[role="button"]',
  "[data-testid]",
  "[aria-label]",
  "[title]",
].join(",");

export async function listAssistantDownloadCandidates(page, { scope = "last-assistant" } = {}) {
  if (!new Set(["last-assistant", "all-assistant"]).has(scope)) {
    throw codedError("INVALID_DOWNLOAD_SCOPE", "scope must be last-assistant or all-assistant.");
  }
  const raw = await page.evaluate((requestedScope, selector) => {
    const normalize = (value) => String(value || "").replace(/\s+/gu, " ").trim();
    const turnCandidates = Array.from(document.querySelectorAll([
      'main [data-testid^="conversation-turn-"]',
      "main article",
      'main [data-message-author-role]',
    ].join(",")));
    const turns = turnCandidates.filter((candidate) =>
      !turnCandidates.some((other) => other !== candidate && other.contains(candidate)),
    );
    const assistants = turns.flatMap((turn, turnIndex) => {
      const roleNode = turn.matches("[data-message-author-role]")
        ? turn
        : turn.querySelector("[data-message-author-role]");
      const role = roleNode?.getAttribute("data-message-author-role") || turn.getAttribute("data-message-author-role");
      if (role !== "assistant") return [];
      return [{ turn, turnIndex }];
    });
    const selected = requestedScope === "last-assistant" ? assistants.slice(-1) : assistants;
    return selected.flatMap(({ turn, turnIndex }, selectedTurnIndex) => {
      const turnId = turn.getAttribute("data-message-id") ||
        turn.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
        turn.getAttribute("data-testid") || turn.id || null;
      const controls = Array.from(turn.querySelectorAll(selector));
      const serialized = controls.flatMap((control, linkIndex) => {
        const anchors = [
          ...(control.matches("a[href], a[download]") ? [control] : []),
          ...Array.from(control.querySelectorAll("a[href], a[download]")),
        ];
        const values = [
          ...Array.from(control.attributes || []).map((attribute) => attribute.value),
          ...anchors.flatMap((anchor) => [
            anchor.getAttribute("href") || "",
            anchor.href || "",
            anchor.getAttribute("download") || "",
            ...Array.from(anchor.attributes || []).map((attribute) => attribute.value),
          ]),
        ].map((value) => String(value || "").trim()).filter(Boolean);
        const rawHref = values.find((value) =>
          value.startsWith("sandbox:/mnt/data/") ||
          value.includes("/backend-api/sandbox/download") ||
          /\/backend-api\/files\/[^/]+\/(?:download|content)/iu.test(value) ||
          value.includes("/backend-api/estuary/content"),
        );
        const labels = [
          control.textContent,
          control.getAttribute("aria-label"),
          control.getAttribute("title"),
          ...anchors.flatMap((anchor) => [anchor.textContent, anchor.getAttribute("aria-label"), anchor.getAttribute("title")]),
        ].map(normalize).filter(Boolean).sort((left, right) => left.length - right.length);
        const label = labels[0] || "";
        const tagName = String(control.tagName || "").toLowerCase();
        const role = String(control.getAttribute("role") || "").toLowerCase();
        const downloadSignal = [label, control.getAttribute("aria-label"), control.getAttribute("title"), control.getAttribute("data-testid")]
          .map(normalize)
          .join(" ")
          .toLowerCase();
        const behaviorDownload = !rawHref && (tagName === "button" || role === "button") && downloadSignal.includes("download");
        if (!rawHref && !behaviorDownload) return [];
        return [{
          label,
          rawHref: rawHref || "",
          behaviorDownload,
          downloadName: anchors.map((anchor) => anchor.getAttribute("download") || "").find(Boolean) || "",
          assistantTurnId: turnId,
          assistantTurnIndex: turnIndex,
          selectedTurnIndex,
          linkIndex,
        }];
      });
      const bySource = new Map();
      for (const item of serialized) {
        const key = item.rawHref || `browser-download:${item.linkIndex}:${item.label}`;
        const current = bySource.get(key);
        if (!current || item.label.length < current.label.length) bySource.set(key, item);
      }
      return Array.from(bySource.values());
    });
  }, scope, CONTROL_SELECTOR);

  const candidates = [];
  for (const item of raw) {
    const source = item.behaviorDownload
      ? { downloadUrl: null, sourceKind: "browser-download", sourceFilename: item.label }
      : normalizeChatGptDownloadSource(item.rawHref);
    if (!source) continue;
    const label = normalizeLabel(item.label || item.downloadName || source.sourceFilename);
    const filename = sanitizeFilename(item.downloadName || source.sourceFilename || label);
    const linkId = createHash("sha256")
      .update(`${item.assistantTurnId || ""}\0${item.linkIndex}\0${item.rawHref || item.label}`)
      .digest("hex")
      .slice(0, 20);
    candidates.push({ ...item, label, filename, source, linkId });
  }
  return candidates;
}

async function browserControlFor(page, candidate) {
  const handle = await page.evaluateHandle((turnIndex, controlIndex, selector) => {
    const turnCandidates = Array.from(document.querySelectorAll([
      'main [data-testid^="conversation-turn-"]',
      "main article",
      'main [data-message-author-role]',
    ].join(",")));
    const turns = turnCandidates.filter((item) =>
      !turnCandidates.some((other) => other !== item && other.contains(item)),
    );
    const turn = turns[turnIndex];
    return turn?.querySelectorAll(selector)?.[controlIndex] || null;
  }, candidate.assistantTurnIndex, candidate.linkIndex, CONTROL_SELECTOR);
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    throw codedError("DOWNLOAD_CONTROL_CHANGED", "The exact download control changed before it could be clicked. No download was attempted.");
  }
  const observed = await element.evaluate((control) => {
    const normalize = (value) => String(value || "").replace(/\s+/gu, " ").trim();
    const labels = [control.textContent, control.getAttribute("aria-label"), control.getAttribute("title")]
      .map(normalize)
      .filter(Boolean)
      .sort((left, right) => left.length - right.length);
    return {
      label: labels[0] || "",
      tagName: String(control.tagName || "").toLowerCase(),
      role: String(control.getAttribute("role") || "").toLowerCase(),
    };
  });
  if (
    normalizedMatch(observed.label) !== normalizedMatch(candidate.label) ||
    (observed.tagName !== "button" && observed.role !== "button")
  ) {
    await element.dispose();
    throw codedError("DOWNLOAD_CONTROL_CHANGED", "The exact download control changed before it could be clicked. No download was attempted.");
  }
  return element;
}

async function stagingSnapshot(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const snapshot = new Map();
  for (const name of await readdir(directory)) {
    const info = await stat(path.join(directory, name)).catch(() => null);
    if (info?.isFile()) snapshot.set(name, `${info.size}:${info.mtimeMs}`);
  }
  return snapshot;
}

async function waitForBrowserDownload(directory, before, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let stable = null;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const changed = [];
    for (const name of await readdir(directory)) {
      if (/\.(?:part|crdownload)$/iu.test(name)) continue;
      const filePath = path.join(directory, name);
      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile()) continue;
      if (before.get(name) !== `${info.size}:${info.mtimeMs}`) changed.push({ filePath, name, size: info.size, mtimeMs: info.mtimeMs });
    }
    if (changed.length > 1) {
      throw codedError("DOWNLOAD_RESULT_AMBIGUOUS", "The browser produced more than one file for the exact download control. The files were left in private staging for manual inspection.");
    }
    if (changed.length === 1) {
      const key = `${changed[0].name}:${changed[0].size}:${changed[0].mtimeMs}`;
      if (key === stable) stableCount += 1;
      else { stable = key; stableCount = 1; }
      if (changed[0].size > 0 && stableCount >= 3) return changed[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw codedError("DOWNLOAD_TIMEOUT", `The exact download control was clicked once, but Firefox did not finish one file within ${timeoutMs / 1_000} seconds. It was not clicked again.`);
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  const prefix = [];
  let prefixBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    if (prefixBytes < 8) {
      const slice = chunk.subarray(0, 8 - prefixBytes);
      prefix.push(slice);
      prefixBytes += slice.length;
    }
  }
  return { sha256: hash.digest("hex"), prefix: Buffer.concat(prefix) };
}

async function downloadWithBrowserControl(page, selected, { maxBytes, rootDirectory, stagingDirectory }) {
  const staging = stagingDirectory;
  const before = await stagingSnapshot(staging);
  const element = await browserControlFor(page, selected);
  try {
    await element.click();
  } finally {
    await element.dispose();
  }
  const downloaded = await waitForBrowserDownload(staging, before);
  if (downloaded.size > maxBytes) {
    throw codedError("DOWNLOAD_TOO_LARGE", `The browser-downloaded ChatGPT file is larger than the ${maxBytes}-byte limit. It was left in private staging for manual inspection.`);
  }
  const filename = sanitizeFilename(downloaded.name, selected.filename);
  const downloadId = randomUUID();
  const directory = path.join(path.resolve(rootDirectory), downloadId);
  const target = path.join(directory, filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const digest = await hashFile(downloaded.filePath);
  assertArtifactSignature(filename, digest.prefix);
  await rename(downloaded.filePath, target);
  await chmod(target, 0o600);
  return {
    downloadId,
    path: target,
    filename,
    sizeBytes: downloaded.size,
    sha256: digest.sha256,
    mimeType: "application/octet-stream",
    linkText: selected.label,
    linkId: selected.linkId,
    sourceKind: selected.source.sourceKind,
    assistantTurnId: selected.assistantTurnId,
  };
}

export function selectAssistantDownloadCandidate(candidates, linkText) {
  const expected = normalizedMatch(linkText);
  if (!expected) throw codedError("LINK_TEXT_REQUIRED", "An exact non-empty download link text is required.");
  const matches = candidates.filter((candidate) => normalizedMatch(candidate.label) === expected);
  if (matches.length === 1) return matches[0];
  const details = { candidates: candidates.map(publicCandidate) };
  if (matches.length > 1) {
    throw codedError("DOWNLOAD_LINK_AMBIGUOUS", "More than one downloadable link has that exact text. Use a narrower conversation or message scope.", { details });
  }
  throw codedError("DOWNLOAD_LINK_NOT_FOUND", `No downloadable link has the exact text ${JSON.stringify(normalizeLabel(linkText))}.`, { details });
}

async function cookieHeaderFor(page, downloadUrl) {
  const cookies = await page.cookies(downloadUrl);
  return cookies
    .filter((cookie) => cookie.name && typeof cookie.value === "string")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function fetchDownload(page, initialUrl, fetchImpl) {
  let current = new URL(initialUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const headers = { "user-agent": "Mozilla/5.0" };
    if (isAllowedChatGptHost(current.hostname) && isKnownChatGptDownloadUrl(current)) {
      const cookieHeader = await cookieHeaderFor(page, current.href);
      if (!cookieHeader) throw codedError("DOWNLOAD_AUTH_REQUIRED", "The authenticated Firefox page did not expose ChatGPT cookies for this file endpoint.");
      headers.cookie = cookieHeader;
    }
    const response = await fetchImpl(current, { headers, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw codedError("DOWNLOAD_REDIRECT_INVALID", "The ChatGPT file endpoint returned a redirect without a destination.");
      const next = new URL(location, current);
      if (next.protocol !== "https:") throw codedError("DOWNLOAD_REDIRECT_INVALID", "The ChatGPT file endpoint redirected to a non-HTTPS destination.");
      current = next;
      continue;
    }
    if (!response.ok) {
      throw codedError("DOWNLOAD_FAILED", `The ChatGPT file endpoint returned HTTP ${response.status}.`);
    }
    return response;
  }
  throw codedError("DOWNLOAD_REDIRECT_INVALID", `The ChatGPT file endpoint exceeded ${MAX_REDIRECTS} redirects.`);
}

function assertArtifactSignature(filename, prefix) {
  if (path.extname(filename).toLowerCase() !== ".zip") return;
  const signature = prefix.subarray(0, 4).toString("hex");
  if (!new Set(["504b0304", "504b0506", "504b0708"]).has(signature)) {
    throw codedError("DOWNLOAD_CONTENT_INVALID", "The downloaded .zip file did not have a valid ZIP signature.");
  }
}

export async function downloadAssistantArtifact(
  page,
  { linkText, scope = "last-assistant", maxBytes = DEFAULT_DOWNLOAD_MAX_BYTES, rootDirectory = downloadsDirectory(), stagingDirectory = browserDownloadStagingDirectory(), fetchImpl = fetch } = {},
) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > ABSOLUTE_DOWNLOAD_MAX_BYTES) {
    throw codedError("INVALID_DOWNLOAD_LIMIT", `maxBytes must be an integer from 1 to ${ABSOLUTE_DOWNLOAD_MAX_BYTES}.`);
  }
  const candidates = await listAssistantDownloadCandidates(page, { scope });
  const selected = selectAssistantDownloadCandidate(candidates, linkText);
  if (selected.source.sourceKind === "browser-download") {
    return { ...(await downloadWithBrowserControl(page, selected, { maxBytes, rootDirectory, stagingDirectory })), scope };
  }
  const response = await fetchDownload(page, selected.source.downloadUrl, fetchImpl);
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  if (/text\/html/iu.test(contentType)) {
    throw codedError("DOWNLOAD_CONTENT_INVALID", "The ChatGPT file endpoint returned an HTML page instead of a file.");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw codedError("DOWNLOAD_TOO_LARGE", `The ChatGPT file is larger than the ${maxBytes}-byte limit.`);
  }
  const dispositionName = filenameFromContentDisposition(response.headers.get("content-disposition"));
  let filename = sanitizeFilename(dispositionName || selected.filename);
  if (!path.extname(filename)) filename += extensionForMimeType(contentType);
  const downloadId = randomUUID();
  const directory = path.join(path.resolve(rootDirectory), downloadId);
  const target = path.join(directory, filename);
  const temporary = path.join(directory, `.${filename}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const handle = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  const prefixChunks = [];
  let prefixBytes = 0;
  let sizeBytes = 0;
  try {
    if (!response.body) throw codedError("DOWNLOAD_FAILED", "The ChatGPT file endpoint returned no response body.");
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) throw codedError("DOWNLOAD_TOO_LARGE", `The ChatGPT file exceeded the ${maxBytes}-byte limit while downloading.`);
      if (prefixBytes < 8) {
        const slice = chunk.subarray(0, 8 - prefixBytes);
        prefixChunks.push(slice);
        prefixBytes += slice.length;
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
    if (sizeBytes === 0) throw codedError("DOWNLOAD_CONTENT_INVALID", "The ChatGPT file endpoint returned an empty file.");
    assertArtifactSignature(filename, Buffer.concat(prefixChunks));
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporary, target);
  await chmod(target, 0o600);
  return {
    downloadId,
    path: target,
    filename,
    sizeBytes,
    sha256: hash.digest("hex"),
    mimeType: contentType,
    linkText: selected.label,
    linkId: selected.linkId,
    sourceKind: selected.source.sourceKind,
    assistantTurnId: selected.assistantTurnId,
    scope,
  };
}

export function publicDownloadCandidates(candidates) {
  return candidates.map(publicCandidate);
}
