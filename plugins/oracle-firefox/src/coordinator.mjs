import { randomUUID } from "node:crypto";
import { access, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { BrowserManager } from "./browser-manager.mjs";
import { emergencyLockPath } from "./config.mjs";
import { codedError, structuredError } from "./errors.mjs";
import {
  buildLocalDataReply,
  deriveEvidenceAuthorizationId,
  scanEvidenceForSecrets,
} from "./evidence.mjs";
import { attachmentManifestKey, assistantSnapshot, normalizeConversationUrl, openExistingConversation, semanticTextHash } from "./firefox.mjs";
import { requestDigest, StateStore, TERMINAL_JOB_STATES } from "./state-store.mjs";
import {
  conversationKeyFor,
  discoverChats,
  discoverProjects,
  executeJob,
  importFirefoxSession,
  listFirefoxProfiles,
  prepareJobRequest,
  resolveProjectTarget,
  setupLogin,
  doctor,
} from "./workflow.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function publicJob(job) {
  if (!job) return null;
  return {
    jobId: job.id,
    authorizationId: job.authorizationId,
    operation: job.operation,
    state: job.state,
    terminal: TERMINAL_JOB_STATES.has(job.state),
    safeToRetry: job.error?.safeToRetry ?? false,
    submissionMayHaveOccurred: job.submissionMayHaveOccurred,
    modelEvidence: job.modelEvidence,
    projectTitle: job.projectTitle,
    projectUrl: job.projectUrl,
    chatTitle: job.chatTitle,
    conversationUrl: job.conversationUrl,
    assistantDisposition: job.assistantDisposition,
    localDataRequest: job.localDataRequest,
    evidenceRound: job.evidenceRound,
    maxAutomaticEvidenceReplies: job.maxAutomaticEvidenceReplies,
    sessionPath: job.sessionPath,
    error: job.error,
    recoveryAction: job.recoveryAction,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

async function fileExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export class Coordinator {
  constructor({ store = new StateStore(), browserManager = new BrowserManager(), writeConcurrency, jobExecutor = executeJob } = {}) {
    this.store = store;
    this.browserManager = browserManager;
    this.writeConcurrency = Math.max(1, Math.min(2, Number(writeConcurrency ?? process.env.ORACLE_FIREFOX_WRITE_CONCURRENCY ?? 1)));
    this.jobExecutor = jobExecutor;
    this.active = new Map();
    this.lastSubmissionAt = 0;
    this.submitGate = Promise.resolve();
    this.startedAt = new Date().toISOString();
    this.closed = false;
  }

  async open() {
    await this.store.open();
    this.recovery = this.store.recoverInterruptedJobs();
    this.schedule();
    return this;
  }

  async close() {
    this.closed = true;
    await Promise.allSettled(this.active.values());
    await this.browserManager.close();
    this.store.close();
  }

  status() {
    return {
      ready: true,
      protocolVersion: 1,
      buildVersion: "1.0.0",
      pid: process.pid,
      startedAt: this.startedAt,
      activeJobs: Array.from(this.active.keys()),
      queuedJobs: this.store.queuedJobs().length,
      outstandingJobs: this.store.countOutstanding(),
      writeConcurrency: this.writeConcurrency,
      minimumSubmissionIntervalMs: 2_000,
      recovery: this.recovery,
      browser: this.browserManager.status(),
      emergencyLocked: false,
    };
  }

  async statusAsync() {
    return { ...this.status(), emergencyLocked: await fileExists(emergencyLockPath()) };
  }

  async startJob(operation, input, { generatedAuthorization = false } = {}) {
    if (!new Set(["consult", "continue_chat"]).has(operation)) {
      throw codedError("INVALID_OPERATION", `Unsupported job operation: ${operation}`);
    }
    const authorizationId = input.authorizationId || (generatedAuthorization ? randomUUID() : null);
    if (!authorizationId || !UUID_PATTERN.test(authorizationId)) {
      throw codedError("AUTHORIZATION_REQUIRED", "authorizationId must be a UUID for asynchronous start tools.");
    }
    const digest = requestDigest({ operation, ...input, authorizationId: undefined });
    const existing = this.store.getJobByAuthorization(authorizationId);
    if (existing) {
      if (existing.requestDigest !== digest) {
        throw codedError("AUTHORIZATION_REUSED", "This authorizationId was already used for a different request.");
      }
      return { ...publicJob(existing), idempotent: true, authorizationGenerated: generatedAuthorization };
    }
    if (this.store.countOutstanding() >= 100) {
      throw codedError("QUEUE_FULL", "Oracle Firefox has reached its 100-job queue limit.", { safeToRetry: true });
    }
    if (await fileExists(emergencyLockPath())) {
      throw codedError("EMERGENCY_LOCKED", `Oracle Firefox submissions are disabled by ${emergencyLockPath()}.`);
    }
    let resolvedInput = { ...input };
    if (operation === "consult" && input.projectTitle && !input.projectUrl) {
      const project = await resolveProjectTarget(this.browserManager, {
        projectTitle: input.projectTitle,
        headless: input.headless,
      });
      resolvedInput = {
        ...resolvedInput,
        projectTitle: undefined,
        projectUrl: project.url,
        resolvedProjectTitle: project.title || input.projectTitle,
        resolvedProjectUrl: project.url,
      };
    }
    if (operation === "continue_chat" && input.chatTitle && !input.conversationUrl) {
      const discovered = await discoverChats(this.browserManager, {
        query: input.chatTitle,
        projectTitle: input.projectTitle,
        projectUrl: input.projectUrl,
        timeoutSeconds: 15,
        headless: input.headless,
      });
      const expected = input.chatTitle.replace(/\s+/gu, " ").trim().toLowerCase();
      const matches = discovered.chats.filter((chat) => chat.chatTitle.replace(/\s+/gu, " ").trim().toLowerCase() === expected);
      if (matches.length !== 1) {
        throw codedError(
          matches.length > 1 ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND",
          matches.length > 1
            ? `More than one ChatGPT conversation is titled ${JSON.stringify(input.chatTitle)}. Use conversationUrl.`
            : `No ChatGPT conversation was found with the exact title ${JSON.stringify(input.chatTitle)}.`,
          { safeToRetry: true, details: { candidates: matches } },
        );
      }
      const match = matches[0];
      resolvedInput = {
        ...resolvedInput,
        chatTitle: undefined,
        conversationUrl: match.conversationUrl,
        projectTitle: undefined,
        projectUrl: undefined,
        resolvedChatTitle: match.chatTitle,
        resolvedProjectTitle: discovered.projectTitle,
        resolvedProjectUrl: match.projectUrl || discovered.projectUrl,
      };
    }
    const prepared = await prepareJobRequest(operation, resolvedInput);
    const conversationKey = conversationKeyFor(operation, prepared);
    const created = this.store.createJob({
      authorizationId,
      operation,
      request: prepared,
      requestDigest: digest,
      conversationKey,
      conversationUrl: prepared.conversationUrl,
      projectTitle: prepared.projectTitle,
      projectUrl: prepared.projectUrl,
      chatTitle: prepared.chatTitle,
      sessionPath: prepared.sessionPath,
      evidenceRound: prepared.evidenceRound,
      maxAutomaticEvidenceReplies: prepared.maxAutomaticEvidenceReplies,
    });
    this.store.transition(created.job.id, "snapshotted");
    const queued = this.store.transition(created.job.id, "queued");
    this.schedule();
    return { ...publicJob(queued), idempotent: false, authorizationGenerated: generatedAuthorization };
  }

  schedule() {
    if (this.closed) return;
    queueMicrotask(() => this.drain());
  }

  drain() {
    if (this.closed) return;
    const queued = this.store.queuedJobs();
    // Conversation keys may change while a job is active: new-chat jobs are
    // re-keyed from their creation scope to ChatGPT's canonical URL as soon as
    // the submitted turn is proven. Always consult the authoritative rows so a
    // continuation cannot overlap the still-running creator job.
    const reservedKeys = new Set(
      Array.from(this.active.keys(), (jobId) => this.store.getJob(jobId)?.conversationKey).filter(Boolean),
    );
    for (const job of queued) {
      if (this.active.size >= this.writeConcurrency) break;
      if (reservedKeys.has(job.conversationKey)) continue;
      reservedKeys.add(job.conversationKey);
      const running = this.runJob(job)
        .catch(() => undefined)
        .finally(() => {
          this.active.delete(job.id);
          this.schedule();
        });
      this.active.set(job.id, running);
    }
  }

  async beforeSubmit() {
    const previous = this.submitGate;
    let release;
    this.submitGate = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      if (await fileExists(emergencyLockPath())) {
        throw codedError("EMERGENCY_LOCKED", "The user-wide emergency lock was enabled before submission.", { safeToRetry: true });
      }
      const waitMs = Math.max(0, 2_000 - (Date.now() - this.lastSubmissionAt));
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.lastSubmissionAt = Date.now();
    } finally {
      release();
    }
  }

  async runJob(job) {
    return this.jobExecutor({
      jobId: job.id,
      store: this.store,
      browserManager: this.browserManager,
      beforeSubmit: () => this.beforeSubmit(),
    });
  }

  getJob(jobId) {
    return publicJob(this.store.requireJob(jobId));
  }

  listJobs(params) {
    return { jobs: this.store.listJobs(params).map(publicJob) };
  }

  async waitForJob(jobId, timeoutSeconds = 55) {
    const bounded = Math.max(0, Math.min(55, Number(timeoutSeconds) || 55));
    const deadline = Date.now() + bounded * 1_000;
    let job = this.store.requireJob(jobId);
    const initialVersion = job.version;
    while (!TERMINAL_JOB_STATES.has(job.state) && job.version === initialVersion && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      job = this.store.requireJob(jobId);
    }
    return publicJob(job);
  }

  result(jobId) {
    const job = this.store.requireJob(jobId);
    if (job.state === "completed") return job.result;
    if (TERMINAL_JOB_STATES.has(job.state)) {
      return { ...publicJob(job), status: job.state };
    }
    return { ...publicJob(job), status: "pending" };
  }

  async waitCompatibility(receipt, waitSeconds = 240) {
    const deadline = Date.now() + Math.max(0, Math.min(240, waitSeconds)) * 1_000;
    let status = this.getJob(receipt.jobId);
    while (!status.terminal && Date.now() < deadline) {
      status = await this.waitForJob(receipt.jobId, Math.min(55, Math.ceil((deadline - Date.now()) / 1_000)));
    }
    return status.state === "completed" ? this.result(receipt.jobId) : { ...status, status: status.terminal ? status.state : "pending" };
  }

  async reconcile(jobId, conversationUrl) {
    let job = this.store.requireJob(jobId);
    if (!new Set(["submission_uncertain", "response_uncertain", "quarantined"]).has(job.state)) {
      return { ...publicJob(job), reconciled: false, reason: "Job is not uncertain." };
    }
    if (!job.conversationUrl && conversationUrl) {
      const canonicalUrl = normalizeConversationUrl(conversationUrl);
      job = this.store.transition(job.id, job.state, {
        conversationKey: canonicalUrl,
        conversationUrl: canonicalUrl,
      }, { userSuppliedReconciliationTarget: true });
    }
    if (!job.conversationUrl || !job.submittedMessageHash) {
      return {
        ...publicJob(job),
        reconciled: false,
        reason: "The conversation URL or exact submitted-message hash is unavailable; no browser write was attempted.",
        recoveryAction: `acknowledge_uncertain ${job.id} after manual inspection`,
      };
    }
    const lease = await this.browserManager.leasePage(`reconcile-${job.id}`, { discovery: true });
    try {
      await openExistingConversation(lease.page, { conversationUrl: job.conversationUrl, title: job.chatTitle });
      const snapshot = await assistantSnapshot(lease.page);
      const matches = snapshot.turns.filter((turn) =>
        turn.role === "user" &&
        semanticTextHash(turn.text) === job.submittedMessageHash &&
        attachmentManifestKey(turn.attachments) === attachmentManifestKey(job.attachmentManifest || []),
      );
      if (matches.length !== 1) {
        return {
          ...publicJob(job),
          reconciled: false,
          observedMatches: matches.length,
          reason: matches.length ? "More than one exact user turn matched; attribution remains ambiguous." : "No exact submitted user turn was found.",
        };
      }
      const match = matches[0];
      this.store.reopenForMonitoring(job.id, { userTurnId: match.id, userTurnHash: job.submittedMessageHash });
      this.store.acknowledge(job.id);
      this.schedule();
      return { ...this.getJob(job.id), reconciled: true, recoveryAction: "monitoring the proven submitted turn; no message was resent" };
    } finally {
      await this.browserManager.releasePage(lease.jobId);
    }
  }

  acknowledge(jobId) {
    return this.store.acknowledge(jobId);
  }

  cancel(jobId) {
    const result = this.store.cancel(jobId);
    return { ...publicJob(result), cancelled: result.cancelled, detached: result.detached };
  }

  async setEmergencyLock(enabled) {
    if (enabled) {
      await mkdir(path.dirname(emergencyLockPath()), { recursive: true, mode: 0o700 });
      const handle = await open(emergencyLockPath(), "a", 0o600);
      await handle.close();
    } else {
      await rm(emergencyLockPath(), { force: true });
    }
    return { emergencyLocked: enabled, path: emergencyLockPath() };
  }

  async replyWithLocalData(input) {
    const parent = this.store.requireJob(input.jobId);
    if (parent.state !== "completed" || parent.assistantDisposition !== "local_data_request" || !parent.localDataRequest) {
      throw codedError("LOCAL_DATA_REQUEST_REQUIRED", "The selected job did not complete with a valid local-data request.");
    }
    if (!parent.localDataRequest.safeReadOnly) {
      throw codedError("LOCAL_DATA_APPROVAL_REQUIRED", "The request contains a sensitive, write, or scope-expanding item and requires user approval.");
    }
    const round = parent.evidenceRound + 1;
    if (round > parent.maxAutomaticEvidenceReplies || round > 3) {
      throw codedError("LOCAL_DATA_LIMIT_REACHED", "The automatic local-data reply limit has been reached; ask the user before continuing.");
    }
    if (scanEvidenceForSecrets({ facts: input.facts, unavailable: input.unavailable })) {
      throw codedError("SENSITIVE_EVIDENCE_REJECTED", "The supplied evidence appears to contain secrets and was not sent.");
    }
    const requestedIds = new Set(parent.localDataRequest.requests.map((request) => request.id));
    const suppliedIds = [...(input.facts ?? []), ...(input.unavailable ?? [])].map((item) => item.id);
    if (new Set(suppliedIds).size !== suppliedIds.length || suppliedIds.some((id) => !requestedIds.has(id))) {
      throw codedError("LOCAL_DATA_SCOPE_MISMATCH", "Evidence ids must be unique and must match the requested local facts.");
    }
    const missingIds = [...requestedIds].filter((id) => !suppliedIds.includes(id));
    if (missingIds.length) {
      throw codedError("LOCAL_DATA_INCOMPLETE", `Explain unavailable requested facts instead of omitting them: ${missingIds.join(", ")}.`);
    }
    const prompt = buildLocalDataReply({ request: parent.localDataRequest, facts: input.facts ?? [], unavailable: input.unavailable ?? [] });
    return this.startJob("continue_chat", {
      authorizationId: deriveEvidenceAuthorizationId(parent.authorizationId, round),
      conversationUrl: parent.conversationUrl,
      prompt,
      evidenceReply: true,
      parentJobId: parent.id,
      evidenceRound: round,
      responseTimeoutSeconds: input.responseTimeoutSeconds ?? parent.request.responseTimeoutSeconds,
      attachmentTimeoutSeconds: parent.request.attachmentTimeoutSeconds,
      modelRequirement: "pro",
      maxAutomaticEvidenceReplies: parent.maxAutomaticEvidenceReplies,
    });
  }

  async methods() {
    return {
      "broker.status": () => this.statusAsync(),
      "workflow.doctor": async () => ({ ...(await doctor()), broker: await this.statusAsync() }),
      "workflow.profiles": async () => ({ profiles: await listFirefoxProfiles() }),
      "workflow.setup": (params) => this.browserManager.withMaintenance(() => setupLogin({ timeoutMs: (params.timeoutSeconds ?? 300) * 1_000 })),
      "workflow.importSession": (params) => this.browserManager.withMaintenance(() => importFirefoxSession(params)),
      "workflow.listProjects": (params) => discoverProjects(this.browserManager, params),
      "workflow.findChats": (params) => discoverChats(this.browserManager, params),
      "jobs.startConsult": (params) => this.startJob("consult", params),
      "jobs.startContinue": (params) => this.startJob("continue_chat", params),
      "jobs.compatConsult": async (params) => this.waitCompatibility(await this.startJob("consult", params, { generatedAuthorization: !params.authorizationId }), 240),
      "jobs.compatContinue": async (params) => this.waitCompatibility(await this.startJob("continue_chat", params, { generatedAuthorization: !params.authorizationId }), 240),
      "jobs.status": (params) => this.getJob(params.jobId),
      "jobs.wait": (params) => this.waitForJob(params.jobId, params.timeoutSeconds),
      "jobs.result": (params) => this.result(params.jobId),
      "jobs.list": (params) => this.listJobs(params),
      "jobs.reconcile": (params) => this.reconcile(params.jobId, params.conversationUrl),
      "jobs.acknowledge": (params) => this.acknowledge(params.jobId),
      "jobs.cancel": (params) => this.cancel(params.jobId),
      "jobs.replyWithLocalData": (params) => this.replyWithLocalData(params),
      "broker.setEmergencyLock": (params) => this.setEmergencyLock(Boolean(params.enabled)),
    };
  }
}

export { publicJob, structuredError };
