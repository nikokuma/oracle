---
name: oracle-firefox
description: Get an automated second opinion from ChatGPT through the user's installed Firefox browser using WebDriver BiDi. Use when the user asks to consult Oracle, check work with another model, review selected project files through ChatGPT, or use subscription-backed ChatGPT automation without Chrome or an API key.
---

# Oracle Firefox

Use the `oracle-firefox` MCP tools to bundle selected UTF-8 project files, submit the request through a dedicated persistent Firefox profile, wait for a confirmed terminal ChatGPT answer, and return that answer as advisory input.

## Workflow

1. Call `doctor` before the first consult in a task. If Firefox is missing, report the detected path problem and stop.
2. If `consult` reports that ChatGPT is not signed in, call `profiles` to check whether normal Firefox already has ChatGPT/OpenAI cookies. This read-only check returns counts, never cookie values.
3. If a normal profile has ChatGPT cookies—or its count is unavailable because the profile is active—explain that `import_session` copies only ChatGPT/OpenAI cookies into the dedicated profile. It does not copy passwords, history, Google cookies, or other site cookies. Call it only after the user explicitly approves and briefly quits both normal Firefox and the dedicated Oracle Firefox window.
4. Otherwise, tell the user that `setup` opens Firefox for an interactive login. Google OAuth may reject automated Firefox; direct email/password login or session import is more reliable. Call `setup` only when the user is ready.
5. Select the smallest file set that contains the relevant truth. Pass an absolute `cwd`; use `files` for paths/globs and `!pattern` exclusions.
6. Call `consult` with `delivery: "auto"` and a realistic timeout. Keep the default headful mode unless the user explicitly prefers headless and accepts that Cloudflare may block it.
7. Treat the response as a second opinion. Verify claims against the source and tests before changing code.

For an existing ChatGPT conversation, call `continue_chat` only when the user has identified the target and authorized a new message. Prefer an exact conversation URL. An exact title is acceptable when unique; never guess among duplicate or fuzzy title matches. Send one message per authorization, and do not retry after a timeout because the message may still be processing in ChatGPT.

## Guardrails

- Never attach secrets. The tool refuses common `.env`, private-key, and credential filenames, but inspect the selected files as well.
- Do not start a duplicate consult after a timeout. The tool fails closed rather than returning an answer it cannot prove complete; report the saved session id/path and diagnose first.
- Treat `continue_chat` as an external write. Confirm the exact target and message from the user's request. On timeout, report the saved conversation URL and do not send again.
- Use narrow globs and exclusions. The tool limits file count, individual file size, and total bundle size.
- Expect a visible Firefox window during normal calls. The plugin uses a dedicated profile under `~/.oracle-firefox`, not the user's regular Firefox profile.
- Never call `import_session` without explicit approval. It imports only `chatgpt.com` and `openai.com` cookies through a consistent SQLite snapshot. Both normal Firefox and the dedicated Oracle Firefox window must be closed briefly because some Firefox versions lock their live cookie database.
- Current scope is one-shot text consultation plus one-message continuation of an existing conversation, using the currently selected ChatGPT model. Model picker control, Deep Research, images, and binary attachments are intentionally out of scope.

## Prompt shape

State the exact question, relevant constraints, prior attempts, errors, and desired output. Ask for a decision, patch plan, risk list, or review rather than a vague assessment.
