import { access, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { prepareZipAttachments, verifyPreparedZipAttachments } from "./archives.mjs";
import { browserDoctor as doctor, setupBrowserLogin as setupLogin } from "./browser-backends.mjs";
import { bundleContext } from "./bundle.mjs";
import { browserProfileDirectory, profileDirectory } from "./config.mjs";
import { codedError, structuredError } from "./errors.mjs";
import {
  attachmentManifestKey,
  assistantSnapshot,
  findChats,
  insertComposerText,
  inspectComposerState,
  launchFirefox,
  listProjects,
  normalizeConversationTitle,
  normalizeConversationUrl,
  normalizeProjectTitle,
  openChatGpt,
  openExistingConversation,
  openProject,
  probeLogin,
  projectUrlFromConversationUrl,
  semanticTextHash,
  submitComposer,
  uploadAttachmentFiles,
  waitForAssistantAfterTurn,
  waitForComposer,
  waitForUserMessage,
} from "./firefox.mjs";
import {
  discoverFirefoxProfiles,
  importChatGptCookies,
  isFirefoxProfileActive,
  readChatGptCookies,
  resolveFirefoxProfile,
} from "./profiles.mjs";
import { createSession, writeSessionFile } from "./sessions.mjs";
import { ensureModelRequirement, verifyModelRequirement } from "./model.mjs";
import { parseLocalDataRequest, withLocalDataProtocol } from "./evidence.mjs";

export { doctor, setupLogin };

export function triggerFailpoint(name) {
  if (process.env.ORACLE_FIREFOX_FAILPOINT !== name) return;
  if (process.env.ORACLE_FIREFOX_FAILPOINT_MODE === "throw") {
    throw codedError("TEST_FAILPOINT", `Triggered Oracle Firefox failpoint: ${name}`);
  }
  process.kill(process.pid, "SIGKILL");
}

async function ensureDedicatedProfileInitialized() {
  const cookiesPath = path.join(profileDirectory(), "cookies.sqlite");
  try {
    await access(cookiesPath);
    return;
  } catch {
    // A brief headless launch creates Firefox's profile databases.
  }
  const browser = await launchFirefox({ headless: true });
  await browser.close().catch(() => undefined);
  try {
    await access(cookiesPath);
  } catch {
    throw codedError("PROFILE_INITIALIZATION_FAILED", `Firefox did not initialize ${cookiesPath}.`);
  }
}

export async function listFirefoxProfiles() {
  return discoverFirefoxProfiles();
}

export async function importFirefoxSession({ sourceProfile, confirmImport = false } = {}) {
  if (confirmImport !== true) {
    throw codedError(
      "IMPORT_CONFIRMATION_REQUIRED",
      "Session import requires explicit confirmation before copying ChatGPT/OpenAI cookies.",
    );
  }
  const destination = profileDirectory();
  if (await isFirefoxProfileActive(destination)) {
    throw codedError("PROFILE_ACTIVE", `Close the dedicated Oracle Firefox window using ${destination}, then retry.`);
  }
  await ensureDedicatedProfileInitialized();
  const source = await resolveFirefoxProfile(sourceProfile);
  if (source.chatGptCookieCount === 0) {
    throw codedError("NO_CHATGPT_COOKIES", `Firefox profile ${source.name} has no ChatGPT/OpenAI cookies.`);
  }
  const imported = await importChatGptCookies({
    sourceProfileDir: source.path,
    destinationProfileDir: destination,
  });
  return {
    imported: imported.importedCookieCount > 0,
    importedCookieCount: imported.importedCookieCount,
    domains: imported.domains,
    sourceProfile: { name: source.name, path: source.path },
    destinationProfile: destination,
  };
}

export async function importSessionIntoManagedBrowser({
  browser,
  browserName,
  sourceProfile,
  confirmImport = false,
} = {}) {
  if (confirmImport !== true) {
    throw codedError(
      "IMPORT_CONFIRMATION_REQUIRED",
      "Session import requires explicit confirmation before reading ChatGPT/OpenAI cookies from Firefox.",
    );
  }
  if (!new Set(["chrome", "safari"]).has(browserName)) {
    throw codedError("IMPORT_UNSUPPORTED_FOR_BROWSER", `Managed cookie injection is not supported for ${browserName}.`);
  }
  const source = await resolveFirefoxProfile(sourceProfile);
  if (source.chatGptCookieCount === 0) {
    throw codedError("NO_CHATGPT_COOKIES", `Firefox profile ${source.name} has no ChatGPT/OpenAI cookies.`);
  }
  const cookies = await readChatGptCookies({ sourceProfileDir: source.path });
  if (!cookies.length) throw codedError("NO_CHATGPT_COOKIES", "The selected Firefox profile yielded no importable ChatGPT/OpenAI cookies.");
  const page = await openChatGpt(browser);
  const targets = [
    { url: "https://chatgpt.com/", suffix: "chatgpt.com" },
    { url: "https://openai.com/", suffix: "openai.com" },
  ];
  let importedCookieCount = 0;
  let rejectedCookieCount = 0;
  for (const target of targets) {
    const selected = cookies.filter((cookie) => {
      const domain = cookie.domain.replace(/^\./u, "").toLowerCase();
      return domain === target.suffix || domain.endsWith(`.${target.suffix}`);
    });
    if (!selected.length) continue;
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    for (const cookie of selected) {
      try {
        await page.setCookie(cookie);
        importedCookieCount += 1;
      } catch {
        rejectedCookieCount += 1;
      }
    }
  }
  if (importedCookieCount === 0) {
    throw codedError("COOKIE_IMPORT_FAILED", `${browserName} rejected every ChatGPT/OpenAI cookie. No session was imported.`);
  }
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  const login = await probeLogin(page);
  if (!login.authenticated) {
    throw codedError(
      "IMPORTED_SESSION_NOT_AUTHENTICATED",
      `${browserName} accepted ${importedCookieCount} cookies, but ChatGPT did not confirm an authenticated session. No message was sent.`,
      { details: { importedCookieCount, rejectedCookieCount } },
    );
  }
  return {
    imported: true,
    authenticated: true,
    browser: browserName,
    importedCookieCount,
    rejectedCookieCount,
    domains: ["chatgpt.com", "openai.com"],
    sourceProfile: { name: source.name, path: source.path },
    destinationProfile: browserName === "chrome" ? browserProfileDirectory("chrome") : null,
    authenticationPersistence: browserName === "safari" ? "automation-session-only" : "profile",
  };
}

function resolveDelivery(requested, bundle) {
  if (requested === "inline" || requested === "attachment") return requested;
  return bundle.included.length > 0 && bundle.characterCount > 25_000 ? "attachment" : "inline";
}

function cleanAssistantText(text) {
  return String(text ?? "").replace(/^ChatGPT said:\s*/iu, "").trim();
}

function publicZipAttachments(request) {
  return (request?.zipAttachments ?? []).map(({ filename, sizeBytes, sha256, entryCount, uncompressedBytes }) => ({
    filename,
    sizeBytes,
    sha256,
    entryCount,
    uncompressedBytes,
  }));
}

function assertProjectSelector(projectTitle, projectUrl) {
  if (normalizeProjectTitle(projectTitle) && projectUrl) {
    throw codedError("INVALID_TARGET", "Provide either projectTitle or projectUrl, not both.");
  }
}

function assertTimeouts({ responseTimeoutSeconds, attachmentTimeoutSeconds }) {
  if (!Number.isInteger(responseTimeoutSeconds) || responseTimeoutSeconds < 30 || responseTimeoutSeconds > 86_400) {
    throw codedError("INVALID_TIMEOUT", "responseTimeoutSeconds must be an integer from 30 to 86400.");
  }
  if (!Number.isInteger(attachmentTimeoutSeconds) || attachmentTimeoutSeconds < 30 || attachmentTimeoutSeconds > 1_800) {
    throw codedError("INVALID_TIMEOUT", "attachmentTimeoutSeconds must be an integer from 30 to 1800.");
  }
}

async function requireAuthenticatedPage(page) {
  const login = await probeLogin(page);
  if (!login.authenticated) {
    throw codedError(
      "NOT_AUTHENTICATED",
      "The dedicated Firefox profile is not signed into ChatGPT. Import or set up the session, then retry.",
      { safeToRetry: true },
    );
  }
  return page;
}

export function conversationKeyFor(operation, request) {
  if (request.conversationUrl) return normalizeConversationUrl(request.conversationUrl);
  if (operation === "continue_chat") {
    const title = normalizeConversationTitle(request.chatTitle).toLowerCase();
    const project = request.projectUrl || normalizeProjectTitle(request.projectTitle).toLowerCase() || "standalone";
    return `title:${project}:${title}`;
  }
  if (request.projectUrl) return `new-project:${request.projectUrl}`;
  if (normalizeProjectTitle(request.projectTitle)) return `new-project-title:${normalizeProjectTitle(request.projectTitle).toLowerCase()}`;
  return "new-standalone";
}

export async function prepareJobRequest(operation, input) {
  assertProjectSelector(input.projectTitle, input.projectUrl);
  const responseTimeoutSeconds = input.responseTimeoutSeconds ?? 10_800;
  const attachmentTimeoutSeconds = input.attachmentTimeoutSeconds ?? 600;
  assertTimeouts({ responseTimeoutSeconds, attachmentTimeoutSeconds });
  const modelRequirement = input.modelRequirement ?? "pro";
  if (!new Set(["pro", "current"]).has(modelRequirement)) {
    throw codedError("INVALID_MODEL_REQUIREMENT", 'modelRequirement must be "pro" or "current".');
  }
  const maxAutomaticEvidenceReplies = input.maxAutomaticEvidenceReplies ?? 3;
  if (!Number.isInteger(maxAutomaticEvidenceReplies) || maxAutomaticEvidenceReplies < 0 || maxAutomaticEvidenceReplies > 3) {
    throw codedError("INVALID_EVIDENCE_LIMIT", "maxAutomaticEvidenceReplies must be an integer from 0 to 3.");
  }
  const responseFailurePolicy = input.responseFailurePolicy ?? "report";
  if (!new Set(["report", "retry-once"]).has(responseFailurePolicy)) {
    throw codedError("INVALID_RESPONSE_FAILURE_POLICY", 'responseFailurePolicy must be "report" or "retry-once".');
  }
  const completionMode = input.completionMode ?? "manual";
  if (!new Set(["manual", "notify", "harness"]).has(completionMode)) {
    throw codedError("INVALID_COMPLETION_MODE", 'completionMode must be "manual", "notify", or "harness".');
  }
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) throw codedError("PROMPT_REQUIRED", "A non-empty prompt is required.");
  if (operation === "continue_chat" && !String(input.chatTitle ?? "").trim() && !String(input.conversationUrl ?? "").trim()) {
    throw codedError("TARGET_REQUIRED", "Provide an exact chatTitle or conversationUrl.");
  }
  if (input.conversationUrl && (normalizeProjectTitle(input.projectTitle) || input.projectUrl)) {
    throw codedError("INVALID_TARGET", "A conversationUrl already identifies its project; do not add a project selector.");
  }

  const session = await createSession();
  let context;
  let selectedDelivery = "inline";
  if (operation === "consult") {
    context = await bundleContext({
      prompt: withLocalDataProtocol(prompt),
      files: input.files ?? [],
      cwd: input.cwd,
    });
    selectedDelivery = resolveDelivery(input.delivery ?? "auto", context);
  } else {
    const finalPrompt = input.evidenceReply ? prompt : withLocalDataProtocol(prompt);
    context = {
      bundle: finalPrompt,
      cwd: input.cwd ? path.resolve(input.cwd) : process.cwd(),
      included: [],
      skippedBinary: [],
      characterCount: finalPrompt.length,
    };
  }
  const zipAttachments = await prepareZipAttachments({
    zipFiles: input.zipFiles ?? [],
    cwd: input.cwd,
    session,
  });
  const requestPath = await writeSessionFile(session, "request.md", `${context.bundle}\n`);
  const prepared = {
    operation,
    browser: input.browserBackend || "firefox",
    prompt,
    requestPath,
    delivery: selectedDelivery,
    projectTitle: normalizeProjectTitle(input.resolvedProjectTitle ?? input.projectTitle) || null,
    projectUrl: input.resolvedProjectUrl ?? input.projectUrl ?? null,
    chatTitle: normalizeConversationTitle(input.resolvedChatTitle ?? input.chatTitle) || null,
    conversationUrl: input.conversationUrl ? normalizeConversationUrl(input.conversationUrl) : null,
    responseTimeoutSeconds,
    attachmentTimeoutSeconds,
    modelRequirement,
    maxAutomaticEvidenceReplies,
    responseFailurePolicy,
    maxAutomaticResponseRetries: responseFailurePolicy === "retry-once" ? 1 : 0,
    completionMode,
    includedFiles: context.included.map((entry) => entry.displayPath),
    skippedBinaryFiles: context.skippedBinary,
    zipAttachments,
    bundleCharacters: context.characterCount,
    sessionId: session.id,
    sessionPath: session.directory,
    evidenceReply: Boolean(input.evidenceReply),
    parentJobId: input.parentJobId ?? null,
    rootJobId: input.rootJobId ?? null,
    retryAttempt: input.retryAttempt ?? 0,
    evidenceRound: input.evidenceRound ?? 0,
  };
  await writeSessionFile(session, "request.json", `${JSON.stringify(prepared, null, 2)}\n`);
  return prepared;
}

