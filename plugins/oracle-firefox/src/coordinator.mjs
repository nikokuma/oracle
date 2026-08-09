import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { AsyncMutex } from "./async-lock.mjs";
import { BrowserManager } from "./browser-manager.mjs";
import { mintCapability, parseCapability } from "./capabilities.mjs";
import { completionRecordPath, removeCompletionRecord, writeCompletionRecord } from "./completion-records.mjs";
import { emergencyLockPath } from "./config.mjs";
import {
  downloadAssistantArtifact,
  listAssistantDownloadCandidates,
  publicDownloadCandidates,
} from "./downloads.mjs";
import { codedError, structuredError } from "./errors.mjs";
import {
  buildLocalDataReply,
  deriveLocalDataNonce,
  deriveEvidenceAuthorizationId,
  deriveResponseRecoveryAuthorizationId,
  scanEvidenceForSecrets,
} from "./evidence.mjs";
import { attachmentManifestKey, assistantSnapshot, normalizeConversationTitle, normalizeConversationUrl, openExistingConversation, projectUrlFromConversationUrl, semanticMismatchDetails, semanticTextHash } from "./firefox.mjs";
import { requestDigest, StateStore, TERMINAL_JOB_STATES } from "./state-store.mjs";
import {
  BROKER_BUILD_VERSION,
  BROKER_MINIMUM_READER_PROTOCOL,
  BROKER_MINIMUM_WRITER_PROTOCOL,
  BROKER_PROTOCOL_VERSION,
} from "./protocol.mjs";
import {
  conversationKeyFor,
  discoverChats,
  discoverProjects,
  executeJob,
  importFirefoxSession,
  importSessionIntoManagedBrowser,
  listFirefoxProfiles,
  prepareJobRequest,
  repairTerminalArtifacts,
  resolveProjectTarget,
  setupLogin,
  doctor,
  writeFinalMetadata,
} from "./workflow.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const INPUT_REQUEST_ABANDON_REASONS = new Set(["false-positive", "not-needed", "user-declined"]);

function inputRequestAbandonReason(value) {
  const reason = value || "user-declined";
  if (!INPUT_REQUEST_ABANDON_REASONS.has(reason)) {
    throw codedError("INVALID_INPUT_REQUEST_ABANDON_REASON", "Input-request abandonment reason must be false-positive, not-needed, or user-declined.");
  }
  return reason;
}

function publicExecutionView(job, logicalState = null) {
  const executionMode = job.executionKind === "monitor_only" ? "monitor_only" : "pre_submit";
  let blockedReason = null;
  if (executionMode === "monitor_only" && job.executionState === "backoff") blockedReason = "MONITOR_REATTACHING";
  else if (logicalState === "blocked_attention") {
    blockedReason = job.state === "input_invalid" || job.chainState === "input_invalid"
      ? "INPUT_INVALID"
      : "INPUT_REQUIRED_BLOCKING";
  } else if (logicalState === "blocked_uncertainty") {
    blockedReason = job.state === "response_uncertain"
      ? "RESPONSE_UNCERTAIN"
      : job.state === "submission_uncertain" ? "SUBMISSION_UNCERTAIN" : "CONVERSATION_QUARANTINED";
  }
  const monitorRetry = executionMode === "monitor_only" ? {
    state: job.executionState === "backoff" ? "reattaching" : job.executionState,
    retryCount: Number(job.executionFailureCount || 0),
    retryAt: job.nextExecutionNotBefore || null,
    deadlineAt: job.monitorDeadlineAt || null,
    finalReconciliationAttemptedAt: job.finalReconciliationAttemptedAt || null,
    lastError: job.lastExecutorError || null,
  } : null;
  return {
    executionMode,
    blockedReason,
    attentionRequired: Boolean(
      job.attentionRequiredAt ||
      logicalState === "blocked_attention" ||
      new Set(["input_required", "input_invalid"]).has(job.chainState)
    ),
    resultAvailable: Boolean(job.result),
    monitorRetry,
  };
}

function publicJob(job, extras = {}) {
  if (!job) return null;
  const logicalState = extras.logicalState ?? null;
  return {
    jobId: job.id,
    authorizationId: job.authorizationId,
    operation: job.operation,
    browser: job.request?.browser ?? null,
    state: job.state,
    terminal: TERMINAL_JOB_STATES.has(job.state),
    safeToRetry: job.error?.safeToRetry ?? false,
    submissionMayHaveOccurred: job.submissionMayHaveOccurred,
    attachmentManifest: job.attachmentManifest,
    zipAttachments: (job.request?.zipAttachments ?? []).map(({ filename, sizeBytes, sha256, entryCount, uncompressedBytes }) => ({
      filename,
      sizeBytes,
      sha256,
      entryCount,
      uncompressedBytes,
    })),
    modelEvidence: job.modelEvidence,
    projectTitle: job.projectTitle,
    projectUrl: job.projectUrl,
    chatTitle: job.chatTitle,
    conversationUrl: job.conversationUrl,
    assistantDisposition: job.assistantDisposition,
    responseDisposition: job.responseDisposition,
    responseFailure: job.responseFailure,
    localDataRequest: job.localDataRequest,
    evidenceRound: job.evidenceRound,
    maxAutomaticEvidenceReplies: job.maxAutomaticEvidenceReplies,
    sessionPath: job.sessionPath,
    error: job.error,
    recoveryAction: job.recoveryAction,
    parentJobId: job.parentJobId,
    rootJobId: job.rootJobId,
    replacementJobId: job.replacementJobId,
    retryAttempt: job.retryAttempt,
    maxAutomaticResponseRetries: job.maxAutomaticResponseRetries,
    chainId: job.chainId,
    chainState: job.chainState,
    inputRequestAbandonedAt: job.inputRequestAbandonedAt,
    inputRequestAbandonedReason: job.inputRequestAbandonedReason,
    attemptKind: job.attemptKind,
    responseFailurePolicy: job.request?.responseFailurePolicy ?? "report",
    completionMode: job.request?.completionMode ?? "manual",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    ...publicExecutionView(job, logicalState),
    ...extras,
  };
}

function committedStartError(error) {
  const value = error instanceof Error ? error : new Error(String(error));
  value.details = {
    ...(value.details && typeof value.details === "object" ? value.details : {}),
    startReceiptCommitted: true,
  };
  return value;
}

async function fileExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function notifyMacOsCompletion(delivery) {
  if (process.platform !== "darwin") return Promise.resolve(false);
  const terminal = new Set(["completed", "failed", "cancelled", "submission_uncertain", "response_uncertain", "quarantined"]);
  const body = terminal.has(delivery.state)
    ? "An Oracle job finished. Reopen your agent and retrieve the durable result."
    : "An Oracle job needs your attention. Reopen your agent and check its durable status.";
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", [
      "-e",
      `display notification ${JSON.stringify(body)} with title ${JSON.stringify("Oracle Firefox")}`,
    ], { timeout: 10_000 }, (error) => resolve(!error));
  });
}

