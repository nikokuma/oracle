# Oracle Firefox reliability review — 2026-09-04

The installed package and local development source were Oracle Firefox 1.7.1. GitHub `main` was still 1.2.1 (`6b37a9ce`); the remote Firefox release branch was also behind the local checkout. Existing unpublished work was preserved on `codex/oracle-reliability`. The reliability changes are packaged as Oracle Firefox 1.7.2 for GitHub and local installation.

## Findings and fixes

- **Response recovery:** the browser SHA-256 fallback returned 512 hexadecimal characters instead of 64. After a turn ID changed, matching by message hash could never succeed. A real Firefox comparison reproduced zero matches before the fix and one afterward. Secure pages now use native Web Crypto; the corrected fallback supports other contexts.
- **Long-running monitoring:** unfinished responses were polled every 500 ms, and changing responses triggered full text/HTML transfers. Active generation now uses two-second probes; full content is retrieved only after stable completion. Metadata and content must describe the same response, with generation stopped.
- **Stuck drafts:** a failed pre-Send execution now rolls back its own unchanged text-only insertion, including synchronously transformed insertion failures. It does not clear pre-existing drafts, subsequent edits, attachments, or any possible submission. Cleanup is bounded and fenced by the current execution.
- **Pro verification:** the live test exposed sidebar chat titles being accepted as model evidence, while the actual compact `6Pro` label was missed. Verification now recognizes compact labels and reads model controls, excluding conversation/sidebar content.
- **Skill:** the main instructions decreased from 6,493 to 4,669 characters (28%), with one start/result workflow and explicit draft recovery guidance.

## Validation

All 170 portable tests, 35 Firefox safety cases (including the added model-verification case), and 3 browser compatibility tests passed; packaging and skill/plugin validators also passed. Coverage includes a 10,000-turn conversation, exact-turn hash recovery, streaming, changed snapshots, protected drafts and attachments, and model verification.

A simulated three-hour unfinished response used approximately 5,400 probes, no full-content reads, and stopped at its deadline. This is a simulated endurance check, not a three-hour live browser soak. The final live round-trip verified `6Pro` from `button.__composer-pill`, completed with exactly one submission, and returned `ORACLE_RELIABILITY_OK`; the persisted response was verified locally and its completion delivery acknowledged.

The local marketplace installation was rebuilt as 1.7.2 (release sequence 1705), with a full broker/browser restart through the controlled upgrade handoff. Browser authentication and durable job history were retained; 14 historical uncertain submissions were not cleared or resent.

## Locations

- Development source: `plugins/oracle-firefox/` in this repository.
- Installed marketplace source: `~/plugins/oracle-firefox/`.
- Session metadata: `~/.oracle-firefox/sessions/`.
- Broker log: `~/Library/Application Support/oracle-firefox/coordinator/broker.log`.

Session files contain private prompts and answers. The review used aggregate error metadata and local fixtures; no private source files were included in the live smoke test.
