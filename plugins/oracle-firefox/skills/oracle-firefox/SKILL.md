---
name: oracle-firefox
description: Get an automated second opinion from ChatGPT through the user's installed Firefox browser using WebDriver BiDi, including standalone chats, project chats, and existing-chat continuation. Use when the user asks to consult Oracle, check work with another model, review selected files through ChatGPT, continue a ChatGPT conversation, target a ChatGPT project, or use subscription-backed ChatGPT automation without Chrome or an API key.
---

# Oracle Firefox

Use the `oracle-firefox` MCP tools to bundle selected UTF-8 project files, submit the request through a dedicated persistent Firefox profile, wait for a confirmed terminal ChatGPT answer, and return that answer as advisory input.

## Workflow

1. Call `doctor` before the first consult in a task. If Firefox is missing, report the detected path problem and stop.
2. If `consult` reports that ChatGPT is not signed in, call `profiles` to check whether normal Firefox already has ChatGPT/OpenAI cookies. This read-only check returns counts, never cookie values.
3. If a normal profile has ChatGPT cookies—or its count is unavailable because the profile is active—explain that `import_session` copies only ChatGPT/OpenAI cookies into the dedicated profile. It does not copy passwords, history, Google cookies, or other site cookies. Call it only after the user explicitly approves and briefly quits both normal Firefox and the dedicated Oracle Firefox window.
4. Otherwise, tell the user that `setup` opens Firefox for an interactive login. Google OAuth may reject automated Firefox; direct email/password login or session import is more reliable. Call `setup` only when the user is ready.
5. Resolve the destination using the rules below, then select the smallest file set that contains the relevant truth. Pass an absolute `cwd`; use `files` for paths/globs and `!pattern` exclusions.
6. Call `consult` with `delivery: "auto"` and a realistic timeout. Keep the default headful mode unless the user explicitly prefers headless and accepts that Cloudflare may block it.
7. Treat the response as a second opinion. Verify claims against the source and tests before changing code.

## Destination selection

- Infer a new chat unless the user says continue/follow up or identifies an existing chat. Do not ask “new or existing?” when intent is clear.
- When no project is mentioned, create a standalone chat. When one project is identified but no existing chat is identified, create a new chat there with `projectTitle` or `projectUrl`.
- Accept ordinary names from the user. Use `list_projects` for a partial or uncertain project name and `find_chats` for a partial or uncertain chat title. These discovery tools are read-only.
- Resolve one exact, case-insensitive title before writing. If there is no exact unique match, show the candidates and ask the user to choose; never send to a fuzzy or duplicate match. Prefer an exact URL for duplicates.
- When continuation is requested without a chat target, ask for its name or link. A project-chat URL identifies both the project and chat; do not add a separate project selector.
- Call `continue_chat` only after the user has identified the target and authorized one new message. Do not retry after a timeout because the message may still be processing.

## Guardrails

- Never attach secrets. The tool refuses common `.env`, private-key, and credential filenames, but inspect the selected files as well.
- Do not start a duplicate consult after a timeout. The tool fails closed rather than returning an answer it cannot prove complete; report the saved session id/path and diagnose first.
- Treat `continue_chat` as an external write. Confirm the exact target and message from the user's request. On timeout, report the saved conversation URL and do not send again.
- Do not remember or reuse a “last project.” Omitted project fields always mean a new standalone chat.
- Do not create, rename, or delete projects. Project files and instructions remain managed by ChatGPT.
- Use narrow globs and exclusions. The tool limits file count, individual file size, and total bundle size.
- Expect a visible Firefox window during normal calls. The plugin uses a dedicated profile under `~/.oracle-firefox`, not the user's regular Firefox profile.
- Never call `import_session` without explicit approval. It imports only `chatgpt.com` and `openai.com` cookies through a consistent SQLite snapshot. Both normal Firefox and the dedicated Oracle Firefox window must be closed briefly because some Firefox versions lock their live cookie database.
- Current scope is one-shot text consultation plus one-message continuation of an existing conversation, using the currently selected ChatGPT model. Model picker control, Deep Research, images, and binary attachments are intentionally out of scope.

## Prompt shape

State the exact question, relevant constraints, prior attempts, errors, and desired output. Ask for a decision, patch plan, risk list, or review rather than a vague assessment.