export async function discoverProjects(browserManager, { query = "", headless = false } = {}) {
  const lease = await browserManager.leasePage(`discovery-projects-${randomUUID()}`, { discovery: true, headless });
  try {
    await requireAuthenticatedPage(lease.page);
    const normalizedQuery = normalizeProjectTitle(query);
    return { query: normalizedQuery || null, projects: await listProjects(lease.page, normalizedQuery) };
  } finally {
    await browserManager.releasePage(lease.jobId);
  }
}

export async function resolveProjectTarget(browserManager, { projectTitle, projectUrl, headless = false } = {}) {
  assertProjectSelector(projectTitle, projectUrl);
  const lease = await browserManager.leasePage(`resolve-project-${randomUUID()}`, { discovery: true, headless });
  try {
    await requireAuthenticatedPage(lease.page);
    return await openProject(lease.page, { title: projectTitle, projectUrl });
  } catch (error) {
    if (/More than one ChatGPT project/iu.test(error.message)) {
      throw codedError("TARGET_AMBIGUOUS", error.message, { safeToRetry: true });
    }
    if (/No ChatGPT project/iu.test(error.message)) {
      throw codedError("TARGET_NOT_FOUND", error.message, { safeToRetry: true });
    }
    throw error;
  } finally {
    await browserManager.releasePage(lease.jobId);
  }
}

