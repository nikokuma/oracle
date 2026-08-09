#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pluginMeta from "../plugin.meta.json" with { type: "json" };
import { callBroker } from "./broker-client.mjs";
import { ORACLE_FIREFOX_VERSION } from "./build-info.mjs";
import { structuredError } from "./errors.mjs";

const harnessName = process.env.ORACLE_FIREFOX_HARNESS || "codex-mcp";
const defaultCompletionMode = harnessName === "claude-desktop-mcp" ? "notify" : "manual";
const canonicalTools = new Map(pluginMeta.tools.map((tool) => [tool.name, tool]));

function prepareExecutionParams(params) {
  return {
    ...params,
    completionMode: harnessName === "claude-desktop-mcp" && params.completionMode === "harness"
      ? "notify"
      : params.completionMode,
  };
}

const server = new McpServer(
  { name: "oracle-firefox", version: ORACLE_FIREFOX_VERSION },
  {
    capabilities: { logging: {} },
    instructions: "Oracle uses one durable, identity-locked broker and one selected browser backend shared by all local harnesses. Never launch, kill, or replace its browser or broker directly. Start one authorized job, retain its private handles, and use status, wait, and result; a timeout or pending result never authorizes another send. Same-chat work is FIFO and stale broker generations fail closed. Firefox is the compatibility default; switch browsers only while no jobs are outstanding.",
  },
);

const projectFields = {
  projectTitle: z.string().optional().describe("Exact project title; do not combine with projectUrl."),
  projectUrl: z.string().url().optional().describe("Exact https://chatgpt.com/g/g-p-.../project URL."),
};
const executionFields = {
  modelRequirement: z.enum(["pro", "current"]).default("pro").describe("Require and verify Pro by default; current explicitly preserves the visible model."),
  responseTimeoutSeconds: z.number().int().min(30).max(86400).default(10800),
  attachmentTimeoutSeconds: z.number().int().min(30).max(1800).default(600),
  maxAutomaticEvidenceReplies: z.number().int().min(0).max(3).default(3),
  responseFailurePolicy: z.enum(["report", "retry-once"]).default("report").describe("Report terminal response failures, or authorize one durable recovery continuation for narrowly classified retryable failures."),
  completionMode: z.enum(["manual", "notify", "harness"]).default(defaultCompletionMode).describe("Choose manual retrieval, a local OS notification, or a harness-owned completion watcher. Claude Desktop defaults to notify because a notification cannot wake its model."),
  headless: z.boolean().default(false),
};
const zipFields = {
  zipFiles: z.array(z.string()).max(5).default([]).describe("Explicit .zip paths to snapshot, validate, and upload unchanged; paths are resolved from cwd."),
  cwd: z.string().optional().describe("Absolute working directory used to resolve files and zipFiles."),
};
const consultFields = {
  prompt: z.string().min(1),
  files: z.array(z.string()).default([]),
  ...zipFields,
  delivery: z.enum(["auto", "inline", "attachment"]).default("auto"),
  ...projectFields,
  ...executionFields,
};
const continueFields = {
  chatTitle: z.string().optional(),
  conversationUrl: z.string().url().optional(),
  ...projectFields,
  prompt: z.string().min(1),
  ...zipFields,
  ...executionFields,
};
const artifactTargetFields = {
  chatTitle: z.string().optional().describe("Exact chat title; omit when conversationUrl is provided."),
  conversationUrl: z.string().url().optional().describe("Exact standalone or project ChatGPT conversation URL; sufficient by itself."),
  ...projectFields,
  scope: z.enum(["last-assistant", "all-assistant"]).default("last-assistant"),
  timeoutSeconds: z.number().int().min(5).max(60).default(30),
  headless: z.boolean().default(false),
};

function contentFor(result) {
  const text = result?.answer || JSON.stringify(result, null, 2);
  return [{ type: "text", text }];
}

const jobReferenceFields = {
  jobId: z.string().uuid().optional().describe("Opaque job UUID; accessible only to its owner session or for legacy read-only jobs."),
  jobHandle: z.string().optional().describe("Broker-minted control/read handle used to resume a job from another process."),
};
const inputRequestReason = z.enum(["false-positive", "not-needed", "user-declined"])
  .default("user-declined")
  .describe("Auditable reason for discarding the pending evidence request; never authorizes a replacement send.");

