# Recovery and exceptional states

Read this file before acting on a pending receipt after client restart, positively classified response failure, cooldown, uncertain submission, quarantine, cancellation, or recovery chain.

Keep the root `jobId`, `jobHandle`, `completionHandle`, `receiptRecoveryHandle`, and `requestDigest`. Present only the needed private handle when resuming. Use `followRetries: true` unless the user explicitly asks to inspect the original failed job.

`RECEIPT_MAY_EXIST` means start delivery was ambiguous. Call `recover_start_receipt` with the preserved authorization id, digest, and receipt handle. This rotates access to the same committed chain; never create a new authorization or replay the request. `receiptState: "recovered"` confirms recovery.

## Draft errors

`COMPOSER_DRAFT_PRESENT` means text remains in the destination composer. The broker rolls back only its own unchanged text-only draft when that same execution fails before Send. It preserves existing drafts, edited text, attachments, and every possible submission.

Do not repeatedly create new starts against the same draft. A remaining draft requires the user to clear it or explicitly authorize `discardExistingDraft: true` for one exact new start. If submission may have occurred, reconcile that job first; draft discard never authorizes a duplicate Send.

## Response failure

`responseDisposition: "reasoning_stopped"` or `"transient_failure"` is a positively classified failure tied to the exact assistant turn. Similar words inside ordinary prose do not count.

With `responseFailurePolicy: "retry-once"`, the broker may create exactly one deterministic child authorization and send one continuation in the same conversation. Status/result calls follow it. Never replay the original Send, click regeneration controls, manually send recovery, or duplicate the `recoveryJobId`, `activeJobId`, or `recoveryChain`.

Rate limits, authentication failures, unavailable models, ambiguous errors, and a failed recovery are never retried automatically. If recovery was not authorized, is ineligible, or fails, report the terminal outcome and obtain fresh user authorization before any new write.

## Cooldown

For `ACCOUNT_COOLDOWN`, do not create another send. The broker persists one account-wide cooldown, invalidates unused permits, pauses other queued writes, and reopens them through a paced probe. A job already failed by the throttle still needs fresh user authorization before a replacement. If cooldown occurred after `submit_intent`, preserve uncertainty and reconcile read-only first.

## Uncertainty and quarantine

Never replay after `submit_intent` or when `submissionMayHaveOccurred` is true.

`MONITOR_REATTACHING` means Oracle is retrying only the bounded exact-turn monitor. Wait for that job and do not send. `RESPONSE_MONITOR_STALLED` and `RESPONSE_TIMEOUT` after the recovery bound mean the authorized turn may still finish; Oracle marks the exact conversation `response_uncertain` and quarantines only that lane.

1. Call `reconcile_job`; it searches the exact conversation read-only and never sends.
2. If proven, reattach or monitor the existing submission.
3. If unproven, ask the user to inspect the reported conversation/session.
4. Use `acknowledge_uncertain` only after that manual decision. It removes quarantine but neither proves absence nor authorizes replacement.
5. Respect `CONVERSATION_QUARANTINED` until the exact scope is resolved.

If a migrated quarantine blocks an exact conversation but the originating task and its private job capability are gone:

1. Call `inspect_quarantine` with the exact conversation URL from the blocked request. It reveals no other jobs, prompts, answers, or session paths.
2. Keep the returned fingerprint. Never recover from a title, partial URL, stale fingerprint, or global search.
3. Prefer `recover_orphaned_quarantine` with `action: "reconcile"` and explicit confirmation that the old capability is unavailable. Oracle reads the exact chat and adopts the chain only if one exact submitted turn matches; it never sends.
4. If read-only proof fails, ask the user to inspect that exact ChatGPT chat. Use `action: "acknowledge"` only after the user explicitly accepts the uncertainty; set both confirmation fields.
5. Acknowledgement only removes the lane barrier. It does not expose the old job, prove absence, or authorize a fresh submission.

## Restart and cancellation

After restart, use `broker_status` or `job_status`. Safe pre-send work may resume; proven submitted work is monitor-only; unproven post-send work remains uncertain.

For `BROKER_DRAINING`, `BROKER_UNRESPONSIVE`, `BROKER_ENDPOINT_CONFLICT`, `BROKER_PROTOCOL_MISMATCH`, or `CLIENT_UPGRADE_REQUIRED`, do not kill a process, delete a socket/lease/locator, launch Firefox directly, or start another broker. Protocol 8 may keep reading but cannot mutate; reload the current package for writes. Keep handles and follow the returned action.

`cancel_job` cancels only before `submit_intent`. Afterward it detaches the caller while monitoring continues and never authorizes a retry.

## Unanswered local-data requests

An `input_required` chain intentionally holds its exact conversation lane so a later agent cannot overtake a pending evidence reply. If the user explicitly declines that reply, use capability-owned `abandon_input_request`; it preserves the completed response, records the reason, sends nothing, and releases only the FIFO barrier.

`INPUT_REQUIRED_BLOCKING` means an earlier owner must resolve or abandon its request. `INPUT_INVALID` is a preserved malformed request: never construct an automated reply; only its owning control capability may abandon it. `list_attention` is session-scoped, and `inspect_input_request` exposes only sanitized `blockers[]`.

If the original capability is unavailable, call `inspect_input_request` with the exact conversation URL, retain its fingerprint, then call `recover_orphaned_input_request` only with explicit lost-capability and abandonment confirmations. Never recover from a title, partial URL, stale fingerprint, or global search. The orphan flow exposes no old prompt, answer, job id, handle, or session path and never authorizes a replacement message.

## Terminal result

Call `job_result` once terminal and verify a normal answer locally. For an unknown state, preserve the job id and report the structured outcome instead of inventing recovery behavior.
