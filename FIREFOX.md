# Oracle Firefox

Oracle Firefox keeps its original install name while letting Codex, Claude Code, Claudex, and Claude Desktop consult ChatGPT Pro through Firefox, native macOS Google Chrome, or Safari. It needs no OpenAI API key.

One background broker owns the selected browser backend per OS user. Firefox remains the default; Firefox and Chrome use separate dedicated profiles, while Safari uses one isolated automation session. Calls from every agent enter the same durable queue, so a client timeout, plugin reload, or agent disconnect does not restart the message.

macOS with Firefox 153 and Node.js 24+ remains the fully live-qualified path. Native macOS Chrome 151 is bundle/signature checked and headless-fixture qualified. Safari 26.5 has protocol-fixture coverage but still needs an explicitly approved live ChatGPT qualification. Linux and Windows share portable broker tests but are not advertised as live-supported.

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

Download and open [`oracle-firefox-1.6.2.mcpb`](plugins/oracle-firefox/releases/oracle-firefox-1.6.2.mcpb). During installation, set the Node executable to a Node.js 24+ command or path if `node` on your PATH is older.

## Choose a browser

Firefox is the compatibility default. Ask the agent to use `select_browser`, or use the CLI while no Oracle jobs are outstanding:

```bash
node plugins/oracle-firefox/dist/cli.mjs browser-select firefox
node plugins/oracle-firefox/dist/cli.mjs browser-select chrome
node plugins/oracle-firefox/dist/cli.mjs browser-select safari
node plugins/oracle-firefox/dist/cli.mjs doctor
```

The broker refuses to switch during queued, running, or otherwise nonterminal work. On macOS, Chrome is accepted only when its real path is a native app under `/Applications` or `~/Applications`, its bundle id is `com.google.Chrome`, and its code signature belongs to Google. Parallels, VM, Windows-app, mounted-volume, unsigned, and ambiguous copies are rejected before launch.

Safari uses Apple's `safaridriver`. Its visible automation windows are isolated from normal Safari data, support only one driver session, block manual interaction, and cannot reuse normal Safari login. After explicit approval, `import_session` can inject only ChatGPT/OpenAI cookies from a closed Firefox profile; they last only while Oracle's Safari automation session remains alive. Enable Safari **Develop → Developer Settings → Allow remote automation** yourself when requested; Oracle never changes that setting automatically. Browser-managed Download buttons require Firefox or Chrome, though direct signed file links remain supported.

## First login with Firefox

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

Send a ZIP to a new or existing chat:

> Ask ChatGPT Pro to inspect `/absolute/path/review.zip` through Oracle Firefox.

Agents pass raw archives with `zipFiles`; ordinary `files` remain UTF-8 text inputs. Oracle accepts up to five explicit `.zip` paths per message, snapshots them into the private durable session, validates their structure and hashes, rejects traversal, symlinks, encryption, common credential filenames, dangerous expansion, ambiguous names, and changed snapshots, then verifies the exact attachment set before Send. It never extracts the archive locally.

Oracle resolves one exact conversation, lists safe ChatGPT-generated links or Download buttons, and downloads one exact label without sending a message. Behavior-only buttons receive one click, serialized across agents. Files land in a new private directory under `~/.oracle-firefox/downloads/`; the result includes the path, byte count, and SHA-256. Signed download URLs and Firefox cookies are never returned.

The equivalent CLI flow is:

```bash
node plugins/oracle-firefox/dist/cli.mjs artifacts --url "https://chatgpt.com/c/..."
node plugins/oracle-firefox/dist/cli.mjs download-artifact \
  --url "https://chatgpt.com/c/..." \
  --link-text "Exact visible download label"

node plugins/oracle-firefox/dist/cli.mjs consult-start \
  --authorization-id "$(uuidgen | tr '[:upper:]' '[:lower:]')" \
  --zip-file /absolute/path/review.zip \
  -p "Inspect the attached archive and summarize its contents."
```

Discovery defaults to the last assistant response. Add `--scope all-assistant` only when targeting an older response or when an exact requested label is hidden behind a trailing ChatGPT status node. Downloads default to 100 MB and have a 250 MB hard maximum.

## Long jobs

The durable flow returns a job id plus private job and completion handles immediately. Keep the handles with the originating task; another process must present the job handle to resume that exact chain.

Up to five different conversations may remain active while their Pro responses are monitored. Same-chat work stays FIFO, and the account gate admits only one pre-submit action at a time with a conservative ten-second minimum between sends. A stalled browser probe or response deadline becomes `response_uncertain`, quarantines only that conversation, and never triggers another send.

Claude Desktop uses a broker-owned macOS notification by default. The notification tells you that durable state is ready; macOS cannot wake Claude's model, so reopen the chat and ask it to fetch `job_result`. Codex, Claude Code, and Claudex may instead keep a harness watcher when their host supports one.

```bash
node plugins/oracle-firefox/dist/cli.mjs consult-start \
  --authorization-id "$(uuidgen | tr '[:upper:]' '[:lower:]')" \
  --response-failure-policy retry-once \
  --completion-mode notify \
  -p "Review this design" \
  -f FIREFOX.md

node plugins/oracle-firefox/dist/cli.mjs watch <job-id> \
  --handle '<job-handle>' \
  --completion-handle '<completion-handle>' \
  --jsonl --notify
node plugins/oracle-firefox/dist/cli.mjs result <job-id> --handle '<job-handle>'
```