function register(name, config, method, timeoutMs = 65_000, prepareParams = null) {
  const canonical = canonicalTools.get(name);
  if (!canonical) throw new Error(`Tool ${name} is missing from plugin.meta.json.`);
  server.registerTool(name, { ...config, description: canonical.description }, async (params, extra) => {
    try {
      const requestParams = prepareParams ? prepareParams(params) : params;
      const result = await callBroker(method, requestParams, {
        timeoutMs,
        harness: harnessName,
        hostSessionHint: extra?.sessionId || extra?._meta?.sessionId || null,
      });
      return { content: contentFor(result), structuredContent: result };
    } catch (error) {
      const value = structuredError(error);
      return { isError: true, content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: { error: value } };
    }
  });
}

register("broker_status", {
  title: "Check the Oracle Firefox broker",
  description: "Show the user-wide broker, persistent Firefox, queue, recovery, and emergency-lock state.",
  inputSchema: {},
}, "broker.status");

register("doctor", {
  title: "Check Oracle browser readiness",
  description: "Check native Firefox, Chrome, Safari, the selected backend, and the durable broker without sending a ChatGPT message.",
  inputSchema: {},
}, "workflow.doctor");

register("select_browser", {
  title: "Select the Oracle browser",
  description: "Persistently select Firefox, native macOS Chrome, or Safari. Refuses to switch while any job is outstanding and never launches a browser by itself.",
  inputSchema: { browser: z.enum(["firefox", "chrome", "safari"]) },
}, "workflow.selectBrowser");

register("setup", {
  title: "Sign into ChatGPT in the selected browser",
  description: "Open the selected browser's dedicated login page under an exclusive maintenance barrier. Safari login lasts only for its automation session.",
  inputSchema: { timeoutSeconds: z.number().int().min(30).max(900).default(300) },
}, "workflow.setup", 910_000);

register("profiles", {
  title: "Find Firefox source profiles with ChatGPT cookies",
  description: "Report only ChatGPT/OpenAI cookie counts for possible session import; never cookie names or values.",
  inputSchema: {},
}, "workflow.profiles");

register("import_session", {
  title: "Import ChatGPT login from Firefox",
  description: "After explicit approval, copy only ChatGPT/OpenAI cookies from a closed Firefox profile into the selected Oracle browser. Safari keeps them only for its current automation session.",
  inputSchema: {
    sourceProfile: z.string().optional(),
    confirmImport: z.boolean().describe("Must be true only after explicit user approval."),
  },
}, "workflow.importSession", 120_000);

register("list_projects", {
  title: "List ChatGPT projects",
  description: "Read-only project discovery with optional case-insensitive substring filtering.",
  inputSchema: { query: z.string().default(""), headless: z.boolean().default(false) },
}, "workflow.listProjects");

register("find_chats", {
  title: "Find existing ChatGPT conversations",
  description: "Read-only chat-title discovery, optionally scoped to one exact project.",
  inputSchema: {
    query: z.string().min(1),
    ...projectFields,
    timeoutSeconds: z.number().int().min(5).max(60).default(15),
    headless: z.boolean().default(false),
  },
}, "workflow.findChats", 90_000);

register("list_chat_artifacts", {
  title: "List downloadable files in a ChatGPT conversation",
  description: "Read one exact conversation and list safe ChatGPT-generated file links without exposing signed URLs or sending a message.",
  inputSchema: artifactTargetFields,
}, "workflow.listChatArtifacts", 120_000);

register("download_chat_artifact", {
  title: "Download one exact ChatGPT-generated file",
  description: "Download one exact assistant link into a private Oracle directory. Rejects ambiguous labels, external URLs, path traversal, oversize files, and overwrites; never sends a message.",
  inputSchema: {
    ...artifactTargetFields,
    linkText: z.string().min(1).describe("Exact visible link text, matched case-insensitively after whitespace normalization."),
    maxBytes: z.number().int().min(1).max(250_000_000).default(100_000_000),
  },
}, "workflow.downloadChatArtifact", 300_000);

register("consult_start", {
  title: "Start a durable ChatGPT consultation",
  description: "Authorize one asynchronous new-chat submission, plus at most one derived recovery continuation only when responseFailurePolicy=retry-once. Returns a durable job receipt immediately.",
  inputSchema: { authorizationId: z.string().uuid(), ...consultFields },
}, "jobs.startConsult", 65_000, prepareExecutionParams);

register("continue_chat_start", {
  title: "Start a durable existing-chat continuation",
  description: "Authorize one asynchronous message to one exact conversation, plus at most one derived recovery continuation only when responseFailurePolicy=retry-once. Returns immediately.",
  inputSchema: { authorizationId: z.string().uuid(), ...continueFields },
}, "jobs.startContinue", 65_000, prepareExecutionParams);

