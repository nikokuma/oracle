---
name: oracle-firefox
description: Get a durable second opinion from ChatGPT Pro through the user's authenticated Firefox, including standalone chats, project chats, exact existing-chat continuation, generated-file downloads, long background jobs, and safe local-evidence follow-ups. Use when the user asks to consult Oracle or ChatGPT Pro, review work with another model, continue a ChatGPT conversation, target a ChatGPT project, download a file generated in a ChatGPT conversation, or automate subscription-backed ChatGPT without Chrome or an API key.
---

# Oracle Firefox

Use the Oracle Firefox MCP tools to coordinate one authenticated Firefox and one durable per-user broker across Codex, Claude Code, Claudex, and Claude Desktop.

## Default operating mode

Unless the user explicitly says otherwise, treat a request to use Oracle or ChatGPT Pro as authorization for this complete workflow:

- Start a durable asynchronous job with `modelRequirement: "pro"`.
- Set `responseFailurePolicy: "retry-once"`, permitting exactly one separately authorized recovery continuation after a positively classified retryable assistant failure.
- Follow recovery children with `followRetries: true`.
- Arrange one job-scoped completion handoff appropriate to the current harness instead of repeatedly waking the agent to poll.
- Retrieve the final result and independently verify it locally.

Honor explicit overrides. “Do not retry,” “report failures,” or equivalent means `responseFailurePolicy: "report"`. “Notify me only” means a local notification without claiming automatic model resumption. “Wait manually” or “no automation” means do not create a heartbeat or background monitor.

## Start safely

1. Call `doctor` once per task. Stop if Firefox or the broker is not ready.
2. If ChatGPT is signed out, call `profiles`. It returns cookie counts only, never values.
3. Call `import_session` only after the user explicitly approves copying ChatGPT/OpenAI cookies and closes normal and Oracle Firefox. It never copies passwords, history, Google cookies, or unrelated cookies.
4. Otherwise use `setup` when the user is ready for interactive login. Google OAuth may reject WebDriver; direct login or approved cookie import is more reliable.

## Resolve one destination

- No continuation language or chat target means a new chat.
- No project means a new standalone chat.
- A named project with no chat means a new chat in that project.
- Continue/follow-up wording requires an existing chat name or URL.
- Use `list_projects` and `find_chats` for partial names. Proceed only on one case-insensitive exact match after whitespace normalization.
- Never choose a fuzzy or duplicate match. Show candidates and ask; prefer a URL when titles are duplicated.
- A project-chat URL identifies both the project and chat. Do not add another project selector.

## Prefer durable jobs

For work that may take longer than a normal tool call:

1. Generate a fresh UUID authorization, then call `consult_start` or `continue_chat_start`.
2. Leave `modelRequirement` as `pro` unless the user explicitly asks to keep the currently selected model.
3. Keep the returned root `jobId`. One authorization permits at most one Send-button click. Use the skill default `responseFailurePolicy: "retry-once"` unless the user opts out; the recovery receives a separate deterministic child authorization. The raw API default remains `report` for callers that bypass this skill.
4. Prefer one completion handoff over repeated agent polling. `job_wait` sleeps on broker state-change events for at most 55 seconds and follows an authorized recovery child by default. For longer work:
   - Codex: by default set `completionMode: "harness"` and create one heartbeat automation attached to the current task when available. It must monitor only the root job id, make no user-facing report while pending, call `job_result` once terminal, then delete itself. Codex heartbeats are scheduled rather than file-triggered, so do not claim zero-token automatic wake-up.
   - Claude Code or Claudex: run one job-specific native Monitor/background task or `oracle-firefox watch <job-id> --jsonl`. The local watcher blocks event-first without model tokens and follows the recovery child.
   - Desktop or a harness without an automatic wake API: use `oracle-firefox watch <job-id> --notify`, then call `job_result` after the notification. A local process can notify the user but cannot independently resume a stopped model turn.
5. A client timeout or pending receipt is not permission to start again. The broker keeps working.

Use compatibility `consult` or `continue_chat` only when a result is likely within 240 seconds. They still create a durable job and return a non-error pending receipt when the wait expires.

