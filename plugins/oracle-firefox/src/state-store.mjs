import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { coordinatorDatabasePath } from "./config.mjs";
import { codedError, structuredError } from "./errors.mjs";

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
  "response_confirmed",
  "completed",
  "cancelled_pre_submit",
  "failed_pre_submit",
  "submission_uncertain",
  "response_uncertain",
  "quarantined",
]);

export const TERMINAL_JOB_STATES = new Set([
  "completed",
  "cancelled_pre_submit",
  "failed_pre_submit",
  "submission_uncertain",
  "response_uncertain",
  "quarantined",
]);

const STATE_INDEX = new Map(JOB_STATES.map((state, index) => [state, index]));
const SUBMIT_INDEX = STATE_INDEX.get("submit_intent");

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
    localDataRequest: parse(row.local_data_request_json),
    evidenceRound: row.evidence_round,
    maxAutomaticEvidenceReplies: row.max_evidence_replies,
    submissionMayHaveOccurred: Boolean(row.submission_may_have_happened),
    submitIntentAt: row.submit_intent_at,
    result: parse(row.result_json),
    error: parse(row.error_json),
    recoveryAction: row.recovery_action,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    version: row.version,
  };
}

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

export class StateStore {
  constructor(databasePath = coordinatorDatabasePath()) {
    this.databasePath = databasePath;
    this.db = null;
  }

  async open() {
    await mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(this.databasePath), 0o700);
    this.db = new DatabaseSync(this.databasePath);
    await chmod(this.databasePath, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    return this;
  }