register("recover_start_receipt", {
  title: "Recover an Oracle Firefox start receipt",
  description: "Recover the exact committed start and rotate its private job/completion handles without submitting, retrying, or creating another ChatGPT turn.",
  inputSchema: {
    authorizationId: z.string().uuid(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    receiptRecoveryHandle: z.string().min(1).describe("Private receiptRecoveryHandle returned by the original start receipt."),
  },
}, "jobs.recoverStartReceipt", 65_000, (params) => ({
  authorizationId: params.authorizationId,
  requestDigest: params.requestDigest,
  recoveryHandle: params.receiptRecoveryHandle,
}));

register("consult", {
  title: "Consult ChatGPT through Firefox",
  description: "Compatibility tool: starts one durable consultation, waits up to 240 seconds, then returns either the result or a non-error pending receipt.",
  inputSchema: { authorizationId: z.string().uuid().optional(), ...consultFields },
}, "jobs.compatConsult", 245_000, (params) => ({
  ...prepareExecutionParams(params),
  authorizationId: params.authorizationId ?? randomUUID(),
}));

register("continue_chat", {
  title: "Continue an existing ChatGPT conversation",
  description: "Compatibility tool: starts one durable continuation, waits up to 240 seconds, then returns the result or a non-error pending receipt. A derived recovery send occurs only when explicitly requested.",
  inputSchema: { authorizationId: z.string().uuid().optional(), ...continueFields },
}, "jobs.compatContinue", 245_000, (params) => ({
  ...prepareExecutionParams(params),
  authorizationId: params.authorizationId ?? randomUUID(),
}));

register("job_status", {
  title: "Read Oracle Firefox job status",
  description: "Read durable state and recovery guidance without touching Firefox.",
  inputSchema: { ...jobReferenceFields, followRetries: z.boolean().default(true) },
}, "jobs.status");

register("job_wait", {
  title: "Wait briefly for an Oracle Firefox job",
  description: "Wait event-first on one logical job for up to 55 seconds, following its explicitly authorized recovery child by default. The waiter never initiates a retry.",
  inputSchema: { ...jobReferenceFields, timeoutSeconds: z.number().int().min(0).max(55).default(55), followRetries: z.boolean().default(true) },
}, "jobs.wait", 60_000);

register("job_result", {
  title: "Read an Oracle Firefox job result",
  description: "Return the completed answer, terminal failure, or a pending receipt.",
  inputSchema: { ...jobReferenceFields, followRetries: z.boolean().default(true) },
}, "jobs.result");

register("list_jobs", {
  title: "List Oracle Firefox jobs",
  description: "List only this client session's recent durable jobs without exposing prompt contents.",
  inputSchema: { limit: z.number().int().min(1).max(200).default(50), states: z.array(z.string()).default([]) },
}, "jobs.list");

register("list_attention", {
  title: "List Oracle Firefox attention",
  description: "List only this client session's sanitized input and uncertainty blockers without prompts, answers, job ids, paths, URLs, or capabilities.",
  inputSchema: {},
}, "jobs.listAttention");

register("inspect_quarantine", {
  title: "Inspect one exact Oracle Firefox quarantine",
  description: "Read sanitized recovery metadata for one exact conversation URL when the original job capability is unavailable. Never lists other chats, opens a browser, or sends a message.",
  inputSchema: {
    conversationUrl: z.string().url().describe("Exact standalone or project ChatGPT conversation URL reported by the blocked submission."),
  },
}, "jobs.inspectQuarantine");

register("inspect_input_request", {
  title: "Inspect one exact Oracle Firefox input request",
  description: "Read sanitized recovery metadata for the input request blocking one exact conversation URL. Never exposes the prompt or answer and never sends.",
  inputSchema: {
    conversationUrl: z.string().url().describe("Exact standalone or project ChatGPT conversation URL reported by the blocked submission."),
  },
}, "jobs.inspectInputRequest");

register("abandon_input_request", {
  title: "Abandon an Oracle Firefox input request",
  description: "Discard one capability-owned local-evidence request and release its same-chat FIFO lane. Never sends and never authorizes a replacement.",
  inputSchema: {
    ...jobReferenceFields,
    confirmAbandon: z.boolean().describe("Must be true after the user explicitly chooses not to answer this local-data request."),
    reason: inputRequestReason,
  },
}, "jobs.abandonInputRequest");

register("recover_orphaned_input_request", {
  title: "Abandon one orphaned Oracle Firefox input request",
  description: "Use an exact-URL inspection fingerprint to discard a blocking input request whose original capability is unavailable. Never sends or authorizes a replacement.",
  inputSchema: {
    conversationUrl: z.string().url().describe("The same exact conversation URL used with inspect_input_request."),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).describe("Current fingerprint returned by inspect_input_request."),
    confirmCapabilityUnavailable: z.boolean().describe("Must be true only after confirming the original control capability is unavailable."),
    confirmAbandon: z.boolean().describe("Must be true after the user explicitly chooses to discard the request and release the lane."),
    reason: inputRequestReason,
  },
}, "jobs.abandonOrphanedInputRequest");

