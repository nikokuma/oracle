#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { callBroker } from "./broker-client.mjs";
import { ORACLE_FIREFOX_VERSION } from "./build-info.mjs";
import { inspectCoordinatorDatabase } from "./coordinator-diagnostics.mjs";
import { structuredError } from "./errors.mjs";

function option(args, names, fallback) {
  const index = args.findIndex((value) => names.includes(value));
  return index >= 0 ? args[index + 1] : fallback;
}
function repeated(args, names) {
  return args.flatMap((value, index) => (names.includes(value) && args[index + 1] ? [args[index + 1]] : []));
}
function bool(args, name) { return args.includes(name); }
function number(args, names, fallback) { return Number(option(args, names, String(fallback))); }
function jsonOption(args, names, fallback) {
  const value = option(args, names);
  return value === undefined ? fallback : JSON.parse(value);
}
function common(args) {
  return {
    modelRequirement: option(args, ["--model"], "pro"),
    responseTimeoutSeconds: number(args, ["--response-timeout-seconds", "--timeout-seconds"], 10800),
    attachmentTimeoutSeconds: number(args, ["--attachment-timeout-seconds"], 600),
    maxAutomaticEvidenceReplies: number(args, ["--max-evidence-replies"], 3),
    responseFailurePolicy: option(args, ["--response-failure-policy"], "report"),
    completionMode: option(args, ["--completion-mode"], "manual"),
    headless: bool(args, "--headless"),
  };
}
function target(args) {
  return {
    projectTitle: option(args, ["--project-title"]),
    projectUrl: option(args, ["--project-url"]),
  };
}
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
async function notify(title, body) {
  if (process.platform !== "darwin") return;
  const child = spawn("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body], { stdio: "ignore" });
  child.unref();
}

const [, , command = "doctor", ...args] = process.argv;
const harness = process.env.ORACLE_FIREFOX_HARNESS || "cli";
const jobReference = () => ({ jobId: args[0], jobHandle: option(args, ["--handle"]) });
try {
  let result;
  if (command === "version" || command === "--version" || command === "-v") result = { version: ORACLE_FIREFOX_VERSION };
  else if (command === "coordinator-inspect") result = await inspectCoordinatorDatabase();
  else if (command === "doctor") result = await callBroker("workflow.doctor", {}, { harness });
  else if (command === "browser-select") result = await callBroker("workflow.selectBrowser", { browser: args[0] }, { harness });
  else if (command === "broker-status") result = await callBroker("broker.status", {}, { harness });
  else if (command === "profiles") result = await callBroker("workflow.profiles", {}, { harness });
  else if (command === "setup") result = await callBroker("workflow.setup", { timeoutSeconds: number(args, ["--timeout-seconds"], 300) }, { timeoutMs: 910000, harness });
  else if (command === "import-session") result = await callBroker("workflow.importSession", { sourceProfile: option(args, ["--source-profile"]), confirmImport: bool(args, "--confirm") }, { harness });
  else if (command === "projects") result = await callBroker("workflow.listProjects", { query: option(args, ["-q", "--query"], ""), headless: bool(args, "--headless") }, { harness });
  else if (command === "find-chats") result = await callBroker("workflow.findChats", { query: option(args, ["-q", "--query"]), ...target(args), timeoutSeconds: number(args, ["--timeout-seconds"], 15), headless: bool(args, "--headless") }, { harness });
  else if (command === "artifacts" || command === "download-artifact") {
    const params = {
      chatTitle: option(args, ["--title"]),
      conversationUrl: option(args, ["--url"]),
      ...target(args),
      scope: option(args, ["--scope"], "last-assistant"),
      timeoutSeconds: number(args, ["--timeout-seconds"], 30),
      headless: bool(args, "--headless"),
    };
    if (command === "download-artifact") {
      params.linkText = option(args, ["--link-text"]);
      params.maxBytes = number(args, ["--max-bytes"], 100000000);
    }
    result = await callBroker(
      command === "artifacts" ? "workflow.listChatArtifacts" : "workflow.downloadChatArtifact",
      params,
      { timeoutMs: command === "artifacts" ? 120000 : 300000, harness },
    );
  }
  else if (command === "consult" || command === "consult-start") {
    const params = { authorizationId: option(args, ["--authorization-id"], command === "consult-start" ? undefined : randomUUID()), prompt: option(args, ["-p", "--prompt"]), files: repeated(args, ["-f", "--file"]), zipFiles: repeated(args, ["--zip-file", "--zip"]), cwd: option(args, ["--cwd"]), delivery: option(args, ["--delivery"], "auto"), ...target(args), ...common(args) };
    result = await callBroker(command === "consult" ? "jobs.compatConsult" : "jobs.startConsult", params, { timeoutMs: command === "consult" ? 245000 : 65000, harness });
  } else if (command === "continue-chat" || command === "continue-chat-start") {
    const params = { authorizationId: option(args, ["--authorization-id"], command === "continue-chat-start" ? undefined : randomUUID()), chatTitle: option(args, ["--title"]), conversationUrl: option(args, ["--url"]), prompt: option(args, ["-p", "--prompt"]), zipFiles: repeated(args, ["--zip-file", "--zip"]), cwd: option(args, ["--cwd"]), ...target(args), ...common(args) };
    result = await callBroker(command === "continue-chat" ? "jobs.compatContinue" : "jobs.startContinue", params, { timeoutMs: command === "continue-chat" ? 245000 : 65000, harness });
  } else if (command === "recover-start-receipt") result = await callBroker("jobs.recoverStartReceipt", {
    authorizationId: option(args, ["--authorization-id"]),
    requestDigest: option(args, ["--request-digest"]),
    recoveryHandle: option(args, ["--receipt-recovery-handle"]),
  }, { harness });
  else if (command === "status") result = await callBroker("jobs.status", { ...jobReference(), followRetries: !bool(args, "--no-follow-retries") }, { harness });
  else if (command === "result") result = await callBroker("jobs.result", { ...jobReference(), followRetries: !bool(args, "--no-follow-retries") }, { harness });
  else if (command === "jobs") result = await callBroker("jobs.list", { limit: number(args, ["--limit"], 50) }, { harness });
  else if (command === "list-attention" || command === "attention") result = await callBroker("jobs.listAttention", {}, { harness });
  else if (command === "quarantine-inspect") result = await callBroker("jobs.inspectQuarantine", {
    conversationUrl: option(args, ["--url"]),
  }, { harness });
  else if (command === "input-request-inspect") result = await callBroker("jobs.inspectInputRequest", {
    conversationUrl: option(args, ["--url"]),
  }, { harness });
  else if (command === "abandon-input") result = await callBroker("jobs.abandonInputRequest", {
    ...jobReference(),
    confirmAbandon: bool(args, "--confirm-abandon"),
    reason: option(args, ["--reason"], "user-declined"),
  }, { harness });
  else if (command === "input-request-recover") result = await callBroker("jobs.abandonOrphanedInputRequest", {
    conversationUrl: option(args, ["--url"]),
    fingerprint: option(args, ["--fingerprint"]),
    confirmCapabilityUnavailable: bool(args, "--confirm-capability-unavailable"),
    confirmAbandon: bool(args, "--confirm-abandon"),
    reason: option(args, ["--reason"], "user-declined"),
  }, { harness });
  else if (command === "quarantine-recover") result = await callBroker("jobs.recoverOrphanedQuarantine", {
    conversationUrl: option(args, ["--url"]),
    fingerprint: option(args, ["--fingerprint"]),
    action: option(args, ["--action"], "reconcile"),
    confirmCapabilityUnavailable: bool(args, "--confirm-capability-unavailable"),
    confirmManualInspection: bool(args, "--confirm-manual-inspection"),
    completionMode: option(args, ["--completion-mode"], "manual"),
  }, { timeoutMs: 120000, harness });
  else if (command === "reconcile") result = await callBroker("jobs.reconcile", { ...jobReference(), conversationUrl: option(args, ["--url"]) }, { timeoutMs: 120000, harness });
  else if (command === "acknowledge") result = await callBroker("jobs.acknowledge", jobReference(), { harness });
  else if (command === "cancel") result = await callBroker("jobs.cancel", jobReference(), { harness });
  else if (command === "reply-local-data") result = await callBroker("jobs.replyWithLocalData", {
    ...jobReference(),
    facts: jsonOption(args, ["--facts-json"], []),
    unavailable: jsonOption(args, ["--unavailable-json"], []),
    responseTimeoutSeconds: number(args, ["--response-timeout-seconds"], 10800),
  }, { harness });
  else if (command === "completion-claim") result = await callBroker("completion.claim", {
    completionHandle: option(args, ["--completion-handle"]),
    claimSeconds: number(args, ["--claim-seconds"], 90),
  }, { harness });
  else if (command === "completion-wait") result = await callBroker("completion.wait", {
    completionHandle: option(args, ["--completion-handle"]),
    timeoutSeconds: number(args, ["--timeout-seconds"], 55),
    claimSeconds: number(args, ["--claim-seconds"], 90),
  }, { timeoutMs: 60_000, harness });
  else if (command === "completion-delivered") result = await callBroker("completion.delivered", {
    completionHandle: option(args, ["--completion-handle"]),
    deliveryId: number(args, ["--delivery-id"], 0),
    claimId: option(args, ["--claim-id"]),
  }, { harness });
  else if (command === "completion-ack") result = await callBroker("completion.acknowledge", {
    completionHandle: option(args, ["--completion-handle"]),
    deliveryId: number(args, ["--delivery-id"], 0),
  }, { harness });
  else if (command === "emergency-lock") result = await callBroker("broker.setEmergencyLock", { enabled: true }, { harness });
  else if (command === "emergency-unlock") result = await callBroker("broker.setEmergencyLock", { enabled: false }, { harness });
  else if (command === "watch") {
    const jobId = args.find((arg) => !arg.startsWith("-"));
    const jsonl = bool(args, "--jsonl");
    const completionHandle = option(args, ["--completion-handle"]);
    let lastVersion = "";
    if (completionHandle) {
      for (;;) {
        const waited = await callBroker("completion.wait", {
          completionHandle,
          timeoutSeconds: 55,
          claimSeconds: 90,
        }, { timeoutMs: 60_000, harness: `${harness}-watch` });
        if (!waited.delivery) continue;
        result = waited;
        if (jsonl) process.stdout.write(`${JSON.stringify(result)}\n`);
        if (bool(args, "--notify")) await notify("Oracle Firefox", `Logical chain ${waited.delivery.state}`);
        await callBroker("completion.delivered", {
          completionHandle,
          deliveryId: waited.delivery.deliveryId,
          claimId: waited.delivery.claimId,
        }, { harness: `${harness}-watch` });
        break;
      }
    } else {
      for (;;) {
        result = await callBroker("jobs.wait", { jobId, jobHandle: option(args, ["--handle"]), timeoutSeconds: 55, followRetries: !bool(args, "--no-follow-retries") }, { timeoutMs: 60000, harness: `${harness}-watch` });
        const key = `${result.state}:${result.updatedAt}`;
        if (jsonl && key !== lastVersion) process.stdout.write(`${JSON.stringify(result)}\n`);
        lastVersion = key;
        if (result.terminal) break;
      }
      if (bool(args, "--notify")) await notify("Oracle Firefox", `Job ${jobId} ${result.state}`);
    }
  } else {
    throw new Error("Usage: oracle-firefox version|coordinator-inspect|doctor|browser-select firefox|chrome|safari|broker-status|profiles|setup|import-session|projects|find-chats|artifacts|download-artifact|consult|consult-start|continue-chat|continue-chat-start|recover-start-receipt --authorization-id UUID --request-digest SHA256 --receipt-recovery-handle HANDLE|status <job-id> [--handle HANDLE]|result <job-id> [--handle HANDLE]|jobs|list-attention|watch <job-id> [--handle HANDLE]|input-request-inspect --url URL|abandon-input <job-id> --handle HANDLE --confirm-abandon|input-request-recover --url URL --fingerprint HASH --confirm-capability-unavailable --confirm-abandon|quarantine-inspect --url URL|quarantine-recover --url URL --fingerprint HASH --confirm-capability-unavailable [--action reconcile|acknowledge]|reconcile|acknowledge|cancel|reply-local-data|completion-claim|completion-delivered|completion-ack|emergency-lock|emergency-unlock");
  }
  if (command !== "watch" || !bool(args, "--jsonl")) print(result);
} catch (error) {
  process.stderr.write(`${JSON.stringify(structuredError(error), null, 2)}\n`);
  process.exitCode = 1;
}