export async function discoverChats(browserManager, { query, projectTitle, projectUrl, timeoutSeconds = 15, headless = false } = {}) {
  const normalizedQuery = normalizeConversationTitle(query);
  if (!normalizedQuery) throw codedError("QUERY_REQUIRED", "A non-empty chat search query is required.");
  assertProjectSelector(projectTitle, projectUrl);
  const lease = await browserManager.leasePage(`discovery-chats-${randomUUID()}`, { discovery: true, headless });
  try {
    await requireAuthenticatedPage(lease.page);
    const result = await findChats(lease.page, normalizedQuery, {
      projectTitle,
      projectUrl,
      timeoutMs: timeoutSeconds * 1_000,
    });
    return {
      query: result.query,
      projectTitle: result.project?.title || null,
      projectUrl: result.project?.url || null,
      chats: result.conversations.map((conversation) => ({
        chatTitle: conversation.title,
        conversationUrl: conversation.url,
        projectUrl: conversation.projectUrl,
      })),
    };
  } finally {
    await browserManager.releasePage(lease.jobId);
  }
}

export async function writeFinalMetadata(job, result) {
  await writeSessionFile(
    { id: path.basename(job.sessionPath), directory: job.sessionPath },
    "metadata.json",
    `${JSON.stringify(result, null, 2)}\n`,
  );
}

