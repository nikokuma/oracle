---
name: oracle-firefox
description: Get a durable second opinion from ChatGPT Pro through the user's authenticated Firefox, including standalone chats, project chats, exact existing-chat continuation, long background jobs, and safe local-evidence follow-ups. Use when the user asks to consult Oracle or ChatGPT Pro, review work with another model, continue a ChatGPT conversation, target a ChatGPT project, or automate subscription-backed ChatGPT without Chrome or an API key.
---

# Oracle Firefox

Use the Oracle Firefox MCP tools to coordinate one authenticated Firefox and one durable per-user broker across Codex, Claude Code, Claudex, and Claude Desktop.

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
3. Keep the returned `jobId`. One authorization permits at most one automatic submission attempt.
4. Use `job_wait` for at most 55 seconds per call, or attach a job-specific watcher:
   - Codex: when task automations or heartbeats are available, monitor only that job id and call only `job_status` or `job_result`.
   - Claude Code or Claudex: use a job-specific Monitor/background process, or `oracle-firefox watch <job-id> --jsonl`.
   - Desktop: rely on `--notify` plus `job_status` or `job_result`; do not claim Desktop can wake its model automatically.
5. A client timeout or pending receipt is not permission to start again. The broker keeps working.

Use compatibility `consult` or `continue_chat` only when a result is likely within 240 seconds. They still create a durable job and return a non-error pending receipt when the wait expires.

## Handle completion and uncertainty

- Read the final answer with `job_result` and independently verify it against local source and tests.
- Never retry automatically after `submit_intent` or when `submissionMayHaveOccurred` is true.
- For `SUBMISSION_UNCERTAIN`, call `reconcile_job`. It performs read-only exact-turn matching and never sends.
- For `ACCOUNT_COOLDOWN`, report that ChatGPT rejected the request, do not retry, and wait for the user to authorize a fresh job after the cooldown. If it happened after `submit_intent`, preserve the conservative uncertain state and reconcile read-only before acknowledging it.
- If reconciliation cannot prove the turn, ask the user to inspect the reported conversation and session. Use `acknowledge_uncertain` only after that decision.
- Respect `CONVERSATION_QUARANTINED`; it prevents another write into an unresolved scope.
- Never click or ask Oracle to click Answer now, regenerate, continue generation, Stop, or clear a user draft.

## Local-evidence rounds

Pro may finish with `assistantDisposition: "local_data_request"` and a parsed `ORACLE_LOCAL_DATA_REQUEST_V1` request.

1. Confirm `safeReadOnly` is true.
2. Perform only the requested read-only checks inside the original task, workspace, and tooling scope.
3. Do not retrieve credentials, cookies, tokens, private keys, browser-profile contents, unrelated chats, or unrelated private files.
4. Call `reply_with_local_data` with structured facts, sources, and unavailable-item reasons. It re-verifies Pro and sends to the same conversation.
5. Up to three safe rounds are covered by the original authorization. Ask the user before a fourth round, any write, sensitive request, or scope expansion.
6. When Pro returns a final answer, verify it locally before acting.

## Context and guardrails

- Send the smallest relevant UTF-8 file set. Use an absolute `cwd`, narrow globs, and exclusions.
- Never attach secrets. The bundler refuses common env, key, and credential files, but inspect selections too.
- Attachment processing may legitimately take ten minutes. Do not resubmit while it is loading.
- The database is authoritative; private request and response artifacts remain under `~/.oracle-firefox/sessions/<uuid>`.
- Creating, renaming, or deleting ChatGPT projects is out of scope.
- Deep Research, image generation, remote Claude.ai control, and network-exposed broker access are out of scope.
