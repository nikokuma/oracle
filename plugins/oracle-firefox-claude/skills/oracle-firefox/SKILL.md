---
name: oracle-firefox
description: Durable ChatGPT Pro consultation through Firefox, native macOS Chrome, or Safari. Use for Oracle/Pro review, browser selection, ZIP upload, exact standalone/project chats, continuations, generated-file downloads, and local evidence without an API key.
---

# Oracle Firefox

Use the Oracle Firefox MCP tools.

## Defaults

For consultations and continuations, unless the user explicitly overrides them:

- Use `consult_start` or `continue_chat_start` with a fresh UUID.
- Set `modelRequirement: "pro"` and `responseFailurePolicy: "retry-once"`; only the broker may create the one eligible recovery continuation.
- Use `followRetries: true` for status, wait, and result reads.
- Choose exactly one harness-appropriate completion handoff and matching `completionMode`; do not repeatedly wake the model to poll.
- Keep `jobHandle` and `completionHandle` inside the originating task. Use the job handle after process restart; never share or expose handles.
- Retrieve the terminal result and verify it locally.

Honor overrides: “current model” means `modelRequirement: "current"`; “do not retry” means `responseFailurePolicy: "report"`; “notify only” or “manual” disables automatic resumption.

## Safety invariants

- One authorization permits at most one Send-button click. A retry-once recovery uses its own deterministic child authorization; never create or send a duplicate recovery yourself.
- Never replay the original request after `submit_intent` or whenever `submissionMayHaveOccurred` is true. A timeout, disconnect, plugin reload, pending receipt, or unknown result is not permission to submit again.
- Never click or request Answer now, Regenerate/Try again, Continue generation, Stop, or Enter-as-send. Never clear, replace, or overwrite an existing draft or foreign attachment.
- Require one exact destination. Never guess a project or conversation from a fuzzy, partial, or duplicate match.
- Respect cooldown, response-failure, quarantine, and reconciliation states exactly as returned.
- Send the smallest set. `files` bundles UTF-8 text; archives require explicit `zipFiles`. Use an absolute `cwd` and narrow selections. Never attach secrets or unrelated material; inspect inputs even though Oracle validates ZIPs and exact manifests.
- Attachment processing may be slow. Do not resubmit while attachments are loading.
- Never expose cookie values, signed download URLs, browser-profile contents, or private request/response artifacts. Import cookies only after explicit user consent.
- A job UUID is routing metadata, not authority. Use only jobs started by this task or explicitly resumed with their capability; `list_jobs` is session-scoped.
- Never manage a browser or the broker outside Oracle tools. Never switch browsers while a job is outstanding. On broker errors, preserve handles and follow the returned recovery action.

## Route the task

1. Call `doctor`. Keep the selected browser unless the user requests another. To change it, require zero outstanding jobs, call `select_browser` once, then call `doctor` again; never kill or restart the broker. For readiness or login, read [setup and login](references/setup.md).
2. For generated-file discovery or download, do not send a chat message; read [exact generated-file downloads](references/downloads.md) and use that workflow instead.
3. Resolve the destination:
   - No continuation language or chat target means a new chat; without a project target it is standalone.
   - A named project without a chat means a new chat in that exact project.
   - Continue/follow-up wording requires an exact existing chat title or conversation URL.
   For a project or existing chat, read [exact project and chat targeting](references/targeting.md) before resolving or sending.
4. Choose the completion handoff before starting:
   - **Codex:** set `completionMode: "harness"`; when supported, attach one heartbeat to the root job. Stay silent while pending, retrieve/report once terminal, then delete it.
   - **Claude Code/Claudex:** set `completionMode: "harness"`; use one job-specific Monitor or `oracle-firefox watch <job-id> --handle <job-handle> --completion-handle <completion-handle> --jsonl`. Without auto-resume, use notification mode.
   - **Claude Desktop/no wake API:** set `completionMode: "notify"`; the broker posts one generic macOS notification, then the user resumes the chat and the agent calls `job_result`. A notification cannot wake Claude's model.
   - **Explicit manual mode:** set `completionMode: "manual"` and create no watcher.
   Never combine handoffs or poll repeatedly.
5. Call `consult_start` for a new chat or `continue_chat_start` for an existing chat. Keep the root `jobId`, private `jobHandle`, and `completionHandle`; the broker follows the logical chain across recovery/evidence children. Optionally make one event-first `job_wait` or `completion_wait`; a pending result leaves the broker job running.
6. Call `job_result` once terminal, following retries, and verify a normal answer locally.
   If you directly claimed a subscription event, mark it delivered after the handoff and acknowledge it only after consuming the result.
7. Before acting on a pending receipt after restart, response failure, cooldown, uncertainty, quarantine, cancellation, or recovery chain, read [recovery and exceptional states](references/recovery.md).
8. If the result is `assistantDisposition: "local_data_request"`, read [local-evidence replies](references/local-evidence.md) before any check, reply, or explicitly approved abandonment.

## Completion and scope

A normal answer is complete only when `job_result` returns the terminal logical result. If the result is anything else, do not improvise; use the recovery reference. A positively classified response failure is not ordinary prose containing failure-like words, and an uncertain submission requires read-only reconciliation before acknowledgement or a fresh write.

Oracle Firefox keeps its compatibility name while coordinating ChatGPT through one selected local browser. Firefox and native Chrome use dedicated persistent profiles. Safari is visible, serialized, isolated from normal Safari data, and loses authentication when its automation session ends; never imply otherwise. Do not treat Oracle as an API, expose the broker to the network, or mutate ChatGPT projects. Tool schemas and returned fields are authoritative.
