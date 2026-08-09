import { backup, DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { coordinatorDatabasePath } from "./config.mjs";
import { codedError, structuredError } from "./errors.mjs";
import { isTemplateLocalDataRequest } from "./evidence.mjs";
import { mintCapability, parseCapability, verifyCapability } from "./capabilities.mjs";
import {
  BROKER_PROTOCOL_VERSION,
  BROKER_MINIMUM_READER_PROTOCOL,
  BROKER_MINIMUM_WRITER_PROTOCOL,
  BROKER_RELEASE_SEQUENCE,
  BROKER_SCHEMA_VERSION,
  BROKER_BUILD_ID,
  ORACLE_FIREFOX_VERSION,
} from "./build-info.mjs";

export const JOB_STATES = Object.freeze([
  "accepted",
  "snapshotted",
  "queued",
  "page_leased",
  "target_verified",
  "attachment_processing",
  "composer_verified",
  "model_verified",
  "submit_intent",
  "user_turn_confirmed",
  "awaiting_response",
  "response_failed_detected",
  "response_confirmed",
  "completed",
  "cancelled_pre_submit",
  "failed_pre_submit",
  "submission_uncertain",
  "response_uncertain",
  "response_failed",
  "input_invalid",
  "quarantined",
]);

export const TERMINAL_JOB_STATES = new Set([
  "completed",
  "cancelled_pre_submit",
  "failed_pre_submit",
  "submission_uncertain",
  "response_uncertain",
  "response_failed",
  "input_invalid",
  "quarantined",
]);

const STATE_INDEX = new Map(JOB_STATES.map((state, index) => [state, index]));
const SUBMIT_INDEX = STATE_INDEX.get("submit_intent");
const PRE_SUBMIT_JOB_STATES = new Set(JOB_STATES.slice(0, SUBMIT_INDEX));
const MONITOR_JOB_STATES = new Set([
  "user_turn_confirmed",
  "awaiting_response",
  "response_failed_detected",
  "response_confirmed",
]);

function isCanonicalConversationUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "https:" && parsed.hostname === "chatgpt.com" &&
      !parsed.search && !parsed.hash &&
      (/^\/c\/[a-zA-Z0-9-]+$/u.test(parsed.pathname) ||
        /^\/g\/g-p-[^/]+\/c\/[a-zA-Z0-9-]+$/u.test(parsed.pathname));
  } catch {
    return false;
  }
}

function hasExactUserTurnProof(job) {
  return Boolean(
    job?.submitIntentAt &&
    isCanonicalConversationUrl(job?.conversationUrl) &&
    (job?.userTurnId || job?.userTurnHash)
  );
}

function json(value) {
  return value == null ? null : JSON.stringify(value);
}

function parse(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    authorizationId: row.authorization_id,
    operation: row.operation,
    state: row.state,
    request: parse(row.request_json),
    requestDigest: row.request_digest,
    conversationKey: row.conversation_key,
    conversationUrl: row.canonical_url,
    projectTitle: row.project_title,
    projectUrl: row.project_url,
    chatTitle: row.chat_title,
    sessionPath: row.session_path,
    userTurnId: row.user_turn_id,
    userTurnHash: row.user_turn_hash,
    submittedMessageHash: row.submitted_message_hash,
    attachmentManifest: parse(row.attachment_manifest_json) ?? [],
    modelEvidence: parse(row.model_evidence_json),
    assistantDisposition: row.assistant_disposition,
    responseDisposition: row.response_disposition,
    responseFailure: parse(row.response_failure_json),
    localDataRequest: parse(row.local_data_request_json),
    evidenceRound: row.evidence_round,
    maxAutomaticEvidenceReplies: row.max_evidence_replies,
    submissionMayHaveOccurred: Boolean(row.submission_may_have_happened),
    submitIntentAt: row.submit_intent_at,
    result: parse(row.result_json),
    error: parse(row.error_json),
    recoveryAction: row.recovery_action,
    parentJobId: row.parent_job_id,
    rootJobId: row.root_job_id || row.id,
    replacementJobId: row.replacement_job_id,
    retryAttempt: row.retry_attempt ?? 0,
    maxAutomaticResponseRetries: row.max_response_retries ?? 0,
    chainId: row.chain_id || row.root_job_id || row.id,
    attemptKind: row.attempt_kind || "initial",
    attemptOrdinal: row.attempt_ordinal ?? 0,
    executionEpoch: row.execution_epoch ?? 0,
    executionOwnerInstanceId: row.execution_owner_instance_id ?? null,
    executionLeaseGeneration: row.execution_lease_generation ?? null,
    executionState: row.execution_state ?? "idle",
    executionKind: row.execution_kind ?? "pre_submit",
    executionFailureCount: row.execution_failure_count ?? 0,
    nextExecutionNotBefore: row.next_execution_not_before ?? null,
    lastExecutorError: parse(row.last_executor_error_json),
    monitorDeadlineAt: row.monitor_deadline_at ?? null,
    finalReconciliationAttemptedAt: row.final_reconciliation_attempted_at ?? null,
    assistantTurnId: row.assistant_turn_id ?? null,
    assistantTurnHash: row.assistant_turn_hash ?? null,
    chainState: row.chain_state ?? null,
    inputRequestAbandonedAt: row.input_required_abandoned_at ?? null,
    inputRequestAbandonedReason: row.input_required_abandoned_reason ?? null,
    attentionRequiredAt: row.attention_required_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    version: row.version,
    lastRecoveryGeneration: row.last_recovery_generation ?? 0,
  };
}

function rowToChain(row) {
  if (!row) return null;
  return {
    id: row.id,
    rootJobId: row.root_job_id,
    originSessionId: row.origin_session_id,
    acceptedSequence: row.accepted_sequence,
    state: row.state,
    activeJobId: row.active_job_id,
    targetKind: row.target_kind,
    conversationKey: row.conversation_key,
    conversationUrl: row.canonical_url,
    completionMode: row.completion_mode,
    legacyMode: row.legacy_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
    inputRequestAbandonedAt: row.input_required_abandoned_at,
    inputRequestAbandonedJobId: row.input_required_abandoned_job_id,
    inputRequestAbandonedReason: row.input_required_abandoned_reason,
    attentionRequiredAt: row.attention_required_at,
  };
}

function quarantineFingerprint(row) {
  if (!row) return null;
  return createHash("sha256").update([
    "oracle-firefox-quarantine-v1",
    row.scope_key,
    row.job_id,
    row.created_at,
  ].map((value) => String(value ?? "")).join("\0")).digest("hex");
}

function inputRequestFingerprint(row) {
  if (!row) return null;
  return createHash("sha256").update([
    "oracle-firefox-input-request-v1",
    row.conversation_key,
    row.id,
    row.active_job_id,
    row.created_at,
  ].map((value) => String(value ?? "")).join("\0")).digest("hex");
}

function blockerAgeSeconds(row, nowMs = Date.now()) {
  const createdMs = Date.parse(row.created_at || row.updated_at || 0);
  return Number.isFinite(createdMs) ? Math.max(0, Math.floor((nowMs - createdMs) / 1_000)) : null;
}

function sanitizedInputBlocker(row, nowMs = Date.now()) {
  const invalid = row.job_state === "input_invalid" || row.assistant_disposition === "input_invalid";
  return {
    fingerprint: inputRequestFingerprint(row),
    type: invalid ? "input_invalid" : "local_data",
    ageSeconds: blockerAgeSeconds({
      created_at: row.updated_at || row.created_at,
    }, nowMs),
    state: row.attention_required_at ? "attention_required" : "waiting_for_owner",
  };
}

function sanitizedQuarantineBlocker(row, nowMs = Date.now()) {
  return {
    fingerprint: quarantineFingerprint(row),
    type: "uncertainty",
    ageSeconds: blockerAgeSeconds(row, nowMs),
    state: "reconciliation_required",
  };
}

const WAKE_CHAIN_STATES = new Set([
  "input_required",
  "input_invalid",
  "attention_required",
  "completed",
  "failed",
  "cancelled",
  "submission_uncertain",
  "response_uncertain",
  "quarantined",
]);

const TERMINAL_CHAIN_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "submission_uncertain",
  "response_uncertain",
  "quarantined",
  "legacy_inconsistent",
]);

export function requestDigest(request) {
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .filter((key) => value[key] !== undefined)
          .sort()
          .map((key) => [key, canonicalize(value[key])]),
      );
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(request))).digest("hex");
}

export class StateStore extends EventEmitter {
  constructor(databasePath = coordinatorDatabasePath(), options = {}) {
    super();
    this.databasePath = databasePath;
    this.db = null;
    this.productionFencing = Boolean(options.brokerContext) && options.allowUnfenced !== true;
    this.brokerContext = options.brokerContext || {
      coordinatorId: `test:${createHash("sha256").update(path.resolve(databasePath)).digest("hex")}`,
      instanceId: `test-${randomUUID()}`,
      leaseGeneration: 0,
      protocolVersion: BROKER_PROTOCOL_VERSION,
      minimumReaderProtocol: BROKER_MINIMUM_READER_PROTOCOL,
      minimumWriterProtocol: BROKER_MINIMUM_WRITER_PROTOCOL,
      releaseSequence: BROKER_RELEASE_SEQUENCE,
      buildVersion: ORACLE_FIREFOX_VERSION,
      buildId: BROKER_BUILD_ID,
      pid: process.pid,
      processStartId: "test-process",
      endpoint: "test://state-store",
      endpointKind: "test",
      endpointDevice: null,
      endpointInode: null,
    };
  }

  async open() {
    if (this.db) return this;
    try {
      await mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
      await chmod(path.dirname(this.databasePath), 0o700);
      this.db = new DatabaseSync(this.databasePath);
      await chmod(this.databasePath, 0o600);
      this.registerWriterFunctions();
      if (this.productionFencing) {
        this.db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN EXCLUSIVE; COMMIT;");
      } else {
        this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      }
      const existingVersion = this.schemaVersionBeforeMigration();
      if (existingVersion >= BROKER_SCHEMA_VERSION) {
        this.registerBrokerTakeover();
        this.migrateSix({ existing: true });
        this.migrateEight();
      } else {
        if (this.productionFencing && existingVersion > 0) await this.backupBeforeMigration();
        const integrity = this.db.prepare("PRAGMA integrity_check").get()?.integrity_check;
        if (integrity !== "ok" || this.db.prepare("PRAGMA foreign_key_check").all().length > 0) {
          throw codedError("COORDINATOR_DATABASE_INVALID", "Oracle Firefox refused to migrate a coordinator database that failed integrity checks.");
        }
        // Schema v6 introduced broker-generation writer guards. A successor
        // must take ownership before any later migration touches guarded job
        // tables; otherwise the new broker correctly fences its own upgrade.
        const hasBrokerGenerationGuards = existingVersion >= 6;
        if (hasBrokerGenerationGuards) this.registerBrokerTakeover();
        this.migrateLegacy();
        this.migrateSix({ existing: hasBrokerGenerationGuards });
        if (!hasBrokerGenerationGuards) this.registerBrokerTakeover();
        this.migrateEight();
      }
      this.migrateDisconnectRecovery();
      this.backfillUntrackedUncertaintyQuarantines();
      return this;
    } catch (error) {
      try { this.db?.close(); } catch {}
      this.db = null;
      throw error;
    }
  }

  registerWriterFunctions() {
    this.db.function("oracle_writer_protocol", () => Number(this.brokerContext.protocolVersion || 0));
    this.db.function("oracle_broker_instance", () => String(this.brokerContext.instanceId || ""));
    this.db.function("oracle_lease_generation", () => Number(this.brokerContext.leaseGeneration || 0));
    this.db.function("oracle_canonical_conversation_url", (value) => isCanonicalConversationUrl(value) ? 1 : 0);
  }

  schemaVersionBeforeMigration() {
    try {
      return Number(this.db.prepare("SELECT COALESCE(MAX(version), 0) version FROM schema_migrations").get().version);
    } catch {
      return 0;
    }
  }

  async backupBeforeMigration() {
    const target = `${this.databasePath}.pre-v${BROKER_SCHEMA_VERSION}.bak`;
    const exists = await stat(target).then(() => true, () => false);
    if (!exists) await backup(this.db, target);
  }

