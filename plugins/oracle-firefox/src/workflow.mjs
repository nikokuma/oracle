import { access, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { bundleContext } from "./bundle.mjs";
import { profileDirectory } from "./config.mjs";
import { codedError, structuredError } from "./errors.mjs";
import {
  assistantSnapshot,
  doctor,
  findChats,
  insertComposerText,
  inspectComposerState,
  launchFirefox,
  listProjects,
  normalizeConversationTitle,
  normalizeConversationUrl,
  normalizeProjectTitle,
  openExistingConversation,
  openProject,
  probeLogin,
  projectUrlFromConversationUrl,
  semanticTextHash,
  setupLogin,
  submitComposer,
  uploadContextFile,
  waitForAssistantAfterTurn,
  waitForComposer,
  waitForUserMessage,
} from "./firefox.mjs";
import {
  discoverFirefoxProfiles,
  importChatGptCookies,
  isFirefoxProfileActive,
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

function resolveDelivery(requested, bundle) {
  if (requested === "inline" || requested === "attachment") return requested;
  return bundle.included.length > 0 && bundle.characterCount > 25_000 ? "attachment" : "inline";
}

function cleanAssistantText(text) {
  return String(text ?? "").replace(/^ChatGPT said:\s*/iu, "").trim();
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
  const requestPath = await writeSessionFile(session, "request.md", `${context.bundle}\n`);
  const prepared = {
    operation,
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
    includedFiles: context.included.map((entry) => entry.displayPath),
    skippedBinaryFiles: context.skippedBinary,
    bundleCharacters: context.characterCount,
    sessionId: session.id,
    sessionPath: session.directory,
    evidenceReply: Boolean(input.evidenceReply),
    parentJobId: input.parentJobId ?? null,
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

async function writeFinalMetadata(job, result) {
  await writeSessionFile(
    { id: path.basename(job.sessionPath), directory: job.sessionPath },
    "metadata.json",
    `${JSON.stringify(result, null, 2)}\n`,
  );
}

async function monitorSubmittedJob({ job, page, store }) {
  if (!job.conversationUrl || (!job.userTurnId && !job.userTurnHash)) {
    throw codedError("SUBMISSION_UNCERTAIN", "A submitted job lacks enough durable evidence for monitor-only recovery.", {
      submissionMayHaveOccurred: true,
      recoveryAction: `reconcile_job ${job.id}`,
    });
  }
  await openExistingConversation(page, { conversationUrl: job.conversationUrl, title: job.chatTitle });
  store.transition(job.id, "awaiting_response", { recoveryAction: "monitoring proven submitted turn" });
  const response = await waitForAssistantAfterTurn(
    page,
    { id: job.userTurnId, hash: job.userTurnHash },
    { timeoutMs: job.request.responseTimeoutSeconds * 1_000 },
  );
  return finalizeResponse({ job: store.requireJob(job.id), response, store });
}

async function finalizeResponse({ job, response, store }) {
  const answer = cleanAssistantText(response.text);
  const responsePath = await writeSessionFile({ id: path.basename(job.sessionPath), directory: job.sessionPath }, "response.md", `${answer}\n`);
  triggerFailpoint("after_response_persistence");
  const localDataRequest = parseLocalDataRequest(answer);
  const disposition = localDataRequest ? "local_data_request" : "final";
  store.transition(job.id, "response_confirmed", {
    assistantDisposition: disposition,
    localDataRequest,
  });
  const completedAt = new Date().toISOString();
  const result = {
    jobId: job.id,
    authorizationId: job.authorizationId,
    state: "completed",
    status: "completed",
    mode: job.operation === "consult" ? "new-chat" : "continue-chat",
    projectTitle: job.projectTitle,
    projectUrl: job.projectUrl,
    chatTitle: job.chatTitle,
    conversationUrl: job.conversationUrl,
    modelEvidence: job.modelEvidence,
    assistantDisposition: disposition,
    localDataRequest,
    evidenceRound: job.evidenceRound,
    maxAutomaticEvidenceReplies: job.maxAutomaticEvidenceReplies,
    answer,
    responsePath,
    sessionPath: job.sessionPath,
    completedAt,
    safeToRetry: false,
    submissionMayHaveOccurred: true,
    recoveryAction: localDataRequest ? "perform approved read-only checks, then call reply_with_local_data" : null,
  };
  store.transition(job.id, "completed", { result, recoveryAction: result.recoveryAction });
  await writeFinalMetadata(store.requireJob(job.id), result);
  return result;
}

export async function executeJob({ jobId, store, browserManager, beforeSubmit }) {
  let job = store.requireJob(jobId);
  const lease = await browserManager.leasePage(job.id, { headless: Boolean(job.request.headless) });
  try {
    store.transition(job.id, "page_leased");
    job = store.requireJob(job.id);
    await requireAuthenticatedPage(lease.page);
    if (job.submitIntentAt && (job.userTurnId || job.userTurnHash)) {
      return await monitorSubmittedJob({ job, page: lease.page, store });
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
      store.transition(job.id, "target_verified", {
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
      store.transition(job.id, "target_verified", {
        projectTitle: project?.title || null,
        projectUrl: project?.url || null,
      });
    }

    const baseline = await assistantSnapshot(lease.page);
    triggerFailpoint("before_insertion");
    const authorized = (await readFile(job.request.requestPath, "utf8")).trimEnd();
    let composerPrompt = authorized;
    let attachmentManifest = [];
    if (job.request.delivery === "attachment") {
      const attachmentPath = await writeSessionFile(
        { id: path.basename(job.sessionPath), directory: job.sessionPath },
        "oracle-context.md",
        `${authorized}\n`,
      );
      store.transition(job.id, "attachment_processing", { attachmentManifest: [path.basename(attachmentPath)] });
      attachmentManifest = [path.basename(attachmentPath)];
      composerPrompt = [
        "Read the attached oracle-context.md before answering.",
        "Follow the [USER] request and ORACLE LOCAL DATA PROTOCOL in that file.",
        "Return only the substantive answer or the strict local-data request block.",
      ].join("\n");
      await insertComposerText(lease.page, composerPrompt);
      await uploadContextFile(lease.page, attachmentPath, { timeoutMs: job.request.attachmentTimeoutSeconds * 1_000 });
      triggerFailpoint("after_attachment_readiness");
    } else {
      store.transition(job.id, "attachment_processing", { attachmentManifest: [] });
      await insertComposerText(lease.page, composerPrompt);
    }
    triggerFailpoint("after_insertion");
    const composerState = await inspectComposerState(lease.page);
    if (composerState.uploading || composerState.attachments.join("\u0000") !== attachmentManifest.join("\u0000")) {
      throw codedError("ATTACHMENT_MISMATCH", "The composer attachment set changed before submission.", { safeToRetry: true });
    }
    store.transition(job.id, "composer_verified", { attachmentManifest });
    const selectedModel = await ensureModelRequirement(lease.page, job.request.modelRequirement);
    store.transition(job.id, "model_verified", { modelEvidence: selectedModel });
    const finalModelEvidence = await verifyModelRequirement(lease.page, job.request.modelRequirement);
    triggerFailpoint("after_model_verification");
    await beforeSubmit?.(job.id);

    if (store.requireJob(job.id).state === "cancelled_pre_submit") {
      throw codedError("JOB_CANCELLED", "The job was cancelled before submission; no message was sent.", { safeToRetry: false });
    }

    store.transition(
      job.id,
      "submit_intent",
      { modelEvidence: finalModelEvidence, submittedMessageHash: semanticTextHash(composerPrompt) },
      { authorizedMessageHash: semanticTextHash(composerPrompt) },
    );
    triggerFailpoint("after_submit_intent");
    await submitComposer(lease.page);
    triggerFailpoint("after_click");
    const confirmed = await waitForUserMessage(lease.page, baseline.userCount, composerPrompt, {
      timeoutMs: 30_000,
      expectedAttachments: attachmentManifest,
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
    store.transition(job.id, "user_turn_confirmed", {
      conversationKey: observedUrl,
      conversationUrl: observedUrl,
      projectUrl: resultingProjectUrl,
      userTurnId: confirmed.userTurn.id,
      userTurnHash: confirmed.userTurn.hash,
    });
    triggerFailpoint("after_user_turn_discovery");
    store.transition(job.id, "awaiting_response");
    job = store.requireJob(job.id);
    const response = await waitForAssistantAfterTurn(
      lease.page,
      { id: job.userTurnId, hash: job.userTurnHash },
      { timeoutMs: job.request.responseTimeoutSeconds * 1_000 },
    );
    triggerFailpoint("after_assistant_completion");
    return await finalizeResponse({ job: store.requireJob(job.id), response, store });
  } catch (error) {
    const current = store.requireJob(job.id);
    if (current.state === "cancelled_pre_submit") throw error;
    const failed = store.markFailure(job.id, error);
    await writeFinalMetadata(failed, {
      jobId: failed.id,
      authorizationId: failed.authorizationId,
      state: failed.state,
      status: failed.state,
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
