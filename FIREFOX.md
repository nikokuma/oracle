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

Download and open [`oracle-firefox-1.0.0.mcpb`](plugins/oracle-firefox/releases/oracle-firefox-1.0.0.mcpb). During installation, set the Node executable to a Node.js 24+ command or path if `node` on your PATH is older.

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

## Long jobs

The durable flow returns a job id immediately:

```bash
node plugins/oracle-firefox/dist/cli.mjs consult-start \
  --authorization-id "$(uuidgen | tr '[:upper:]' '[:lower:]')" \
  -p "Review this design" \
  -f FIREFOX.md

node plugins/oracle-firefox/dist/cli.mjs watch <job-id> --jsonl --notify
node plugins/oracle-firefox/dist/cli.mjs result <job-id>
```

MCP clients use `consult_start`, `continue_chat_start`, `job_status`, `job_wait`, and `job_result`. The compatibility `consult` and `continue_chat` tools wait at most 240 seconds, then return a pending receipt while the broker continues working.

## Safety guarantees

- Pro is selected and visibly verified before each message unless the caller explicitly requests `current`.
- Each authorization allows at most one automatic Send-button click.
- The broker writes `submit_intent` to SQLite before clicking Send and never retries past that boundary.
- Existing drafts and foreign attachments are never cleared or overwritten.
- The whole composer message must match after Unicode and line-ending normalization.
- Attachments must exactly match, finish processing, and leave the composer send-ready.
- Assistant completion is bound to the exact submitted user turn, not the latest visible response or turn count.
- Oracle never clicks Answer now, regenerate, continue generation, Stop, or Enter as a send fallback.
- Same-chat writes are FIFO across all harnesses. Different chats are serial by default; live-qualified two-chat overlap can be enabled with `ORACLE_FIREFOX_WRITE_CONCURRENCY=2`.
- Firefox trusted keyboard input is foregrounded through a short broker-wide mutex; response generation on other leased pages continues concurrently.
- A visible ChatGPT request throttle is reported as `ACCOUNT_COOLDOWN`; Oracle never retries it automatically.
- Uncertain submissions quarantine their exact conversation or creation scope until read-only reconciliation or user acknowledgement.

Private state lives in:

- Firefox profile and session artifacts: `~/.oracle-firefox/`
- macOS coordinator database, token, and protected log: `~/Library/Application Support/oracle-firefox/coordinator/`
- broker socket: `$TMPDIR/oracle-firefox-$UID/broker.sock`

## Local evidence

If Pro needs local facts, it returns a structured `ORACLE_LOCAL_DATA_REQUEST_V1` block instead of guessing. The local agent may perform up to three secret-scanned, read-only evidence rounds inside the original task scope. A fourth round, sensitive request, write, or scope expansion requires fresh user approval.

## Recovery

Use `broker_status` or `job_status` after a client restart. Safe pre-send work resumes automatically. Proven submitted turns reattach in monitor-only mode. A verified ownership record lets a replacement broker close only its own orphaned dedicated Firefox after a crash. Unproven post-send states return `SUBMISSION_UNCERTAIN`; `reconcile_job` searches the exact conversation read-only and never sends another message.

The canonical Codex source is [`plugins/oracle-firefox`](plugins/oracle-firefox). The generated Claude package is [`plugins/oracle-firefox-claude`](plugins/oracle-firefox-claude). Both are MIT licensed.
