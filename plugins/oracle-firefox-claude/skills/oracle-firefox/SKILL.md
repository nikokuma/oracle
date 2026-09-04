---
name: oracle-firefox
description: Consult ChatGPT Pro through a local browser, continue exact chats, attach files, and retrieve answers or generated downloads with durable recovery.
---

# Oracle Firefox

## Start and finish

1. Call `doctor`. Keep the selected browser. For login, read [setup](references/setup.md). Change browsers only at the user's request, with zero outstanding jobs, through `select_browser` followed by `doctor`.
2. Resolve the destination. Default to a new standalone chat; a project target means a new chat in that exact project. Continuation requires an exact existing chat title or URL. Read [targeting](references/targeting.md) for projects or existing chats; never guess ambiguous matches.
3. Choose one completion handoff below. Start with `consult_start` or `continue_chat_start` and a fresh authorization UUID. Default to `modelRequirement: "pro"`, `responseFailurePolicy: "retry-once"`, and the three-hour response deadline (omit `responseTimeoutSeconds`). “Current model” selects `current`; “do not retry” selects `report`.
4. Retain the root job ID, `jobHandle`, `completionHandle`, `receiptRecoveryHandle`, and `requestDigest` privately in this task. Use `followRetries: true` for status, wait, and result. One event-first wait is optional; pending means the existing job is still running.
5. Consume terminal `job_result` and verify the normal answer locally. A claimed completion event is marked delivered after handoff and acknowledged after consuming the result. A local-data request is routed through [local evidence](references/local-evidence.md), including any approved abandonment.

For generated-file discovery or download, use [downloads](references/downloads.md) instead of starting a chat message.

## Completion handoff

Choose one mode before starting; never select `harness` without its watcher or repeatedly wake the model to poll.

- **Codex:** `harness` with one heartbeat for the exact root job. Notify only on completion, failure, or required action. Report once, acknowledge delivery, and delete the heartbeat after terminal consumption. Without a heartbeat, use `notify` and tell the user to resume this task.
- **Claude Code/Claudex:** `harness` with one job-specific Monitor or `oracle-firefox watch <job-id> --handle <job-handle> --completion-handle <completion-handle> --jsonl`; otherwise `notify`.
- **Claude Desktop/no wake API:** `notify` posts a generic macOS notification; the user resumes the task to retrieve the result. It cannot wake the model.
- **User requests manual or notify-only:** honor `manual` or `notify`, without automatic resumption or another watcher.

## Recovery

For blocked jobs, lost receipts, draft errors, restarts, cooldowns, uncertainty, quarantine, or upgrades, read [recovery](references/recovery.md) and follow the structured recovery action.

A timeout or disconnect never authorizes another Send. After `submit_intent` or `submissionMayHaveOccurred: true`, recovery is read-only reconciliation or monitor-only reattachment. Use the saved job handle after restart; use `recover_start_receipt` for a lost receipt from the same committed start. Never replay the original request or create a duplicate recovery continuation. Only the broker creates the single eligible retry-once child.

## Boundaries

- Each authorization permits at most one Send click. Never use Answer now, Regenerate/Try again, Continue generation, Stop, or Enter-as-send.
- Existing drafts require explicit authorization for this exact start with `discardExistingDraft: true`; that option never covers attachments. The broker may roll back its own unchanged text-only edit before Send when that execution fails. Do not clear drafts through another browser tool.
- Use absolute `cwd` and narrow file selections. `files` bundles UTF-8 text; archives require explicit `zipFiles`. Inspect inputs for secrets and unrelated material. Wait for attachment processing without resubmitting.
- Keep handles, cookies, signed download URLs, profile data, and private request/response artifacts private. Cookie import requires explicit consent. A UUID alone grants no job access; only use jobs owned by this task or explicitly resumed with their capability.
- Manage the broker and its browser through Oracle tools. Never kill/restart them to clear an error or switch browsers with outstanding jobs. Do not mutate ChatGPT projects or expose the broker to the network.

Firefox and native Chrome use dedicated persistent profiles. Safari is visible and serialized, is isolated from normal Safari data, and loses authentication when its automation session ends. Tool schemas and returned fields are authoritative.
