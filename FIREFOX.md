# Oracle Firefox

Oracle Firefox lets Codex, Claude Code, Claudex, and Claude Desktop consult ChatGPT Pro through your logged-in Firefox. It needs no Chrome and no OpenAI API key.

One background broker owns one dedicated Firefox profile per OS user. Calls from every agent enter the same durable queue, so a client timeout, plugin reload, or agent disconnect does not restart the message.

macOS with Firefox 153 and Node.js 24+ is the live-qualified platform. Linux and Windows share the portable broker, protocol, SQLite, and packaging tests but are not yet advertised as live-supported.

## Install

### Codex

```bash
codex plugin marketplace add nikokuma/oracle
codex plugin add oracle-firefox@nikokuma-oracle
```

Start a new Codex task after installing or updating the plugin.

### Claude Code

```bash
claude plugin marketplace add nikokuma/oracle
claude plugin install oracle-firefox@nikokuma-oracle
```

Run `/reload-plugins` or start a new Claude session.

### Claudex

From a downloaded repository checkout:

```bash
brew install BeamoINT/tap/claudex
node plugins/oracle-firefox/scripts/install-claudex.mjs
oracle-claudex [your normal Claudex arguments]
```

The wrapper adds only `--plugin-dir <stable-install-path>`. It preserves every other argument, including managed GPT and native Fable routes, and never combines `--plugin-dir` with a duplicate `--mcp-config`.

### Claude Desktop

Download and open [`oracle-firefox-1.2.1.mcpb`](plugins/oracle-firefox/releases/oracle-firefox-1.2.1.mcpb). During installation, set the Node executable to a Node.js 24+ command or path if `node` on your PATH is older.

## First login

Google often rejects login inside a WebDriver browser. The reliable path is:

1. Sign into ChatGPT normally in Firefox.
2. Ask the agent to inspect Firefox profiles.
3. Explicitly approve importing only ChatGPT/OpenAI cookies.
4. Briefly close normal Firefox and Oracle Firefox while the import runs.

The importer never copies passwords, history, Google cookies, cookie values into logs, or unrelated site cookies.

## Use it naturally

New standalone chat:

> Use Oracle Firefox to ask ChatGPT Pro to review these files for correctness bugs.

New project chat:

> Use Oracle Firefox to review this in my “Firefox Development” ChatGPT project.

Continue one chat:

> Continue the ChatGPT chat “Firefox compatibility plan” with this message: …

No chat target means a new chat. No project means standalone. “Continue” requires an exact existing title or URL. Partial and duplicate matches are shown for you to choose; Oracle never guesses.

Download a file from an existing chat:

> From the last reply in “Nono Ecosystem Reorganization,” download the link “Download the Codex-ready Nono Messages inputs.”

Oracle resolves one exact conversation, lists safe ChatGPT-generated links or Download buttons, and downloads one exact label without sending a message. Behavior-only buttons receive one click, serialized across agents. Files land in a new private directory under `~/.oracle-firefox/downloads/`; the result includes the path, byte count, and SHA-256. Signed download URLs and Firefox cookies are never returned.

The equivalent CLI flow is:

```bash
node plugins/oracle-firefox/dist/cli.mjs artifacts --url "https://chatgpt.com/c/..."
node plugins/oracle-firefox/dist/cli.mjs download-artifact \
  --url "https://chatgpt.com/c/..." \
  --link-text "Exact visible download label"
```

Discovery defaults to the last assistant response. Add `--scope all-assistant` only when targeting an older response or when an exact requested label is hidden behind a trailing ChatGPT status node. Downloads default to 100 MB and have a 250 MB hard maximum.

## Long jobs

The durable flow returns a job id immediately:

```bash
node plugins/oracle-firefox/dist/cli.mjs consult-start \
  --authorization-id "$(uuidgen | tr '[:upper:]' '[:lower:]')" \
  --response-failure-policy retry-once \
  --completion-mode notify \
  -p "Review this design" \
  -f FIREFOX.md

node plugins/oracle-firefox/dist/cli.mjs watch <job-id> --jsonl --notify
node plugins/oracle-firefox/dist/cli.mjs result <job-id>
```

MCP clients use `consult_start`, `continue_chat_start`, `job_status`, `job_wait`, and `job_result`. The compatibility `consult` and `continue_chat` tools wait at most 240 seconds, then return a pending receipt while the broker continues working.

