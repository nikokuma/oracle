# Oracle Firefox

Oracle Firefox is a Codex plugin that talks to ChatGPT through your installed Firefox using WebDriver BiDi. It does not require Chrome, Chromium, or an OpenAI API key.

Tested on macOS with Firefox 153 and Node.js 24+.

## Install

```bash
codex plugin marketplace add nikokuma/oracle
codex plugin add oracle-firefox@nikokuma-oracle
```

Start a new Codex task after installation so the tools load.

## First-time login

Google blocks login inside automated browsers. Sign into ChatGPT normally in Firefox first, then ask Codex:

> Import my existing ChatGPT session into Oracle Firefox. I approve copying only ChatGPT/OpenAI cookies.

Close normal Firefox and the Oracle Firefox window briefly when Codex asks. The importer copies only `chatgpt.com` and `openai.com` cookies—not passwords, history, Google cookies, or unrelated site cookies.

## Use it

Start a new consultation:

> Use Oracle Firefox to review these files and identify correctness risks.

Start a new chat in a project:

> Use Oracle Firefox to review these files in my “Firefox Development” ChatGPT project.

Continue an existing chat:

> Continue the existing ChatGPT chat titled “Firefox compatibility plan” with this message: …

If you give an approximate project or chat name, Oracle can list matching candidates and ask you to choose. A final write requires one exact, unique name; duplicate names fail safely, so use the project or conversation URL to disambiguate.

When you do not mention a chat or project, Oracle starts a new standalone chat. Saying “continue” or “follow up” requires an existing chat name or URL.

## What works

- Persistent ChatGPT login imported from normal Firefox
- New ChatGPT consultations
- New chats inside an exact ChatGPT project
- Read-only project and chat discovery
- Text-file context bundling and uploads
- Existing standalone or project-chat continuation by exact title or URL
- Confirmed complete-response capture
- Firefox 153 WebDriver BiDi smoke tests

## Current limits

- Uses the model currently selected in ChatGPT; automatic model selection is not finished
- Long Pro responses can exceed the default wait and need reattachment support
- Deep Research, images, and Gemini browser mode are not yet supported
- Native Firefox support in the full Oracle CLI remains in progress on `feat/firefox-webdriver-bidi`

The plugin source is under [`plugins/oracle-firefox`](plugins/oracle-firefox). It is MIT licensed.
