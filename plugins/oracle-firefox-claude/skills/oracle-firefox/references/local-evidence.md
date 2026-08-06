# Local-evidence replies

Read this file only when `job_result` returns `assistantDisposition: "local_data_request"` with a parsed `ORACLE_LOCAL_DATA_REQUEST_V1` request.

1. Confirm the returned request is parsed and `safeReadOnly` is true. If not, do not perform checks or reply automatically.
2. Perform only the specifically requested read-only checks within the original user task, workspace, files, and tooling scope.
3. Do not retrieve or disclose credentials, cookies, tokens, passwords, private keys, browser-profile contents, unrelated chats, unrelated private files, or other sensitive material.
4. Do not make writes, change system state, broaden the investigation, or substitute a more invasive check.
5. Call `reply_with_local_data` with:
   - one structured fact for each satisfied request, including its request id, value, and precise source; and
   - an `unavailable` entry with the request id and reason for every item that could not safely be established.
6. The reply stays in the same conversation, re-verifies Pro, and is part of the original logical job.
7. Up to three safe read-only evidence rounds are covered by the original authorization. Before a fourth round, any write, sensitive request, or scope expansion, stop and obtain fresh explicit user approval.
8. When Pro returns a final answer, retrieve it through the normal job flow and verify it locally before acting.

Never guess a requested local fact. Report an unavailable fact as unavailable instead of approximating it.
