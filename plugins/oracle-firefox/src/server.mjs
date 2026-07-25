#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { callBroker } from "./broker-client.mjs";
import { structuredError } from "./errors.mjs";

const server = new McpServer(
  { name: "oracle-firefox", version: "1.1.0" },
  { capabilities: { logging: {} } },
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
  headless: z.boolean().default(false),
};
const consultFields = {
  prompt: z.string().min(1),
  files: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  delivery: z.enum(["auto", "inline", "attachment"]).default("auto"),
  ...projectFields,
  ...executionFields,
};
const continueFields = {
  chatTitle: z.string().optional(),
  conversationUrl: z.string().url().optional(),
  ...projectFields,
  prompt: z.string().min(1),
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

function register(name, config, method, timeoutMs = 65_000, prepareParams = null) {
  server.registerTool(name, config, async (params) => {
    try {
      const requestParams = prepareParams ? prepareParams(params) : params;
      const result = await callBroker(method, requestParams, { timeoutMs, harness: "codex-mcp" });
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
  title: "Check Oracle Firefox readiness",
  description: "Check Firefox, the dedicated profile, and the durable broker without sending a ChatGPT message.",
  inputSchema: {},
}, "workflow.doctor");

register("setup", {
  title: "Sign into ChatGPT in dedicated Firefox",
  description: "Open the dedicated Firefox login page under an exclusive maintenance barrier.",
  inputSchema: { timeoutSeconds: z.number().int().min(30).max(900).default(300) },
}, "workflow.setup", 910_000);

register("profiles", {
  title: "Find Firefox profiles with ChatGPT cookies",
  description: "Report only ChatGPT/OpenAI cookie counts; never cookie names or values.",
  inputSchema: {},
}, "workflow.profiles");

register("import_session", {
  title: "Import ChatGPT login from Firefox",
  description: "After explicit approval, copy only ChatGPT/OpenAI cookies into the dedicated profile under an exclusive maintenance barrier.",
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
  description: "Authorize exactly one asynchronous new-chat submission. Returns a durable job receipt immediately.",
  inputSchema: { authorizationId: z.string().uuid(), ...consultFields },
}, "jobs.startConsult");

register("continue_chat_start", {
  title: "Start a durable existing-chat continuation",
  description: "Authorize exactly one asynchronous message to one exact existing conversation. Returns immediately.",
  inputSchema: { authorizationId: z.string().uuid(), ...continueFields },
}, "jobs.startContinue");

register("consult", {
  title: "Consult ChatGPT through Firefox",
  description: "Compatibility tool: starts one durable consultation, waits up to 240 seconds, then returns either the result or a non-error pending receipt.",
  inputSchema: { authorizationId: z.string().uuid().optional(), ...consultFields },
}, "jobs.compatConsult", 245_000, (params) => ({
  ...params,
  authorizationId: params.authorizationId ?? randomUUID(),
}));

register("continue_chat", {
  title: "Continue an existing ChatGPT conversation",
  description: "Compatibility tool: sends at most one message, waits up to 240 seconds, then returns the result or a non-error pending receipt.",
  inputSchema: { authorizationId: z.string().uuid().optional(), ...continueFields },
}, "jobs.compatContinue", 245_000, (params) => ({
  ...params,
  authorizationId: params.authorizationId ?? randomUUID(),
}));

register("job_status", {
  title: "Read Oracle Firefox job status",
  description: "Read durable state and recovery guidance without touching Firefox.",
  inputSchema: { jobId: z.string().uuid() },
}, "jobs.status");

register("job_wait", {
  title: "Wait briefly for an Oracle Firefox job",
  description: "Long-poll one exact job for up to 55 seconds. It never restarts or resubmits the job.",
  inputSchema: { jobId: z.string().uuid(), timeoutSeconds: z.number().int().min(0).max(55).default(55) },
}, "jobs.wait", 60_000);

register("job_result", {
  title: "Read an Oracle Firefox job result",
  description: "Return the completed answer, terminal failure, or a pending receipt.",
  inputSchema: { jobId: z.string().uuid() },
}, "jobs.result");

register("list_jobs", {
  title: "List Oracle Firefox jobs",
  description: "List recent durable jobs without exposing prompt contents.",
  inputSchema: { limit: z.number().int().min(1).max(200).default(50), states: z.array(z.string()).default([]) },
}, "jobs.list");

register("reconcile_job", {
  title: "Reconcile an uncertain Oracle Firefox submission",
  description: "Read the exact target conversation and look for the authorized user-turn hash. Never sends or retries a message.",
  inputSchema: {
    jobId: z.string().uuid(),
    conversationUrl: z.string().url().optional().describe("Canonical ChatGPT URL discovered manually when an uncertain new chat failed before persisting its URL."),
  },
}, "jobs.reconcile", 120_000);

register("acknowledge_uncertain", {
  title: "Acknowledge an uncertain Oracle Firefox job",
  description: "Remove its quarantine after manual inspection. This never sends a message.",
  inputSchema: { jobId: z.string().uuid() },
}, "jobs.acknowledge");

register("cancel_job", {
  title: "Cancel or detach from an Oracle Firefox job",
  description: "Cancel only before submit_intent. After that boundary it detaches the caller while monitoring continues and never retries.",
  inputSchema: { jobId: z.string().uuid() },
}, "jobs.cancel");

register("reply_with_local_data", {
  title: "Reply to a safe Pro local-data request",
  description: "Send structured, secret-scanned facts to the same conversation under the original authorization, up to three rounds.",
  inputSchema: {
    jobId: z.string().uuid(),
    facts: z.array(z.object({ id: z.string().min(1), value: z.unknown(), source: z.string().min(1) })).default([]),
    unavailable: z.array(z.object({ id: z.string().min(1), reason: z.string().min(1) })).default([]),
    responseTimeoutSeconds: z.number().int().min(30).max(86400).optional(),
  },
}, "jobs.replyWithLocalData");

const transport = new StdioServerTransport();
transport.onerror = (error) => console.error("Oracle Firefox MCP transport error:", error);
await server.connect(transport);