MCP clients use `consult_start`, `continue_chat_start`, `job_status`, `job_wait`, and `job_result`. The compatibility `consult` and `continue_chat` tools wait at most 240 seconds, then return a pending receipt while the broker continues working.

When an agent uses the bundled Oracle skill, the default is `responseFailurePolicy=retry-once`, recovery-chain following, and one harness-appropriate completion handoff. You do not need to repeat those instructions. Explicit requests such as “do not retry,” “notify me only,” or “no automation” override the skill default. Direct CLI/MCP callers that bypass the skill retain the conservative raw default `responseFailurePolicy=report`.

`job_wait` and `completion_wait` are event-driven inside the broker; they sleep until durable state changes rather than repeatedly checking SQLite. The CLI watcher follows an authorized recovery/evidence chain and can display one macOS notification. A local watcher uses no model tokens while idle, but it cannot resume a stopped model turn unless its host provides a wake API. Codex can attach one task heartbeat to the exact chain; without a host wake API, use the notification and resume manually.

New logical jobs receive a capability-bound durable completion subscription with claim, delivered, and acknowledgement states. Completion events contain only safe routing state, never the prompt, answer, cookies, capability secrets, paths, or browser-profile contents. Legacy completion files are disabled unless `ORACLE_FIREFOX_LEGACY_COMPLETION_FILES=1` is explicitly set while operating serially.

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
- Every new logical chain is owned by a broker-minted capability. A bare UUID never grants access to another agent's new job; `list_jobs` is scoped to the current client session.
- Same-chat writes are durable FIFO across all harnesses, including response recovery and local-evidence children. Version 1.5 starts with one active conversation as a conservative rollout. After live qualification, set both `ORACLE_FIREFOX_MAX_ACTIVE_CONVERSATIONS=1..5` and `ORACLE_FIREFOX_QUALIFIED_CONCURRENCY=1..5`; that qualified cap persists across clean broker restarts.
- Normal broker runs are headless by default. Visible setup/login is exclusive and cannot overlap a job page. Set `ORACLE_FIREFOX_BROWSER_MODE=visible` only for broker-wide debugging.
- Firefox launch, page slots, maintenance, trusted input, model selection, final verification, and Send are fenced by broker-owned locks, a profile-wide lifetime lease, broker generations, and page/execution epochs. Response generation on qualified isolated pages can continue concurrently.
- A visible ChatGPT request throttle opens a durable broker-wide `ACCOUNT_COOLDOWN`, invalidates unused submit permits, pauses queued writes, and reopens through one paced probe. Oracle never replays a submitted message.
- Positively classified response failures expose `responseDisposition`, `responseFailure`, `recoveryJobId`, `activeJobId`, and the durable `recoveryChain`.
- Uncertain submissions quarantine their exact conversation or creation scope until read-only reconciliation or user acknowledgement.

Private state lives in:

- Firefox profile and session artifacts: `~/.oracle-firefox/`
- Chrome's dedicated profile: `~/.oracle-firefox/browser-profiles/chrome/`
- Persisted browser selection: `~/Library/Application Support/oracle-firefox/coordinator/browser-selection.json`
- macOS coordinator database, token, and protected log: `~/Library/Application Support/oracle-firefox/coordinator/`
- Capability hashes, completion subscriptions, delivery acknowledgements, lanes, and cooldown state: the coordinator SQLite database
- stable broker socket: `/tmp/oracle-firefox-<uid>-<coordinator-id>/broker.sock` (independent of each host's `TMPDIR`)

The coordinator UUID, signed broker locator, coordinator lifetime lease, and profile lifetime lease make differently installed Codex, Claude, Claudex, and Desktop packages converge on one owner. A newer client may request a directional idle handoff from a known older broker. It never kills active work, unlinks an unverified socket, or lets an older client downgrade a newer broker. Schema 6 also fences pre-1.5 SQLite writers and writes a `coordinator.sqlite.pre-v6.bak` backup before migrating an existing production database.

If startup reports a database or identity failure, stop before editing SQLite. `node plugins/oracle-firefox/dist/cli.mjs coordinator-inspect` performs an offline/read-only integrity, schema, backup, and broker-generation inspection without launching Firefox or a broker. Preserve both the database and its migration backup before any separately approved repair.

## Local evidence

If Pro needs local facts, it returns a structured `ORACLE_LOCAL_DATA_REQUEST_V1` block instead of guessing. The local agent may perform up to three secret-scanned, read-only evidence rounds inside the original task scope. A fourth round, sensitive request, write, or scope expansion requires fresh user approval.

## Recovery

Use `broker_status` or `job_status` after a client restart. Safe pre-send work resumes automatically. Proven submitted turns reattach in monitor-only mode. A verified ownership record lets a replacement broker close only its own orphaned dedicated Firefox after a crash. Unproven post-send states return `SUBMISSION_UNCERTAIN`; `reconcile_job` searches the exact conversation read-only and never sends another message.

If a migrated quarantine outlives its private control capability, `inspect_quarantine` accepts only the exact conversation URL and returns a state fingerprint without exposing the old job. `recover_orphaned_quarantine` can then adopt a uniquely proven submitted turn for monitoring, or remove only the lane barrier after explicit manual inspection. Neither path sends or authorizes a replacement message.

The canonical Codex source is [`plugins/oracle-firefox`](plugins/oracle-firefox). The generated Claude package is [`plugins/oracle-firefox-claude`](plugins/oracle-firefox-claude). Both are MIT licensed.