When an agent uses the bundled Oracle skill, the default is `responseFailurePolicy=retry-once`, recovery-chain following, and one harness-appropriate completion handoff. You do not need to repeat those instructions. Explicit requests such as “do not retry,” “notify me only,” or “no automation” override the skill default. Direct CLI/MCP callers that bypass the skill retain the conservative raw default `responseFailurePolicy=report`.

`job_wait` is event-driven inside the broker; it sleeps until durable job state changes rather than repeatedly checking SQLite. The CLI watcher follows an authorized recovery child automatically and can display one macOS notification. A local watcher uses no model tokens while idle, but it cannot resume a stopped model turn unless its host provides a wake API. Codex currently handles automatic continuation with a task heartbeat scoped to the exact root job; without a heartbeat, use the notification and resume manually.

Terminal logical jobs receive a private atomic completion record under the coordinator `completions/` directory. It contains job state and safe routing metadata, never the prompt, answer, cookies, or browser-profile contents.

## Failed Pro responses

Oracle distinguishes a real answer from short terminal failures such as **Stopped reasoning**, **Something went wrong**, and generation/network errors. Detection is bound to the exact assistant turn and requires an exact short failure or visible ChatGPT error controls, so normal prose containing those words is not treated as a failure.

The default `responseFailurePolicy=report` sends nothing else. With `retry-once`, the initial authorization also permits one deterministic child authorization that sends a new continuation in the same conversation asking Pro to answer the original request. It never re-clicks the original Send action and never clicks Regenerate, Try again, Answer now, Continue generation, or Stop. Rate limits, authentication failures, unavailable models, ambiguous errors, and a failed recovery are never retried automatically.

`job_status`, `job_wait`, `job_result`, and `watch` follow this recovery chain by default. Use `followRetries=false` or CLI `--no-follow-retries` only when inspecting the original failed job itself.

## Safety guarantees

- Pro is selected and visibly verified before each message unless the caller explicitly requests `current`.
- Each authorization allows at most one Send-button click. An explicitly enabled one-shot recovery receives its own deterministic child authorization.
- The broker writes `submit_intent` to SQLite before clicking Send and never retries past that boundary.
- Existing drafts and foreign attachments are never cleared or overwritten.
- The whole composer message must match after Unicode and line-ending normalization.
- Attachments must exactly match, finish processing, and leave the composer send-ready.
- Assistant completion is bound to the exact submitted user turn, not the latest visible response or turn count.
- Oracle never clicks Answer now, regenerate, continue generation, Stop, or Enter as a send fallback.
- Same-chat writes are FIFO across all harnesses. Different chats are serial by default; live-qualified two-chat overlap can be enabled with `ORACLE_FIREFOX_WRITE_CONCURRENCY=2`.
- Firefox trusted keyboard input is foregrounded through a short broker-wide mutex; response generation on other leased pages continues concurrently.
- A visible ChatGPT request throttle is reported as `ACCOUNT_COOLDOWN`; Oracle never retries it automatically.
- Positively classified response failures expose `responseDisposition`, `responseFailure`, `recoveryJobId`, `activeJobId`, and the durable `recoveryChain`.
- Uncertain submissions quarantine their exact conversation or creation scope until read-only reconciliation or user acknowledgement.

Private state lives in:

- Firefox profile and session artifacts: `~/.oracle-firefox/`
- macOS coordinator database, token, and protected log: `~/Library/Application Support/oracle-firefox/coordinator/`
- Private completion handoffs: `~/Library/Application Support/oracle-firefox/coordinator/completions/`
- broker socket: `$TMPDIR/oracle-firefox-$UID/broker.sock`

## Local evidence

If Pro needs local facts, it returns a structured `ORACLE_LOCAL_DATA_REQUEST_V1` block instead of guessing. The local agent may perform up to three secret-scanned, read-only evidence rounds inside the original task scope. A fourth round, sensitive request, write, or scope expansion requires fresh user approval.

## Recovery

Use `broker_status` or `job_status` after a client restart. Safe pre-send work resumes automatically. Proven submitted turns reattach in monitor-only mode. A verified ownership record lets a replacement broker close only its own orphaned dedicated Firefox after a crash. Unproven post-send states return `SUBMISSION_UNCERTAIN`; `reconcile_job` searches the exact conversation read-only and never sends another message.

The canonical Codex source is [`plugins/oracle-firefox`](plugins/oracle-firefox). The generated Claude package is [`plugins/oracle-firefox-claude`](plugins/oracle-firefox-claude). Both are MIT licensed.