  migrateLegacy() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        authorization_id TEXT NOT NULL UNIQUE,
        operation TEXT NOT NULL,
        state TEXT NOT NULL,
        request_json TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        canonical_url TEXT,
        project_title TEXT,
        project_url TEXT,
        chat_title TEXT,
        session_path TEXT NOT NULL,
        user_turn_id TEXT,
        user_turn_hash TEXT,
        submitted_message_hash TEXT,
        attachment_manifest_json TEXT,
        model_evidence_json TEXT,
        assistant_disposition TEXT,
        response_disposition TEXT,
        response_failure_json TEXT,
        local_data_request_json TEXT,
        evidence_round INTEGER NOT NULL DEFAULT 0,
        max_evidence_replies INTEGER NOT NULL DEFAULT 3,
        submission_may_have_happened INTEGER NOT NULL DEFAULT 0,
        submit_intent_at TEXT,
        result_json TEXT,
        error_json TEXT,
        recovery_action TEXT,
        parent_job_id TEXT,
        root_job_id TEXT,
        replacement_job_id TEXT,
        retry_attempt INTEGER NOT NULL DEFAULT 0,
        max_response_retries INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        version INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS jobs_state_created ON jobs(state, created_at);
      CREATE INDEX IF NOT EXISTS jobs_conversation_state ON jobs(conversation_key, state, created_at);
      CREATE TABLE IF NOT EXISTS job_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS job_events_job_sequence ON job_events(job_id, sequence);
      CREATE TABLE IF NOT EXISTS quarantines (
        scope_key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        reason TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT
      );
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
    `);
    const jobColumns = new Set(this.db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name));
    if (!jobColumns.has("submitted_message_hash")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN submitted_message_hash TEXT");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)")
      .run(new Date().toISOString());
    const durableColumns = [
      ["response_disposition", "TEXT"],
      ["response_failure_json", "TEXT"],
      ["parent_job_id", "TEXT"],
      ["root_job_id", "TEXT"],
      ["replacement_job_id", "TEXT"],
      ["retry_attempt", "INTEGER NOT NULL DEFAULT 0"],
      ["max_response_retries", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, definition] of durableColumns) {
      if (!jobColumns.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec("UPDATE jobs SET root_job_id = id WHERE root_job_id IS NULL");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)")
      .run(new Date().toISOString());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner_sessions (
        id TEXT PRIMARY KEY,
        harness TEXT NOT NULL,
        client_instance_id TEXT,
        host_session_hint TEXT,
        session_cap_hash TEXT,
        isolation_strength TEXT NOT NULL DEFAULT 'chain'
          CHECK (isolation_strength IN ('chain', 'host_session', 'legacy', 'admin')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS owner_sessions_cap_hash
        ON owner_sessions(session_cap_hash) WHERE session_cap_hash IS NOT NULL;

      CREATE TABLE IF NOT EXISTS scheduler_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_chains (
        id TEXT PRIMARY KEY,
        root_job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) DEFERRABLE INITIALLY DEFERRED,
        origin_session_id TEXT NOT NULL REFERENCES owner_sessions(id),
        accepted_sequence INTEGER NOT NULL UNIQUE,
        state TEXT NOT NULL,
        active_job_id TEXT REFERENCES jobs(id) DEFERRABLE INITIALLY DEFERRED,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('existing', 'new_standalone', 'new_project')),
        conversation_key TEXT NOT NULL,
        canonical_url TEXT,
        completion_mode TEXT NOT NULL DEFAULT 'manual',
        read_cap_hash TEXT,
        control_cap_hash TEXT,
        legacy_mode TEXT NOT NULL DEFAULT 'none'
          CHECK (legacy_mode IN ('none', 'unclaimed', 'claimed', 'inconsistent')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT
      );
      CREATE INDEX IF NOT EXISTS job_chains_scope_sequence
        ON job_chains(conversation_key, accepted_sequence);
      CREATE INDEX IF NOT EXISTS job_chains_state_sequence
        ON job_chains(state, accepted_sequence);

      CREATE TABLE IF NOT EXISTS job_attempts (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        chain_id TEXT NOT NULL REFERENCES job_chains(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('initial', 'response_recovery', 'evidence_reply')),
        ordinal INTEGER NOT NULL,
        parent_job_id TEXT REFERENCES jobs(id),
        execution_epoch INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(chain_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS job_attempts_chain ON job_attempts(chain_id, ordinal);

      CREATE TABLE IF NOT EXISTS chain_session_grants (
        chain_id TEXT NOT NULL REFERENCES job_chains(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES owner_sessions(id) ON DELETE CASCADE,
        can_read INTEGER NOT NULL DEFAULT 1 CHECK (can_read IN (0, 1)),
        can_control INTEGER NOT NULL DEFAULT 0 CHECK (can_control IN (0, 1)),
        can_list INTEGER NOT NULL DEFAULT 1 CHECK (can_list IN (0, 1)),
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY(chain_id, session_id)
      );

      CREATE TABLE IF NOT EXISTS chain_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        chain_id TEXT NOT NULL REFERENCES job_chains(id) ON DELETE CASCADE,
        active_job_id TEXT REFERENCES jobs(id),
        state TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chain_events_chain_sequence
        ON chain_events(chain_id, sequence);

      CREATE TABLE IF NOT EXISTS completion_subscriptions (
        id TEXT PRIMARY KEY,
        chain_id TEXT NOT NULL REFERENCES job_chains(id) ON DELETE CASCADE,
        owner_session_id TEXT NOT NULL REFERENCES owner_sessions(id),
        mode TEXT NOT NULL CHECK (mode IN ('manual', 'notify', 'harness')),
        capability_hash TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS completion_subscriptions_owner
        ON completion_subscriptions(owner_session_id, state, created_at);

      CREATE TABLE IF NOT EXISTS completion_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription_id TEXT NOT NULL REFERENCES completion_subscriptions(id) ON DELETE CASCADE,
        chain_event_sequence INTEGER NOT NULL REFERENCES chain_events(sequence) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending', 'claimed', 'delivered', 'acknowledged')),
        claim_id TEXT,
        claimed_at TEXT,
        delivered_at TEXT,
        acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(subscription_id, chain_event_sequence)
      );
      CREATE INDEX IF NOT EXISTS completion_deliveries_subscription_state
        ON completion_deliveries(subscription_id, state, id);

      CREATE TABLE IF NOT EXISTS account_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        gate_version INTEGER NOT NULL DEFAULT 0,
        next_submit_not_before TEXT,
        cooldown_until TEXT,
        cooldown_code TEXT,
        cooldown_count INTEGER NOT NULL DEFAULT 0,
        effective_concurrency INTEGER NOT NULL DEFAULT 5,
        success_streak INTEGER NOT NULL DEFAULT 0,
        probe_in_flight INTEGER NOT NULL DEFAULT 0,
        last_success_at TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO account_state(id, updated_at) VALUES (1, datetime('now'));

      CREATE TABLE IF NOT EXISTS submit_permits (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        gate_version INTEGER NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        invalidated_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS submit_permits_open_job
        ON submit_permits(job_id) WHERE consumed_at IS NULL AND invalidated_at IS NULL;
    `);
    this.backfillLegacyChains();
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, ?)")
      .run(new Date().toISOString());
    const migrationFive = this.db.prepare("SELECT 1 present FROM schema_migrations WHERE version = 5").get();
    if (!migrationFive) {
      const account = this.db.prepare("SELECT cooldown_until FROM account_state WHERE id = 1").get();
      const cooldownActive = account?.cooldown_until && Date.parse(account.cooldown_until) > Date.now();
      this.db.prepare("UPDATE account_state SET effective_concurrency = ?, updated_at = ? WHERE id = 1")
        .run(cooldownActive ? 0 : 5, new Date().toISOString());
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (5, ?)")
        .run(new Date().toISOString());
    }
  }

  migrateSix({ existing = false } = {}) {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS broker_instances (
          instance_id TEXT PRIMARY KEY,
          coordinator_id TEXT NOT NULL,
          lease_generation INTEGER NOT NULL UNIQUE,
          pid INTEGER NOT NULL,
          process_start_id TEXT,
          endpoint TEXT NOT NULL,
          endpoint_kind TEXT NOT NULL,
          endpoint_device TEXT,
          endpoint_inode TEXT,
          protocol_version INTEGER NOT NULL,
          release_sequence INTEGER NOT NULL,
          build_version TEXT NOT NULL,
          build_id TEXT NOT NULL,
          state TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ready_at TEXT,
          heartbeat_at TEXT NOT NULL,
          draining_at TEXT,
          released_at TEXT,
          exit_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS broker_instances_generation ON broker_instances(lease_generation);
        CREATE TABLE IF NOT EXISTS broker_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          coordinator_id TEXT NOT NULL,
          current_instance_id TEXT REFERENCES broker_instances(instance_id),
          current_lease_generation INTEGER NOT NULL DEFAULT 0,
          last_recovery_generation INTEGER NOT NULL DEFAULT 0,
          minimum_reader_protocol INTEGER NOT NULL,
          minimum_writer_protocol INTEGER NOT NULL,
          qualified_concurrency INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        );
      `);
      this.db.prepare(`
        INSERT OR IGNORE INTO broker_state(
          id, coordinator_id, current_lease_generation, last_recovery_generation,
          minimum_reader_protocol, minimum_writer_protocol, qualified_concurrency, updated_at
        ) VALUES (1, ?, 0, 0, ?, ?, 1, ?)
      `).run(
        this.brokerContext.coordinatorId,
        BROKER_MINIMUM_READER_PROTOCOL,
        BROKER_MINIMUM_WRITER_PROTOCOL,
        now,
      );

      const addColumns = (table, columns) => {
        const known = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
        for (const [name, definition] of columns) {
          if (!known.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
      };
      addColumns("job_attempts", [
        ["execution_owner_instance_id", "TEXT"],
        ["execution_lease_generation", "INTEGER"],
        ["execution_state", "TEXT NOT NULL DEFAULT 'idle'"],
        ["execution_started_at", "TEXT"],
        ["execution_heartbeat_at", "TEXT"],
        ["execution_failure_count", "INTEGER NOT NULL DEFAULT 0"],
        ["next_execution_not_before", "TEXT"],
        ["last_executor_error_json", "TEXT"],
      ]);
      addColumns("jobs", [["last_recovery_generation", "INTEGER NOT NULL DEFAULT 0"]]);
      addColumns("job_chains", [
        ["input_required_abandoned_at", "TEXT"],
        ["input_required_abandoned_job_id", "TEXT"],
        ["input_required_abandoned_reason", "TEXT"],
      ]);
      addColumns("job_events", [
        ["broker_instance_id", "TEXT"],
        ["lease_generation", "INTEGER"],
      ]);
      addColumns("chain_events", [
        ["broker_instance_id", "TEXT"],
        ["lease_generation", "INTEGER"],
      ]);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS job_attempts_execution_ready
          ON job_attempts(execution_state, next_execution_not_before, execution_lease_generation);
        CREATE INDEX IF NOT EXISTS jobs_recovery_generation
          ON jobs(last_recovery_generation, state);
      `);
      if (!existing) {
        this.db.prepare("UPDATE account_state SET effective_concurrency = CASE WHEN cooldown_until IS NULL THEN 1 ELSE 0 END, updated_at = ? WHERE id = 1")
          .run(now);
      }
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (7, ?)")
        .run(now);
      this.installWriterGuards();
    });
    if (existing) this.assertCoordinatorIdentity();
  }

  migrateEight() {
    const migration = this.db.prepare("SELECT 1 present FROM schema_migrations WHERE version = 8").get();
    if (migration) {
      this.installWriterGuards();
      return;
    }
    const now = new Date().toISOString();
    this.transaction(() => {
      const addColumns = (table, columns) => {
        const known = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
        for (const [name, definition] of columns) {
          if (!known.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
      };
      addColumns("job_attempts", [
        ["execution_kind", "TEXT NOT NULL DEFAULT 'pre_submit' CHECK (execution_kind IN ('pre_submit', 'monitor_only'))"],
        ["monitor_deadline_at", "TEXT"],
        ["final_reconciliation_attempted_at", "TEXT"],
      ]);
      addColumns("jobs", [
        ["assistant_turn_id", "TEXT"],
        ["assistant_turn_hash", "TEXT"],
      ]);

      const submitted = this.db.prepare(`
        SELECT j.id, j.submit_intent_at, j.request_json, j.canonical_url,
               j.user_turn_id, j.user_turn_hash, j.state
        FROM jobs j JOIN job_attempts a ON a.job_id = j.id
        WHERE j.submit_intent_at IS NOT NULL
      `).all();
      for (const row of submitted) {
        const request = parse(row.request_json) || {};
        const timeoutSeconds = Math.max(30, Math.min(86_400, Number(request.responseTimeoutSeconds) || 10_800));
        const submittedAt = Number.isFinite(Date.parse(row.submit_intent_at)) ? Date.parse(row.submit_intent_at) : Date.now();
        const deadline = new Date(submittedAt + timeoutSeconds * 1_000).toISOString();
        const exactTurn = Boolean(isCanonicalConversationUrl(row.canonical_url) && (row.user_turn_id || row.user_turn_hash));
        this.db.prepare(`
          UPDATE job_attempts SET execution_kind=?, monitor_deadline_at=COALESCE(monitor_deadline_at, ?)
          WHERE job_id=?
        `).run(exactTurn ? "monitor_only" : "pre_submit", deadline, row.id);
        if (exactTurn && PRE_SUBMIT_JOB_STATES.has(row.state)) {
          this.db.prepare(`
            UPDATE jobs SET state='awaiting_response', updated_at=?, version=version+1,
              recovery_action='reattach submitted turn without resending'
            WHERE id=?
          `).run(now, row.id);
          const attempt = this.db.prepare("SELECT chain_id FROM job_attempts WHERE job_id=?").get(row.id);
          this.db.prepare("UPDATE job_chains SET state='running', updated_at=? WHERE id=?")
            .run(now, attempt.chain_id);
          this.db.prepare(`
            INSERT INTO job_events(job_id,state,details_json,created_at,broker_instance_id,lease_generation)
            VALUES (?, 'awaiting_response', ?, ?, ?, ?)
          `).run(row.id, json({ migratedMonitorOnly: true, schemaVersion: 8 }), now, this.brokerContext.instanceId, this.brokerContext.leaseGeneration);
        }
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS job_attempts_execution_kind_ready
          ON job_attempts(execution_kind, execution_state, next_execution_not_before, monitor_deadline_at);
      `);
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (8, ?)").run(now);
      this.installWriterGuards();
    });
  }

  migrateDisconnectRecovery() {
    const addColumns = (table, columns) => {
      const known = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
      for (const [name, definition] of columns) {
        if (!known.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    this.transaction(() => {
      addColumns("job_chains", [
        ["start_receipt_cap_hash", "TEXT"],
        ["start_receipt_recovered_at", "TEXT"],
        ["start_receipt_recovery_count", "INTEGER NOT NULL DEFAULT 0"],
        ["attention_required_at", "TEXT"],
      ]);
      addColumns("completion_deliveries", [
        ["claim_kind", "TEXT"],
        ["claim_expires_at", "TEXT"],
        ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
        ["next_attempt_at", "TEXT"],
        ["last_error_json", "TEXT"],
      ]);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS completion_deliveries_system_ready
          ON completion_deliveries(state, next_attempt_at, claim_expires_at, id);
        CREATE TABLE IF NOT EXISTS cooldown_incidents (
          evidence_fingerprint TEXT PRIMARY KEY,
          evidence_kind TEXT NOT NULL,
          code TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          observer_count INTEGER NOT NULL DEFAULT 1,
          cooldown_until TEXT NOT NULL
        );
      `);
      this.db.exec(`
        UPDATE completion_deliveries
        SET state='pending', claim_id=NULL, claimed_at=NULL
        WHERE state='claimed' AND claim_kind IS NULL;

        UPDATE completion_deliveries
        SET claim_id=NULL, claimed_at=NULL, claim_kind=NULL, claim_expires_at=NULL,
            next_attempt_at=NULL, last_error_json=NULL
        WHERE state IN ('delivered', 'acknowledged');
      `);
      this.installWriterGuards();
    });
  }

  installWriterGuards() {
    const operational = [
      "jobs", "job_events", "quarantines", "owner_sessions", "scheduler_tickets",
      "job_chains", "job_attempts", "chain_session_grants", "chain_events",
      "completion_subscriptions", "completion_deliveries", "account_state", "submit_permits",
      "cooldown_incidents",
    ];
    const metadata = ["schema_migrations", "broker_instances", "broker_state"];
    const existingTables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    for (const table of operational.filter((name) => existingTables.has(name))) {
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        const name = `oracle_guard_${table}_${action.toLowerCase()}`;
        this.db.exec(`
          DROP TRIGGER IF EXISTS ${name};
          CREATE TRIGGER ${name} BEFORE ${action} ON ${table}
          BEGIN
            SELECT CASE WHEN
              oracle_writer_protocol() < (SELECT minimum_writer_protocol FROM broker_state WHERE id = 1)
              OR oracle_broker_instance() IS NOT (SELECT current_instance_id FROM broker_state WHERE id = 1)
              OR oracle_lease_generation() != (SELECT current_lease_generation FROM broker_state WHERE id = 1)
            THEN RAISE(ABORT, 'ORACLE_BROKER_FENCE') END;
          END;
        `);
      }
    }
    for (const table of metadata) {
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        const name = `oracle_protocol_guard_${table}_${action.toLowerCase()}`;
        this.db.exec(`
          DROP TRIGGER IF EXISTS ${name};
          CREATE TRIGGER ${name} BEFORE ${action} ON ${table}
          BEGIN
            SELECT CASE WHEN
              oracle_writer_protocol() < (SELECT minimum_writer_protocol FROM broker_state WHERE id = 1)
            THEN RAISE(ABORT, 'ORACLE_WRITER_PROTOCOL_TOO_OLD') END;
          END;
        `);
      }
    }
  }

  assertCoordinatorIdentity() {
    const row = this.db.prepare("SELECT coordinator_id FROM broker_state WHERE id = 1").get();
    if (row?.coordinator_id !== this.brokerContext.coordinatorId) {
      throw codedError(
        "COORDINATOR_ID_MISMATCH",
        "The coordinator identity file does not match the durable database. Oracle Firefox stopped before recovery or scheduling.",
      );
    }
  }

  backfillUntrackedUncertaintyQuarantines() {
    this.assertCurrentBroker();
    this.db.prepare(`
      INSERT OR IGNORE INTO quarantines(scope_key, job_id, reason, active, created_at)
      SELECT conversation_key, id,
             'Uncertain submission imported from an older Oracle Firefox build; reconcile it before another send.',
             1, COALESCE(completed_at, updated_at, created_at)
      FROM jobs
      WHERE state IN ('submission_uncertain', 'response_uncertain', 'quarantined')
        AND conversation_key IS NOT NULL
    `).run();
  }

  registerBrokerTakeover() {
    const context = this.brokerContext;
    const now = new Date().toISOString();
    const generation = this.transaction(() => {
      const state = this.db.prepare("SELECT * FROM broker_state WHERE id = 1").get();
      if (!state) throw codedError("BROKER_STATE_MISSING", "Oracle Firefox broker state is unavailable.");
      if (state.coordinator_id !== context.coordinatorId) {
        throw codedError("COORDINATOR_ID_MISMATCH", "The coordinator identity does not match the durable database.");
      }
      if (state.current_instance_id) {
        this.db.prepare("UPDATE broker_instances SET state='crashed', released_at=?, exit_reason=? WHERE instance_id=? AND state NOT IN ('released','failed')")
          .run(now, "exclusive lifetime lease acquired by successor", state.current_instance_id);
      }
      const next = Number(state.current_lease_generation) + 1;
      this.db.prepare(`
        INSERT INTO broker_instances(
          instance_id, coordinator_id, lease_generation, pid, process_start_id,
          endpoint, endpoint_kind, endpoint_device, endpoint_inode,
          protocol_version, release_sequence, build_version, build_id,
          state, started_at, heartbeat_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?)
      `).run(
        context.instanceId, context.coordinatorId, next, context.pid || process.pid,
        context.processStartId || null, context.endpoint || "unknown", context.endpointKind || "unknown",
        context.endpointDevice || null, context.endpointInode || null,
        context.protocolVersion, context.releaseSequence, context.buildVersion, context.buildId, now, now,
      );
      this.db.prepare(`
        UPDATE broker_state SET current_instance_id=?, current_lease_generation=?,
          minimum_reader_protocol=?,
          minimum_writer_protocol=MAX(minimum_writer_protocol, ?), updated_at=? WHERE id=1
      `).run(
        context.instanceId,
        next,
        BROKER_MINIMUM_READER_PROTOCOL,
        BROKER_MINIMUM_WRITER_PROTOCOL,
        now,
      );
      return next;
    });
    context.leaseGeneration = generation;
    return context;
  }

  markBrokerReady() {
    this.assertCurrentBroker();
    const now = new Date().toISOString();
    this.db.prepare("UPDATE broker_instances SET state='ready', ready_at=?, heartbeat_at=? WHERE instance_id=?")
      .run(now, now, this.brokerContext.instanceId);
  }

  heartbeatBroker() {
    this.assertCurrentBroker();
    const now = new Date().toISOString();
    this.db.prepare("UPDATE broker_instances SET heartbeat_at=? WHERE instance_id=?")
      .run(now, this.brokerContext.instanceId);
    return now;
  }

  markBrokerReleased(reason = "graceful shutdown") {
    if (!this.db) return;
    const now = new Date().toISOString();
    this.transaction(() => {
      const state = this.db.prepare("SELECT * FROM broker_state WHERE id=1").get();
      if (state?.current_instance_id !== this.brokerContext.instanceId || Number(state.current_lease_generation) !== Number(this.brokerContext.leaseGeneration)) return;
      this.db.prepare("UPDATE broker_instances SET state='released', released_at=?, exit_reason=? WHERE instance_id=?")
        .run(now, reason, this.brokerContext.instanceId);
      this.db.prepare("UPDATE broker_state SET current_instance_id=NULL, updated_at=? WHERE id=1")
        .run(now);
    });
  }

  assertCurrentBroker() {
    const row = this.db.prepare("SELECT current_instance_id, current_lease_generation FROM broker_state WHERE id=1").get();
    if (
      row?.current_instance_id !== this.brokerContext.instanceId ||
      Number(row?.current_lease_generation) !== Number(this.brokerContext.leaseGeneration)
    ) {
      throw codedError("BROKER_LEASE_LOST", "This Oracle Firefox broker no longer owns the coordinator database.");
    }
    return true;
  }

  backfillLegacyChains() {
    const unassigned = this.db.prepare(`
      SELECT j.*, j.rowid AS _rowid FROM jobs j
      LEFT JOIN job_attempts a ON a.job_id = j.id
      WHERE a.job_id IS NULL
      ORDER BY j.created_at, j.rowid
    `).all();
    if (!unassigned.length) return;
    return this.transaction(() => {
    const byId = new Map(unassigned.map((row) => [row.id, row]));
    const parent = new Map(unassigned.map((row) => [row.id, row.id]));
    const find = (id) => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      while (parent.get(id) !== id) {
        const next = parent.get(id);
        parent.set(id, root);
        id = next;
      }
      return root;
    };
    const union = (left, right) => {
      if (!byId.has(left) || !byId.has(right)) return;
      const a = find(left);
      const b = find(right);
      if (a !== b) parent.set(b, a);
    };
    for (const row of unassigned) {
      if (row.parent_job_id) union(row.id, row.parent_job_id);
      if (row.replacement_job_id) union(row.id, row.replacement_job_id);
      if (row.root_job_id) union(row.id, row.root_job_id);
    }
    const groups = new Map();
    for (const row of unassigned) {
      const key = find(row.id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const rows of groups.values()) {
      rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a._rowid - b._rowid);
      const rowIds = new Set(rows.map((row) => row.id));
      const roots = rows.filter((row) => !row.parent_job_id || !rowIds.has(row.parent_job_id));
      const missingParent = rows.some((row) => row.parent_job_id && !byId.has(row.parent_job_id));
      const canonicalUrls = new Set(rows.map((row) => row.canonical_url).filter(Boolean));
      const nonterminalRows = rows.filter((row) => !TERMINAL_JOB_STATES.has(row.state));
      const childCounts = new Map();
      for (const row of rows) {
        if (row.parent_job_id && rowIds.has(row.parent_job_id)) {
          childCounts.set(row.parent_job_id, (childCounts.get(row.parent_job_id) || 0) + 1);
        }
      }
      const hasCycle = (edgeFor) => {
        const visiting = new Set();
        const visited = new Set();
        const visit = (id) => {
          if (visiting.has(id)) return true;
          if (visited.has(id)) return false;
          visiting.add(id);
          const next = edgeFor(byId.get(id));
          if (next && rowIds.has(next) && visit(next)) return true;
          visiting.delete(id);
          visited.add(id);
          return false;
        };
        return rows.some((row) => visit(row.id));
      };
      const inconsistent =
        missingParent ||
        roots.length !== 1 ||
        canonicalUrls.size > 1 ||
        nonterminalRows.length > 1 ||
        [...childCounts.values()].some((count) => count > 1) ||
        hasCycle((row) => row?.parent_job_id) ||
        hasCycle((row) => row?.replacement_job_id);
      const root = roots[0] || rows[0];
      const ownerId = `legacy-${root.id}`;
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT OR IGNORE INTO owner_sessions(
          id, harness, isolation_strength, metadata_json, created_at, last_seen_at
        ) VALUES (?, 'legacy', 'legacy', '{}', ?, ?)
      `).run(ownerId, root.created_at || now, now);
      const ticket = Number(this.db.prepare("INSERT INTO scheduler_tickets(created_at) VALUES (?)").run(root.created_at || now).lastInsertRowid);
      const active = rows.findLast((row) => !TERMINAL_JOB_STATES.has(row.state)) || rows.at(-1);
      const targetKind = root.operation === "continue_chat"
        ? "existing"
        : root.project_url ? "new_project" : "new_standalone";
      this.db.prepare(`
        INSERT OR IGNORE INTO job_chains(
          id, root_job_id, origin_session_id, accepted_sequence, state, active_job_id,
          target_kind, conversation_key, canonical_url, completion_mode, legacy_mode,
          created_at, updated_at, terminal_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unclaimed', ?, ?, ?)
      `).run(
        root.id,
        root.id,
        ownerId,
        ticket,
        inconsistent ? "legacy_inconsistent" : this.chainStateForJob(active),
        active.id,
        targetKind,
        active.conversation_key,
        active.canonical_url,
        parse(root.request_json)?.completionMode || "manual",
        root.created_at || now,
        active.updated_at || now,
        inconsistent || TERMINAL_JOB_STATES.has(active.state) ? (active.completed_at || now) : null,
      );
      if (inconsistent) {
        this.db.prepare("UPDATE job_chains SET legacy_mode = 'inconsistent' WHERE id = ?").run(root.id);
      }
      rows.forEach((row, ordinal) => {
        const kind = row.evidence_round > 0
          ? "evidence_reply"
          : row.retry_attempt > 0 ? "response_recovery" : "initial";
        this.db.prepare(`
          INSERT OR IGNORE INTO job_attempts(
            job_id, chain_id, kind, ordinal, parent_job_id, execution_epoch, created_at
          ) VALUES (?, ?, ?, ?, ?, 0, ?)
        `).run(row.id, root.id, kind, ordinal, row.parent_job_id, row.created_at || now);
        if (!inconsistent) this.db.prepare("UPDATE jobs SET root_job_id = ? WHERE id = ?").run(root.id, row.id);
      });
    }
    });
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  chainStateForJob(job, chain = null) {
    if (!job) return "failed";
    if (
      job.state === "input_invalid" &&
      chain?.input_required_abandoned_job_id !== job.id
    ) return "input_invalid";
    if (
      job.state === "completed" &&
      parse(job.local_data_request_json) &&
      chain?.input_required_abandoned_job_id !== job.id
    ) return "input_required";
    if (job.state === "completed") return "completed";
    if (job.state === "cancelled_pre_submit") return "cancelled";
    if (job.state === "submission_uncertain") return "submission_uncertain";
    if (job.state === "response_uncertain") return "response_uncertain";
    if (job.state === "quarantined") return "quarantined";
    if (TERMINAL_JOB_STATES.has(job.state)) return "failed";
    if (job.state === "accepted" || job.state === "snapshotted" || job.state === "queued") return "queued";
    return "running";
  }

  jobSelect(where = "", suffix = "") {
    return `
      SELECT j.*, a.chain_id, a.kind AS attempt_kind, a.ordinal AS attempt_ordinal,
             a.execution_epoch, a.execution_owner_instance_id, a.execution_lease_generation,
             a.execution_state, a.execution_kind, a.execution_failure_count,
             a.next_execution_not_before, a.last_executor_error_json, a.monitor_deadline_at,
             a.final_reconciliation_attempted_at,
             c.state AS chain_state, c.input_required_abandoned_at,
             c.input_required_abandoned_job_id, c.input_required_abandoned_reason,
             c.attention_required_at
      FROM jobs j
      LEFT JOIN job_attempts a ON a.job_id = j.id
      LEFT JOIN job_chains c ON c.id = a.chain_id
      ${where}
      ${suffix}
    `;
  }

  createOwnerSession({
    harness = "unknown",
    clientInstanceId = null,
    hostSessionHint = null,
    stableSessionId = null,
    stableSessionHandle = null,
    metadata = {},
  } = {}) {
    const stableCapability = stableSessionHandle ? parseCapability(stableSessionHandle, "session") : null;
    if (stableSessionId || stableSessionHandle) {
      if (!stableCapability || stableCapability.subjectId !== stableSessionId) {
        throw codedError("CLIENT_SESSION_REQUIRED", "The stable Oracle Firefox host-session identity is invalid.");
      }
    }
    const id = stableCapability?.subjectId || randomUUID();
    const capability = stableCapability
      ? { handle: stableSessionHandle, hash: stableCapability.hash }
      : mintCapability("session", id);
    const now = new Date().toISOString();
    const normalizedHarness = String(harness || "unknown");
    const normalizedHint = hostSessionHint == null ? null : String(hostSessionHint);
    this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM owner_sessions WHERE id = ?").get(id);
      if (existing) {
        const sameIdentity =
          existing.revoked_at == null &&
          existing.harness === normalizedHarness &&
          (existing.host_session_hint ?? null) === normalizedHint &&
          verifyCapability(capability.handle, existing.session_cap_hash, { kind: "session", subjectId: id });
        if (!sameIdentity) {
          throw codedError("CLIENT_SESSION_REQUIRED", "The stable Oracle Firefox host-session identity does not match this owner session.");
        }
        this.db.prepare(`
          UPDATE owner_sessions SET client_instance_id=?, metadata_json=?, last_seen_at=? WHERE id=?
        `).run(clientInstanceId, json(metadata) || "{}", now, id);
        return;
      }
      this.db.prepare(`
        INSERT INTO owner_sessions(
          id, harness, client_instance_id, host_session_hint, session_cap_hash,
          isolation_strength, metadata_json, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        normalizedHarness,
        clientInstanceId,
        normalizedHint,
        capability.hash,
        stableCapability ? "host_session" : "chain",
        json(metadata) || "{}",
        now,
        now,
      );
    });
    return { sessionId: id, sessionHandle: capability.handle, harness: normalizedHarness };
  }

  resumeOwnerSessionReadOnly({
    harness = "unknown",
    hostSessionHint = null,
    stableSessionId = null,
    stableSessionHandle = null,
  } = {}) {
    const parsed = parseCapability(stableSessionHandle, "session");
    const row = parsed && parsed.subjectId === stableSessionId
      ? this.db.prepare("SELECT * FROM owner_sessions WHERE id=? AND revoked_at IS NULL").get(stableSessionId)
      : null;
    if (
      !row ||
      row.harness !== String(harness || "unknown") ||
      (row.host_session_hint ?? null) !== (hostSessionHint == null ? null : String(hostSessionHint)) ||
      !verifyCapability(stableSessionHandle, row.session_cap_hash, { kind: "session", subjectId: row.id })
    ) {
      throw codedError(
        "CLIENT_UPGRADE_REQUIRED",
        "Protocol 8 may resume an existing owner session for reads but cannot create or repair one.",
        {
          safeToRetry: false,
          recoveryAction: "reload this host with Oracle Firefox 1.7.0 or newer",
          details: {
            minimumReaderProtocol: BROKER_MINIMUM_READER_PROTOCOL,
            minimumWriterProtocol: BROKER_MINIMUM_WRITER_PROTOCOL,
          },
        },
      );
    }
    return { sessionId: row.id, sessionHandle: stableSessionHandle, harness: row.harness, readOnly: true };
  }

  authenticateOwnerSession(client, { touch = true } = {}) {
    const parsed = parseCapability(client?.sessionHandle, "session");
    if (!parsed || parsed.subjectId !== client?.sessionId) {
      throw codedError("CLIENT_SESSION_REQUIRED", "Open an Oracle Firefox client session before accessing jobs.");
    }
    const row = this.db.prepare("SELECT * FROM owner_sessions WHERE id = ? AND revoked_at IS NULL").get(parsed.subjectId);
    if (!row || !verifyCapability(client.sessionHandle, row.session_cap_hash, { kind: "session", subjectId: row.id })) {
      throw codedError("CLIENT_SESSION_REQUIRED", "The Oracle Firefox client session is invalid or expired.");
    }
    if (
      client?.harness && String(client.harness) !== row.harness ||
      client?.hostSessionHint != null && String(client.hostSessionHint) !== (row.host_session_hint ?? null)
    ) {
      throw codedError("CLIENT_SESSION_REQUIRED", "The Oracle Firefox client session belongs to a different harness or host session.");
    }
    if (touch) this.db.prepare("UPDATE owner_sessions SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    return {
      id: row.id,
      harness: row.harness,
      clientInstanceId: row.client_instance_id,
      hostSessionHint: row.host_session_hint,
      isolationStrength: row.isolation_strength,
    };
  }

  getChain(chainId) {
    return rowToChain(this.db.prepare("SELECT * FROM job_chains WHERE id = ?").get(chainId));
  }

  chainForJob(jobId) {
    return rowToChain(this.db.prepare(`
      SELECT c.* FROM job_chains c
      JOIN job_attempts a ON a.chain_id = c.id
      WHERE a.job_id = ?
    `).get(jobId));
  }

  chainAccessRow(chainId) {
    return this.db.prepare("SELECT * FROM job_chains WHERE id = ?").get(chainId);
  }

  sessionGrant(chainId, sessionId) {
    return this.db.prepare(`
      SELECT * FROM chain_session_grants
      WHERE chain_id = ? AND session_id = ? AND revoked_at IS NULL
    `).get(chainId, sessionId);
  }

  authorizeJob({
    jobId,
    jobHandle = null,
    caller = null,
    control = false,
    allowLegacyRead = false,
    allowCapabilityGrant = true,
  } = {}) {
    let job = null;
    let chain = null;
    const parsedHandle = parseCapability(jobHandle);
    if (parsedHandle && new Set(["read", "control"]).has(parsedHandle.kind)) {
      chain = this.getChain(parsedHandle.subjectId);
      if (chain) {
        const raw = this.chainAccessRow(chain.id);
        const expectedHash = parsedHandle.kind === "control" ? raw.control_cap_hash : raw.read_cap_hash;
        if (
          verifyCapability(jobHandle, expectedHash, { kind: parsedHandle.kind, subjectId: chain.id }) &&
          (!control || parsedHandle.kind === "control")
        ) {
          job = jobId ? this.getJob(jobId) : this.getJob(chain.rootJobId);
          if (!job || job.chainId !== chain.id) job = null;
          if (job && caller && allowCapabilityGrant) {
            const now = new Date().toISOString();
            this.db.prepare(`
              INSERT INTO chain_session_grants(
                chain_id, session_id, can_read, can_control, can_list, granted_at, revoked_at
              ) VALUES (?, ?, 1, ?, 1, ?, NULL)
              ON CONFLICT(chain_id, session_id) DO UPDATE SET
                can_read = 1,
                can_control = MAX(can_control, excluded.can_control),
                can_list = 1,
                revoked_at = NULL
            `).run(chain.id, caller.id, parsedHandle.kind === "control" ? 1 : 0, now);
          }
        }
      }
    }
    if (!job && jobId && caller) {
      const candidate = this.getJob(jobId);
      const candidateChain = candidate ? this.getChain(candidate.chainId) : null;
      const grant = candidateChain ? this.sessionGrant(candidateChain.id, caller.id) : null;
      if (candidate && candidateChain && grant && (control ? grant.can_control : grant.can_read)) {
        job = candidate;
        chain = candidateChain;
      }
    }
    if (!job && jobId && allowLegacyRead && !control) {
      const candidate = this.getJob(jobId);
      const candidateChain = candidate ? this.getChain(candidate.chainId) : null;
      if (candidate && candidateChain?.legacyMode === "unclaimed") {
        job = candidate;
        chain = candidateChain;
      }
    }
    if (!job || !chain) {
      throw codedError("JOB_NOT_FOUND", "No accessible Oracle Firefox job matches that reference.");
    }
    return { job, chain };
  }

  listJobsForSession(sessionId, params = {}) {
    const capped = Math.max(1, Math.min(200, Number(params.limit) || 50));
    const states = (params.states || []).filter((state) => STATE_INDEX.has(state));
    const stateClause = states.length ? `AND j.state IN (${states.map(() => "?").join(",")})` : "";
    return this.db.prepare(`
      SELECT j.*, a.chain_id, a.kind AS attempt_kind, a.ordinal AS attempt_ordinal,
             a.execution_epoch, a.execution_state, a.execution_kind,
             a.execution_failure_count, a.next_execution_not_before,
             a.last_executor_error_json, a.monitor_deadline_at,
             a.final_reconciliation_attempted_at, c.state AS chain_state,
             c.input_required_abandoned_at, c.input_required_abandoned_job_id,
             c.input_required_abandoned_reason, c.attention_required_at
      FROM jobs j
      JOIN job_attempts a ON a.job_id = j.id
      JOIN job_chains c ON c.id = a.chain_id
      JOIN chain_session_grants g ON g.chain_id = a.chain_id
      WHERE g.session_id = ? AND g.can_list = 1 AND g.revoked_at IS NULL ${stateClause}
      ORDER BY j.created_at DESC, j.rowid DESC LIMIT ?
    `).all(sessionId, ...states, capped).map(rowToJob);
  }

  createJob(input) {
    const now = new Date().toISOString();
    const digest = input.requestDigest || requestDigest(input.request);
    const created = this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM jobs WHERE authorization_id = ?").get(input.authorizationId);
      if (existing) {
        const existingJob = this.getJob(existing.id);
        const existingChain = this.getChain(existingJob.chainId);
        if (
          input.ownerSessionId &&
          existingChain?.legacyMode === "none" &&
          existingChain.originSessionId !== input.ownerSessionId &&
          !this.sessionGrant(existingChain.id, input.ownerSessionId)
        ) {
          throw codedError("JOB_NOT_FOUND", "No accessible Oracle Firefox job matches that authorization.");
        }
        if (existing.request_digest !== digest) {
          throw codedError(
            "AUTHORIZATION_REUSED",
            "This authorizationId was already used for a different request.",
            { safeToRetry: false },
          );
        }
        return { job: existingJob, chain: existingChain, idempotent: true };
      }
      const id = input.id || randomUUID();
      const parentAttempt = input.parentJobId
        ? this.db.prepare("SELECT * FROM job_attempts WHERE job_id = ?").get(input.parentJobId)
        : null;
      const inheritedChain = parentAttempt ? this.chainAccessRow(parentAttempt.chain_id) : null;
      if (!inheritedChain) {
        const inputBlockers = this.activeInputRequestRecords(input.conversationKey);
        if (inputBlockers.length) {
          throw codedError(
            "INPUT_REQUIRED_BLOCKING",
            "This exact conversation lane is waiting for explicit owner input and cannot accept another start.",
            {
              safeToRetry: false,
              recoveryAction: "The owning session must resolve or explicitly abandon the outstanding input request.",
              details: { blockers: inputBlockers.map((row) => sanitizedInputBlocker(row)) },
            },
          );
        }
        const activeQuarantine = this.db
          .prepare("SELECT * FROM quarantines WHERE scope_key = ? AND active = 1")
          .get(input.conversationKey);
        if (activeQuarantine) {
          throw codedError(
            "CONVERSATION_QUARANTINED",
            "This conversation or new-chat scope is quarantined until its uncertain submission is reconciled.",
            {
              recoveryAction: "Inspect the exact conversation blocker and reconcile or explicitly acknowledge it.",
              details: {
                exactScopeRequired: true,
                blockers: this.activeQuarantineRecords(input.conversationKey).map((row) => sanitizedQuarantineBlocker(row)),
              },
            },
          );
        }
      }
      const chainId = input.chainId || inheritedChain?.id || id;
      const rootJobId = inheritedChain?.root_job_id || input.rootJobId || id;
      this.db.prepare(`
        INSERT INTO jobs (
          id, authorization_id, operation, state, request_json, request_digest,
          conversation_key, canonical_url, project_title, project_url, chat_title,
          session_path, evidence_round, max_evidence_replies, parent_job_id, root_job_id,
          retry_attempt, max_response_retries, created_at, updated_at
        ) VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.authorizationId,
        input.operation,
        json(input.request),
        digest,
        input.conversationKey,
        input.conversationUrl ?? null,
        input.projectTitle ?? null,
        input.projectUrl ?? null,
        input.chatTitle ?? null,
        input.sessionPath,
        input.evidenceRound ?? 0,
        input.maxAutomaticEvidenceReplies ?? 3,
        input.parentJobId ?? null,
        rootJobId,
        input.retryAttempt ?? 0,
        input.maxAutomaticResponseRetries ?? 0,
        now,
        now,
      );
      this.db.prepare("INSERT INTO job_events(job_id, state, details_json, created_at) VALUES (?, 'accepted', ?, ?)")
        .run(id, json({ operation: input.operation }), now);
      let chain;
      if (inheritedChain) {
        if (input.ownerSessionId && inheritedChain.origin_session_id !== input.ownerSessionId && !this.sessionGrant(inheritedChain.id, input.ownerSessionId)?.can_control) {
          throw codedError("JOB_NOT_FOUND", "No accessible Oracle Firefox logical chain matches the parent job.");
        }
        const ordinal = Number(this.db.prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 value FROM job_attempts WHERE chain_id = ?").get(chainId).value);
        const kind = input.attemptKind || (input.evidenceRound > 0 ? "evidence_reply" : "response_recovery");
        this.db.prepare(`
          INSERT INTO job_attempts(job_id, chain_id, kind, ordinal, parent_job_id, execution_epoch, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?)
        `).run(id, chainId, kind, ordinal, input.parentJobId, now);
        this.db.prepare(`
          UPDATE job_chains
          SET active_job_id = ?, state = 'queued', updated_at = ?, terminal_at = NULL,
              attention_required_at = NULL
          WHERE id = ?
        `).run(id, now, chainId);
        chain = this.getChain(chainId);
      } else {
        let ownerSessionId = input.ownerSessionId;
        let legacyMode = "none";
        if (!ownerSessionId) {
          ownerSessionId = `legacy-${id}`;
          legacyMode = "unclaimed";
          this.db.prepare(`
            INSERT INTO owner_sessions(id, harness, isolation_strength, metadata_json, created_at, last_seen_at)
            VALUES (?, 'legacy', 'legacy', '{}', ?, ?)
          `).run(ownerSessionId, now, now);
        }
        const ticket = Number(this.db.prepare("INSERT INTO scheduler_tickets(created_at) VALUES (?)").run(now).lastInsertRowid);
        const targetKind = input.operation === "continue_chat"
          ? "existing"
          : input.projectUrl ? "new_project" : "new_standalone";
        this.db.prepare(`
          INSERT INTO job_chains(
            id, root_job_id, origin_session_id, accepted_sequence, state, active_job_id,
            target_kind, conversation_key, canonical_url, completion_mode,
            read_cap_hash, control_cap_hash, start_receipt_cap_hash, legacy_mode, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          chainId,
          rootJobId,
          ownerSessionId,
          ticket,
          id,
          targetKind,
          input.conversationKey,
          input.conversationUrl ?? null,
          input.completionMode || input.request?.completionMode || "manual",
          input.readCapabilityHash ?? null,
          input.controlCapabilityHash ?? null,
          input.startReceiptCapabilityHash ?? null,
          legacyMode,
          now,
          now,
        );
        this.db.prepare(`
          INSERT INTO job_attempts(job_id, chain_id, kind, ordinal, parent_job_id, execution_epoch, created_at)
          VALUES (?, ?, 'initial', 0, NULL, 0, ?)
        `).run(id, chainId, now);
        this.db.prepare(`
          INSERT INTO chain_session_grants(chain_id, session_id, can_read, can_control, can_list, granted_at)
          VALUES (?, ?, 1, ?, 1, ?)
        `).run(chainId, ownerSessionId, legacyMode === "none" ? 1 : 0, now);
        this.db.prepare("INSERT INTO chain_events(chain_id, active_job_id, state, details_json, created_at) VALUES (?, ?, 'queued', ?, ?)")
          .run(chainId, id, json({ operation: input.operation }), now);
        if (input.subscriptionId && input.subscriptionCapabilityHash) {
          this.db.prepare(`
            INSERT INTO completion_subscriptions(
              id, chain_id, owner_session_id, mode, capability_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            input.subscriptionId,
            chainId,
            ownerSessionId,
            input.completionMode || input.request?.completionMode || "manual",
            input.subscriptionCapabilityHash,
            now,
          );
        }
        chain = this.getChain(chainId);
      }
      return { job: this.getJob(id), chain, idempotent: false };
    });
    if (!created.idempotent) this.emit("change", created.job);
    return created;
  }

  getJob(id) {
    return rowToJob(this.db.prepare(this.jobSelect("WHERE j.id = ?")).get(id));
  }

  getJobByAuthorization(authorizationId) {
    return rowToJob(this.db.prepare(this.jobSelect("WHERE j.authorization_id = ?")).get(authorizationId));
  }

  requireJob(id) {
    const job = this.getJob(id);
    if (!job) throw codedError("JOB_NOT_FOUND", `No Oracle Firefox job exists with id ${id}.`);
    return job;
  }

  listJobs({ limit = 50, states = [] } = {}) {
    const capped = Math.max(1, Math.min(200, Number(limit) || 50));
    if (states.length) {
      const valid = states.filter((state) => STATE_INDEX.has(state));
      if (!valid.length) return [];
      const placeholders = valid.map(() => "?").join(",");
      return this.db
        .prepare(this.jobSelect(`WHERE j.state IN (${placeholders})`, "ORDER BY j.created_at DESC, j.rowid DESC LIMIT ?"))
        .all(...valid, capped)
        .map(rowToJob);
    }
    return this.db.prepare(this.jobSelect("", "ORDER BY j.created_at DESC, j.rowid DESC LIMIT ?")).all(capped).map(rowToJob);
  }

  allRootJobIds() {
    return this.db
      .prepare("SELECT root_job_id FROM job_chains")
      .all()
      .map((row) => row.root_job_id);
  }

  completedJobsWithExactProof() {
    return this.db.prepare(this.jobSelect(`
      WHERE j.state IN ('completed', 'input_invalid') AND j.result_json IS NOT NULL
        AND j.submit_intent_at IS NOT NULL
        AND oracle_canonical_conversation_url(j.canonical_url) = 1
        AND (j.user_turn_id IS NOT NULL OR j.user_turn_hash IS NOT NULL)
        AND j.assistant_turn_hash IS NOT NULL
    `, "ORDER BY j.completed_at, j.created_at")).all().map(rowToJob);
  }

  terminalJobsForArtifactRepair() {
    const states = Array.from(TERMINAL_JOB_STATES);
    return this.db.prepare(this.jobSelect(
      `WHERE j.state IN (${states.map(() => "?").join(",")})`,
      "ORDER BY j.completed_at, j.created_at",
    )).all(...states).map(rowToJob);
  }

  recoverStartReceipt({ authorizationId, digest, recoveryHandle, caller }) {
    const failClosed = () => codedError(
      "START_RECEIPT_NOT_FOUND",
      "No recoverable Oracle Firefox start receipt matches this caller, request, and private recovery capability.",
      { safeToRetry: false },
    );
    return this.transaction(() => {
      const job = this.getJobByAuthorization(authorizationId);
      if (!job || !caller || job.requestDigest !== digest) throw failClosed();
      const chain = this.chainAccessRow(job.chainId);
      if (
        !chain ||
        chain.origin_session_id !== caller.id ||
        !verifyCapability(recoveryHandle, chain.start_receipt_cap_hash, {
          kind: "receipt",
          subjectId: authorizationId,
        })
      ) throw failClosed();

      const readCapability = mintCapability("read", chain.id);
      const controlCapability = mintCapability("control", chain.id);
      let subscription = this.db.prepare(`
        SELECT * FROM completion_subscriptions
        WHERE chain_id=? AND owner_session_id=?
        ORDER BY created_at LIMIT 1
      `).get(chain.id, caller.id);
      const subscriptionId = subscription?.id || randomUUID();
      const subscriptionCapability = mintCapability("subscription", subscriptionId);
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE job_chains
        SET read_cap_hash=?, control_cap_hash=?, start_receipt_recovered_at=?,
            start_receipt_recovery_count=start_receipt_recovery_count+1, updated_at=?
        WHERE id=?
      `).run(readCapability.hash, controlCapability.hash, now, now, chain.id);
      if (subscription) {
        this.db.prepare(`
          UPDATE completion_subscriptions SET capability_hash=? WHERE id=?
        `).run(subscriptionCapability.hash, subscriptionId);
      } else {
        this.db.prepare(`
          INSERT INTO completion_subscriptions(
            id, chain_id, owner_session_id, mode, capability_hash, state, created_at
          ) VALUES (?, ?, ?, ?, ?, 'open', ?)
        `).run(subscriptionId, chain.id, caller.id, chain.completion_mode, subscriptionCapability.hash, now);
        subscription = { id: subscriptionId };
      }
      return {
        job: this.requireJob(job.id),
        jobHandle: controlCapability.handle,
        readHandle: readCapability.handle,
        completionHandle: subscriptionCapability.handle,
        recoveredAt: now,
      };
    });
  }

  queuedJobs() {
    return this.db.prepare(`
      SELECT j.*, a.chain_id, a.kind AS attempt_kind, a.ordinal AS attempt_ordinal,
             a.execution_epoch, a.execution_owner_instance_id, a.execution_lease_generation,
             a.execution_state, a.execution_kind, a.execution_failure_count,
             a.next_execution_not_before, a.last_executor_error_json, a.monitor_deadline_at,
             a.final_reconciliation_attempted_at,
             c.state AS chain_state, c.input_required_abandoned_at,
             c.input_required_abandoned_job_id, c.input_required_abandoned_reason,
             c.attention_required_at
      FROM jobs j
      JOIN job_attempts a ON a.job_id = j.id
      JOIN job_chains c ON c.id = a.chain_id AND c.active_job_id = j.id
      WHERE j.state = 'queued'
      ORDER BY c.accepted_sequence ASC, a.ordinal ASC
    `).all().map(rowToJob);
  }

  logicalQueueRows(sessionId = null) {
    const sessionJoin = sessionId ? `
      JOIN chain_session_grants g ON g.chain_id=c.id
        AND g.session_id=? AND g.can_list=1 AND g.revoked_at IS NULL
    ` : "";
    return this.db.prepare(`
      SELECT c.*, j.state AS job_state, j.assistant_disposition,
             a.execution_state, a.execution_kind,
             EXISTS(SELECT 1 FROM quarantines q WHERE q.scope_key=c.conversation_key AND q.active=1) AS quarantined_lane
      FROM job_chains c
      JOIN jobs j ON j.id=c.active_job_id
      JOIN job_attempts a ON a.job_id=j.id
      ${sessionJoin}
      ORDER BY c.accepted_sequence
    `).all(...(sessionId ? [sessionId] : []));
  }

  logicalQueueSnapshot(sessionId = null) {
    const rows = this.logicalQueueRows(sessionId);
    const outstandingStates = new Set([
      "queued", "running", "input_required", "input_invalid",
      "submission_uncertain", "response_uncertain", "quarantined",
    ]);
    const attentionByLane = new Set();
    const uncertaintyByLane = new Set();
    const byChainId = new Map();
    const counts = {
      executing: 0,
      monitoring: 0,
      runnableQueued: 0,
      blockedAttention: 0,
      blockedUncertainty: 0,
      logicalOutstanding: 0,
    };
    for (const row of rows) {
      if (!outstandingStates.has(row.state)) continue;
      let logicalState;
      if (
        row.state === "input_required" || row.state === "input_invalid" ||
        attentionByLane.has(row.conversation_key)
      ) {
        logicalState = "blocked_attention";
      } else if (
        new Set(["submission_uncertain", "response_uncertain", "quarantined"]).has(row.state) ||
        row.quarantined_lane || uncertaintyByLane.has(row.conversation_key)
      ) {
        logicalState = "blocked_uncertainty";
      } else if (row.execution_state === "running" || row.state === "running") {
        logicalState = row.execution_kind === "monitor_only" ? "monitoring" : "executing";
      } else {
        logicalState = "runnable_queued";
      }
      byChainId.set(row.id, logicalState);
      counts.logicalOutstanding += 1;
      if (logicalState === "blocked_attention") counts.blockedAttention += 1;
      else if (logicalState === "blocked_uncertainty") counts.blockedUncertainty += 1;
      else if (logicalState === "monitoring") counts.monitoring += 1;
      else if (logicalState === "executing") counts.executing += 1;
      else counts.runnableQueued += 1;
      if (row.state === "input_required" || row.state === "input_invalid") attentionByLane.add(row.conversation_key);
      if (new Set(["submission_uncertain", "response_uncertain", "quarantined"]).has(row.state) || row.quarantined_lane) {
        uncertaintyByLane.add(row.conversation_key);
      }
    }
    return { counts, byChainId };
  }

  logicalStateForJob(jobId) {
    const job = this.requireJob(jobId);
    return this.logicalQueueSnapshot().byChainId.get(job.chainId) || null;
  }

  logicalQueueCounts(sessionId = null) {
    return this.logicalQueueSnapshot(sessionId).counts;
  }

  countOutstanding() {
    return this.logicalQueueCounts().logicalOutstanding;
  }

  transition(id, nextState, patch = {}, details = null) {
    if (!STATE_INDEX.has(nextState)) throw new Error(`Unknown job state: ${nextState}`);
    const transitioned = this.transaction(() => this.transitionInCurrentTransaction(id, nextState, patch, details));
    this.emit("change", transitioned);
    return transitioned;
  }

  transitionInCurrentTransaction(id, nextState, patch = {}, details = null, suppliedNow = null) {
    if (!STATE_INDEX.has(nextState)) throw new Error(`Unknown job state: ${nextState}`);
    const current = this.requireJob(id);
    if (TERMINAL_JOB_STATES.has(current.state) && current.state !== nextState) {
      throw codedError("JOB_TERMINAL", `Job ${id} is already terminal in state ${current.state}.`);
    }
    if (current.submitIntentAt && PRE_SUBMIT_JOB_STATES.has(nextState)) {
      throw codedError(
        "INVALID_JOB_TRANSITION",
        `Cannot return submitted job ${id} to pre-submit lifecycle state ${nextState}.`,
      );
    }
    for (const [field, label] of [
      ["userTurnId", "user-turn id"],
      ["userTurnHash", "user-turn hash"],
      ["assistantTurnId", "assistant-turn id"],
      ["assistantTurnHash", "assistant-turn hash"],
    ]) {
      if (current[field] && field in patch && patch[field] !== current[field]) {
        throw codedError(
          "IMMUTABLE_TURN_PROOF",
          `The durable ${label} for job ${id} cannot be replaced.`,
          { submissionMayHaveOccurred: Boolean(current.submitIntentAt) },
        );
      }
    }
    const currentIndex = STATE_INDEX.get(current.state);
    const nextIndex = STATE_INDEX.get(nextState);
    if (!TERMINAL_JOB_STATES.has(nextState) && nextIndex < currentIndex) {
      throw codedError("INVALID_JOB_TRANSITION", `Cannot move job ${id} backward from ${current.state} to ${nextState}.`);
    }
    const now = suppliedNow || new Date().toISOString();
    const submitted = nextState === "submit_intent" || Boolean(current.submitIntentAt);
    const assignments = ["state = ?", "updated_at = ?", "version = version + 1", "submission_may_have_happened = ?"];
    const values = [nextState, now, submitted ? 1 : 0];
    const columns = {
      conversationKey: "conversation_key",
      conversationUrl: "canonical_url",
      projectTitle: "project_title",
      projectUrl: "project_url",
      chatTitle: "chat_title",
      userTurnId: "user_turn_id",
      userTurnHash: "user_turn_hash",
      submittedMessageHash: "submitted_message_hash",
      attachmentManifest: "attachment_manifest_json",
      modelEvidence: "model_evidence_json",
      assistantDisposition: "assistant_disposition",
      responseDisposition: "response_disposition",
      responseFailure: "response_failure_json",
      localDataRequest: "local_data_request_json",
      assistantTurnId: "assistant_turn_id",
      assistantTurnHash: "assistant_turn_hash",
      result: "result_json",
      error: "error_json",
      recoveryAction: "recovery_action",
      replacementJobId: "replacement_job_id",
    };
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      assignments.push(`${column} = ?`);
      values.push(["attachmentManifest", "modelEvidence", "responseFailure", "localDataRequest", "result", "error"].includes(key) ? json(patch[key]) : patch[key]);
    }
    if (nextState === "page_leased" && !current.startedAt) {
      assignments.push("started_at = ?");
      values.push(now);
    }
    if (nextState === "submit_intent" && !current.submitIntentAt) {
      assignments.push("submit_intent_at = ?");
      values.push(now);
    }
    if (TERMINAL_JOB_STATES.has(nextState)) {
      assignments.push("completed_at = ?");
      values.push(now);
    }
    values.push(id);
    this.db.prepare(`UPDATE jobs SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    if (nextState === "submit_intent") {
      const timeoutSeconds = Math.max(30, Math.min(86_400, Number(current.request?.responseTimeoutSeconds) || 10_800));
      this.db.prepare(`
        UPDATE job_attempts SET monitor_deadline_at=COALESCE(monitor_deadline_at, ?)
        WHERE job_id=?
      `).run(new Date(Date.parse(current.submitIntentAt || now) + timeoutSeconds * 1_000).toISOString(), id);
    }
    if (nextState === "user_turn_confirmed") {
      const updated = this.requireJob(id);
      if (!isCanonicalConversationUrl(updated.conversationUrl) ||
          (!updated.userTurnId && !updated.userTurnHash) ||
          !updated.submitIntentAt) {
        throw codedError(
          "EXACT_TURN_PROOF_REQUIRED",
          "Monitor-only execution requires submit intent, a canonical conversation URL, and an exact user-turn id or unambiguous semantic hash.",
          { submissionMayHaveOccurred: true },
        );
      }
      this.db.prepare(`
        UPDATE job_attempts SET execution_kind='monitor_only' WHERE job_id=?
      `).run(id);
    }
    this.db.prepare(`
      INSERT INTO job_events(job_id, state, details_json, created_at, broker_instance_id, lease_generation)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      nextState,
      json(details ?? patch),
      now,
      this.brokerContext.instanceId,
      this.brokerContext.leaseGeneration,
    );
    this.syncChainForJob(id, now, details ?? patch);
    return this.getJob(id);
  }

  syncChainForJob(jobId, now = new Date().toISOString(), details = null) {
    const attempt = this.db.prepare("SELECT * FROM job_attempts WHERE job_id = ?").get(jobId);
    if (!attempt) return null;
    const chain = this.db.prepare("SELECT * FROM job_chains WHERE id = ?").get(attempt.chain_id);
    if (!chain) return null;
    const rawJob = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    const activeJobId = chain.active_job_id || jobId;
    const active = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(activeJobId) || rawJob;
    const nextState = this.chainStateForJob(active, chain);
    const conversationKey = active.conversation_key || chain.conversation_key;
    const canonicalUrl = active.canonical_url || chain.canonical_url;
    if (canonicalUrl && canonicalUrl !== chain.canonical_url) {
      const collision = this.db.prepare(`
        SELECT c.id, c.accepted_sequence, c.state, j.submit_intent_at
        FROM job_chains c JOIN jobs j ON j.id=c.active_job_id
        WHERE c.id <> ? AND (c.canonical_url = ? OR c.conversation_key = ?)
          AND c.state NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY c.accepted_sequence LIMIT 1
      `).get(chain.id, canonicalUrl, canonicalUrl);
      const laterUnsentSuccessor = collision &&
        Number(collision.accepted_sequence) > Number(chain.accepted_sequence) &&
        collision.state === "queued" && !collision.submit_intent_at;
      if (collision && !laterUnsentSuccessor) {
        throw codedError("CONVERSATION_LANE_COLLISION", "The canonical conversation is already owned by another active logical chain. Oracle stopped without another send.", {
          submissionMayHaveOccurred: true,
          recoveryAction: "inspect both logical chains and reconcile the submitted turn",
        });
      }
    }
    const changed =
      chain.state !== nextState ||
      chain.active_job_id !== active.id ||
      chain.conversation_key !== conversationKey ||
      chain.canonical_url !== canonicalUrl;
    this.db.prepare(`
      UPDATE job_chains
      SET state = ?, active_job_id = ?, conversation_key = ?, canonical_url = ?,
          updated_at = ?, terminal_at = ?
      WHERE id = ?
    `).run(
      nextState,
      active.id,
      conversationKey,
      canonicalUrl,
      now,
      TERMINAL_CHAIN_STATES.has(nextState) ? (active.completed_at || now) : null,
      chain.id,
    );
    if (changed) this.createChainEvent(chain.id, active.id, nextState, details, now);
    return this.getChain(chain.id);
  }

  createChainEvent(chainId, activeJobId, state, details = null, now = new Date().toISOString()) {
    const inserted = this.db.prepare(`
      INSERT INTO chain_events(
        chain_id, active_job_id, state, details_json, created_at, broker_instance_id, lease_generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      chainId,
      activeJobId,
      state,
      json(details),
      now,
      this.brokerContext.instanceId,
      this.brokerContext.leaseGeneration,
    );
    const sequence = Number(inserted.lastInsertRowid);
    if (WAKE_CHAIN_STATES.has(state)) {
      this.db.prepare(`
        INSERT OR IGNORE INTO completion_deliveries(
          subscription_id, chain_event_sequence, state, created_at
        )
        SELECT id, ?, 'pending', ?
        FROM completion_subscriptions
        WHERE chain_id = ? AND state = 'open' AND (? = 'attention_required' OR mode != 'manual')
      `).run(sequence, now, chainId, state);
    }
    if (TERMINAL_CHAIN_STATES.has(state)) {
      this.db.prepare(`
        UPDATE completion_subscriptions
        SET state = 'closed', closed_at = ?
        WHERE chain_id = ? AND state = 'open' AND mode = 'manual'
      `).run(now, chainId);
    }
    return sequence;
  }

  markFailure(id, error) {
    const job = this.requireJob(id);
    const structured = structuredError(error, { jobState: job.state });
    if (!job.submitIntentAt) {
      return this.transition(id, "failed_pre_submit", {
        error: structured,
        recoveryAction: structured.safeToRetry ? "start a new authorized job" : structured.recoveryAction,
      });
    }
    const state = hasExactUserTurnProof(job) ? "response_uncertain" : "submission_uncertain";
    const recoveryAction = `reconcile_job ${id}`;
    const result = this.transition(id, state, {
      error: { ...structured, submissionMayHaveOccurred: true },
      recoveryAction,
    });
    this.quarantine(job.conversationKey, id, structured.message);
    return result;
  }

  markFailureClaimed(claim, error) {
    const job = this.requireJob(claim.jobId);
    const structured = structuredError(error, { jobState: job.state });
    if (!job.submitIntentAt) {
      return this.transitionClaimed(claim, "failed_pre_submit", {
        error: structured,
        recoveryAction: structured.safeToRetry ? "start a new authorized job" : structured.recoveryAction,
      });
    }
    const state = hasExactUserTurnProof(job) ? "response_uncertain" : "submission_uncertain";
    const recoveryAction = `reconcile_job ${job.id}`;
    const result = this.transitionClaimed(claim, state, {
      error: { ...structured, submissionMayHaveOccurred: true },
      recoveryAction,
    });
    this.quarantine(job.conversationKey, job.id, structured.message);
    return result;
  }

  quarantine(scopeKey, jobId, reason) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO quarantines(scope_key, job_id, reason, active, created_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(scope_key) DO UPDATE SET job_id=excluded.job_id, reason=excluded.reason, active=1, created_at=excluded.created_at, acknowledged_at=NULL
    `).run(scopeKey, jobId, reason, now);
  }

  activeQuarantineRecords(scopeKey) {
    return this.db.prepare(`
      SELECT q.*, j.state AS job_state, j.updated_at AS job_updated_at,
             j.canonical_url, j.submitted_message_hash, j.attachment_manifest_json,
             a.chain_id, c.state AS chain_state
      FROM quarantines q
      JOIN jobs j ON j.id = q.job_id
      JOIN job_attempts a ON a.job_id = j.id
      JOIN job_chains c ON c.id = a.chain_id
      WHERE q.scope_key = ? AND q.active = 1
      ORDER BY q.created_at, q.job_id
    `).all(scopeKey);
  }

  activeQuarantineRecord(scopeKey) {
    const rows = this.activeQuarantineRecords(scopeKey);
    return rows.length === 1 ? rows[0] : null;
  }

  quarantineView(scopeKey) {
    const rows = this.activeQuarantineRecords(scopeKey);
    if (!rows.length) return { quarantined: false, blockers: [] };
    const blockers = rows.map((row) => sanitizedQuarantineBlocker(row));
    return {
      quarantined: true,
      capabilityRecoveryRequired: true,
      blockers,
      ...(blockers.length === 1 ? blockers[0] : {}),
    };
  }

  requireMatchingQuarantine(scopeKey, fingerprint) {
    const rows = this.activeQuarantineRecords(scopeKey);
    if (!rows.length) {
      throw codedError("QUARANTINE_NOT_FOUND", "No active Oracle Firefox quarantine matches that exact conversation URL.");
    }
    const matches = rows.filter((row) => quarantineFingerprint(row) === fingerprint);
    if (matches.length === 0) {
      throw codedError(
        "QUARANTINE_CHANGED",
        "The quarantine changed after inspection. Inspect the exact conversation quarantine again before recovering it.",
        { safeToRetry: true },
      );
    }
    if (matches.length > 1) {
      throw codedError("QUARANTINE_AMBIGUOUS", "More than one durable quarantine matched the supplied fingerprint. Oracle refused to guess.");
    }
    const [row] = matches;
    if (!new Set(["submission_uncertain", "response_uncertain", "quarantined"]).has(row.job_state)) {
      throw codedError("QUARANTINE_NOT_RECOVERABLE", "The quarantined job is no longer in an uncertain terminal state.");
    }
    return row;
  }

  orphanedQuarantineJob(scopeKey, fingerprint) {
    const row = this.requireMatchingQuarantine(scopeKey, fingerprint);
    return this.requireJob(row.job_id);
  }

  acknowledgeOrphanedQuarantine(scopeKey, fingerprint) {
    const result = this.transaction(() => {
      const row = this.requireMatchingQuarantine(scopeKey, fingerprint);
      const now = new Date().toISOString();
      const changed = this.db.prepare(`
        UPDATE quarantines SET active = 0, acknowledged_at = ?
        WHERE scope_key = ? AND job_id = ? AND active = 1
      `).run(now, scopeKey, row.job_id);
      if (Number(changed.changes) !== 1) {
        throw codedError("QUARANTINE_CHANGED", "The quarantine changed while it was being acknowledged.", { safeToRetry: true });
      }
      return { fingerprint, acknowledgedAt: now };
    });
    return {
      ...result,
      acknowledged: true,
      messageSent: false,
      replacementAuthorized: false,
      recoveryAction: "A fresh submission still requires its own explicit user authorization.",
    };
  }

  recoverOrphanedQuarantineForMonitoring({
    scopeKey,
    fingerprint,
    caller,
    userTurnId,
    userTurnHash,
    readCapabilityHash,
    controlCapabilityHash,
    subscriptionId,
    subscriptionCapabilityHash,
    completionMode = "manual",
  }) {
    const recovered = this.transaction(() => {
      const row = this.requireMatchingQuarantine(scopeKey, fingerprint);
      const job = this.requireJob(row.job_id);
      const chain = this.getChain(row.chain_id);
      if (!caller?.id || !chain || chain.activeJobId !== job.id) {
        throw codedError("QUARANTINE_NOT_RECOVERABLE", "The uncertain logical chain cannot be safely adopted for monitoring.");
      }
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE job_chains SET read_cap_hash = ?, control_cap_hash = ?, updated_at = ? WHERE id = ?
      `).run(readCapabilityHash, controlCapabilityHash, now, chain.id);
      this.db.prepare(`
        INSERT INTO chain_session_grants(
          chain_id, session_id, can_read, can_control, can_list, granted_at, revoked_at
        ) VALUES (?, ?, 1, 1, 1, ?, NULL)
        ON CONFLICT(chain_id, session_id) DO UPDATE SET
          can_read = 1, can_control = 1, can_list = 1,
          granted_at = excluded.granted_at, revoked_at = NULL
      `).run(chain.id, caller.id, now);
      this.db.prepare(`
        UPDATE completion_subscriptions SET state = 'closed', closed_at = ?
        WHERE chain_id = ? AND state = 'open'
      `).run(now, chain.id);
      this.db.prepare(`
        INSERT INTO completion_subscriptions(
          id, chain_id, owner_session_id, mode, capability_hash, state, created_at
        ) VALUES (?, ?, ?, ?, ?, 'open', ?)
      `).run(subscriptionId, chain.id, caller.id, completionMode, subscriptionCapabilityHash, now);
      const reopened = this.reopenForMonitoringInCurrentTransaction(job.id, { userTurnId, userTurnHash }, now);
      this.db.prepare(`
        UPDATE quarantines SET active = 0, acknowledged_at = ?
        WHERE scope_key = ? AND job_id = ? AND active = 1
      `).run(now, scopeKey, job.id);
      return reopened;
    });
    this.emit("change", recovered);
    return recovered;
  }

  acknowledge(jobId) {
    const job = this.requireJob(jobId);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE quarantines SET active = 0, acknowledged_at = ? WHERE job_id = ?").run(now, jobId);
    return { jobId, acknowledged: true, conversationKey: job.conversationKey };
  }

  activeInputRequestRecords(scopeKey) {
    return this.db.prepare(`
      SELECT c.*, j.state AS job_state, j.updated_at AS job_updated_at,
             j.assistant_disposition, j.local_data_request_json
      FROM job_chains c
      JOIN jobs j ON j.id = c.active_job_id
      WHERE (c.conversation_key = ? OR c.canonical_url = ?)
        AND c.state IN ('input_required', 'input_invalid')
        AND (
          (j.state = 'completed' AND j.assistant_disposition = 'local_data_request' AND j.local_data_request_json IS NOT NULL)
          OR (j.state = 'input_invalid' AND j.assistant_disposition = 'input_invalid')
        )
      ORDER BY c.accepted_sequence
    `).all(scopeKey, scopeKey);
  }

  activeInputRequestRecord(scopeKey) {
    const rows = this.activeInputRequestRecords(scopeKey);
    return rows.length === 1 ? rows[0] : null;
  }

  inputBlockers(scopeKey) {
    return this.activeInputRequestRecords(scopeKey).map((row) => sanitizedInputBlocker(row));
  }

  inputRequestView(scopeKey) {
    const rows = this.activeInputRequestRecords(scopeKey);
    if (!rows.length) return { inputRequired: false, blockers: [] };
    const blockers = rows.map((row) => sanitizedInputBlocker(row));
    return {
      inputRequired: true,
      capabilityRecoveryRequired: true,
      blockers,
      ...(blockers.length === 1 ? blockers[0] : {}),
    };
  }

  requireMatchingInputRequest(scopeKey, fingerprint) {
    const rows = this.activeInputRequestRecords(scopeKey);
    if (!rows.length) {
      throw codedError("INPUT_REQUEST_NOT_FOUND", "No active Oracle Firefox input request matches that exact conversation URL.");
    }
    const matches = rows.filter((row) => inputRequestFingerprint(row) === fingerprint);
    if (matches.length === 0) {
      throw codedError(
        "INPUT_REQUEST_CHANGED",
        "The input request changed after inspection. Inspect the exact conversation lane again before abandoning it.",
        { safeToRetry: true },
      );
    }
    if (matches.length > 1) {
      throw codedError("INPUT_REQUEST_AMBIGUOUS", "More than one durable input request matched the supplied fingerprint. Oracle refused to guess.");
    }
    return matches[0];
  }

  attentionForSession(sessionId) {
    const inputRows = this.db.prepare(`
      SELECT c.*, j.state AS job_state, j.updated_at AS job_updated_at,
             j.assistant_disposition, j.local_data_request_json
      FROM job_chains c
      JOIN jobs j ON j.id=c.active_job_id
      JOIN chain_session_grants g ON g.chain_id=c.id
      WHERE g.session_id=? AND g.can_list=1 AND g.revoked_at IS NULL
        AND c.state IN ('input_required', 'input_invalid')
      ORDER BY c.accepted_sequence
    `).all(sessionId);
    const uncertaintyRows = this.db.prepare(`
      SELECT q.*, j.state AS job_state, j.updated_at AS job_updated_at,
             j.canonical_url, j.submitted_message_hash, j.attachment_manifest_json,
             a.chain_id, c.state AS chain_state
      FROM quarantines q
      JOIN jobs j ON j.id=q.job_id
      JOIN job_attempts a ON a.job_id=j.id
      JOIN job_chains c ON c.id=a.chain_id
      JOIN chain_session_grants g ON g.chain_id=c.id
      WHERE g.session_id=? AND g.can_list=1 AND g.revoked_at IS NULL AND q.active=1
      ORDER BY q.created_at, q.job_id
    `).all(sessionId);
    return [
      ...inputRows.map((row) => sanitizedInputBlocker(row)),
      ...uncertaintyRows.map((row) => sanitizedQuarantineBlocker(row)),
    ];
  }

  sweepAttentionRequired({ nowMs = Date.now(), afterMs = 30 * 60_000 } = {}) {
    const cutoff = new Date(nowMs - Math.max(1, Number(afterMs) || 30 * 60_000)).toISOString();
    const marked = this.transaction(() => {
      const candidates = this.db.prepare(`
        SELECT c.id, c.active_job_id
        FROM job_chains c
        WHERE c.state IN ('input_required', 'input_invalid')
          AND c.attention_required_at IS NULL AND c.updated_at <= ?
        ORDER BY c.accepted_sequence
      `).all(cutoff);
      const attentionAt = new Date(nowMs).toISOString();
      const changed = [];
      for (const candidate of candidates) {
        const update = this.db.prepare(`
          UPDATE job_chains SET attention_required_at=?
          WHERE id=? AND active_job_id=? AND state IN ('input_required', 'input_invalid')
            AND attention_required_at IS NULL
        `).run(attentionAt, candidate.id, candidate.active_job_id);
        if (Number(update.changes) !== 1) continue;
        this.createChainEvent(candidate.id, candidate.active_job_id, "attention_required", {
          ownerActionRequired: true,
          laneReleased: false,
        }, attentionAt);
        changed.push(candidate.active_job_id);
      }
      return changed;
    });
    for (const jobId of marked) this.emit("change", this.requireJob(jobId));
    return marked.map((jobId) => ({ fingerprint: inputRequestFingerprint(
      this.db.prepare(`
        SELECT c.*, j.state AS job_state, j.updated_at AS job_updated_at,
               j.assistant_disposition, j.local_data_request_json
        FROM job_chains c JOIN jobs j ON j.id=c.active_job_id WHERE j.id=?
      `).get(jobId),
    ), state: "attention_required" }));
  }

  earliestAttentionWake({ afterMs = 30 * 60_000 } = {}) {
    const row = this.db.prepare(`
      SELECT MIN(updated_at) AS created_at FROM job_chains
      WHERE state IN ('input_required', 'input_invalid') AND attention_required_at IS NULL
    `).get();
    if (!row?.created_at) return null;
    return new Date(Date.parse(row.created_at) + Math.max(1, Number(afterMs) || 30 * 60_000)).toISOString();
  }

  abandonInputRequestInCurrentTransaction(row, { reason, recoveryMode }, now = new Date().toISOString()) {
    const request = parse(row.local_data_request_json);
    const validRequest = row.state === "input_required" && row.job_state === "completed" &&
      row.assistant_disposition === "local_data_request" && request;
    const malformedRequest = row.state === "input_invalid" && row.job_state === "input_invalid" &&
      row.assistant_disposition === "input_invalid";
    if (!validRequest && !malformedRequest) {
      throw codedError("LOCAL_DATA_REQUEST_REQUIRED", "The selected logical chain is not waiting for a valid local-data request.");
    }
    const changed = this.db.prepare(`
      UPDATE job_chains
      SET state = 'completed', terminal_at = ?, updated_at = ?,
          input_required_abandoned_at = ?, input_required_abandoned_job_id = ?,
          input_required_abandoned_reason = ?
      WHERE id = ? AND active_job_id = ? AND state IN ('input_required', 'input_invalid')
    `).run(now, now, now, row.active_job_id, reason, row.id, row.active_job_id);
    if (Number(changed.changes) !== 1) {
      throw codedError("INPUT_REQUEST_CHANGED", "The input request changed while Oracle was abandoning it.", { safeToRetry: true });
    }
    this.createChainEvent(row.id, row.active_job_id, "completed", {
      inputRequestAbandoned: true,
      reason,
      recoveryMode,
      messageSent: false,
      replacementAuthorized: false,
    }, now);
    return {
      job: this.requireJob(row.active_job_id),
      chain: this.getChain(row.id),
      abandonedAt: now,
      reason,
      templateFalsePositive: request ? isTemplateLocalDataRequest(request) : false,
      inputInvalid: malformedRequest,
    };
  }

  abandonInputRequest(jobId, { reason = "user-declined" } = {}) {
    let released;
    this.transaction(() => {
      const job = this.requireJob(jobId);
      const chain = this.chainAccessRow(job.chainId);
      if (chain?.input_required_abandoned_job_id === job.id && chain.state === "completed") {
        released = {
          job,
          chain: this.getChain(chain.id),
          abandonedAt: chain.input_required_abandoned_at,
          reason: chain.input_required_abandoned_reason,
          templateFalsePositive: isTemplateLocalDataRequest(job.localDataRequest),
          inputInvalid: job.state === "input_invalid",
          idempotent: true,
        };
        return;
      }
      if (!chain || chain.active_job_id !== job.id) {
        throw codedError("LOCAL_DATA_REQUEST_REQUIRED", "Only the active input request in a logical chain can be abandoned.");
      }
      const row = {
        ...chain,
        job_state: job.state,
        job_updated_at: job.updatedAt,
        assistant_disposition: job.assistantDisposition,
        local_data_request_json: json(job.localDataRequest),
      };
      released = this.abandonInputRequestInCurrentTransaction(row, { reason, recoveryMode: "capability" });
    });
    this.emit("change", released.job);
    return released;
  }

  abandonOrphanedInputRequest(scopeKey, fingerprint, { reason = "user-declined" } = {}) {
    let released;
    this.transaction(() => {
      const row = this.requireMatchingInputRequest(scopeKey, fingerprint);
      if (row.state === "input_invalid" || row.job_state === "input_invalid") {
        throw codedError(
          "INPUT_INVALID_CAPABILITY_REQUIRED",
          "Malformed local-data input may be resolved only with the logical chain's existing control capability.",
        );
      }
      released = this.abandonInputRequestInCurrentTransaction(row, { reason, recoveryMode: "orphaned-capability" });
    });
    this.emit("change", released.job);
    return released;
  }

  cancel(jobId) {
    const job = this.requireJob(jobId);
    if (TERMINAL_JOB_STATES.has(job.state)) return { ...job, cancelled: job.state === "cancelled_pre_submit", detached: false };
    if (job.submitIntentAt || job.submissionMayHaveOccurred) {
      return { ...job, cancelled: false, detached: true };
    }
    const cancelled = this.transition(jobId, "cancelled_pre_submit", {
      recoveryAction: "start a new job only with a new explicit authorization",
    });
    return { ...cancelled, cancelled: true, detached: false };
  }

  reopenForMonitoring(jobId, { userTurnId, userTurnHash }) {
    const reopened = this.transaction(() => this.reopenForMonitoringInCurrentTransaction(
      jobId,
      { userTurnId, userTurnHash },
      new Date().toISOString(),
    ));
    this.emit("change", reopened);
    return reopened;
  }

  reopenForMonitoringInCurrentTransaction(jobId, { userTurnId, userTurnHash }, now) {
    const job = this.requireJob(jobId);
    if (!job.submitIntentAt ||
        !isCanonicalConversationUrl(job.conversationUrl) ||
        (!userTurnId && !userTurnHash)) {
      throw codedError(
        "EXACT_TURN_PROOF_REQUIRED",
        "Monitor-only recovery requires immutable submit intent, a canonical conversation URL, and an exact user-turn id or unambiguous semantic hash.",
        { submissionMayHaveOccurred: Boolean(job.submitIntentAt) },
      );
    }
    if ((job.userTurnId && job.userTurnId !== userTurnId) || (job.userTurnHash && job.userTurnHash !== userTurnHash)) {
      throw codedError(
        "IMMUTABLE_TURN_PROOF",
        "Monitor-only recovery cannot replace the durable exact user-turn proof.",
        { submissionMayHaveOccurred: true },
      );
    }
    this.db.prepare(`
      UPDATE jobs
      SET state='awaiting_response', user_turn_id=?, user_turn_hash=?, error_json=NULL,
          recovery_action='reattach submitted turn without resending', completed_at=NULL,
          updated_at=?, version=version+1
      WHERE id=?
    `).run(userTurnId ?? null, userTurnHash ?? null, now, jobId);
    this.db.prepare(`
      UPDATE job_attempts
      SET execution_state='idle', execution_owner_instance_id=NULL,
          execution_lease_generation=NULL, execution_heartbeat_at=NULL,
          next_execution_not_before=NULL, execution_kind='monitor_only',
          final_reconciliation_attempted_at=NULL
      WHERE job_id=?
    `).run(jobId);
    this.db.prepare("INSERT INTO job_events(job_id, state, details_json, created_at) VALUES (?, 'awaiting_response', ?, ?)")
      .run(jobId, json({ reconciledFrom: job.state, monitorOnly: true }), now);
    this.syncChainForJob(jobId, now, { reconciledFrom: job.state, monitorOnly: true });
    return this.requireJob(jobId);
  }

  jobChain(jobId) {
    const requested = this.requireJob(jobId);
    return this.db.prepare(`
      SELECT j.*, a.chain_id, a.kind AS attempt_kind, a.ordinal AS attempt_ordinal,
             a.execution_epoch, a.execution_owner_instance_id, a.execution_lease_generation,
             a.execution_state, a.execution_kind, a.execution_failure_count,
             a.next_execution_not_before, a.last_executor_error_json, a.monitor_deadline_at,
             a.final_reconciliation_attempted_at,
             c.state AS chain_state, c.input_required_abandoned_at,
             c.input_required_abandoned_job_id, c.input_required_abandoned_reason,
             c.attention_required_at
      FROM job_attempts a
      JOIN jobs j ON j.id = a.job_id
      JOIN job_chains c ON c.id = a.chain_id
      WHERE a.chain_id = ?
      ORDER BY a.ordinal ASC
    `).all(requested.chainId).map(rowToJob);
  }

  activeJob(jobId) {
    const requested = this.requireJob(jobId);
    const chain = this.getChain(requested.chainId);
    return this.requireJob(chain.activeJobId);
  }

  isRunnable(jobId) {
    const job = this.requireJob(jobId);
    const chain = this.getChain(job.chainId);
    if (!chain || chain.activeJobId !== job.id || TERMINAL_JOB_STATES.has(job.state)) return false;
    const attempt = this.db.prepare("SELECT * FROM job_attempts WHERE job_id = ?").get(jobId);
    if (!attempt || !new Set(["idle", "backoff"]).has(attempt.execution_state || "idle")) return false;
    if (attempt.next_execution_not_before && Date.parse(attempt.next_execution_not_before) > Date.now()) return false;
    const executionKind = attempt.execution_kind || "pre_submit";
    if (executionKind === "pre_submit" && (job.state !== "queued" || chain.state !== "queued" || job.submitIntentAt)) return false;
    if (executionKind === "monitor_only" && (!MONITOR_JOB_STATES.has(job.state) || !hasExactUserTurnProof(job))) return false;
    if (this.db.prepare("SELECT 1 blocked FROM quarantines WHERE scope_key=? AND active=1").get(chain.conversationKey)) return false;
    const earlier = this.db.prepare(`
      SELECT id FROM job_chains
      WHERE conversation_key = ?
        AND accepted_sequence < ?
        AND state IN ('queued', 'running', 'input_required', 'input_invalid')
      ORDER BY accepted_sequence LIMIT 1
    `).get(chain.conversationKey, chain.acceptedSequence);
    if (earlier) return false;
    const unqualifiedCreation = this.db.prepare(`
      SELECT id FROM job_chains
      WHERE target_kind IN ('new_standalone', 'new_project')
        AND canonical_url IS NULL
        AND state IN ('queued', 'running')
      ORDER BY accepted_sequence LIMIT 1
    `).get();
    if (unqualifiedCreation && unqualifiedCreation.id !== chain.id) return false;
    return true;
  }

  claimNextRunnable({ allowPreSubmit = true } = {}) {
    return this.claimRunnable(null, { allowPreSubmit });
  }

  claimRunnable(jobId = null, { allowPreSubmit = true } = {}) {
    return this.transaction(() => {
      this.assertCurrentBroker();
      const now = new Date().toISOString();
      const candidate = this.db.prepare(`
        SELECT j.id AS job_id, a.chain_id, a.execution_epoch, a.execution_kind, c.accepted_sequence
        FROM jobs j
        JOIN job_attempts a ON a.job_id = j.id
        JOIN job_chains c ON c.id = a.chain_id AND c.active_job_id = j.id
        WHERE j.state NOT IN (${Array.from(TERMINAL_JOB_STATES).map(() => "?").join(",")})
          AND a.execution_state IN ('idle', 'backoff')
          AND (a.next_execution_not_before IS NULL OR a.next_execution_not_before <= ?)
          AND (? IS NULL OR j.id = ?)
          AND (
            (a.execution_kind = 'pre_submit' AND j.state = 'queued' AND c.state = 'queued'
              AND j.submit_intent_at IS NULL AND ? = 1)
            OR
            (a.execution_kind = 'monitor_only' AND j.state IN ('user_turn_confirmed','awaiting_response','response_failed_detected','response_confirmed')
              AND j.submit_intent_at IS NOT NULL AND j.canonical_url IS NOT NULL
              AND (j.user_turn_id IS NOT NULL OR j.user_turn_hash IS NOT NULL)
              AND a.monitor_deadline_at IS NOT NULL
              AND oracle_canonical_conversation_url(j.canonical_url) = 1)
          )
          AND NOT EXISTS (
            SELECT 1 FROM quarantines q WHERE q.scope_key=c.conversation_key AND q.active=1
          )
          AND NOT EXISTS (
            SELECT 1 FROM job_chains earlier
            WHERE earlier.conversation_key = c.conversation_key
              AND earlier.accepted_sequence < c.accepted_sequence
              AND earlier.state IN ('queued', 'running', 'input_required', 'input_invalid')
          )
          AND NOT EXISTS (
            SELECT 1 FROM job_chains creation
            WHERE creation.target_kind IN ('new_standalone', 'new_project')
              AND creation.canonical_url IS NULL
              AND creation.state IN ('queued', 'running')
              AND creation.id != c.id
              AND creation.accepted_sequence < c.accepted_sequence
          )
        ORDER BY c.accepted_sequence, a.ordinal
        LIMIT 1
      `).get(...TERMINAL_JOB_STATES, now, jobId, jobId, allowPreSubmit ? 1 : 0);
      if (!candidate) return null;
      const attemptUpdate = this.db.prepare(`
        UPDATE job_attempts
        SET execution_epoch = execution_epoch + 1,
            execution_owner_instance_id = ?, execution_lease_generation = ?,
            execution_state = 'running', execution_started_at = ?, execution_heartbeat_at = ?,
            next_execution_not_before = NULL
        WHERE job_id = ? AND execution_epoch = ? AND execution_state IN ('idle', 'backoff')
      `).run(
        this.brokerContext.instanceId,
        this.brokerContext.leaseGeneration,
        now,
        now,
        candidate.job_id,
        candidate.execution_epoch,
      );
      if (Number(attemptUpdate.changes) !== 1) return null;
      const chainUpdate = this.db.prepare(`
        UPDATE job_chains SET state='running', updated_at=?
        WHERE id=? AND active_job_id=? AND state IN ('queued','running')
      `).run(now, candidate.chain_id, candidate.job_id);
      if (Number(chainUpdate.changes) !== 1) throw codedError("EXECUTION_CLAIM_RACE", "The logical chain changed while Oracle Firefox was claiming it.");
      return {
        jobId: candidate.job_id,
        chainId: candidate.chain_id,
        executionEpoch: Number(candidate.execution_epoch) + 1,
        executionKind: candidate.execution_kind,
        brokerInstanceId: this.brokerContext.instanceId,
        leaseGeneration: this.brokerContext.leaseGeneration,
      };
    });
  }

  beginExecution(jobId) {
    return this.claimRunnable(jobId);
  }

  assertExecution(claim) {
    if (!claim?.jobId || !claim?.chainId) {
      throw codedError("STALE_EXECUTION", "No valid Oracle Firefox execution claim was supplied.");
    }
    const row = this.db.prepare(`
      SELECT a.execution_epoch, a.execution_owner_instance_id, a.execution_lease_generation,
             a.execution_state, c.active_job_id, c.state,
             b.current_instance_id, b.current_lease_generation
      FROM job_attempts a
      JOIN job_chains c ON c.id = a.chain_id
      JOIN broker_state b ON b.id = 1
      WHERE a.job_id = ? AND a.chain_id = ?
    `).get(claim?.jobId, claim?.chainId);
    if (
      !row || Number(row.execution_epoch) !== Number(claim?.executionEpoch) ||
      row.execution_owner_instance_id !== claim?.brokerInstanceId ||
      Number(row.execution_lease_generation) !== Number(claim?.leaseGeneration) ||
      row.execution_state !== "running" || row.active_job_id !== claim?.jobId || row.state !== "running" ||
      row.current_instance_id !== claim?.brokerInstanceId ||
      Number(row.current_lease_generation) !== Number(claim?.leaseGeneration)
    ) {
      throw codedError("STALE_EXECUTION", "This browser executor no longer owns the logical job. No browser action was attempted.");
    }
    return true;
  }

  heartbeatExecution(claim) {
    return this.transaction(() => {
      this.assertExecution(claim);
      const now = new Date().toISOString();
      const changed = this.db.prepare(`
        UPDATE job_attempts SET execution_heartbeat_at = ?
        WHERE job_id = ? AND execution_epoch = ? AND execution_state = 'running'
      `).run(now, claim.jobId, claim.executionEpoch);
      if (Number(changed.changes) !== 1) {
        throw codedError("STALE_EXECUTION", "The Oracle Firefox execution heartbeat no longer owns this job.");
      }
      return now;
    });
  }

  transitionClaimed(claim, nextState, patch = {}, details = null) {
    let transitioned;
    this.transaction(() => {
      this.assertExecution(claim);
      transitioned = this.transitionInCurrentTransaction(claim.jobId, nextState, patch, details);
      if (TERMINAL_JOB_STATES.has(nextState)) {
        this.db.prepare(`
          UPDATE job_attempts SET execution_state='released', execution_owner_instance_id=NULL,
            execution_lease_generation=NULL, execution_heartbeat_at=? WHERE job_id=?
        `).run(new Date().toISOString(), claim.jobId);
      }
    });
    this.emit("change", transitioned);
    return transitioned;
  }

  completeResponseClaimed(claim, {
    assistantTurnId,
    assistantTurnHash,
    assistantTurnBound = false,
    assistantDisposition,
    responseDisposition = "completed",
    localDataRequest = null,
    result,
    recoveryAction = null,
    terminalState = "completed",
  }) {
    if (!assistantTurnHash || (!assistantTurnId && assistantTurnBound !== true) || !result) {
      throw codedError(
        "ASSISTANT_PROOF_REQUIRED",
        "A completed response requires an assistant id or unambiguous exact-turn binding, plus its content hash and complete durable result.",
        { submissionMayHaveOccurred: true },
      );
    }
    let completed;
    if (!new Set(["completed", "input_invalid"]).has(terminalState)) {
      throw codedError("INVALID_JOB_TRANSITION", "Assistant response commits may terminate only as completed or input_invalid.");
    }
    this.transaction(() => {
      this.assertExecution(claim);
      const job = this.requireJob(claim.jobId);
      if (!hasExactUserTurnProof(job) || job.executionKind !== "monitor_only") {
        throw codedError(
          "MONITOR_CLAIM_REQUIRED",
          "Only the exact monitor-only execution claim may commit an assistant response.",
          { submissionMayHaveOccurred: true },
        );
      }
      completed = this.transitionInCurrentTransaction(claim.jobId, terminalState, {
        assistantTurnId: assistantTurnId || null,
        assistantTurnHash,
        assistantDisposition,
        responseDisposition,
        localDataRequest,
        result,
        error: null,
        recoveryAction,
      }, {
        assistantTurnId,
        assistantTurnHash,
        responseDisposition,
        terminalAtomicCommit: true,
      });
      const releasedAt = new Date().toISOString();
      const changed = this.db.prepare(`
        UPDATE job_attempts SET execution_state='released', execution_owner_instance_id=NULL,
          execution_lease_generation=NULL, execution_heartbeat_at=?, next_execution_not_before=NULL
        WHERE job_id=? AND execution_epoch=? AND execution_state='running'
      `).run(releasedAt, claim.jobId, claim.executionEpoch);
      if (Number(changed.changes) !== 1) {
        throw codedError("STALE_EXECUTION", "The monitor claim changed before its terminal result could be committed.");
      }
      completed = this.requireJob(claim.jobId);
    });
    this.emit("change", completed);
    return completed;
  }

  beginFinalMonitorReconciliation(claim) {
    return this.transaction(() => {
      this.assertExecution(claim);
      const job = this.requireJob(claim.jobId);
      if (claim.executionKind !== "monitor_only" || !hasExactUserTurnProof(job)) {
        throw codedError("MONITOR_CLAIM_REQUIRED", "Final reconciliation requires the exact monitor-only execution claim.");
      }
      if (!job.monitorDeadlineAt || Date.parse(job.monitorDeadlineAt) > Date.now()) {
        throw codedError("MONITOR_DEADLINE_ACTIVE", "The original response-monitor deadline has not expired.", { safeToRetry: true });
      }
      const now = new Date().toISOString();
      const changed = this.db.prepare(`
        UPDATE job_attempts SET final_reconciliation_attempted_at=?
        WHERE job_id=? AND execution_epoch=? AND execution_state='running'
          AND final_reconciliation_attempted_at IS NULL
      `).run(now, claim.jobId, claim.executionEpoch);
      if (Number(changed.changes) !== 1) {
        throw codedError(
          "FINAL_RECONCILIATION_ALREADY_ATTEMPTED",
          "The one final exact-turn reconciliation attempt was already consumed.",
          { submissionMayHaveOccurred: true },
        );
      }
      return now;
    });
  }

  releaseExecutionWithBackoff(claim, error, { maximumFailures = 5, backoffDelays = null } = {}) {
    let released;
    this.transaction(() => {
      this.assertExecution(claim);
      const job = this.requireJob(claim.jobId);
      const attempt = this.db.prepare("SELECT * FROM job_attempts WHERE job_id=?").get(claim.jobId);
      const failures = Number(attempt.execution_failure_count || 0) + 1;
      const structured = structuredError(error, { jobState: job.state });
      const releaseTerminal = (state, recoveryAction) => {
        released = this.transitionInCurrentTransaction(claim.jobId, state, {
          error: { ...structured, submissionMayHaveOccurred: state !== "failed_pre_submit" },
          recoveryAction,
        });
        this.db.prepare(`
          UPDATE job_attempts SET execution_state='released', execution_owner_instance_id=NULL,
            execution_lease_generation=NULL, execution_failure_count=?, last_executor_error_json=?,
            next_execution_not_before=NULL WHERE job_id=? AND execution_epoch=?
        `).run(failures, json(structured), claim.jobId, claim.executionEpoch);
        if (state === "submission_uncertain" || state === "response_uncertain") {
          this.quarantine(job.conversationKey, job.id, structured.message);
        }
      };

      if (!job.submitIntentAt) {
        if (failures >= maximumFailures) {
          releaseTerminal("failed_pre_submit", "inspect the repeated pre-submit executor failure before authorizing another job");
          return;
        }
        const delays = backoffDelays?.length ? backoffDelays : [250, 1_000, 4_000, 15_000, 30_000];
        const delay = delays[Math.min(failures - 1, delays.length - 1)];
        const retryAt = new Date(Date.now() + delay).toISOString();
        this.db.prepare(`
          UPDATE job_attempts SET execution_state='backoff', execution_kind='pre_submit',
            execution_owner_instance_id=NULL, execution_lease_generation=NULL,
            execution_failure_count=?, next_execution_not_before=?, last_executor_error_json=?
          WHERE job_id=? AND execution_epoch=?
        `).run(failures, retryAt, json(structured), claim.jobId, claim.executionEpoch);
        this.db.prepare("UPDATE job_chains SET state='queued', updated_at=? WHERE id=? AND active_job_id=?")
          .run(new Date().toISOString(), claim.chainId, claim.jobId);
        released = this.requireJob(claim.jobId);
        return;
      }

      if (!hasExactUserTurnProof(job)) {
        releaseTerminal("submission_uncertain", `reconcile_job ${job.id}`);
        return;
      }
      if (attempt.final_reconciliation_attempted_at) {
        releaseTerminal("response_uncertain", `reconcile_job ${job.id}`);
        return;
      }
      const delays = backoffDelays?.length ? backoffDelays : [250, 1_000, 4_000, 15_000, 30_000];
      const delay = delays[Math.min(failures - 1, delays.length - 1)];
      const deadlineMs = Date.parse(attempt.monitor_deadline_at || job.monitorDeadlineAt || 0);
      const retryMs = Number.isFinite(deadlineMs) && deadlineMs > 0
        ? Math.min(Date.now() + delay, deadlineMs)
        : Date.now() + delay;
      const retryAt = new Date(Math.max(Date.now(), retryMs)).toISOString();
      const reattaching = structuredError(codedError(
        "MONITOR_REATTACHING",
        "Oracle is reattaching to the proven submitted turn without sending another message.",
        {
          safeToRetry: false,
          submissionMayHaveOccurred: true,
          recoveryAction: "wait for the existing monitor-only job; do not resubmit",
          details: {
            causeCode: structured.code,
            retryAt,
            monitorDeadlineAt: attempt.monitor_deadline_at || job.monitorDeadlineAt || null,
            retryCount: failures,
          },
        },
      ));
      this.db.prepare(`
        UPDATE job_attempts SET execution_state='backoff', execution_kind='monitor_only',
          execution_owner_instance_id=NULL, execution_lease_generation=NULL,
          execution_failure_count=?, next_execution_not_before=?, last_executor_error_json=?
        WHERE job_id=? AND execution_epoch=?
      `).run(failures, retryAt, json(reattaching), claim.jobId, claim.executionEpoch);
      this.db.prepare("UPDATE job_chains SET state='running', updated_at=? WHERE id=? AND active_job_id=?")
        .run(new Date().toISOString(), claim.chainId, claim.jobId);
      released = this.requireJob(claim.jobId);
    });
    this.emit("change", released);
    return released;
  }

  releaseExecutionClaim(claim, error = null) {
    try {
      this.assertExecution(claim);
    } catch {
      return false;
    }
    const job = this.requireJob(claim.jobId);
    if (!TERMINAL_JOB_STATES.has(job.state)) {
      return this.releaseExecutionWithBackoff(
        claim,
        error || codedError(
          "EXECUTOR_EXITED_WITHOUT_SETTLEMENT",
          "The browser executor exited without committing a terminal result; its durable claim was recovered.",
          { safeToRetry: true, submissionMayHaveOccurred: Boolean(job.submitIntentAt) },
        ),
      );
    }
    let released = false;
    this.transaction(() => {
      try { this.assertExecution(claim); } catch { return; }
      const changed = this.db.prepare(`
        UPDATE job_attempts SET execution_state='released', execution_owner_instance_id=NULL,
          execution_lease_generation=NULL, execution_heartbeat_at=?
        WHERE job_id=? AND execution_epoch=? AND execution_state='running'
      `).run(new Date().toISOString(), claim.jobId, claim.executionEpoch);
      released = Number(changed.changes) === 1;
    });
    return released;
  }

  sweepAbandonedExecutionClaims({
    activeExecutorIds = [],
    heartbeatTimeoutMs = 20_000,
    nowMs = Date.now(),
  } = {}) {
    const live = new Set(Array.from(activeExecutorIds, (value) => String(value)));
    const boundedTimeout = Math.max(1, Number(heartbeatTimeoutMs) || 20_000);
    const sweepNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const staleBefore = new Date(sweepNow - boundedTimeout).toISOString();
    const recovered = [];
    const changed = [];
    this.transaction(() => {
      this.assertCurrentBroker();
      const candidates = this.db.prepare(this.jobSelect(`
        WHERE a.execution_state='running'
          AND a.execution_owner_instance_id=?
          AND a.execution_lease_generation=?
          AND COALESCE(a.execution_heartbeat_at, a.execution_started_at, a.created_at) <= ?
          AND j.state NOT IN (${Array.from(TERMINAL_JOB_STATES).map(() => "?").join(",")})
      `, "ORDER BY a.execution_heartbeat_at, j.created_at")).all(
        this.brokerContext.instanceId,
        this.brokerContext.leaseGeneration,
        staleBefore,
        ...TERMINAL_JOB_STATES,
      ).map(rowToJob);

      for (const job of candidates) {
        if (live.has(job.id)) continue;
        const monitorOnly = Boolean(job.submitIntentAt && hasExactUserTurnProof(job));
        const terminalUncertainty = Boolean(job.submitIntentAt && !monitorOnly);
        const nextExecutionState = terminalUncertainty ? "released" : "idle";
        const nextExecutionKind = monitorOnly ? "monitor_only" : "pre_submit";
        const reclaimed = this.db.prepare(`
          UPDATE job_attempts
          SET execution_epoch=execution_epoch+1, execution_state=?, execution_kind=?,
              execution_owner_instance_id=NULL, execution_lease_generation=NULL,
              execution_started_at=NULL, execution_heartbeat_at=NULL,
              next_execution_not_before=NULL
          WHERE job_id=? AND execution_epoch=? AND execution_state='running'
            AND execution_owner_instance_id=? AND execution_lease_generation=?
            AND COALESCE(execution_heartbeat_at, execution_started_at, created_at) <= ?
        `).run(
          nextExecutionState,
          nextExecutionKind,
          job.id,
          job.executionEpoch,
          this.brokerContext.instanceId,
          this.brokerContext.leaseGeneration,
          staleBefore,
        );
        if (Number(reclaimed.changes) !== 1) continue;

        const now = new Date(sweepNow).toISOString();
        if (!job.submitIntentAt) {
          this.db.prepare(`
            UPDATE jobs SET state='queued', updated_at=?, recovery_action=?,
              submission_may_have_happened=0,
              user_turn_id=NULL, user_turn_hash=NULL,
              assistant_turn_id=NULL, assistant_turn_hash=NULL,
              version=version+1 WHERE id=?
          `).run(now, "recovered abandoned pre-submit executor", job.id);
          this.db.prepare("UPDATE job_chains SET state='queued', updated_at=? WHERE id=? AND active_job_id=?")
            .run(now, job.chainId, job.id);
          this.db.prepare(`
            INSERT INTO job_events(job_id,state,details_json,created_at,broker_instance_id,lease_generation)
            VALUES (?, 'queued', ?, ?, ?, ?)
          `).run(
            job.id,
            json({ abandonedClaim: true, recoveredFrom: job.state, executionEpoch: job.executionEpoch }),
            now,
            this.brokerContext.instanceId,
            this.brokerContext.leaseGeneration,
          );
          recovered.push({ id: job.id, action: "requeued-pre-submit" });
        } else if (monitorOnly) {
          const recoveredState = PRE_SUBMIT_JOB_STATES.has(job.state) || job.state === "submit_intent"
            ? "awaiting_response"
            : job.state;
          this.db.prepare(`
            UPDATE jobs SET state=?, updated_at=?, recovery_action=?,
              submission_may_have_happened=1, version=version+1 WHERE id=?
          `).run(recoveredState, now, "recovered abandoned monitor-only executor without resending", job.id);
          this.db.prepare("UPDATE job_chains SET state='running', updated_at=? WHERE id=? AND active_job_id=?")
            .run(now, job.chainId, job.id);
          this.db.prepare(`
            INSERT INTO job_events(job_id,state,details_json,created_at,broker_instance_id,lease_generation)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            job.id,
            recoveredState,
            json({ abandonedClaim: true, monitorOnly: true, executionEpoch: job.executionEpoch }),
            now,
            this.brokerContext.instanceId,
            this.brokerContext.leaseGeneration,
          );
          recovered.push({ id: job.id, action: "resumed-monitor-only" });
        } else {
          this.transitionInCurrentTransaction(job.id, "submission_uncertain", {
            error: {
              code: "SUBMISSION_UNCERTAIN",
              message: "A submitted executor was abandoned without exact canonical user-turn proof.",
              submissionMayHaveOccurred: true,
            },
            recoveryAction: `reconcile_job ${job.id}`,
          }, { abandonedClaim: true, executionEpoch: job.executionEpoch });
          this.quarantine(job.conversationKey, job.id, "Abandoned submitted executor without exact user-turn proof");
          recovered.push({ id: job.id, action: "submission-uncertain" });
        }
        changed.push(job.id);
      }
    });
    for (const id of changed) this.emit("change", this.requireJob(id));
    return recovered;
  }

  earliestExecutionWake() {
    return this.db.prepare(`
      SELECT MIN(next_execution_not_before) wake_at FROM job_attempts
      WHERE execution_state='backoff' AND next_execution_not_before IS NOT NULL
    `).get()?.wake_at || null;
  }

  accountState() {
    const row = this.db.prepare("SELECT * FROM account_state WHERE id = 1").get();
    const broker = this.db.prepare("SELECT qualified_concurrency FROM broker_state WHERE id = 1").get();
    return {
      gateVersion: row.gate_version,
      nextSubmitNotBefore: row.next_submit_not_before,
      cooldownUntil: row.cooldown_until,
      cooldownCode: row.cooldown_code,
      cooldownCount: row.cooldown_count,
      cooldownIncidentCount: Number(this.db.prepare("SELECT COUNT(*) count FROM cooldown_incidents").get()?.count || 0),
      effectiveConcurrency: row.effective_concurrency,
      successStreak: row.success_streak,
      probeInFlight: Boolean(row.probe_in_flight),
      lastSuccessAt: row.last_success_at,
      updatedAt: row.updated_at,
      qualifiedConcurrency: Number(broker?.qualified_concurrency || 1),
    };
  }

  setQualifiedConcurrency(value) {
    this.assertCurrentBroker();
    const qualified = Math.max(1, Math.min(5, Number(value) || 1));
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE broker_state SET qualified_concurrency=?, updated_at=? WHERE id=1").run(qualified, now);
      this.db.prepare(`
        UPDATE account_state SET effective_concurrency=?, updated_at=?
        WHERE id=1 AND cooldown_until IS NULL
      `).run(qualified, now);
    });
    return qualified;
  }

  databaseStatus() {
    return {
      sqliteVersion: this.db.prepare("SELECT sqlite_version() version").get().version,
      journalMode: this.db.prepare("PRAGMA journal_mode").get().journal_mode,
      synchronous: this.db.prepare("PRAGMA synchronous").get().synchronous,
      foreignKeys: Boolean(this.db.prepare("PRAGMA foreign_keys").get().foreign_keys),
      schemaVersion: Number(this.db.prepare("SELECT COALESCE(MAX(version), 0) version FROM schema_migrations").get().version),
    };
  }

  protocolCompatibilityStatus() {
    const state = this.db.prepare(`
      SELECT minimum_reader_protocol, minimum_writer_protocol
      FROM broker_state WHERE id=1
    `).get();
    const counts = { currentWriter: 0, readOnlyLegacy: 0, incompatible: 0, unknown: 0 };
    const sessions = this.db.prepare(`
      SELECT metadata_json FROM owner_sessions WHERE revoked_at IS NULL
    `).all();
    for (const session of sessions) {
      const protocol = Number(parse(session.metadata_json)?.protocolVersion || 0);
      if (!protocol) counts.unknown += 1;
      else if (protocol >= BROKER_MINIMUM_WRITER_PROTOCOL && protocol <= BROKER_PROTOCOL_VERSION) counts.currentWriter += 1;
      else if (protocol >= BROKER_MINIMUM_READER_PROTOCOL && protocol < BROKER_MINIMUM_WRITER_PROTOCOL) counts.readOnlyLegacy += 1;
      else counts.incompatible += 1;
    }
    return {
      brokerProtocol: BROKER_PROTOCOL_VERSION,
      minimumReaderProtocol: Number(state?.minimum_reader_protocol || BROKER_MINIMUM_READER_PROTOCOL),
      minimumWriterProtocol: Number(state?.minimum_writer_protocol || BROKER_MINIMUM_WRITER_PROTOCOL),
      protocol8ReadCompatible: BROKER_MINIMUM_READER_PROTOCOL <= 8 && BROKER_PROTOCOL_VERSION >= 8,
      clientSessions: { total: sessions.length, ...counts },
    };
  }

  completionDeliveryHealth() {
    const subscriptionRows = this.db.prepare(`
      SELECT state, COUNT(*) count FROM completion_subscriptions GROUP BY state
    `).all();
    const deliveryRows = this.db.prepare(`
      SELECT state, COUNT(*) count FROM completion_deliveries GROUP BY state
    `).all();
    const counts = (rows) => Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
    const subscriptions = { open: 0, closed: 0, ...counts(subscriptionRows) };
    const deliveries = { pending: 0, claimed: 0, delivered: 0, acknowledged: 0, ...counts(deliveryRows) };
    const retry = this.db.prepare(`
      SELECT COUNT(*) AS scheduled,
             MIN(next_attempt_at) AS next_attempt_at,
             SUM(CASE WHEN last_error_json IS NOT NULL THEN 1 ELSE 0 END) AS with_error
      FROM completion_deliveries
      WHERE state='pending' AND next_attempt_at IS NOT NULL
    `).get();
    const expiredClaims = Number(this.db.prepare(`
      SELECT COUNT(*) count FROM completion_deliveries
      WHERE state='claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?
    `).get(new Date().toISOString())?.count || 0);
    return {
      subscriptions: { ...subscriptions, total: subscriptions.open + subscriptions.closed },
      deliveries: {
        ...deliveries,
        total: deliveries.pending + deliveries.claimed + deliveries.delivered + deliveries.acknowledged,
      },
      retry: {
        scheduled: Number(retry?.scheduled || 0),
        nextAttemptAt: retry?.next_attempt_at || null,
        withLastError: Number(retry?.with_error || 0),
        expiredClaims,
      },
    };
  }

  checkInvariants() {
    const violations = [];
    const foreign = this.db.prepare("PRAGMA foreign_key_check").all();
    if (foreign.length) violations.push({ invariant: "DB-FOREIGN-KEYS", count: foreign.length });
    const missingAttempts = this.db.prepare(`
      SELECT COUNT(*) count FROM jobs j LEFT JOIN job_attempts a ON a.job_id = j.id WHERE a.job_id IS NULL
    `).get().count;
    if (missingAttempts) violations.push({ invariant: "CHAIN-EVERY-JOB", count: Number(missingAttempts) });
    const invalidActive = this.db.prepare(`
      SELECT COUNT(*) count FROM job_chains c
      LEFT JOIN job_attempts a ON a.job_id = c.active_job_id AND a.chain_id = c.id
      WHERE a.job_id IS NULL
    `).get().count;
    if (invalidActive) violations.push({ invariant: "CHAIN-ACTIVE-ATTEMPT", count: Number(invalidActive) });
    const ownerless = this.db.prepare(`
      SELECT COUNT(*) count FROM job_chains
      WHERE legacy_mode = 'none' AND (read_cap_hash IS NULL OR control_cap_hash IS NULL)
    `).get().count;
    if (ownerless) violations.push({ invariant: "CAP-NEW-CHAINS", count: Number(ownerless) });
    const duplicateRunningLanes = this.db.prepare(`
      SELECT COUNT(*) count FROM (
        SELECT conversation_key FROM job_chains WHERE state = 'running'
        GROUP BY conversation_key HAVING COUNT(*) > 1
      )
    `).get().count;
    if (duplicateRunningLanes) violations.push({ invariant: "LANE-ONE-OWNER", count: Number(duplicateRunningLanes) });
    return { ok: violations.length === 0, violations };
  }

  issueSubmitPermit(jobId, { minimumIntervalMs = 2_000, ttlMs = 30_000 } = {}) {
    return this.transaction(() => {
      const nowMs = Date.now();
      const state = this.accountState();
      const cooldownMs = state.cooldownUntil ? Date.parse(state.cooldownUntil) : 0;
      if (cooldownMs > nowMs) {
        throw codedError("ACCOUNT_COOLDOWN", "ChatGPT submissions are paused by the broker-wide account cooldown.", {
          safeToRetry: true,
          recoveryAction: `wait until ${state.cooldownUntil} before submitting again`,
          details: {
            cooldownUntil: state.cooldownUntil,
            cooldownCode: state.cooldownCode,
            cooldownEpoch: state.gateVersion,
            existingLocalGate: true,
          },
        });
      }
      const paceMs = state.nextSubmitNotBefore ? Date.parse(state.nextSubmitNotBefore) : 0;
      if (paceMs > nowMs) {
        throw codedError("SUBMIT_PACING_WAIT", "The durable account submission interval has not elapsed.", {
          safeToRetry: true,
          details: { retryAt: state.nextSubmitNotBefore },
        });
      }
      const id = randomUUID();
      const now = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + ttlMs).toISOString();
      this.db.prepare(`
        UPDATE submit_permits SET invalidated_at = ?
        WHERE consumed_at IS NULL AND invalidated_at IS NULL AND expires_at <= ?
      `).run(now, now);
      const reopening = Boolean(state.cooldownUntil && cooldownMs <= nowMs);
      if (reopening) {
        this.db.prepare(`
          UPDATE account_state
          SET cooldown_until = NULL, cooldown_code = NULL, effective_concurrency = 1,
              probe_in_flight = 1, updated_at = ?
          WHERE id = 1
        `).run(now);
      }
      this.db.prepare(`
        INSERT INTO submit_permits(id, job_id, gate_version, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, jobId, state.gateVersion, now, expiresAt);
      this.db.prepare("UPDATE account_state SET next_submit_not_before = ?, updated_at = ? WHERE id = 1")
        .run(new Date(nowMs + (reopening ? Math.max(minimumIntervalMs, 30_000) : minimumIntervalMs)).toISOString(), now);
      return { id, jobId, gateVersion: state.gateVersion, issuedAt: now, expiresAt };
    });
  }

  consumeSubmitPermit(jobId, permitId, patch = {}, details = null) {
    const transitioned = this.transaction(() => {
      const now = new Date().toISOString();
      const permit = this.db.prepare("SELECT * FROM submit_permits WHERE id = ? AND job_id = ?").get(permitId, jobId);
      const account = this.db.prepare("SELECT * FROM account_state WHERE id = 1").get();
      const job = this.requireJob(jobId);
      if (
        !permit || permit.consumed_at || permit.invalidated_at ||
        job.submitIntentAt || job.state === "cancelled_pre_submit" ||
        Date.parse(permit.expires_at) <= Date.now() ||
        permit.gate_version !== account.gate_version ||
        (account.cooldown_until && Date.parse(account.cooldown_until) > Date.now())
      ) {
        throw codedError("SUBMIT_PERMIT_INVALID", "The broker-wide submit permit expired or was invalidated. No message was sent.", { safeToRetry: true });
      }
      this.db.prepare("UPDATE submit_permits SET consumed_at = ? WHERE id = ?").run(now, permitId);
      return this.transitionInCurrentTransaction(jobId, "submit_intent", patch, details, now);
    });
    this.emit("change", transitioned);
    return transitioned;
  }

  consumeSubmitPermitClaimed(claim, permitId, patch = {}, details = null) {
    let transitioned;
    this.transaction(() => {
      this.assertExecution(claim);
      const now = new Date().toISOString();
      const permit = this.db.prepare("SELECT * FROM submit_permits WHERE id = ? AND job_id = ?").get(permitId, claim.jobId);
      const account = this.db.prepare("SELECT * FROM account_state WHERE id = 1").get();
      const job = this.requireJob(claim.jobId);
      if (
        !permit || permit.consumed_at || permit.invalidated_at || job.submitIntentAt ||
        Date.parse(permit.expires_at) <= Date.now() || permit.gate_version !== account.gate_version ||
        (account.cooldown_until && Date.parse(account.cooldown_until) > Date.now()) ||
        job.state === "cancelled_pre_submit"
      ) {
        throw codedError("SUBMIT_PERMIT_INVALID", "The broker-wide submit permit or execution claim is no longer valid. No message was sent.", { safeToRetry: true });
      }
      this.db.prepare("UPDATE submit_permits SET consumed_at = ? WHERE id = ?").run(now, permitId);
      transitioned = this.transitionInCurrentTransaction(claim.jobId, "submit_intent", patch, details, now);
    });
    this.emit("change", transitioned);
    return transitioned;
  }

  recordAccountCooldown(error, { minimumMs = 120_000, maximumMs = 30 * 60_000, nowMs = Date.now() } = {}) {
    return this.transaction(() => {
      const evidence = error?.details?.remoteThrottleEvidence || error?.remoteThrottleEvidence || null;
      if (!evidence || typeof evidence !== "object") {
        return { ...this.accountState(), incidentRecorded: false, existingLocalGate: true };
      }
      const evidenceFingerprint = /^[a-f0-9]{64}$/u.test(String(evidence.fingerprint || ""))
        ? String(evidence.fingerprint)
        : createHash("sha256").update(`oracle-remote-throttle-v1\0${JSON.stringify(evidence)}`).digest("hex");
      const current = this.accountState();
      const count = current.cooldownCount + 1;
      const duration = Math.min(maximumMs, minimumMs * (2 ** Math.min(4, count - 1)));
      const now = new Date(nowMs).toISOString();
      const until = new Date(nowMs + duration).toISOString();
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO cooldown_incidents(
          evidence_fingerprint, evidence_kind, code, first_seen_at, last_seen_at,
          observer_count, cooldown_until
        ) VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run(
        evidenceFingerprint,
        String(evidence.kind || "remote_throttle"),
        error?.code || "ACCOUNT_COOLDOWN",
        now,
        now,
        until,
      );
      if (Number(inserted.changes) === 0) {
        this.db.prepare(`
          UPDATE cooldown_incidents SET observer_count=observer_count+1, last_seen_at=?
          WHERE evidence_fingerprint=?
        `).run(now, evidenceFingerprint);
        return {
          ...this.accountState(),
          incidentRecorded: false,
          evidenceFingerprint,
          existingLocalGate: false,
        };
      }
      this.db.prepare(`
        UPDATE account_state
        SET gate_version = gate_version + 1, cooldown_until = ?, cooldown_code = ?,
            cooldown_count = ?, effective_concurrency = 0,
            success_streak = 0, probe_in_flight = 0, updated_at = ?
        WHERE id = 1
      `).run(until, error?.code || "ACCOUNT_COOLDOWN", count, now);
      this.db.prepare("UPDATE submit_permits SET invalidated_at = ? WHERE consumed_at IS NULL AND invalidated_at IS NULL").run(now);
      return { ...this.accountState(), incidentRecorded: true, evidenceFingerprint, existingLocalGate: false };
    });
  }

  recordSubmissionSuccess() {
    const now = new Date().toISOString();
    const qualified = Number(this.db.prepare("SELECT qualified_concurrency FROM broker_state WHERE id=1").get()?.qualified_concurrency || 1);
    this.db.prepare(`
      UPDATE account_state
      SET cooldown_until = NULL, cooldown_code = NULL, cooldown_count = 0,
          success_streak = success_streak + 1, probe_in_flight = 0,
          effective_concurrency = MIN(?, MAX(effective_concurrency, 1 + CAST((success_streak + 1) / 3 AS INTEGER))),
          last_success_at = ?, updated_at = ?
      WHERE id = 1
    `).run(qualified, now, now);
    return this.accountState();
  }

  subscriptionForChain(chainId, ownerSessionId) {
    return this.db.prepare(`
      SELECT * FROM completion_subscriptions
      WHERE chain_id = ? AND owner_session_id = ? AND state = 'open'
      ORDER BY created_at LIMIT 1
    `).get(chainId, ownerSessionId);
  }

  authorizeSubscription({ subscriptionHandle, caller }) {
    const parsed = parseCapability(subscriptionHandle, "subscription");
    let row = null;
    if (parsed) row = this.db.prepare("SELECT * FROM completion_subscriptions WHERE id = ?").get(parsed.subjectId);
    if (!row || !verifyCapability(subscriptionHandle, row.capability_hash, { kind: "subscription", subjectId: row.id })) {
      throw codedError("COMPLETION_NOT_FOUND", "No accessible Oracle Firefox completion subscription matches that reference.");
    }
    return row;
  }

  claimCompletion(subscriptionHandle, caller, { claimSeconds = 90 } = {}) {
    return this.transaction(() => {
      const subscription = this.authorizeSubscription({ subscriptionHandle, caller });
      if (subscription.state !== "open") return null;
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE completion_deliveries
        SET state = 'pending', claim_id = NULL, claimed_at = NULL,
            claim_kind = NULL, claim_expires_at = NULL
        WHERE subscription_id = ? AND state = 'claimed' AND claim_kind = 'subscriber'
          AND claim_expires_at <= ?
      `).run(subscription.id, now);
      const delivery = this.db.prepare(`
        SELECT d.*, e.chain_id, e.active_job_id, e.state AS event_state,
               e.created_at AS event_created_at
        FROM completion_deliveries d
        JOIN chain_events e ON e.sequence = d.chain_event_sequence
        WHERE d.subscription_id = ? AND d.state IN ('pending', 'delivered')
        ORDER BY d.id LIMIT 1
      `).get(subscription.id);
      if (!delivery) return null;
      if (delivery.state === "delivered") return this.publicCompletionDelivery(delivery, subscription);
      const claimId = randomUUID();
      const expiresAt = new Date(Date.now() + Math.max(10, claimSeconds) * 1_000).toISOString();
      this.db.prepare(`
        UPDATE completion_deliveries
        SET state = 'claimed', claim_id = ?, claimed_at = ?, claim_kind = 'subscriber', claim_expires_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(claimId, now, expiresAt, delivery.id);
      return this.publicCompletionDelivery({
        ...delivery,
        state: "claimed",
        claim_id: claimId,
        claimed_at: now,
        claim_expires_at: expiresAt,
      }, subscription);
    });
  }

  publicCompletionDelivery(delivery, subscription) {
    return {
      deliveryId: delivery.id,
      subscriptionId: subscription.id,
      chainId: delivery.chain_id,
      activeJobId: delivery.active_job_id,
      state: delivery.event_state,
      deliveryState: delivery.state,
      claimId: delivery.claim_id || null,
      createdAt: delivery.event_created_at,
    };
  }

  markCompletionDelivered(subscriptionHandle, caller, deliveryId, claimId) {
    return this.transaction(() => {
      const subscription = this.authorizeSubscription({ subscriptionHandle, caller });
      const now = new Date().toISOString();
      const changed = this.db.prepare(`
        UPDATE completion_deliveries
        SET state='delivered', delivered_at=?, claim_id=NULL, claimed_at=NULL,
            claim_kind=NULL, claim_expires_at=NULL, next_attempt_at=NULL,
            last_error_json=NULL
        WHERE id = ? AND subscription_id = ? AND state = 'claimed'
          AND claim_kind = 'subscriber' AND claim_id = ?
      `).run(now, deliveryId, subscription.id, claimId);
      if (Number(changed.changes) !== 1) throw codedError("COMPLETION_CLAIM_LOST", "The completion delivery claim is no longer active.");
      return { deliveryId, delivered: true, acknowledged: false };
    });
  }

  acknowledgeCompletion(subscriptionHandle, caller, deliveryId) {
    return this.transaction(() => {
      const subscription = this.authorizeSubscription({ subscriptionHandle, caller });
      const now = new Date().toISOString();
      const row = this.db.prepare(`
        SELECT d.*, e.state AS event_state
        FROM completion_deliveries d
        JOIN chain_events e ON e.sequence = d.chain_event_sequence
        WHERE d.id = ? AND d.subscription_id = ?
      `).get(deliveryId, subscription.id);
      if (!row) throw codedError("COMPLETION_NOT_FOUND", "No accessible completion delivery matches that reference.");
      this.db.prepare(`
        UPDATE completion_deliveries
        SET state='acknowledged', acknowledged_at=COALESCE(acknowledged_at, ?),
            claim_id=NULL, claimed_at=NULL, claim_kind=NULL, claim_expires_at=NULL,
            next_attempt_at=NULL, last_error_json=NULL
        WHERE id=?
      `).run(now, deliveryId);
      if (TERMINAL_CHAIN_STATES.has(row.event_state)) {
        this.db.prepare(`
          UPDATE completion_subscriptions SET state = 'closed', closed_at = ?
          WHERE id = ? AND state = 'open'
        `).run(now, subscription.id);
      }
      return { deliveryId, delivered: Boolean(row.delivered_at), acknowledged: true };
    });
  }

  maxCompletionDeliveryId() {
    return Number(this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM completion_deliveries").get()?.id || 0);
  }

  pendingSystemNotifications(afterId = 0) {
    return this.db.prepare(`
      SELECT d.id AS delivery_id, d.subscription_id, d.state AS delivery_state,
             e.chain_id, e.active_job_id, e.state AS event_state, e.created_at AS event_created_at,
             s.mode, o.harness
      FROM completion_deliveries d
      JOIN completion_subscriptions s ON s.id = d.subscription_id
      JOIN owner_sessions o ON o.id = s.owner_session_id
      JOIN chain_events e ON e.sequence = d.chain_event_sequence
      WHERE d.id > ? AND d.state = 'pending' AND s.state = 'open'
        AND (s.mode = 'notify' OR (s.mode = 'harness' AND o.harness = 'claude-desktop-mcp'))
      ORDER BY d.id
    `).all(Math.max(0, Number(afterId) || 0)).map((row) => ({
      deliveryId: Number(row.delivery_id),
      subscriptionId: row.subscription_id,
      chainId: row.chain_id,
      activeJobId: row.active_job_id,
      state: row.event_state,
      createdAt: row.event_created_at,
      mode: row.mode,
      harness: row.harness,
    }));
  }

  claimSystemNotification({ claimSeconds = 30 } = {}) {
    return this.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE completion_deliveries
        SET state='pending', claim_id=NULL, claimed_at=NULL, claim_kind=NULL,
            claim_expires_at=NULL
        WHERE state='claimed' AND claim_kind='system' AND claim_expires_at <= ?
      `).run(now);
      const row = this.db.prepare(`
        SELECT d.id AS delivery_id, d.subscription_id,
               e.chain_id, e.active_job_id, e.state AS event_state, e.created_at AS event_created_at,
               s.mode, o.harness, d.attempt_count
        FROM completion_deliveries d
        JOIN completion_subscriptions s ON s.id = d.subscription_id
        JOIN owner_sessions o ON o.id = s.owner_session_id
        JOIN chain_events e ON e.sequence = d.chain_event_sequence
        WHERE d.state='pending' AND s.state='open'
          AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
          AND (s.mode='notify' OR (s.mode='harness' AND o.harness='claude-desktop-mcp'))
        ORDER BY d.id LIMIT 1
      `).get(now);
      if (!row) return null;
      const claimId = randomUUID();
      const expiresAt = new Date(Date.now() + Math.max(1, claimSeconds) * 1_000).toISOString();
      const changed = this.db.prepare(`
        UPDATE completion_deliveries
        SET state='claimed', claim_id=?, claimed_at=?, claim_kind='system',
            claim_expires_at=?, attempt_count=attempt_count+1, next_attempt_at=NULL
        WHERE id=? AND state='pending'
      `).run(claimId, now, expiresAt, row.delivery_id);
      if (Number(changed.changes) !== 1) return null;
      return {
        deliveryId: Number(row.delivery_id),
        subscriptionId: row.subscription_id,
        chainId: row.chain_id,
        activeJobId: row.active_job_id,
        state: row.event_state,
        createdAt: row.event_created_at,
        mode: row.mode,
        harness: row.harness,
        claimId,
        claimExpiresAt: expiresAt,
        attempt: Number(row.attempt_count || 0) + 1,
      };
    });
  }

  markSystemNotificationDelivered(deliveryId, claimId) {
    if (!claimId) return false;
    const now = new Date().toISOString();
    const changed = this.db.prepare(`
      UPDATE completion_deliveries
      SET state='delivered', delivered_at=?, claim_id=NULL, claimed_at=NULL,
          claim_kind=NULL, claim_expires_at=NULL, next_attempt_at=NULL,
          last_error_json=NULL
      WHERE id=? AND state='claimed' AND claim_kind='system' AND claim_id=?
    `).run(now, deliveryId, claimId);
    return Number(changed.changes) === 1;
  }

  retrySystemNotification(deliveryId, claimId, error, { baseDelayMs = 1_000, maximumDelayMs = 60_000 } = {}) {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT attempt_count FROM completion_deliveries
        WHERE id=? AND state='claimed' AND claim_kind='system' AND claim_id=?
      `).get(deliveryId, claimId);
      if (!row) return null;
      const minimumDelay = Math.max(1, Number(baseDelayMs) || 1);
      const maximumDelay = Math.max(minimumDelay, Number(maximumDelayMs) || minimumDelay);
      const delayMs = Math.min(
        maximumDelay,
        minimumDelay * (2 ** Math.min(10, Math.max(0, Number(row.attempt_count) - 1))),
      );
      const retryAt = new Date(Date.now() + delayMs).toISOString();
      this.db.prepare(`
        UPDATE completion_deliveries
        SET state='pending', claim_id=NULL, claimed_at=NULL, claim_kind=NULL,
            claim_expires_at=NULL, next_attempt_at=?, last_error_json=?
        WHERE id=? AND state='claimed' AND claim_kind='system' AND claim_id=?
      `).run(retryAt, json(structuredError(error)), deliveryId, claimId);
      return { deliveryId, retryAt, attempt: Number(row.attempt_count) };
    });
  }

  nextSystemNotificationAt() {
    return this.db.prepare(`
      SELECT MIN(
        CASE d.state
          WHEN 'pending' THEN COALESCE(d.next_attempt_at, d.created_at)
          WHEN 'claimed' THEN d.claim_expires_at
        END
      ) AS ready_at
      FROM completion_deliveries d
      JOIN completion_subscriptions s ON s.id=d.subscription_id
      JOIN owner_sessions o ON o.id=s.owner_session_id
      WHERE s.state='open'
        AND (d.state='pending' OR (d.state='claimed' AND d.claim_kind='system'))
        AND (s.mode='notify' OR (s.mode='harness' AND o.harness='claude-desktop-mcp'))
    `).get()?.ready_at || null;
  }

  rebuildCompletionDeliveries() {
    return this.transaction(() => {
      const now = new Date().toISOString();
      const terminalChains = this.db.prepare(`
        SELECT c.id, c.active_job_id, c.state
        FROM job_chains c
        WHERE c.state IN (${Array.from(WAKE_CHAIN_STATES).map(() => "?").join(",")})
          AND NOT EXISTS (
            SELECT 1 FROM chain_events e
            WHERE e.chain_id=c.id AND e.active_job_id=c.active_job_id AND e.state=c.state
          )
      `).all(...WAKE_CHAIN_STATES);
      for (const chain of terminalChains) this.createChainEvent(chain.id, chain.active_job_id, chain.state, null, now);
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO completion_deliveries(
          subscription_id, chain_event_sequence, state, created_at
        )
        SELECT s.id, e.sequence, 'pending', ?
        FROM completion_subscriptions s
        JOIN chain_events e ON e.chain_id=s.chain_id
        WHERE s.state='open' AND s.mode!='manual'
          AND e.state IN (${Array.from(WAKE_CHAIN_STATES).map(() => "?").join(",")})
      `).run(now, ...WAKE_CHAIN_STATES);
      return { chainEvents: terminalChains.length, deliveries: Number(inserted.changes) };
    });
  }

  waitForChange(timeoutMs) {
    const bounded = Math.max(0, Number(timeoutMs) || 0);
    if (bounded === 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      let timer;
      const finish = (job) => {
        clearTimeout(timer);
        this.off("change", finish);
        resolve(job ?? null);
      };
      this.on("change", finish);
      timer = setTimeout(() => finish(null), bounded);
      timer.unref?.();
    });
  }

  eventsAfter(jobId, sequence = 0) {
    return this.db
      .prepare("SELECT sequence, state, details_json, created_at FROM job_events WHERE job_id = ? AND sequence > ? ORDER BY sequence")
      .all(jobId, sequence)
      .map((row) => ({ sequence: row.sequence, state: row.state, details: parse(row.details_json), createdAt: row.created_at }));
  }

  recoverInterruptedJobs() {
    const recovered = [];
    const changed = [];
    this.transaction(() => {
      this.assertCurrentBroker();
      const generation = Number(this.brokerContext.leaseGeneration);
      const brokerState = this.db.prepare("SELECT last_recovery_generation FROM broker_state WHERE id=1").get();
      if (Number(brokerState.last_recovery_generation) >= generation) return;
      const jobs = this.db.prepare(`
        SELECT j.*, a.chain_id, a.execution_state, a.execution_lease_generation
        FROM jobs j JOIN job_attempts a ON a.job_id=j.id
        WHERE j.state NOT IN (${Array.from(TERMINAL_JOB_STATES).map(() => "?").join(",")})
        ORDER BY j.created_at
      `).all(...TERMINAL_JOB_STATES).map(rowToJob);
      for (const job of jobs) {
        const preSubmitDebris = !job.submitIntentAt && Boolean(
          job.submissionMayHaveOccurred ||
          job.userTurnId ||
          job.userTurnHash ||
          job.assistantTurnId ||
          job.assistantTurnHash
        );
        const interrupted = job.executionState === "running" ||
          (job.submitIntentAt ? job.executionState !== "released" : (job.state !== "queued" || preSubmitDebris));
        if (!interrupted || Number(job.lastRecoveryGeneration || 0) >= generation) continue;
        const now = new Date().toISOString();
        let executionKind = "pre_submit";
        let executionState = "idle";
        if (!job.submitIntentAt) {
          this.db.prepare(`
            UPDATE jobs SET state='queued', updated_at=?, recovery_action=?,
              last_recovery_generation=?, version=version+1,
              submission_may_have_happened=0,
              user_turn_id=NULL, user_turn_hash=NULL,
              assistant_turn_id=NULL, assistant_turn_hash=NULL
            WHERE id=?
          `).run(now, "resumed safely before submission", generation, job.id);
          this.db.prepare(`
            INSERT INTO job_events(job_id,state,details_json,created_at,broker_instance_id,lease_generation)
            VALUES (?, 'queued', ?, ?, ?, ?)
          `).run(job.id, json({ recoveredFrom: job.state, recoveryGeneration: generation }), now, this.brokerContext.instanceId, generation);
          this.db.prepare("UPDATE job_chains SET state='queued', updated_at=? WHERE id=?").run(now, job.chainId);
          recovered.push({ id: job.id, action: "requeued" });
        } else if (hasExactUserTurnProof(job)) {
          executionKind = "monitor_only";
          const recoveredState = PRE_SUBMIT_JOB_STATES.has(job.state) || job.state === "submit_intent"
            ? "awaiting_response"
            : job.state;
          this.db.prepare(`
            UPDATE jobs SET state=?, updated_at=?, recovery_action=?,
              last_recovery_generation=?, version=version+1 WHERE id=?
          `).run(recoveredState, now, "reattach submitted turn without resending", generation, job.id);
          this.db.prepare("UPDATE job_chains SET state='running', updated_at=? WHERE id=?").run(now, job.chainId);
          this.db.prepare(`
            INSERT INTO job_events(job_id,state,details_json,created_at,broker_instance_id,lease_generation)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(job.id, recoveredState, json({ monitorOnly: true, recoveryGeneration: generation }), now, this.brokerContext.instanceId, generation);
          recovered.push({ id: job.id, action: "monitor-only" });
        } else {
          this.transitionInCurrentTransaction(job.id, "submission_uncertain", {
            error: { code: "SUBMISSION_UNCERTAIN", message: "Broker restarted after submit_intent without a proven user turn.", submissionMayHaveOccurred: true },
            recoveryAction: `reconcile_job ${job.id}`,
          }, { recoveryGeneration: generation });
          this.db.prepare("UPDATE jobs SET last_recovery_generation=? WHERE id=?").run(generation, job.id);
          this.quarantine(job.conversationKey, job.id, "Restart after submit_intent without a proven user turn");
          recovered.push({ id: job.id, action: "quarantined" });
          executionState = "released";
        }
        this.db.prepare(`
          UPDATE job_attempts SET execution_epoch=execution_epoch+1, execution_state=?,
            execution_owner_instance_id=NULL, execution_lease_generation=NULL,
            execution_started_at=NULL, execution_heartbeat_at=NULL,
            execution_kind=? WHERE job_id=?
        `).run(executionState, executionKind, job.id);
        changed.push(job.id);
      }
      const terminalClaims = this.db.prepare(`
        SELECT a.job_id FROM job_attempts a JOIN jobs j ON j.id=a.job_id
        WHERE a.execution_state='running'
          AND j.state IN (${Array.from(TERMINAL_JOB_STATES).map(() => "?").join(",")})
      `).all(...TERMINAL_JOB_STATES);
      for (const row of terminalClaims) {
        this.db.prepare(`
          UPDATE job_attempts SET execution_epoch=execution_epoch+1, execution_state='released',
            execution_owner_instance_id=NULL, execution_lease_generation=NULL,
            execution_heartbeat_at=? WHERE job_id=? AND execution_state='running'
        `).run(new Date().toISOString(), row.job_id);
        recovered.push({ id: row.job_id, action: "released-terminal" });
        changed.push(row.job_id);
      }
      this.db.prepare("UPDATE broker_state SET last_recovery_generation=?, updated_at=? WHERE id=1")
        .run(generation, new Date().toISOString());
    });
    for (const id of changed) this.emit("change", this.requireJob(id));
    return recovered;
  }
}
