# Recovery and exceptional states

Read this file before acting on a pending receipt after client restart, positively classified response failure, cooldown, uncertain submission, quarantine, cancellation, or recovery chain.

Keep the root `jobId` and private `jobHandle`. Present the handle when a different MCP/CLI process resumes the chain. Use `followRetries: true` unless the user explicitly asks to inspect the original failed job.

## Response failure

`responseDisposition: "reasoning_stopped"` or `"transient_failure"` is a positively classified failure tied to the exact assistant turn. Similar words inside ordinary prose do not count.

With `responseFailurePolicy: "retry-once"`, the broker may create exactly one deterministic child authorization and send one continuation in the same conversation. Status/result calls follow it. Never replay the original Send, click regeneration controls, manually send recovery, or duplicate the `recoveryJobId`, `activeJobId`, or `recoveryChain`.

Rate limits, authentication failures, unavailable models, ambiguous errors, and a failed recovery are never retried automatically. If recovery was not authorized, is ineligible, or fails, report the terminal outcome and obtain fresh user authorization before any new write.

## Cooldown

For `ACCOUNT_COOLDOWN`, do not create another send. The broker persists one account-wide cooldown, invalidates unused permits, pauses other queued writes, and reopens them through a paced probe. A job already failed by the throttle still needs fresh user authorization before a replacement. If cooldown occurred after `submit_intent`, preserve uncertainty and reconcile read-only first.

## Uncertainty and quarantine

Never replay after `submit_intent` or when `submissionMayHaveOccurred` is true.

1. Call `reconcile_job`; it searches the exact conversation read-only and never sends.
2. If proven, reattach or monitor the existing submission.
3. If unproven, ask the user to inspect the reported conversation/session.
4. Use `acknowledge_uncertain` only after that manual decision. It removes quarantine but neither proves absence nor authorizes replacement.
5. Respect `CONVERSATION_QUARANTINED` until the exact scope is resolved.

## Restart and cancellation

After restart, use `broker_status` or `job_status`. Safe pre-send work may resume; proven submitted work is monitor-only; unproven post-send work remains uncertain.

For `BROKER_DRAINING`, `BROKER_UNRESPONSIVE`, `BROKER_ENDPOINT_CONFLICT`, `BROKER_PROTOCOL_MISMATCH`, or `CLIENT_UPGRADE_REQUIRED`, do not kill a process, delete a socket/lease/locator, launch Firefox directly, or start another broker. Keep the private handles and follow the returned wait or host-reload action. A known newer package may request an idle directional handoff; older or unknown builds fail closed.

`cancel_job` cancels only before `submit_intent`. Afterward it detaches the caller while monitoring continues and never authorizes a retry.

## Terminal result

Call `job_result` once terminal and verify a normal answer locally. For an unknown state, preserve the job id and report the structured outcome instead of inventing recovery behavior.
