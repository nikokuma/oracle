# Exact generated-file downloads

Read this file only when the user asks to discover or download a file generated in an existing ChatGPT conversation. This workflow is read-only with respect to chat content and must not send a message.

1. Resolve exactly one existing conversation:
   - Prefer an exact `conversationUrl`; it is sufficient by itself, so do not add a project selector.
   - Otherwise, if a project is named, use `list_projects` and proceed only on one case-insensitive exact title after whitespace normalization.
   - Use `find_chats` with the requested `chatTitle`, optionally scoped to that exact project. Proceed only on one normalized exact match.
   - If a project/chat title has zero or multiple exact matches, show the safe candidates and ask for a URL or explicit selection; never guess.
2. Call `list_chat_artifacts` first with the default `scope: "last-assistant"`.
3. Match only the user-requested visible link/button label, case-insensitively after whitespace normalization.
4. If that exact label is absent because a trailing ChatGPT status node hides an older assistant response, repeat discovery with `scope: "all-assistant"` only to locate that same exact label. Do not select a similar or alternate file.
5. If zero or multiple exact label matches remain, show only the safe candidates and ask the user to choose.
6. Call `download_chat_artifact` once with the exact label. Do not select a model, edit/clear the composer, attach content, or send a message. A behavior-only Download button may receive one serialized click.
7. Report the returned local path, filename, byte size, and SHA-256.
8. Never expose, log, or persist the underlying signed URL or Firefox cookies.

Accept the tool's source validation, overwrite refusal, private destination, and size limits as authoritative. Do not bypass an external/unsafe-source rejection, path check, ambiguity error, overwrite refusal, or hard size limit.