function transitionExecution(store, executionClaim, jobId, state, patch = {}, details = null) {
  return executionClaim
    ? store.transitionClaimed(executionClaim, state, patch, details)
    : store.transition(jobId, state, patch, details);
}

async function monitorSubmittedJob({ job, page, store, executionClaim }) {
  if (!job.conversationUrl || (!job.userTurnId && !job.userTurnHash)) {
    throw codedError("SUBMISSION_UNCERTAIN", "A submitted job lacks enough durable evidence for monitor-only recovery.", {
      submissionMayHaveOccurred: true,
      recoveryAction: `reconcile_job ${job.id}`,
    });
  }
  await openExistingConversation(page, { conversationUrl: job.conversationUrl, title: job.chatTitle });
  transitionExecution(store, executionClaim, job.id, "awaiting_response", { recoveryAction: "monitoring proven submitted turn" });
  const response = await waitForAssistantAfterTurn(
    page,
    { id: job.userTurnId, hash: job.userTurnHash },
    { timeoutMs: job.request.responseTimeoutSeconds * 1_000 },
  );
  return finalizeResponse({ job: store.requireJob(job.id), response, store, executionClaim });
}

async function finalizeResponse({ job, response, store, executionClaim }) {
  const answer = cleanAssistantText(response.text);
  const responsePath = await writeSessionFile({ id: path.basename(job.sessionPath), directory: job.sessionPath }, "response.md", `${answer}\n`);
  triggerFailpoint("after_response_persistence");
  if (response.responseFailure) {
    const failure = response.responseFailure;
    const error = {
      code: failure.code,
      message: failure.message,
      jobState: "response_failed_detected",
      safeToRetry: Boolean(failure.retryable),
      submissionMayHaveOccurred: true,
      recoveryAction: failure.retryable
        ? (job.request.responseFailurePolicy === "retry-once" ? "schedule one authorized recovery continuation" : "report the failed response")
        : "inspect the reported ChatGPT failure before starting another job",
      details: { assistantTurnId: failure.assistantTurnId, classifierVersion: failure.classifierVersion },
    };
    transitionExecution(store, executionClaim, job.id, "response_failed_detected", {
      assistantDisposition: "response_failed",
      responseDisposition: failure.disposition,
      responseFailure: failure,
      error,
      recoveryAction: error.recoveryAction,
    });
    return {
      jobId: job.id,
      rootJobId: job.rootJobId,
      authorizationId: job.authorizationId,
      state: "response_failed_detected",
      status: "response_failed_detected",
      mode: job.operation === "consult" ? "new-chat" : "continue-chat",
      projectTitle: job.projectTitle,
      projectUrl: job.projectUrl,
      chatTitle: job.chatTitle,
      conversationUrl: job.conversationUrl,
      modelEvidence: job.modelEvidence,
      zipAttachments: publicZipAttachments(job.request),
      assistantDisposition: "response_failed",
      responseDisposition: failure.disposition,
      responseFailure: failure,
      responsePath,
      sessionPath: job.sessionPath,
      safeToRetry: Boolean(failure.retryable),
      submissionMayHaveOccurred: true,
      submissionCount: job.retryAttempt + 1,
      recoveryAction: error.recoveryAction,
      error,
    };
  }
  const localDataRequest = parseLocalDataRequest(answer);
  const disposition = localDataRequest ? "local_data_request" : "final";
  transitionExecution(store, executionClaim, job.id, "response_confirmed", {
    assistantDisposition: disposition,
    responseDisposition: "completed",
    localDataRequest,
  });
  const completedAt = new Date().toISOString();
  const result = {
    jobId: job.id,
    rootJobId: job.rootJobId,
    authorizationId: job.authorizationId,
    state: "completed",
    status: "completed",
    mode: job.operation === "consult" ? "new-chat" : "continue-chat",
    browser: job.request.browser || "firefox",
    projectTitle: job.projectTitle,
    projectUrl: job.projectUrl,
    chatTitle: job.chatTitle,
    conversationUrl: job.conversationUrl,
    modelEvidence: job.modelEvidence,
    zipAttachments: publicZipAttachments(job.request),
    assistantDisposition: disposition,
    responseDisposition: "completed",
    localDataRequest,
    evidenceRound: job.evidenceRound,
    maxAutomaticEvidenceReplies: job.maxAutomaticEvidenceReplies,
    answer,
    responsePath,
    sessionPath: job.sessionPath,
    completedAt,
    safeToRetry: false,
    submissionMayHaveOccurred: true,
    submissionCount: job.retryAttempt + 1,
    recoveryAction: localDataRequest ? "perform approved read-only checks, then call reply_with_local_data" : null,
  };
  transitionExecution(store, executionClaim, job.id, "completed", { result, recoveryAction: result.recoveryAction });
  await writeFinalMetadata(store.requireJob(job.id), result);
  return result;
}

