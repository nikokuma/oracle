# Exact project and chat targeting

Read this file only when a consultation names a ChatGPT project or continues/follows up in an existing conversation.

Normalize candidate titles only by case-insensitive comparison and whitespace normalization. Discovery may use partial queries; selection may not.

## New project chat

- A named project without a chat means a new chat in that project.
- Resolve it with `list_projects`.
- Proceed only when exactly one normalized exact project title matches.
- Never combine `projectTitle` with `projectUrl`.

## Existing chat

- Continue/follow-up wording requires an exact `conversationUrl` or `chatTitle`.
- A conversation URL is sufficient by itself. A project-chat URL identifies both project and conversation; do not add a project selector.
- For title discovery, call `find_chats`, optionally scoped to one already resolved exact project.
- Proceed only when exactly one normalized exact chat title matches.
- If no exact match or multiple exact matches remain, show the safe candidates and ask the user to choose. Prefer a conversation URL when titles duplicate.
- Never choose the closest, newest, first, or most plausible project/chat.

Pass only the resolved exact destination to the relevant start tool. Do not create, rename, or delete ChatGPT projects.
