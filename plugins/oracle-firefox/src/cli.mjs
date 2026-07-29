#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { callBroker } from "./broker-client.mjs";

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
try {
  let result;
  if (command === "doctor") result = await callBroker("workflow.doctor", {}, { harness: "cli" });
  else if (command === "broker-status") result = await callBroker("broker.status", {}, { harness: "cli" });
  else if (command === "profiles") result = await callBroker("workflow.profiles", {}, { harness: "cli" });
  else if (command === "setup") result = await callBroker("workflow.setup", { timeoutSeconds: number(args, ["--timeout-seconds"], 300) }, { timeoutMs: 910000, harness: "cli" });
  else if (command === "import-session") result = await callBroker("workflow.importSession", { sourceProfile: option(args, ["--source-profile"]), confirmImport: bool(args, "--confirm") }, { harness: "cli" });
  else if (command === "projects") result = await callBroker("workflow.listProjects", { query: option(args, ["-q", "--query"], ""), headless: bool(args, "--headless") }, { harness: "cli" });
  else if (command === "find-chats") result = await callBroker("workflow.findChats", { query: option(args, ["-q", "--query"]), ...target(args), timeoutSeconds: number(args, ["--timeout-seconds"], 15), headless: bool(args, "--headless") }, { harness: "cli" });
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
      { timeoutMs: command === "artifacts" ? 120000 : 300000, harness: "cli" },
    );
  }
  else if (command === "consult" || command === "consult-start") {
    const params = { authorizationId: option(args, ["--authorization-id"], command === "consult-start" ? undefined : randomUUID()), prompt: option(args, ["-p", "--prompt"]), files: repeated(args, ["-f", "--file"]), cwd: option(args, ["--cwd"]), delivery: option(args, ["--delivery"], "auto"), ...target(args), ...common(args) };
    result = await callBroker(command === "consult" ? "jobs.compatConsult" : "jobs.startConsult", params, { timeoutMs: command === "consult" ? 245000 : 65000, harness: "cli" });
  } else if (command === "continue-chat" || command === "continue-chat-start") {
    const params = { authorizationId: option(args, ["--authorization-id"], command === "continue-chat-start" ? undefined : randomUUID()), chatTitle: option(args, ["--title"]), conversationUrl: option(args, ["--url"]), prompt: option(args, ["-p", "--prompt"]), ...target(args), ...common(args) };
    result = await callBroker(command === "continue-chat" ? "jobs.compatContinue" : "jobs.startContinue", params, { timeoutMs: command === "continue-chat" ? 245000 : 65000, harness: "cli" });
  } else if (command === "status") result = await callBroker("jobs.status", { jobId: args[0], followRetries: !bool(args, "--no-follow-retries") }, { harness: "cli" });
  else if (command === "result") result = await callBroker("jobs.result", { jobId: args[0], followRetries: !bool(args, "--no-follow-retries") }, { harness: "cli" });
  else if (command === "jobs") result = await callBroker("jobs.list", { limit: number(args, ["--limit"], 50) }, { harness: "cli" });
  else if (command === "reconcile") result = await callBroker("jobs.reconcile", { jobId: args[0], conversationUrl: option(args, ["--url"]) }, { timeoutMs: 120000, harness: "cli" });
  else if (command === "acknowledge") result = await callBroker("jobs.acknowledge", { jobId: args[0] }, { harness: "cli" });
  else if (command === "cancel") result = await callBroker("jobs.cancel", { jobId: args[0] }, { harness: "cli" });
  else if (command === "reply-local-data") result = await callBroker("jobs.replyWithLocalData", {
    jobId: args[0],
    facts: jsonOption(args, ["--facts-json"], []),
    unavailable: jsonOption(args, ["--unavailable-json"], []),
    responseTimeoutSeconds: number(args, ["--response-timeout-seconds"], 10800),
  }, { harness: "cli" });
  else if (command === "emergency-lock") result = await callBroker("broker.setEmergencyLock", { enabled: true }, { harness: "cli" });
  else if (command === "emergency-unlock") result = await callBroker("broker.setEmergencyLock", { enabled: false }, { harness: "cli" });
  else if (command === "watch") {
    const jobId = args.find((arg) => !arg.startsWith("-"));
    const jsonl = bool(args, "--jsonl");
    let lastVersion = "";
    for (;;) {
      result = await callBroker("jobs.wait", { jobId, timeoutSeconds: 55, followRetries: !bool(args, "--no-follow-retries") }, { timeoutMs: 60000, harness: "cli-watch" });
      const key = `${result.state}:${result.updatedAt}`;
      if (jsonl && key !== lastVersion) process.stdout.write(`${JSON.stringify(result)}\n`);
      lastVersion = key;
      if (result.terminal) break;
    }
    if (bool(args, "--notify")) await notify("Oracle Firefox", `Job ${jobId} ${result.state}`);
  } else {
    throw new Error("Usage: oracle-firefox doctor|broker-status|profiles|setup|import-session|projects|find-chats|artifacts --url URL|download-artifact --url URL --link-text TEXT|consult|consult-start|continue-chat|continue-chat-start [--response-failure-policy report|retry-once] [--completion-mode manual|notify|harness]|status <job-id>|result <job-id>|jobs|watch <job-id> [--jsonl|--notify|--no-follow-retries]|reconcile <job-id> [--url URL]|acknowledge <job-id>|cancel <job-id>|reply-local-data <job-id> --facts-json JSON [--unavailable-json JSON]|emergency-lock|emergency-unlock");
  }
  if (command !== "watch" || !bool(args, "--jsonl")) print(result);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: error.code || "ORACLE_FIREFOX_ERROR", message: error.message, recoveryAction: error.recoveryAction || null }, null, 2)}\n`);
  process.exitCode = 1;
}