export async function executeJob({ jobId, store, browserManager, beforeSubmit, executionClaim }) {
  let job = store.requireJob(jobId);
  if (executionClaim) store.assertExecution(executionClaim);
  const lease = await browserManager.leasePage(job.id);
  try {
    if (executionClaim) store.assertExecution(executionClaim);
    transitionExecution(store, executionClaim, job.id, "page_leased");
    job = store.requireJob(job.id);
    await requireAuthenticatedPage(lease.page);
    if (job.submitIntentAt && (job.userTurnId || job.userTurnHash)) {
      return await monitorSubmittedJob({ job, page: lease.page, store, executionClaim });
    }

    let target = null;
    let project = null;
    if (job.operation === "continue_chat") {
      target = await openExistingConversation(lease.page, {
        title: job.request.chatTitle,
        conversationUrl: job.request.conversationUrl,
        projectTitle: job.request.conversationUrl ? undefined : job.request.projectTitle,
        projectUrl: job.request.conversationUrl ? undefined : job.request.projectUrl,
      });
      transitionExecution(store, executionClaim, job.id, "target_verified", {
        conversationKey: target.url,
        conversationUrl: target.url,
        projectTitle: target.projectTitle,
        projectUrl: target.projectUrl,
        chatTitle: target.title || job.request.chatTitle,
      });
    } else {
      if (job.request.projectTitle || job.request.projectUrl) {
        project = await openProject(lease.page, {
          title: job.request.projectUrl ? undefined : job.request.projectTitle,
          projectUrl: job.request.projectUrl,
        });
      }
      await waitForComposer(lease.page);
      transitionExecution(store, executionClaim, job.id, "target_verified", {
        projectTitle: project?.title || null,
        projectUrl: project?.url || null,
      });
    }

    const baseline = await assistantSnapshot(lease.page);
    triggerFailpoint("before_insertion");
    const authorized = (await readFile(job.request.requestPath, "utf8")).trimEnd();
    let composerPrompt = authorized;
    const archivePaths = await verifyPreparedZipAttachments(job.request.zipAttachments ?? [], job.sessionPath);
    const attachmentPaths = [...archivePaths];
    if (job.request.delivery === "attachment") {
      const attachmentPath = await writeSessionFile(
        { id: path.basename(job.sessionPath), directory: job.sessionPath },
        "oracle-context.md",
        `${authorized}\n`,
      );
      attachmentPaths.unshift(attachmentPath);
      composerPrompt = [
        "Read the attached oracle-context.md before answering.",
        "Follow the [USER] request and ORACLE LOCAL DATA PROTOCOL in that file.",
        "Return only the substantive answer or the strict local-data request block.",
      ].join("\n");
    }
    const attachmentManifest = attachmentPaths.map((attachmentPath) => path.basename(attachmentPath));
    transitionExecution(store, executionClaim, job.id, "attachment_processing", { attachmentManifest });
    await browserManager.withInputFocus(lease, () => insertComposerText(lease.page, composerPrompt));
    if (attachmentPaths.length > 0) {
      await uploadAttachmentFiles(lease.page, attachmentPaths, {
        timeoutMs: job.request.attachmentTimeoutSeconds * 1_000,
      });
      triggerFailpoint("after_attachment_readiness");
    }
    triggerFailpoint("after_insertion");
    const composerState = await inspectComposerState(lease.page);
    if (semanticTextHash(composerState.text) !== semanticTextHash(composerPrompt)) {
      throw codedError("COMPOSER_MISMATCH", "The final composer content does not exactly match the authorized message.", { safeToRetry: true });
    }
    if (
      composerState.uploading ||
      attachmentManifestKey(composerState.attachments) !== attachmentManifestKey(attachmentManifest)
    ) {
      throw codedError("ATTACHMENT_MISMATCH", "The composer attachment set changed before submission.", { safeToRetry: true });
    }
    transitionExecution(store, executionClaim, job.id, "composer_verified", { attachmentManifest });
    await beforeSubmit?.(job.id, { waitOnly: true });
    await browserManager.withTrustedAction(lease, async () => {
      if (executionClaim) store.assertExecution(executionClaim);
      const selectedModel = await ensureModelRequirement(lease.page, job.request.modelRequirement);
      transitionExecution(store, executionClaim, job.id, "model_verified", { modelEvidence: selectedModel });
      let finalModelEvidence = await verifyModelRequirement(lease.page, job.request.modelRequirement);
      triggerFailpoint("after_model_verification");
      const finalComposer = await inspectComposerState(lease.page);
      if (semanticTextHash(finalComposer.text) !== semanticTextHash(composerPrompt)) {
        throw codedError("COMPOSER_MISMATCH", "The composer changed after model selection; no message was sent.", { safeToRetry: true });
      }
      if (
        finalComposer.uploading ||
        attachmentManifestKey(finalComposer.attachments) !== attachmentManifestKey(attachmentManifest)
      ) {
        throw codedError("ATTACHMENT_MISMATCH", "The attachment set changed after model selection; no message was sent.", { safeToRetry: true });
      }
      const submitPermit = await beforeSubmit?.(job.id, { waitOnly: false });
      if (store.requireJob(job.id).state === "cancelled_pre_submit") {
        throw codedError("JOB_CANCELLED", "The job was cancelled before submission; no message was sent.", { safeToRetry: false });
      }
      if (executionClaim) store.assertExecution(executionClaim);
      const preClickComposer = await inspectComposerState(lease.page);
      if (
        semanticTextHash(preClickComposer.text) !== semanticTextHash(composerPrompt) ||
        preClickComposer.uploading ||
        attachmentManifestKey(preClickComposer.attachments) !== attachmentManifestKey(attachmentManifest)
      ) {
        throw codedError("COMPOSER_MISMATCH", "The exact composer state changed while waiting for the submit permit; no message was sent.", { safeToRetry: true });
      }
      finalModelEvidence = await verifyModelRequirement(lease.page, job.request.modelRequirement);
      (executionClaim ? store.consumeSubmitPermitClaimed.bind(store, executionClaim) : store.consumeSubmitPermit.bind(store, job.id))(
        submitPermit.id,
        { modelEvidence: finalModelEvidence, submittedMessageHash: semanticTextHash(composerPrompt) },
        { authorizedMessageHash: semanticTextHash(composerPrompt), executionEpoch: executionClaim?.executionEpoch ?? null },
      );
      triggerFailpoint("after_submit_intent");
      await submitComposer(lease.page);
      triggerFailpoint("after_click");
    }, { owner: `submit:${job.id}` });
    const confirmed = await waitForUserMessage(lease.page, baseline.userCount, composerPrompt, {
      timeoutMs: 30_000,
      expectedAttachments: attachmentManifest,
      baselineTurnIds: baseline.turns.filter((turn) => turn.role === "user").map((turn) => turn.id),
    });
    const observedUrl = normalizeConversationUrl(confirmed.url);
    const resultingProjectUrl = projectUrlFromConversationUrl(observedUrl);
    if (project?.url && resultingProjectUrl !== project.url) {
      throw codedError("WRONG_PROJECT", "The new conversation was not created inside the requested project.", { submissionMayHaveOccurred: true });
    }
    if (!project && job.operation === "consult" && resultingProjectUrl) {
      throw codedError("WRONG_PROJECT", "A standalone consultation unexpectedly opened inside a project.", { submissionMayHaveOccurred: true });
    }
    if (target?.url && observedUrl !== target.url) {
      throw codedError("WRONG_CONVERSATION", "ChatGPT navigated away from the selected conversation after submission.", { submissionMayHaveOccurred: true });
    }
    transitionExecution(store, executionClaim, job.id, "user_turn_confirmed", {
      conversationKey: observedUrl,
      conversationUrl: observedUrl,
      projectUrl: resultingProjectUrl,
      userTurnId: confirmed.userTurn.id,
      userTurnHash: confirmed.userTurn.hash,
    });
    store.recordSubmissionSuccess();
    triggerFailpoint("after_user_turn_discovery");
    transitionExecution(store, executionClaim, job.id, "awaiting_response");
    job = store.requireJob(job.id);
    const response = await waitForAssistantAfterTurn(
      lease.page,
      { id: job.userTurnId, hash: job.userTurnHash },
      { timeoutMs: job.request.responseTimeoutSeconds * 1_000 },
    );
    triggerFailpoint("after_assistant_completion");
    return await finalizeResponse({ job: store.requireJob(job.id), response, store, executionClaim });
  } catch (error) {
    if (new Set(["STALE_EXECUTION", "BROKER_LEASE_LOST", "BROKER_INSTANCE_REPLACED"]).has(error?.code)) throw error;
    let current = store.requireJob(job.id);
    if (current.submitIntentAt && !current.conversationUrl && error?.details?.conversationUrl) {
      try {
        const observedUrl = normalizeConversationUrl(error.details.conversationUrl);
        current = transitionExecution(store, executionClaim, current.id, current.state, {
          conversationKey: observedUrl,
          conversationUrl: observedUrl,
        }, { recoveredCanonicalUrl: true });
      } catch {
        // Preserve the original uncertainty classification if the URL is not canonical.
      }
    }
    if (current.state === "cancelled_pre_submit") throw error;
    const failed = executionClaim ? store.markFailureClaimed(executionClaim, error) : store.markFailure(job.id, error);
    await writeFinalMetadata(failed, {
      jobId: failed.id,
      authorizationId: failed.authorizationId,
      state: failed.state,
      status: failed.state,
      browser: failed.request?.browser || "firefox",
      error: failed.error || structuredError(error),
      conversationUrl: failed.conversationUrl,
      projectUrl: failed.projectUrl,
      sessionPath: failed.sessionPath,
      safeToRetry: failed.error?.safeToRetry ?? false,
      submissionMayHaveOccurred: failed.submissionMayHaveOccurred,
      recoveryAction: failed.recoveryAction,
    }).catch(() => undefined);
    throw error;
  } finally {
    triggerFailpoint("before_browser_close");
    await browserManager.releasePage(job.id);
  }
}
