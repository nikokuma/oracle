# Oracle Firefox 1.7.0 migration

Oracle Firefox 1.7.0 publishes SQLite schema 8 and broker wire protocol 9. Existing state is migrated in place only after integrity and foreign-key checks; production migration first creates `coordinator.sqlite.pre-v8.bak` if that backup does not already exist.

## Submission classification

Migration never treats `response.md` as proof. A historical job is considered submitted only from durable SQLite evidence:

- `submit_intent_at` exists;
- the stored URL is one canonical `https://chatgpt.com/.../c/...` conversation URL; and
- an exact user-turn id or hash exists.

A job with all three becomes `monitor_only` and can reattach to that turn without sending. A post-intent job without exact turn proof remains uncertain and its lane stays quarantined. Pre-intent work remains eligible for safe pre-submit recovery. No migration path authorizes or creates a second ChatGPT user turn.

## Preserved state

The migration preserves owner sessions, session grants, capability hashes, completion subscriptions and deliveries, accepted FIFO sequence, account cooldown/pacing state, authenticated Firefox and Chrome profiles, persisted browser selection, and Firefox as the default when no selection was stored. Safari remains session-authenticated only.

## Client compatibility

Protocol 8 remains read-compatible for an existing authenticated owner session. Protocol-8 calls cannot create/repair a session, rotate capabilities, claim delivery, acknowledge, reconcile, cancel, change browsers, or start/send work. Every mutation requires protocol 9; an older writer receives stable `CLIENT_UPGRADE_REQUIRED`, and the broker remains running and unchanged.

Reload the current package instead of killing the broker or deleting sockets, leases, locators, profiles, sessions, or SQLite files. Preserve job, completion, and receipt handles. The public recovery codes are `MONITOR_REATTACHING`, `INPUT_REQUIRED_BLOCKING`, `INPUT_INVALID`, `RECEIPT_MAY_EXIST`, and `CLIENT_UPGRADE_REQUIRED`.