export class Coordinator {
  constructor({
    store = new StateStore(),
    browserManager = null,
    brokerContext = null,
    writeConcurrency,
    minimumSubmissionIntervalMs,
    executionHeartbeatIntervalMs,
    abandonedClaimTimeoutMs,
    abandonedClaimSweepIntervalMs,
    jobExecutor = executeJob,
    completionDirectory,
    legacyCompletionFiles,
    completionNotifier = notifyMacOsCompletion,
    notificationConcurrency = 2,
    notificationClaimSeconds = 30,
    notificationRetryBaseMs = 1_000,
    notificationRetryMaximumMs = 60_000,
    notificationTimeoutMs = 15_000,
  } = {}) {
    this.store = store;
    this.brokerContext = brokerContext || store.brokerContext;
    this.browserManager = browserManager || new BrowserManager({ brokerContext: this.brokerContext });
    this.browserSelectionGate = new AsyncMutex("browser-selection", { timeoutMs: 120_000 });
    this.writeConcurrency = Math.max(1, Math.min(5, Number(
      writeConcurrency ?? process.env.ORACLE_FIREFOX_MAX_ACTIVE_CONVERSATIONS ?? process.env.ORACLE_FIREFOX_WRITE_CONCURRENCY ?? 5,
    )));
    this.explicitWriteConcurrency = writeConcurrency !== undefined;
    this.qualifiedConcurrencyOverride = process.env.ORACLE_FIREFOX_QUALIFIED_CONCURRENCY?.trim() || null;
    this.jobExecutor = jobExecutor;
    this.minimumSubmissionIntervalMs = Math.max(2_000, Math.min(300_000, Number(
      minimumSubmissionIntervalMs ?? process.env.ORACLE_FIREFOX_MINIMUM_SUBMISSION_INTERVAL_MS ?? 10_000,
    ) || 10_000));
    this.executionHeartbeatIntervalMs = Math.max(100, Number(executionHeartbeatIntervalMs) || 5_000);
    this.abandonedClaimTimeoutMs = Math.max(
      this.executionHeartbeatIntervalMs * 2,
      Number(abandonedClaimTimeoutMs) || 20_000,
    );
    this.abandonedClaimSweepIntervalMs = Math.max(
      100,
      Number(abandonedClaimSweepIntervalMs) || Math.min(5_000, this.abandonedClaimTimeoutMs / 2),
    );
    this.active = new Map();
    this.submitGate = Promise.resolve();
    this.startedAt = new Date().toISOString();
    this.brokerInstanceId = this.brokerContext?.instanceId || randomUUID();
    this.closed = false;
    this.draining = false;
    this.brokerFatalError = null;
    this.completionDirectory = completionDirectory || path.join(path.dirname(this.store.databasePath), "completions");
    this.legacyCompletionFiles = legacyCompletionFiles ?? (
      process.env.ORACLE_FIREFOX_LEGACY_COMPLETION_FILES === "1" ||
      Boolean(completionDirectory)
    );
    this.completionWrites = new Map();
    this.completionNotifier = completionNotifier;
    this.notificationConcurrency = Math.max(1, Math.min(4, Number(notificationConcurrency) || 2));
    this.notificationClaimSeconds = Math.max(1, Number(notificationClaimSeconds) || 30);
    this.notificationRetryBaseMs = Math.max(1, Number(notificationRetryBaseMs) || 1_000);
    this.notificationRetryMaximumMs = Math.max(this.notificationRetryBaseMs, Number(notificationRetryMaximumMs) || 60_000);
    this.notificationTimeoutMs = Math.max(50, Number(notificationTimeoutMs) || 15_000);
    this.notificationClaimSeconds = Math.max(
      this.notificationClaimSeconds,
      Math.ceil(this.notificationTimeoutMs / 1_000) + 1,
    );
    this.notificationWorkers = new Set();
    this.notificationWakeTimer = null;
    this.accountWakeTimer = null;
    this.executionWakeTimer = null;
    this.attentionWakeTimer = null;
    this.abandonedClaimSweepTimer = null;
    this.onStoreChange = (job) => {
      if (this.legacyCompletionFiles) this.queueCompletionRecord(job.rootJobId || job.id);
      this.queueSystemNotifications();
      this.scheduleAttentionWake();
      this.schedule();
    };
  }

  async open() {
    await this.store.open();
    this.brokerContext = this.store.brokerContext;
    if (
      this.explicitWriteConcurrency &&
      (!this.store.productionFencing || process.env.ORACLE_FIREFOX_ALLOW_UNQUALIFIED_CONCURRENCY === "1")
    ) this.store.setQualifiedConcurrency(this.writeConcurrency);
    if (this.qualifiedConcurrencyOverride) {
      const qualified = Number(this.qualifiedConcurrencyOverride);
      if (!Number.isInteger(qualified) || qualified < 1 || qualified > 5) {
        throw codedError("INVALID_QUALIFIED_CONCURRENCY", "ORACLE_FIREFOX_QUALIFIED_CONCURRENCY must be an integer from 1 to 5.");
      }
      this.store.setQualifiedConcurrency(Math.min(qualified, this.writeConcurrency));
    }
    this.store.on("change", this.onStoreChange);
    this.database = this.store.databaseStatus();
    this.invariants = this.store.checkInvariants();
    this.safeMode = !this.invariants.ok;
    this.recovery = this.safeMode ? [] : this.store.recoverInterruptedJobs();
    this.deliveryRepair = this.safeMode ? { chainEvents: 0, deliveries: 0 } : this.store.rebuildCompletionDeliveries();
    this.artifactRepair = this.safeMode ? { repaired: [], failed: [] } : await repairTerminalArtifacts(this.store);
    if (this.legacyCompletionFiles) {
      for (const rootJobId of this.store.allRootJobIds()) this.queueCompletionRecord(rootJobId);
    }
    if (!this.safeMode) {
      this.store.sweepAttentionRequired();
      this.startAbandonedClaimSweeper();
      this.schedule();
      this.queueSystemNotifications();
      this.scheduleAttentionWake();
    }
    this.scheduleAccountWake(this.store.accountState().cooldownUntil);
    return this;
  }

  async close() {
    this.closed = true;
    this.draining = true;
    clearInterval(this.abandonedClaimSweepTimer);
    this.abandonedClaimSweepTimer = null;
    clearTimeout(this.notificationWakeTimer);
    this.notificationWakeTimer = null;
    await Promise.allSettled(this.active.values());
    this.store.off("change", this.onStoreChange);
    await Promise.allSettled(this.completionWrites.values());
    await Promise.allSettled(this.notificationWorkers);
    clearTimeout(this.accountWakeTimer);
    clearTimeout(this.executionWakeTimer);
    clearTimeout(this.attentionWakeTimer);
    await this.browserManager.close();
    this.store.markBrokerReleased?.("coordinator closed cleanly");
    this.store.close();
  }

  beginDrain(reason = "upgrade requested") {
    this.draining = true;
    return { draining: true, reason, activeExecutors: this.active.size };
  }

  status() {
    const logicalQueue = this.store.logicalQueueCounts();
    const account = this.store.accountState();
    const queue = { ...logicalQueue };
    return {
      ready: true,
      protocolVersion: BROKER_PROTOCOL_VERSION,
      protocol: { minimum: BROKER_MINIMUM_READER_PROTOCOL, maximum: BROKER_PROTOCOL_VERSION },
      minimumWriterProtocol: BROKER_MINIMUM_WRITER_PROTOCOL,
      schemaVersion: this.database?.schemaVersion ?? null,
      buildVersion: BROKER_BUILD_VERSION,
      pid: process.pid,
      brokerInstanceId: this.brokerInstanceId,
      coordinatorId: this.brokerContext?.coordinatorId || null,
      leaseGeneration: this.brokerContext?.leaseGeneration || null,
      startedAt: this.startedAt,
      activeJobCount: this.active.size,
      executing: logicalQueue.executing,
      monitoring: logicalQueue.monitoring,
      runnableQueued: logicalQueue.runnableQueued,
      blockedAttention: logicalQueue.blockedAttention,
      blockedUncertainty: logicalQueue.blockedUncertainty,
      logicalOutstanding: logicalQueue.logicalOutstanding,
      queuedJobs: logicalQueue.runnableQueued,
      outstandingJobs: logicalQueue.logicalOutstanding,
      writeConcurrency: this.writeConcurrency,
      minimumSubmissionIntervalMs: this.minimumSubmissionIntervalMs,
      queue,
      account,
      durableDelivery: this.store.completionDeliveryHealth(),
      versionSkew: this.store.protocolCompatibilityStatus(),
      concurrency: {
        logicalJobSlots: this.writeConcurrency,
        qualifiedConversationSlots: account.qualifiedConcurrency,
        effectivePreSubmitSlots: account.effectiveConcurrency,
        activeExecutors: this.active.size,
        submissionSerialization: "broker-wide-one-at-a-time",
        minimumSubmissionIntervalMs: this.minimumSubmissionIntervalMs,
        configuredBy: this.explicitWriteConcurrency
          ? "constructor"
          : process.env.ORACLE_FIREFOX_MAX_ACTIVE_CONVERSATIONS
            ? "ORACLE_FIREFOX_MAX_ACTIVE_CONVERSATIONS"
            : process.env.ORACLE_FIREFOX_WRITE_CONCURRENCY
              ? "ORACLE_FIREFOX_WRITE_CONCURRENCY"
              : "default-five",
        qualificationSource: this.qualifiedConcurrencyOverride
          ? "ORACLE_FIREFOX_QUALIFIED_CONCURRENCY"
          : "durable-broker-state",
      },
      recovery: {
        count: this.recovery?.length ?? 0,
        actions: Object.fromEntries(
          Object.entries((this.recovery || []).reduce((counts, entry) => {
            counts[entry.action] = (counts[entry.action] || 0) + 1;
            return counts;
          }, {})),
        ),
      },
      safeMode: Boolean(this.safeMode),
      draining: this.draining,
      brokerFatalError: this.brokerFatalError,
      invariantViolations: this.invariants?.violations ?? [],
      database: this.database,
      completionDelivery: this.legacyCompletionFiles ? "legacy-files-subscriptions-and-system-notifications" : "subscriptions-and-system-notifications",
      browser: this.browserManager.status(),
      emergencyLocked: false,
    };
  }