## Handle completion and uncertainty

- Read the final answer with `job_result` and independently verify it against local source and tests.
- `responseDisposition: "reasoning_stopped"` or `"transient_failure"` means ChatGPT produced a positively classified terminal failure instead of an answer. If `retry-once` was authorized, status/result calls follow the durable recovery child automatically; otherwise report the failure and ask before sending anything else.
- Never treat ordinary answer prose containing words such as “stopped reasoning” or “something went wrong” as a failure. Oracle requires an exact short terminal message or visible error controls tied to the exact assistant turn.
- Never replay the original submission after `submit_intent` or when `submissionMayHaveOccurred` is true. The only automatic response recovery is a new, explicitly authorized, one-shot continuation after a positively identified terminal assistant failure.
- For `SUBMISSION_UNCERTAIN`, call `reconcile_job`. It performs read-only exact-turn matching and never sends.
- For `ACCOUNT_COOLDOWN`, report that ChatGPT rejected the request, do not retry, and wait for the user to authorize a fresh job after the cooldown. If it happened after `submit_intent`, preserve the conservative uncertain state and reconcile read-only before acknowledging it.
- If reconciliation cannot prove the turn, ask the user to inspect the reported conversation and session. Use `acknowledge_uncertain` only after that decision.
- Respect `CONVERSATION_QUARANTINED`; it prevents another write into an unresolved scope.
- Never click or ask Oracle to click Answer now, regenerate, continue generation, Stop, or clear a user draft.
- Never manually duplicate a recovery message. `recoveryJobId`, `activeJobId`, and `recoveryChain` identify the one broker-created continuation.

## Local-evidence rounds

Pro may finish with `assistantDisposition: "local_data_request"` and a parsed `ORACLE_LOCAL_DATA_REQUEST_V1` request.

1. Confirm `safeReadOnly` is true.
2. Perform only the requested read-only checks inside the original task, workspace, and tooling scope.
3. Do not retrieve credentials, cookies, tokens, private keys, browser-profile contents, unrelated chats, or unrelated private files.
4. Call `reply_with_local_data` with structured facts, sources, and unavailable-item reasons. It re-verifies Pro and sends to the same conversation.
5. Up to three safe rounds are covered by the original authorization. Ask the user before a fourth round, any write, sensitive request, or scope expansion.
6. When Pro returns a final answer, verify it locally before acting.

## Download generated files

1. Resolve one exact existing conversation by URL, or by an exact title plus optional exact project. Prefer the URL when the title is duplicated.
2. Call `list_chat_artifacts` first. Keep the default `last-assistant` scope. If an exact user-supplied label is absent because ChatGPT exposes a trailing status node, use `all-assistant` only to find that exact label; never select a different file.
3. Select only one exact visible link label after case and whitespace normalization. If none or more than one match, show the safe candidates and ask; never guess.
4. Call `download_chat_artifact` once with that exact label. It opens the chat read-only and never selects a model, edits the composer, or sends a message. A behavior-only Download button receives one click; download clicks are serialized across agents.
5. Report the returned local path, filename, size, and SHA-256. Never expose or persist the underlying signed URL or Firefox cookies.

Downloads use a new private directory under `~/.oracle-firefox/downloads/`, refuse overwrites and unsafe/external sources, and default to a 100 MB limit with a 250 MB hard maximum.

## Context and guardrails

- Send the smallest relevant UTF-8 file set. Use an absolute `cwd`, narrow globs, and exclusions.
- Never attach secrets. The bundler refuses common env, key, and credential files, but inspect selections too.
- Attachment processing may legitimately take ten minutes. Do not resubmit while it is loading.
- The database is authoritative; private request and response artifacts remain under `~/.oracle-firefox/sessions/<uuid>`.
- Terminal logical jobs also receive an atomic private completion record under the coordinator `completions/` directory. It contains only safe job/result metadata, never prompts, cookies, or answer text.
- Creating, renaming, or deleting ChatGPT projects is out of scope.
- Deep Research, image generation, remote Claude.ai control, and network-exposed broker access are out of scope.