register("recover_orphaned_quarantine", {
  title: "Recover one orphaned Oracle Firefox quarantine",
  description: "Use an inspected exact-URL fingerprint to reconcile read-only or acknowledge after explicit manual inspection. Never sends a message or authorizes a replacement.",
  inputSchema: {
    conversationUrl: z.string().url().describe("The same exact conversation URL used with inspect_quarantine."),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).describe("Current fingerprint returned by inspect_quarantine."),
    action: z.enum(["reconcile", "acknowledge"]).default("reconcile"),
    confirmCapabilityUnavailable: z.boolean().describe("Must be true only after the user confirms the original control capability is unavailable."),
    confirmManualInspection: z.boolean().default(false).describe("For acknowledge only: true after the user manually inspected this exact chat and accepts the uncertainty."),
    completionMode: z.enum(["manual", "notify", "harness"]).default(defaultCompletionMode),
  },
}, "jobs.recoverOrphanedQuarantine", 120_000);

register("reconcile_job", {
  title: "Reconcile an uncertain Oracle Firefox submission",
  description: "Read the exact target conversation and look for the authorized user-turn hash. Never sends or retries a message.",
  inputSchema: {
    ...jobReferenceFields,
    conversationUrl: z.string().url().optional().describe("Canonical ChatGPT URL discovered manually when an uncertain new chat failed before persisting its URL."),
  },
}, "jobs.reconcile", 120_000);

register("acknowledge_uncertain", {
  title: "Acknowledge an uncertain Oracle Firefox job",
  description: "Remove its quarantine after manual inspection. This never sends a message.",
  inputSchema: jobReferenceFields,
}, "jobs.acknowledge");

register("cancel_job", {
  title: "Cancel or detach from an Oracle Firefox job",
  description: "Cancel only before submit_intent. After that boundary it detaches the caller while monitoring continues and never retries.",
  inputSchema: jobReferenceFields,
}, "jobs.cancel");

register("reply_with_local_data", {
  title: "Reply to a safe Pro local-data request",
  description: "Send structured, secret-scanned facts to the same conversation under the original authorization, up to three rounds.",
  inputSchema: {
    ...jobReferenceFields,
    facts: z.array(z.object({ id: z.string().min(1), value: z.unknown(), source: z.string().min(1) })).default([]),
    unavailable: z.array(z.object({ id: z.string().min(1), reason: z.string().min(1) })).default([]),
    responseTimeoutSeconds: z.number().int().min(30).max(86400).optional(),
  },
}, "jobs.replyWithLocalData");

register("completion_claim", {
  title: "Claim one durable Oracle completion",
  description: "Claim the next event from one exact capability-bound completion subscription. Event payloads never contain prompts or answers.",
  inputSchema: {
    completionHandle: z.string().min(1),
    claimSeconds: z.number().int().min(10).max(300).default(90),
  },
}, "completion.claim");

register("completion_wait", {
  title: "Wait for one durable Oracle completion",
  description: "Wait event-first for up to 55 seconds on one exact capability-bound completion subscription.",
  inputSchema: {
    completionHandle: z.string().min(1),
    timeoutSeconds: z.number().int().min(0).max(55).default(55),
    claimSeconds: z.number().int().min(10).max(300).default(90),
  },
}, "completion.wait", 60_000);

register("completion_mark_delivered", {
  title: "Mark an Oracle completion delivered",
  description: "Record that a claimed completion notification reached its destination; this does not acknowledge the answer.",
  inputSchema: {
    completionHandle: z.string().min(1),
    deliveryId: z.number().int().positive(),
    claimId: z.string().uuid(),
  },
}, "completion.delivered");

register("completion_acknowledge", {
  title: "Acknowledge an Oracle completion",
  description: "Acknowledge one delivered completion event for one exact subscription.",
  inputSchema: {
    completionHandle: z.string().min(1),
    deliveryId: z.number().int().positive(),
  },
}, "completion.acknowledge");

const transport = new StdioServerTransport();
transport.onerror = (error) => console.error("Oracle Firefox MCP transport error:", error);
await server.connect(transport);