  async statusAsync() {
    return { ...this.status(), emergencyLocked: await fileExists(emergencyLockPath()) };
  }

  openClientSession(client = {}, { readOnly = false } = {}) {
    if (readOnly) return this.store.resumeOwnerSessionReadOnly(client);
    return this.store.createOwnerSession({
      harness: client.harness || "unknown",
      clientInstanceId: client.clientInstanceId || null,
      hostSessionHint: client.hostSessionHint || null,
      stableSessionId: client.stableSessionId || null,
      stableSessionHandle: client.stableSessionHandle || null,
      metadata: {
        pid: Number.isInteger(client.pid) ? client.pid : null,
        buildVersion: client.buildVersion || null,
        protocolVersion: Number(client.protocolVersion || BROKER_PROTOCOL_VERSION),
      },
    });
  }

  callerFromContext(context, { optional = false } = {}) {
    try {
      return this.store.authenticateOwnerSession(context?.client, {
        touch: Number(context?.protocolVersion || BROKER_PROTOCOL_VERSION) >= BROKER_MINIMUM_WRITER_PROTOCOL,
      });
    } catch (error) {
      if (optional) return null;
      throw error;
    }
  }

  accessibleJob(params, context, { control = false } = {}) {
    const caller = this.callerFromContext(context);
    return this.store.authorizeJob({
      jobId: params.jobId || null,
      jobHandle: params.jobHandle || null,
      caller,
      control,
      allowCapabilityGrant: Number(context?.protocolVersion || BROKER_PROTOCOL_VERSION) >= BROKER_MINIMUM_WRITER_PROTOCOL,
      allowLegacyRead: !control && this.writeConcurrency === 1 && process.env.ORACLE_FIREFOX_LEGACY_UUID_READ !== "0",
    });
  }

  requireWritable() {
    if (this.safeMode) {
      throw codedError("BROKER_SAFE_MODE", "Oracle Firefox is read/monitor-only because a durable-state invariant failed.", {
        details: { invariantViolations: this.invariants?.violations ?? [] },
      });
    }
  }

  async startJob(operation, input, options = {}) {
    return this.browserSelectionGate.run(
      () => this.startJobWithSelectedBrowser(operation, input, options),
      { owner: `start-job:${operation}` },
    );
  }