  migrate() {
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
        local_data_request_json TEXT,
        evidence_round INTEGER NOT NULL DEFAULT 0,
        max_evidence_replies INTEGER NOT NULL DEFAULT 3,
        submission_may_have_happened INTEGER NOT NULL DEFAULT 0,
        submit_intent_at TEXT,
        result_json TEXT,
        error_json TEXT,
        recovery_action TEXT,
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

  createJob(input) {
    const now = new Date().toISOString();
    const digest = input.requestDigest || requestDigest(input.request);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM jobs WHERE authorization_id = ?").get(input.authorizationId);
      if (existing) {
        if (existing.request_digest !== digest) {
          throw codedError(
            "AUTHORIZATION_REUSED",
            "This authorizationId was already used for a different request.",
            { safeToRetry: false },
          );
        }
        return { job: rowToJob(existing), idempotent: true };
      }
      const activeQuarantine = this.db
        .prepare("SELECT * FROM quarantines WHERE scope_key = ? AND active = 1")
        .get(input.conversationKey);
      if (activeQuarantine) {
        throw codedError(
          "CONVERSATION_QUARANTINED",
          "This conversation or new-chat scope is quarantined until its uncertain submission is reconciled.",
          { recoveryAction: `reconcile_job ${activeQuarantine.job_id}` },
        );
      }
      const id = input.id || randomUUID();
      this.db.prepare(`
        INSERT INTO jobs (
          id, authorization_id, operation, state, request_json, request_digest,
          conversation_key, canonical_url, project_title, project_url, chat_title,
          session_path, evidence_round, max_evidence_replies, created_at, updated_at
        ) VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        now,
        now,
      );
      this.db.prepare("INSERT INTO job_events(job_id, state, details_json, created_at) VALUES (?, 'accepted', ?, ?)")
        .run(id, json({ operation: input.operation }), now);
      return { job: this.getJob(id), idempotent: false };
    });
  }

  getJob(id) {
    return rowToJob(this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
  }

  getJobByAuthorization(authorizationId) {
    return rowToJob(this.db.prepare("SELECT * FROM jobs WHERE authorization_id = ?").get(authorizationId));
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
        .prepare(`SELECT * FROM jobs WHERE state IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`)
        .all(...valid, capped)
        .map(rowToJob);
    }
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(capped).map(rowToJob);
  }

  queuedJobs() {
    return this.db.prepare("SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at ASC").all().map(rowToJob);
  }

  countOutstanding() {
    const terminals = Array.from(TERMINAL_JOB_STATES);
    const placeholders = terminals.map(() => "?").join(",");
    return Number(this.db.prepare(`SELECT COUNT(*) count FROM jobs WHERE state NOT IN (${placeholders})`).get(...terminals).count);
  }

  transition(id, nextState, patch = {}, details = null) {
    if (!STATE_INDEX.has(nextState)) throw new Error(`Unknown job state: ${nextState}`);
    return this.transaction(() => {
      const current = this.requireJob(id);
      if (TERMINAL_JOB_STATES.has(current.state) && current.state !== nextState) {
        throw codedError("JOB_TERMINAL", `Job ${id} is already terminal in state ${current.state}.`);
      }
      const currentIndex = STATE_INDEX.get(current.state);
      const nextIndex = STATE_INDEX.get(nextState);
      if (!TERMINAL_JOB_STATES.has(nextState) && nextIndex < currentIndex) {
        throw codedError("INVALID_JOB_TRANSITION", `Cannot move job ${id} backward from ${current.state} to ${nextState}.`);
      }
      const now = new Date().toISOString();
      const definitelyPostSubmit = new Set([
        "submit_intent",
        "user_turn_confirmed",
        "awaiting_response",
        "response_confirmed",
        "completed",
        "submission_uncertain",
        "response_uncertain",
        "quarantined",
      ]).has(nextState);
      const submitted = definitelyPostSubmit || current.submissionMayHaveOccurred;
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
        localDataRequest: "local_data_request_json",
        result: "result_json",
        error: "error_json",
        recoveryAction: "recovery_action",
      };
      for (const [key, column] of Object.entries(columns)) {
        if (!(key in patch)) continue;
        assignments.push(`${column} = ?`);
        values.push(["attachmentManifest", "modelEvidence", "localDataRequest", "result", "error"].includes(key) ? json(patch[key]) : patch[key]);
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
      this.db.prepare("INSERT INTO job_events(job_id, state, details_json, created_at) VALUES (?, ?, ?, ?)")
        .run(id, nextState, json(details ?? patch), now);
      return this.getJob(id);
    });
  }

  markFailure(id, error) {
    const job = this.requireJob(id);
    const structured = structuredError(error, { jobState: job.state });
    if (STATE_INDEX.get(job.state) < SUBMIT_INDEX) {
      return this.transition(id, "failed_pre_submit", {
        error: structured,
        recoveryAction: structured.safeToRetry ? "start a new authorized job" : structured.recoveryAction,
      });
    }
    const state = job.userTurnId || job.userTurnHash ? "response_uncertain" : "submission_uncertain";
    const recoveryAction = state === "submission_uncertain" ? `reconcile_job ${id}` : `job_status ${id}`;
    const result = this.transition(id, state, {
      error: { ...structured, submissionMayHaveOccurred: true },
      recoveryAction,
    });
    if (state === "submission_uncertain") this.quarantine(job.conversationKey, id, structured.message);
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

  acknowledge(jobId) {
    const job = this.requireJob(jobId);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE quarantines SET active = 0, acknowledged_at = ? WHERE job_id = ?").run(now, jobId);
    return { jobId, acknowledged: true, conversationKey: job.conversationKey };
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
    const job = this.requireJob(jobId);
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        UPDATE jobs
        SET state='queued', user_turn_id=?, user_turn_hash=?, error_json=NULL,
            recovery_action='reattach submitted turn without resending', completed_at=NULL,
            updated_at=?, version=version+1
        WHERE id=?
      `).run(userTurnId ?? null, userTurnHash, now, jobId);
      this.db.prepare("INSERT INTO job_events(job_id, state, details_json, created_at) VALUES (?, 'queued', ?, ?)")
        .run(jobId, json({ reconciledFrom: job.state, monitorOnly: true }), now);
    });
    return this.requireJob(jobId);
  }

  eventsAfter(jobId, sequence = 0) {
    return this.db
      .prepare("SELECT sequence, state, details_json, created_at FROM job_events WHERE job_id = ? AND sequence > ? ORDER BY sequence")
      .all(jobId, sequence)
      .map((row) => ({ sequence: row.sequence, state: row.state, details: parse(row.details_json), createdAt: row.created_at }));
  }

  recoverInterruptedJobs() {
    const jobs = this.db
      .prepare(`SELECT * FROM jobs WHERE state NOT IN (${Array.from(TERMINAL_JOB_STATES).map(() => "?").join(",")}) ORDER BY created_at`)
      .all(...TERMINAL_JOB_STATES)
      .map(rowToJob);
    const recovered = [];
    for (const job of jobs) {
      const index = STATE_INDEX.get(job.state);
      if (index < SUBMIT_INDEX) {
        const now = new Date().toISOString();
        this.transaction(() => {
          this.db.prepare("UPDATE jobs SET state='queued', updated_at=?, recovery_action=?, version=version+1 WHERE id=?")
            .run(now, "resumed safely before submission", job.id);
          this.db.prepare("INSERT INTO job_events(job_id, state, details_json, created_at) VALUES (?, 'queued', ?, ?)")
            .run(job.id, json({ recoveredFrom: job.state }), now);
        });
        recovered.push({ id: job.id, action: "requeued" });
      } else if (job.userTurnId || job.userTurnHash) {
        this.db.prepare("UPDATE jobs SET state='queued', updated_at=?, recovery_action=? WHERE id=?")
          .run(new Date().toISOString(), "reattach submitted turn without resending", job.id);
        recovered.push({ id: job.id, action: "monitor-only" });
      } else {
        this.transition(job.id, "submission_uncertain", {
          error: { code: "SUBMISSION_UNCERTAIN", message: "Broker restarted after submit_intent without a proven user turn.", submissionMayHaveOccurred: true },
          recoveryAction: `reconcile_job ${job.id}`,
        });
        this.quarantine(job.conversationKey, job.id, "Restart after submit_intent without a proven user turn");
        recovered.push({ id: job.id, action: "quarantined" });
      }
    }
    return recovered;
  }
}