  async startJobWithSelectedBrowser(operation, input, { generatedAuthorization = false, caller = null, internalChain = null } = {}) {
    if (this.draining) throw codedError("BROKER_DRAINING", "Oracle Firefox is draining for a safe broker handoff; no new job was accepted.", { safeToRetry: true });
    if (this.safeMode) {
      throw codedError("BROKER_SAFE_MODE", "Oracle Firefox detected a durable-state invariant violation and is read/monitor-only until it is repaired.", {
        details: { invariantViolations: this.invariants?.violations ?? [] },
      });
    }
    if (!new Set(["consult", "continue_chat"]).has(operation)) {
      throw codedError("INVALID_OPERATION", `Unsupported job operation: ${operation}`);
    }
    const {
      _receiptRecoveryHandle: receiptRecoveryHandle = null,
      ...authorizedInput
    } = input;
    const authorizationId = authorizedInput.authorizationId || (generatedAuthorization ? randomUUID() : null);
    if (!authorizationId || !UUID_PATTERN.test(authorizationId)) {
      throw codedError("AUTHORIZATION_REQUIRED", "authorizationId must be a UUID for asynchronous start tools.");
    }
    const digest = requestDigest({ operation, ...authorizedInput, authorizationId: undefined });
    const receiptCapability = receiptRecoveryHandle
      ? parseCapability(receiptRecoveryHandle, "receipt")
      : null;
    if (receiptRecoveryHandle && receiptCapability?.subjectId !== authorizationId) {
      throw codedError("START_RECOVERY_CAPABILITY_INVALID", "The private start-receipt recovery capability is invalid.");
    }
    const existing = this.store.getJobByAuthorization(authorizationId);
    if (existing) {
      if (!caller) throw codedError("CLIENT_SESSION_REQUIRED", "A client session is required to resume an idempotent job.");
      if (existing.requestDigest !== digest) {
        throw codedError("AUTHORIZATION_REUSED", "This authorizationId was already used for a different request.");
      }
      if (receiptRecoveryHandle) {
        try {
          return this.recoverStartReceipt({
            authorizationId,
            requestDigest: digest,
            recoveryHandle: receiptRecoveryHandle,
          }, null, caller, { idempotent: true, authorizationGenerated: generatedAuthorization });
        } catch (error) {
          throw committedStartError(error);
        }
      }
      this.store.authorizeJob({ jobId: existing.id, caller, control: false });
      return {
        ...publicJob(existing),
        idempotent: true,
        authorizationGenerated: generatedAuthorization,
        requestDigest: digest,
        receiptRecoveryHandle: null,
        receiptState: "committed",
      };
    }
    if (this.store.countOutstanding() >= 100) {
      throw codedError("QUEUE_FULL", "Oracle Firefox has reached its 100-job queue limit.", { safeToRetry: true });
    }
    if (await fileExists(emergencyLockPath())) {
      throw codedError("EMERGENCY_LOCKED", `Oracle Firefox submissions are disabled by ${emergencyLockPath()}.`);
    }
    let resolvedInput = { ...authorizedInput, browserBackend: this.browserManager.browserName };
    if (operation === "consult" && authorizedInput.projectTitle && !authorizedInput.projectUrl) {
      const project = await resolveProjectTarget(this.browserManager, {
        projectTitle: authorizedInput.projectTitle,
        headless: authorizedInput.headless,
      });
      resolvedInput = {
        ...resolvedInput,
        projectTitle: undefined,
        projectUrl: project.url,
        resolvedProjectTitle: project.title || authorizedInput.projectTitle,
        resolvedProjectUrl: project.url,
      };
    }
    if (operation === "continue_chat" && authorizedInput.chatTitle && !authorizedInput.conversationUrl) {
      const discovered = await discoverChats(this.browserManager, {
        query: authorizedInput.chatTitle,
        projectTitle: authorizedInput.projectTitle,
        projectUrl: authorizedInput.projectUrl,
        timeoutSeconds: 15,
        headless: authorizedInput.headless,
      });
      const expected = authorizedInput.chatTitle.replace(/\s+/gu, " ").trim().toLowerCase();
      const matches = discovered.chats.filter((chat) => chat.chatTitle.replace(/\s+/gu, " ").trim().toLowerCase() === expected);
      if (matches.length !== 1) {
        throw codedError(
          matches.length > 1 ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND",
          matches.length > 1
            ? `More than one ChatGPT conversation is titled ${JSON.stringify(authorizedInput.chatTitle)}. Use conversationUrl.`
            : `No ChatGPT conversation was found with the exact title ${JSON.stringify(authorizedInput.chatTitle)}.`,
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
    if (operation === "continue_chat" && resolvedInput.conversationUrl && !internalChain) {
      const canonicalScope = normalizeConversationUrl(resolvedInput.conversationUrl);
      const blockers = this.store.inputBlockers(canonicalScope);
      if (blockers.length) {
        throw codedError(
          "INPUT_REQUIRED_BLOCKING",
          "This exact conversation lane is waiting for explicit owner input and cannot accept another start.",
          {
            safeToRetry: false,
            recoveryAction: "The owning session must resolve or explicitly abandon the outstanding input request.",
            details: { blockers },
          },
        );
      }
    }
    const rootAuthorizationId = internalChain
      ? this.store.requireJob(internalChain.rootJobId).authorizationId
      : authorizationId;
    resolvedInput = {
      ...resolvedInput,
      localDataNonce: deriveLocalDataNonce(rootAuthorizationId),
    };
    const prepared = await prepareJobRequest(operation, resolvedInput);
    const conversationKey = conversationKeyFor(operation, prepared);
    const chainId = internalChain?.id || null;
    const rootJobId = prepared.rootJobId || randomUUID();
    // Capabilities are minted only after the opaque root identity is fixed.
    const finalReadCapability = chainId ? null : mintCapability("read", rootJobId);
    const finalControlCapability = chainId ? null : mintCapability("control", rootJobId);
    const subscriptionId = chainId ? null : randomUUID();
    const subscriptionCapability = chainId ? null : mintCapability("subscription", subscriptionId);
    const created = this.store.createJob({
      id: chainId ? undefined : rootJobId,
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
      parentJobId: prepared.parentJobId,
      rootJobId: internalChain?.rootJobId || rootJobId,
      chainId,
      ownerSessionId: internalChain?.originSessionId || caller?.id,
      attemptKind: prepared.evidenceReply ? "evidence_reply" : (prepared.retryAttempt > 0 ? "response_recovery" : "initial"),
      readCapabilityHash: finalReadCapability?.hash,
      controlCapabilityHash: finalControlCapability?.hash,
      startReceiptCapabilityHash: receiptCapability?.hash,
      subscriptionId,
      subscriptionCapabilityHash: subscriptionCapability?.hash,
      completionMode: prepared.completionMode,
      retryAttempt: prepared.retryAttempt,
      maxAutomaticResponseRetries: prepared.maxAutomaticResponseRetries,
    });
    try {
      if (created.idempotent) {
        if (receiptRecoveryHandle) {
          return this.recoverStartReceipt({
            authorizationId,
            requestDigest: digest,
            recoveryHandle: receiptRecoveryHandle,
          }, null, caller, { idempotent: true, authorizationGenerated: generatedAuthorization });
        }
        return {
          ...publicJob(created.job),
          idempotent: true,
          authorizationGenerated: generatedAuthorization,
          requestDigest: digest,
          receiptRecoveryHandle: receiptRecoveryHandle || null,
          receiptState: "committed",
        };
      }
      this.store.transition(created.job.id, "snapshotted");
      const queued = this.store.transition(created.job.id, "queued");
      this.schedule();
      return {
        ...publicJob(queued),
        idempotent: false,
        authorizationGenerated: generatedAuthorization,
        requestDigest: digest,
        receiptRecoveryHandle: receiptRecoveryHandle || null,
        receiptState: "committed",
        ...(finalControlCapability ? {
          jobHandle: finalControlCapability.handle,
          readHandle: finalReadCapability.handle,
          completionHandle: subscriptionCapability.handle,
        } : {}),
      };
    } catch (error) {
      throw committedStartError(error);
    }
  }

  recoverStartReceipt(params, context, authenticatedCaller = null, extras = {}) {
    const caller = authenticatedCaller || this.callerFromContext(context);
    const recovered = this.store.recoverStartReceipt({
      authorizationId: params.authorizationId,
      digest: params.requestDigest,
      recoveryHandle: params.recoveryHandle,
      caller,
    });
    return {
      ...publicJob(recovered.job),
      ...extras,
      receiptRecovered: true,
      requestDigest: recovered.job.requestDigest,
      receiptRecoveryHandle: params.recoveryHandle,
      receiptState: "recovered",
      jobHandle: recovered.jobHandle,
      readHandle: recovered.readHandle,
      completionHandle: recovered.completionHandle,
    };
  }

  schedule() {
    if (this.closed || this.safeMode || this.draining) return;
    queueMicrotask(() => this.drain());
  }

  scheduleAccountWake(when) {
    clearTimeout(this.accountWakeTimer);
    this.accountWakeTimer = null;
    if (!when) return;
    const waitMs = Math.max(0, Date.parse(when) - Date.now());
    this.accountWakeTimer = setTimeout(() => {
      this.accountWakeTimer = null;
      this.schedule();
    }, waitMs);
    this.accountWakeTimer.unref?.();
  }

  drain() {
    if (this.closed || this.safeMode || this.draining) return;
    try {
      this.sweepAbandonedExecutions();
    } catch (error) {
      this.safeMode = true;
      this.draining = true;
      this.brokerFatalError = structuredError(error);
      return;
    }
    const account = this.store.accountState();
    const cooldownActive = account.cooldownUntil && Date.parse(account.cooldownUntil) > Date.now();
    const preSubmitLimit = cooldownActive
      ? 0
      : Math.max(1, Math.min(this.writeConcurrency, Number(account.effectiveConcurrency) || 1));
    let activePreSubmit = Array.from(this.active.keys())
      .map((jobId) => this.store.getJob(jobId))
      .filter((job) => job && !job.submissionMayHaveOccurred).length;
    while (this.active.size < this.writeConcurrency) {
      const executionClaim = this.store.claimNextRunnable({ allowPreSubmit: activePreSubmit < preSubmitLimit });
      if (!executionClaim) break;
      const job = this.store.requireJob(executionClaim.jobId);
      if (!job.submissionMayHaveOccurred) activePreSubmit += 1;
      const running = this.runJob(job, executionClaim)
        .catch((error) => this.handleExecutorError(job, executionClaim, error))
        .finally(() => {
          this.store.releaseExecutionClaim(executionClaim);
          this.active.delete(job.id);
          this.scheduleExecutionWake();
          this.schedule();
        });
      this.active.set(job.id, running);
    }
    this.scheduleExecutionWake();
  }

  handleExecutorError(job, claim, error) {
    const brokerFatal = new Set([
      "PROFILE_IN_USE_EXTERNALLY",
      "BROKER_DATABASE_OWNED",
      "BROKER_ENDPOINT_CONFLICT",
      "BROKER_LEASE_LOST",
      "BROKER_INSTANCE_REPLACED",
    ]);
    if (brokerFatal.has(error?.code)) {
      this.safeMode = true;
      this.draining = true;
      this.brokerFatalError = structuredError(error);
      this.store.releaseExecutionClaim(claim, error);
      return;
    }
    this.store.releaseExecutionClaim(claim, error);
  }

  scheduleExecutionWake() {
    clearTimeout(this.executionWakeTimer);
    this.executionWakeTimer = null;
    if (this.closed || this.safeMode || this.draining) return;
    const when = this.store.earliestExecutionWake();
    if (!when) return;
    this.executionWakeTimer = setTimeout(() => {
      this.executionWakeTimer = null;
      this.schedule();
    }, Math.max(1, Date.parse(when) - Date.now()));
    this.executionWakeTimer.unref?.();
  }

  scheduleAttentionWake() {
    clearTimeout(this.attentionWakeTimer);
    this.attentionWakeTimer = null;
    if (this.closed || this.safeMode) return;
    const when = this.store.earliestAttentionWake();
    if (!when) return;
    this.attentionWakeTimer = setTimeout(() => {
      this.attentionWakeTimer = null;
      const marked = this.store.sweepAttentionRequired();
      if (marked.length) this.queueSystemNotifications();
      this.scheduleAttentionWake();
    }, Math.max(1, Date.parse(when) - Date.now()));
    this.attentionWakeTimer.unref?.();
  }

  sweepAbandonedExecutions({ nowMs = Date.now() } = {}) {
    return this.store.sweepAbandonedExecutionClaims({
      activeExecutorIds: this.active.keys(),
      heartbeatTimeoutMs: this.abandonedClaimTimeoutMs,
      nowMs,
    });
  }

  startAbandonedClaimSweeper() {
    clearInterval(this.abandonedClaimSweepTimer);
    this.abandonedClaimSweepTimer = setInterval(() => {
      if (this.closed || this.safeMode) return;
      try {
        const recovered = this.sweepAbandonedExecutions();
        if (recovered.length && !this.draining) this.schedule();
      } catch (error) {
        this.safeMode = true;
        this.draining = true;
        this.brokerFatalError = structuredError(error);
      }
    }, this.abandonedClaimSweepIntervalMs);
    this.abandonedClaimSweepTimer.unref?.();
  }

  async beforeSubmit(jobId, { waitOnly = false } = {}) {
    if (waitOnly) {
      for (;;) {
        if (await fileExists(emergencyLockPath())) {
          throw codedError("EMERGENCY_LOCKED", "The user-wide emergency lock was enabled before submission.", { safeToRetry: true });
        }
        const account = this.store.accountState();
        const readyAt = Math.max(
          account.nextSubmitNotBefore ? Date.parse(account.nextSubmitNotBefore) : 0,
          account.cooldownUntil ? Date.parse(account.cooldownUntil) : 0,
        );
        const waitMs = readyAt - Date.now();
        if (waitMs <= 0) return { ready: true };
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.min(waitMs, 55_000));
          timer.unref?.();
        });
      }
    }
    const previous = this.submitGate;
    let release;
    this.submitGate = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      if (await fileExists(emergencyLockPath())) {
        throw codedError("EMERGENCY_LOCKED", "The user-wide emergency lock was enabled before submission.", { safeToRetry: true });
      }
      return this.store.issueSubmitPermit(jobId, { minimumIntervalMs: this.minimumSubmissionIntervalMs });
    } finally {
      release();
    }
  }

  async runJob(job, executionClaim) {
    let heartbeatError = null;
    const executionHeartbeat = setInterval(() => {
      if (heartbeatError) return;
      try {
        this.store.heartbeatExecution(executionClaim);
      } catch (error) {
        heartbeatError = error;
      }
    }, this.executionHeartbeatIntervalMs);
    executionHeartbeat.unref?.();
    try {
      const result = await this.jobExecutor({
        jobId: job.id,
        store: this.store,
        browserManager: this.browserManager,
        executionClaim,
        beforeSubmit: (jobId, options) => this.beforeSubmit(jobId, options),
      });
      if (result?.state === "response_failed_detected") {
        return this.finalizeResponseFailure(job.id, result, executionClaim);
      }
      return result;
    } catch (error) {
      if (error?.code === "ACCOUNT_COOLDOWN") {
        const account = this.store.recordAccountCooldown(error);
        this.scheduleAccountWake(account.cooldownUntil);
      }
      throw error;
    } finally {
      clearInterval(executionHeartbeat);
    }
  }

  queueSystemNotifications() {
    if (!this.completionNotifier || this.closed) return;
    clearTimeout(this.notificationWakeTimer);
    this.notificationWakeTimer = null;
    while (this.notificationWorkers.size < this.notificationConcurrency) {
      let worker;
      worker = this.deliverSystemNotifications()
        .catch(() => undefined)
        .finally(() => {
          this.notificationWorkers.delete(worker);
          if (!this.closed) this.scheduleSystemNotificationWake();
        });
      this.notificationWorkers.add(worker);
    }
  }

  async deliverSystemNotifications() {
    for (;;) {
      if (this.closed) return;
      const delivery = this.store.claimSystemNotification({ claimSeconds: this.notificationClaimSeconds });
      if (!delivery) return;
      let timeout;
      const notification = Promise.resolve()
        .then(() => this.completionNotifier(delivery))
        .then((delivered) => ({ delivered: delivered === true, error: null }))
        .catch((error) => ({ delivered: false, error }));
      const timed = new Promise((resolve) => {
        timeout = setTimeout(() => resolve({
          delivered: false,
          error: codedError("NOTIFICATION_TIMEOUT", "The completion notifier timed out."),
        }), this.notificationTimeoutMs);
        timeout.unref?.();
      });
      const outcome = await Promise.race([notification, timed]);
      clearTimeout(timeout);
      if (outcome.delivered) {
        this.store.markSystemNotificationDelivered(delivery.deliveryId, delivery.claimId);
      } else {
        this.store.retrySystemNotification(
          delivery.deliveryId,
          delivery.claimId,
          outcome.error || codedError("NOTIFICATION_FAILED", "The completion notifier did not accept the delivery."),
          {
            baseDelayMs: this.notificationRetryBaseMs,
            maximumDelayMs: this.notificationRetryMaximumMs,
          },
        );
      }
    }
  }

  scheduleSystemNotificationWake() {
    if (this.closed || this.notificationWorkers.size > 0 || this.notificationWakeTimer) return;
    const readyAt = this.store.nextSystemNotificationAt();
    if (!readyAt) return;
    const waitMs = Math.max(0, Date.parse(readyAt) - Date.now());
    this.notificationWakeTimer = setTimeout(() => {
      this.notificationWakeTimer = null;
      this.queueSystemNotifications();
    }, waitMs);
    this.notificationWakeTimer.unref?.();
  }

  async finalizeResponseFailure(jobId, detectedResult, executionClaim = null) {
    let parent = this.store.requireJob(jobId);
    const failure = parent.responseFailure || detectedResult.responseFailure;
    const logicalChain = this.store.getChain(parent.chainId);
    const mayRecover =
      parent.request.responseFailurePolicy === "retry-once" &&
      failure?.retryable === true &&
      parent.retryAttempt < parent.maxAutomaticResponseRetries &&
      Boolean(parent.conversationUrl);
    let recoveryJob = null;
    let recoverySchedulingError = null;
    const provisionalAction = mayRecover
      ? "queue the one authorized response-recovery continuation"
      : failure?.retryable
        ? "authorize a new continuation if you want ChatGPT to try again"
        : "inspect the reported ChatGPT failure before starting another job";
    parent = executionClaim
      ? this.store.transitionClaimed(executionClaim, "response_failed", {
          recoveryAction: provisionalAction,
        }, { responseFailure: failure?.code })
      : this.store.transition(parent.id, "response_failed", {
          recoveryAction: provisionalAction,
        }, { responseFailure: failure?.code });
    if (mayRecover) {
      const root = this.store.requireJob(parent.rootJobId);
      const retryAttempt = parent.retryAttempt + 1;
      const prompt = [
        "[ORACLE RESPONSE RECOVERY]",
        `Your immediately preceding response ended with ${JSON.stringify(failure.normalizedText || failure.disposition)} before answering completely.`,
        "Please answer the original request in full now. Do not merely explain the previous failure.",
      ].join("\n");
      try {
        recoveryJob = await this.startJob("continue_chat", {
          authorizationId: deriveResponseRecoveryAuthorizationId(root.authorizationId, retryAttempt),
          conversationUrl: parent.conversationUrl,
          prompt,
          responseTimeoutSeconds: parent.request.responseTimeoutSeconds,
          attachmentTimeoutSeconds: parent.request.attachmentTimeoutSeconds,
          modelRequirement: parent.request.modelRequirement,
          maxAutomaticEvidenceReplies: parent.maxAutomaticEvidenceReplies,
          responseFailurePolicy: "report",
          completionMode: parent.request.completionMode,
          parentJobId: parent.id,
          rootJobId: parent.rootJobId,
          retryAttempt,
        }, {
          caller: { id: logicalChain.originSessionId },
          internalChain: logicalChain,
        });
      } catch (error) {
        recoverySchedulingError = structuredError(error);
      }
    }
    const recoveryAction = recoveryJob
      ? `monitor recovery job ${recoveryJob.jobId}`
      : recoverySchedulingError
        ? "automatic recovery could not be queued; inspect the failure before authorizing another continuation"
        : failure?.retryable
          ? "authorize a new continuation if you want ChatGPT to try again"
          : "inspect the reported ChatGPT failure before starting another job";
    const result = {
      ...detectedResult,
      state: "response_failed",
      status: "response_failed",
      recoveryJobId: recoveryJob?.jobId ?? null,
      activeJobId: recoveryJob?.jobId ?? parent.id,
      recoverySchedulingError,
      recoveryAction,
    };
    parent = this.store.transition(parent.id, "response_failed", {
      replacementJobId: recoveryJob?.jobId ?? null,
      result,
      recoveryAction,
    }, {
      responseFailure: failure?.code,
      recoveryJobId: recoveryJob?.jobId ?? null,
      recoverySchedulingError,
    });
    await writeFinalMetadata(parent, result).catch(() => undefined);
    return result;
  }

  queueCompletionRecord(rootJobId) {
    const previous = this.completionWrites.get(rootJobId) || Promise.resolve();
    const write = previous.then(() => this.refreshCompletionRecord(rootJobId)).catch(() => undefined);
    this.completionWrites.set(rootJobId, write);
    write.finally(() => {
      if (this.completionWrites.get(rootJobId) === write) this.completionWrites.delete(rootJobId);
    });
  }

  async refreshCompletionRecord(rootJobId) {
    this.brokerContext?.assertCurrentLease?.();
    const chain = this.store.jobChain(rootJobId);
    const active = chain.at(-1);
    if (!active || !TERMINAL_JOB_STATES.has(active.state)) {
      this.brokerContext?.assertCurrentLease?.();
      await removeCompletionRecord(this.completionDirectory, rootJobId);
      return;
    }
    this.brokerContext?.assertCurrentLease?.();
    await writeCompletionRecord(this.completionDirectory, {
      version: 2,
      coordinatorId: this.brokerContext?.coordinatorId || null,
      brokerInstanceId: this.brokerContext?.instanceId || null,
      leaseGeneration: this.brokerContext?.leaseGeneration || 0,
      rootJobId,
      activeJobId: active.id,
      state: active.state,
      responseDisposition: active.responseDisposition,
      failureCode: active.error?.code ?? null,
      conversationUrl: active.conversationUrl,
      resultAvailable: active.state === "completed",
      updatedAt: active.updatedAt,
    });
  }

  jobView(jobId, followRetries = true) {
    const requested = this.store.requireJob(jobId);
    const chain = this.store.jobChain(requested.rootJobId);
    const active = followRetries ? chain.at(-1) : requested;
    return publicJob(active, {
      logicalState: this.store.logicalStateForJob(active.id),
      requestedJobId: requested.id,
      activeJobId: active.id,
      recoveryChain: chain.map((job) => job.id),
      completionPath: this.legacyCompletionFiles
        ? completionRecordPath(this.completionDirectory, requested.rootJobId)
        : null,
    });
  }

  getJob(jobId, followRetries = true) {
    return this.jobView(jobId, followRetries);
  }

  listJobs(params, caller) {
    const logical = this.store.logicalQueueSnapshot(caller.id);
    return {
      jobs: this.store.listJobsForSession(caller.id, params).map((job) => publicJob(job, {
        logicalState: logical.byChainId.get(job.chainId) || null,
      })),
      attention: this.store.attentionForSession(caller.id),
      logicalCounts: logical.counts,
    };
  }

  listAttention(caller) {
    return { attention: this.store.attentionForSession(caller.id) };
  }

  async waitForJob(jobId, timeoutSeconds = 55, followRetries = true) {
    const bounded = Math.max(0, Math.min(55, Number(timeoutSeconds) || 55));
    const deadline = Date.now() + bounded * 1_000;
    let job = followRetries ? this.store.activeJob(jobId) : this.store.requireJob(jobId);
    const initialVersion = job.version;
    const initialJobId = job.id;
    while (!TERMINAL_JOB_STATES.has(job.state) && job.id === initialJobId && job.version === initialVersion && Date.now() < deadline) {
      await this.store.waitForChange(Math.max(0, deadline - Date.now()));
      job = followRetries ? this.store.activeJob(jobId) : this.store.requireJob(jobId);
    }
    return this.jobView(jobId, followRetries);
  }

  result(jobId, followRetries = true) {
    const requested = this.store.requireJob(jobId);
    const chain = this.store.jobChain(requested.rootJobId);
    const job = followRetries ? chain.at(-1) : requested;
    if (job.state === "completed" || job.state === "input_invalid") {
      return {
        ...job.result,
        ...publicExecutionView(job, this.store.logicalStateForJob(job.id)),
        ...(job.inputRequestAbandonedAt ? {
          inputRequestAbandoned: true,
          inputRequestAbandonedAt: job.inputRequestAbandonedAt,
          inputRequestAbandonedReason: job.inputRequestAbandonedReason,
          recoveryAction: null,
        } : {}),
        requestedJobId: requested.id,
        activeJobId: job.id,
        recoveryChain: chain.map((entry) => entry.id),
        completionPath: this.legacyCompletionFiles
          ? completionRecordPath(this.completionDirectory, chain[0].rootJobId)
          : null,
      };
    }
    if (TERMINAL_JOB_STATES.has(job.state)) {
      return { ...this.jobView(jobId, followRetries), status: job.state };
    }
    return { ...this.jobView(jobId, followRetries), status: "pending" };
  }

  async waitCompatibility(receipt, waitSeconds = 240) {
    const deadline = Date.now() + Math.max(0, Math.min(240, waitSeconds)) * 1_000;
    let status = this.getJob(receipt.jobId);
    while (!status.terminal && Date.now() < deadline) {
      status = await this.waitForJob(receipt.jobId, Math.min(55, Math.ceil((deadline - Date.now()) / 1_000)));
    }
    const handles = {
      ...(receipt.jobHandle ? { jobHandle: receipt.jobHandle } : {}),
      ...(receipt.readHandle ? { readHandle: receipt.readHandle } : {}),
      ...(receipt.completionHandle ? { completionHandle: receipt.completionHandle } : {}),
    };
    return status.state === "completed"
      ? { ...this.result(receipt.jobId), ...handles }
      : { ...status, status: status.terminal ? status.state : "pending", ...handles };
  }

  async reconcile(jobId, conversationUrl) {
    this.requireWritable();
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
    const { matches, candidateCount, mismatch } = await this.findSubmittedTurnMatches(job);
    if (matches.length !== 1) {
      return {
        ...publicJob(job),
        reconciled: false,
        observedMatches: matches.length,
        candidateCount,
        mismatch,
        reason: matches.length ? "More than one exact user turn matched; attribution remains ambiguous." : "No exact submitted user turn was found.",
      };
    }
    const match = matches[0];
    this.store.reopenForMonitoring(job.id, { userTurnId: match.id, userTurnHash: job.submittedMessageHash });
    this.store.acknowledge(job.id);
    this.schedule();
    return { ...this.getJob(job.id), reconciled: true, recoveryAction: "monitoring the proven submitted turn; no message was resent" };
  }

  async findSubmittedTurnMatches(job) {
    const lease = await this.browserManager.leasePage(`reconcile-${job.id}-${randomUUID()}`, { discovery: true });
    try {
      await openExistingConversation(lease.page, { conversationUrl: job.conversationUrl, title: job.chatTitle });
      const snapshot = await assistantSnapshot(lease.page);
      const candidates = snapshot.turns.filter((turn) =>
        turn.role === "user" &&
        attachmentManifestKey(turn.attachments) === attachmentManifestKey(job.attachmentManifest || [])
      );
      const matches = candidates.filter((turn) => semanticTextHash(turn.text) === job.submittedMessageHash);
      let expectedText = null;
      if (job.request?.delivery === "attachment") {
        expectedText = [
          "Read the attached oracle-context.md before answering.",
          "Follow the [USER] request and ORACLE LOCAL DATA PROTOCOL in that file.",
          "Return only the substantive answer or the strict local-data request block.",
        ].join("\n");
      } else if (job.request?.requestPath) {
        expectedText = (await readFile(job.request.requestPath, "utf8")).trimEnd();
      }
      return {
        matches,
        candidateCount: candidates.length,
        mismatch: expectedText && candidates.length
          ? semanticMismatchDetails(expectedText, candidates.at(-1).text)
          : null,
      };
    } finally {
      await this.browserManager.releasePage(lease.jobId);
    }
  }

  inspectQuarantine(conversationUrl) {
    const canonicalUrl = normalizeConversationUrl(conversationUrl);
    return {
      ...this.store.quarantineView(canonicalUrl),
      exactScope: true,
      messageSent: false,
    };
  }

  inspectInputRequest(conversationUrl) {
    const canonicalUrl = normalizeConversationUrl(conversationUrl);
    return {
      ...this.store.inputRequestView(canonicalUrl),
      exactScope: true,
      messageSent: false,
      replacementAuthorized: false,
    };
  }

  abandonInputRequest(input, context) {
    this.requireWritable();
    if (input.confirmAbandon !== true) {
      throw codedError(
        "INPUT_REQUEST_ABANDON_CONFIRMATION_REQUIRED",
        "Abandoning a local-data request requires explicit confirmation. This discards the evidence round and releases the conversation lane without sending.",
      );
    }
    const { job } = this.accessibleJob(input, context, { control: true });
    const released = this.store.abandonInputRequest(job.id, { reason: inputRequestAbandonReason(input.reason) });
    this.schedule();
    return {
      ...publicJob(released.job),
      abandoned: true,
      idempotent: Boolean(released.idempotent),
      laneReleased: true,
      templateFalsePositive: released.templateFalsePositive,
      inputRequestAbandonedAt: released.abandonedAt,
      inputRequestAbandonedReason: released.reason,
      messageSent: false,
      replacementAuthorized: false,
      recoveryAction: "The next already-authorized same-chat job may now run; any new replacement still requires its own authorization.",
    };
  }

  abandonOrphanedInputRequest(input, context) {
    this.requireWritable();
    this.callerFromContext(context);
    if (input.confirmCapabilityUnavailable !== true) {
      throw codedError(
        "CAPABILITY_RECOVERY_CONFIRMATION_REQUIRED",
        "Orphaned input-request recovery requires explicit confirmation that the original control capability is unavailable.",
      );
    }
    if (input.confirmAbandon !== true) {
      throw codedError(
        "INPUT_REQUEST_ABANDON_CONFIRMATION_REQUIRED",
        "Abandoning the exact input request requires explicit confirmation that no local-evidence reply should be sent.",
      );
    }
    const canonicalUrl = normalizeConversationUrl(input.conversationUrl);
    const released = this.store.abandonOrphanedInputRequest(canonicalUrl, input.fingerprint, {
      reason: inputRequestAbandonReason(input.reason),
    });
    this.schedule();
    return {
      abandoned: true,
      laneReleased: true,
      templateFalsePositive: released.templateFalsePositive,
      inputRequestAbandonedAt: released.abandonedAt,
      inputRequestAbandonedReason: released.reason,
      messageSent: false,
      replacementAuthorized: false,
      recoveryAction: "The next already-authorized same-chat job may now run; any new replacement still requires its own authorization.",
    };
  }

  async recoverOrphanedQuarantine(params, context) {
    this.requireWritable();
    const caller = this.callerFromContext(context);
    const canonicalUrl = normalizeConversationUrl(params.conversationUrl);
    if (params.confirmCapabilityUnavailable !== true) {
      throw codedError(
        "CAPABILITY_RECOVERY_CONFIRMATION_REQUIRED",
        "Recovering an orphaned quarantine requires explicit confirmation that the original control capability is unavailable.",
      );
    }
    if (params.action === "acknowledge") {
      if (params.confirmManualInspection !== true) {
        throw codedError(
          "MANUAL_INSPECTION_REQUIRED",
          "Acknowledgement requires explicit confirmation that the user manually inspected this exact ChatGPT conversation and accepted the uncertainty.",
        );
      }
      return this.store.acknowledgeOrphanedQuarantine(canonicalUrl, params.fingerprint);
    }
    const view = this.store.quarantineView(canonicalUrl);
    if (!view.quarantined) {
      throw codedError("QUARANTINE_NOT_FOUND", "No active Oracle Firefox quarantine matches that exact conversation URL.");
    }
    const job = this.store.orphanedQuarantineJob(canonicalUrl, params.fingerprint);
    if (!job.conversationUrl || !job.submittedMessageHash) {
      return {
        ...view,
        reconciled: false,
        observedMatches: null,
        reason: "The legacy job lacks the exact URL or submitted-message hash required for read-only proof.",
        recoveryAction: "Manually inspect the exact conversation, then use acknowledge recovery with the same current fingerprint.",
        messageSent: false,
      };
    }
    const reconciliation = await this.findSubmittedTurnMatches(job);
    const matches = Array.isArray(reconciliation?.matches) ? reconciliation.matches : [];
    if (matches.length !== 1) {
      return {
        ...view,
        reconciled: false,
        observedMatches: matches.length,
        candidateCount: Number(reconciliation?.candidateCount || 0),
        reason: matches.length
          ? "More than one exact user turn matched; attribution remains ambiguous."
          : "No exact submitted user turn was found.",
        recoveryAction: "Manually inspect the exact conversation before any acknowledgement.",
        messageSent: false,
      };
    }
    const chain = this.store.getChain(job.chainId);
    const readCapability = mintCapability("read", chain.id);
    const controlCapability = mintCapability("control", chain.id);
    const subscriptionId = randomUUID();
    const subscriptionCapability = mintCapability("subscription", subscriptionId);
    const recovered = this.store.recoverOrphanedQuarantineForMonitoring({
      scopeKey: canonicalUrl,
      fingerprint: params.fingerprint,
      caller,
      userTurnId: matches[0].id,
      userTurnHash: job.submittedMessageHash,
      readCapabilityHash: readCapability.hash,
      controlCapabilityHash: controlCapability.hash,
      subscriptionId,
      subscriptionCapabilityHash: subscriptionCapability.hash,
      completionMode: params.completionMode || "manual",
    });
    this.schedule();
    return {
      ...publicJob(recovered),
      reconciled: true,
      adoptedForMonitoring: true,
      messageSent: false,
      recoveryAction: "monitoring the proven submitted turn; no message was resent",
      jobHandle: controlCapability.handle,
      readHandle: readCapability.handle,
      completionHandle: subscriptionCapability.handle,
    };
  }

  acknowledge(jobId) {
    this.requireWritable();
    return this.store.acknowledge(jobId);
  }

  cancel(jobId) {
    this.requireWritable();
    const result = this.store.cancel(jobId);
    return { ...publicJob(result), cancelled: result.cancelled, detached: result.detached };
  }

  claimCompletion(params, context) {
    const caller = this.callerFromContext(context);
    const delivery = this.store.claimCompletion(params.completionHandle, caller, {
      claimSeconds: params.claimSeconds,
    });
    return { delivery };
  }

  async waitCompletion(params, context) {
    const bounded = Math.max(0, Math.min(55, Number(params.timeoutSeconds) || 55));
    const deadline = Date.now() + bounded * 1_000;
    for (;;) {
      const claimed = this.claimCompletion(params, context);
      if (claimed.delivery || Date.now() >= deadline) return claimed;
      await this.store.waitForChange(Math.max(0, deadline - Date.now()));
    }
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

  async selectBrowser(browser) {
    return this.browserSelectionGate.run(async () => {
      this.requireWritable();
      if (this.store.countOutstanding() > 0 || this.active.size > 0) {
        throw codedError("BROWSER_SELECTION_BUSY", "Browser selection is locked while Oracle jobs are outstanding.");
      }
      return this.browserManager.selectBrowser(browser);
    }, { owner: "select-browser" });
  }

  async replyWithLocalData(input, context) {
    this.requireWritable();
    const { job: parent, chain } = this.accessibleJob(input, context, { control: true });
    if (chain.state === "input_invalid" || parent.assistantDisposition === "input_invalid") {
      throw codedError(
        "INPUT_INVALID",
        "The assistant emitted a malformed local-data request. Oracle preserved it but will not construct or send an automated reply.",
      );
    }
    if (chain.state !== "input_required" || chain.inputRequestAbandonedAt) {
      throw codedError("LOCAL_DATA_REQUEST_ABANDONED", "This local-data request was abandoned or is no longer the active input request for its conversation lane.");
    }
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
      rootJobId: chain.rootJobId,
      evidenceRound: round,
      responseTimeoutSeconds: input.responseTimeoutSeconds ?? parent.request.responseTimeoutSeconds,
      attachmentTimeoutSeconds: parent.request.attachmentTimeoutSeconds,
      modelRequirement: "pro",
      maxAutomaticEvidenceReplies: parent.maxAutomaticEvidenceReplies,
      responseFailurePolicy: parent.request.responseFailurePolicy,
      completionMode: chain.completionMode,
    }, {
      caller: this.callerFromContext(context),
      internalChain: chain,
    });
  }

  async resolveReadOnlyConversation(input) {
    if (input.conversationUrl) {
      if (input.chatTitle || input.projectTitle || input.projectUrl) {
        throw codedError("TARGET_CONFLICT", "conversationUrl is sufficient by itself; do not combine it with title or project selectors.");
      }
      const conversationUrl = normalizeConversationUrl(input.conversationUrl);
      return {
        chatTitle: null,
        conversationUrl,
        projectTitle: null,
        projectUrl: projectUrlFromConversationUrl(conversationUrl),
      };
    }
    const chatTitle = normalizeConversationTitle(input.chatTitle);
    if (!chatTitle) {
      throw codedError("CHAT_TARGET_REQUIRED", "Provide an exact conversationUrl or chatTitle for artifact discovery.");
    }
    const discovered = await discoverChats(this.browserManager, {
      query: chatTitle,
      projectTitle: input.projectTitle,
      projectUrl: input.projectUrl,
      timeoutSeconds: input.timeoutSeconds ?? 30,
      headless: input.headless,
    });
    const expected = chatTitle.toLocaleLowerCase("en-US");
    const matches = discovered.chats.filter((chat) =>
      normalizeConversationTitle(chat.chatTitle).toLocaleLowerCase("en-US") === expected,
    );
    if (matches.length !== 1) {
      throw codedError(
        matches.length > 1 ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND",
        matches.length > 1
          ? `More than one ChatGPT conversation is titled ${JSON.stringify(chatTitle)}. Use conversationUrl.`
          : `No ChatGPT conversation was found with the exact title ${JSON.stringify(chatTitle)}.`,
        { details: { candidates: discovered.chats } },
      );
    }
    return {
      chatTitle: matches[0].chatTitle,
      conversationUrl: matches[0].conversationUrl,
      projectTitle: discovered.projectTitle,
      projectUrl: matches[0].projectUrl || discovered.projectUrl,
    };
  }

  async withReadOnlyConversation(input, callback) {
    const target = await this.resolveReadOnlyConversation(input);
    const lease = await this.browserManager.leasePage(`artifact-${randomUUID()}`, {
      discovery: true,
      headless: Boolean(input.headless),
    });
    try {
      const opened = await openExistingConversation(lease.page, {
        conversationUrl: target.conversationUrl,
        title: target.chatTitle,
      });
      return await callback(lease.page, {
        ...target,
        chatTitle: target.chatTitle || opened.title || null,
        conversationUrl: opened.url,
        projectTitle: target.projectTitle || opened.projectTitle || null,
        projectUrl: target.projectUrl || opened.projectUrl || null,
      });
    } finally {
      await this.browserManager.releasePage(lease.jobId);
    }
  }

  async listChatArtifacts(input) {
    return this.withReadOnlyConversation(input, async (page, target) => {
      const candidates = await listAssistantDownloadCandidates(page, { scope: input.scope });
      return { ...target, scope: input.scope, downloads: publicDownloadCandidates(candidates) };
    });
  }

  async downloadChatArtifact(input) {
    return this.browserManager.withDownload(() =>
      this.withReadOnlyConversation(input, async (page, target) => ({
        ...target,
        ...(await downloadAssistantArtifact(page, {
          linkText: input.linkText,
          scope: input.scope,
          maxBytes: input.maxBytes,
          allowBrowserDownload: this.browserManager.browserName !== "safari",
          browserGeneration: this.browserManager.browserGeneration,
        })),
      })),
    );
  }

  async methods() {
    return {
      "broker.openSession": (params, context) => this.openClientSession({
        ...(context?.client || {}),
        ...params,
        protocolVersion: context?.protocolVersion,
      }, { readOnly: Boolean(context?.readOnlyCompatibility) }),
      "broker.status": () => this.statusAsync(),
      "workflow.doctor": async () => ({ ...(await doctor()), broker: await this.statusAsync() }),
      "workflow.selectBrowser": (params) => this.selectBrowser(params.browser),
      "workflow.profiles": async () => ({ profiles: await listFirefoxProfiles() }),
      "workflow.setup": (params) => {
        if (this.browserManager.browserName === "safari") {
          throw codedError(
            "SAFARI_INTERACTIVE_LOGIN_UNAVAILABLE",
            "Safari blocks manual interaction with WebDriver automation windows. Explicitly approve import_session from a closed Firefox profile instead.",
          );
        }
        return this.browserManager.withManagedSetup((browser) => setupLogin({
          browser,
          browserName: this.browserManager.browserName,
          timeoutMs: (params.timeoutSeconds ?? 300) * 1_000,
        }));
      },
      "workflow.importSession": (params) => {
        if (params.confirmImport !== true) {
          throw codedError(
            "IMPORT_CONFIRMATION_REQUIRED",
            "Session import requires explicit confirmation before Oracle reads or copies ChatGPT/OpenAI cookies.",
          );
        }
        if (this.browserManager.browserName === "firefox") {
          return this.browserManager.withMaintenance(() => importFirefoxSession(params));
        }
        return this.browserManager.withManagedSetup((browser) => importSessionIntoManagedBrowser({
          browser,
          browserName: this.browserManager.browserName,
          ...params,
        }));
      },
      "workflow.listProjects": (params) => discoverProjects(this.browserManager, params),
      "workflow.findChats": (params) => discoverChats(this.browserManager, params),
      "workflow.listChatArtifacts": (params) => this.listChatArtifacts(params),
      "workflow.downloadChatArtifact": (params) => this.downloadChatArtifact(params),
      "jobs.startConsult": (params, context) => this.startJob("consult", params, { caller: this.callerFromContext(context) }),
      "jobs.startContinue": (params, context) => this.startJob("continue_chat", params, { caller: this.callerFromContext(context) }),
      "jobs.recoverStartReceipt": (params, context) => this.recoverStartReceipt(params, context),
      "jobs.compatConsult": async (params, context) => this.waitCompatibility(await this.startJob("consult", params, { generatedAuthorization: !params.authorizationId, caller: this.callerFromContext(context) }), 240),
      "jobs.compatContinue": async (params, context) => this.waitCompatibility(await this.startJob("continue_chat", params, { generatedAuthorization: !params.authorizationId, caller: this.callerFromContext(context) }), 240),
      "jobs.status": (params, context) => {
        const { job } = this.accessibleJob(params, context);
        return this.getJob(job.id, params.followRetries !== false);
      },
      "jobs.wait": (params, context) => {
        const { job } = this.accessibleJob(params, context);
        return this.waitForJob(job.id, params.timeoutSeconds, params.followRetries !== false);
      },
      "jobs.result": (params, context) => {
        const { job } = this.accessibleJob(params, context);
        return this.result(job.id, params.followRetries !== false);
      },
      "jobs.list": (params, context) => this.listJobs(params, this.callerFromContext(context)),
      "jobs.listAttention": (_params, context) => this.listAttention(this.callerFromContext(context)),
      "jobs.inspectQuarantine": (params, context) => {
        this.callerFromContext(context);
        return this.inspectQuarantine(params.conversationUrl);
      },
      "jobs.inspectInputRequest": (params, context) => {
        this.callerFromContext(context);
        return this.inspectInputRequest(params.conversationUrl);
      },
      "jobs.abandonInputRequest": (params, context) => this.abandonInputRequest(params, context),
      "jobs.abandonOrphanedInputRequest": (params, context) => this.abandonOrphanedInputRequest(params, context),
      "jobs.recoverOrphanedQuarantine": (params, context) => this.recoverOrphanedQuarantine(params, context),
      "jobs.reconcile": (params, context) => {
        const { job } = this.accessibleJob(params, context, { control: true });
        return this.reconcile(job.id, params.conversationUrl);
      },
      "jobs.acknowledge": (params, context) => {
        const { job } = this.accessibleJob(params, context, { control: true });
        return this.acknowledge(job.id);
      },
      "jobs.cancel": (params, context) => {
        const { job } = this.accessibleJob(params, context, { control: true });
        return this.cancel(job.id);
      },
      "jobs.replyWithLocalData": (params, context) => this.replyWithLocalData(params, context),
      "completion.claim": (params, context) => this.claimCompletion(params, context),
      "completion.wait": (params, context) => this.waitCompletion(params, context),
      "completion.delivered": (params, context) => this.store.markCompletionDelivered(
        params.completionHandle,
        this.callerFromContext(context),
        params.deliveryId,
        params.claimId,
      ),
      "completion.acknowledge": (params, context) => this.store.acknowledgeCompletion(
        params.completionHandle,
        this.callerFromContext(context),
        params.deliveryId,
      ),
      "broker.setEmergencyLock": (params) => this.setEmergencyLock(Boolean(params.enabled)),
    };
  }
}

export { publicJob, structuredError };
