# Browser selection, setup, and login

Read this file only when `doctor` reports a browser, broker, or login-readiness problem, or when the user asks to select a browser, set up Oracle, or import a Firefox session.

1. Do not send while the selected browser or broker is unready. `doctor` reports all three targets and the selected backend.
2. Change browsers only on the user's explicit request. Require zero outstanding jobs, then call `select_browser` once. It persists the choice and closes only Oracle's owned idle browser. Never stop processes or edit the selection file yourself.
3. Chrome on macOS must resolve to native Google Chrome under `/Applications` or the user's Applications directory with bundle id `com.google.Chrome` and Google's signing team. Reject Parallels, VM, mounted-volume, Windows-app, symlinked, unsigned, or ambiguous candidates.
4. Firefox and Chrome keep separate dedicated profiles. For Firefox or Chrome interactive login, call `setup`. For cookie import into any selected backend, call `profiles`, then use `import_session` only after explicit approval and confirmation that normal Firefox and Oracle Firefox are closed.
5. Cookie import copies only ChatGPT/OpenAI cookies. Never request or copy passwords, history, Google cookies, unrelated cookies, cookie values, or browser-profile contents. Do not import Firefox cookies while Chrome or Safari is selected.
6. Safari's visible WebDriver window is isolated from normal Safari data, blocks manual interaction, permits one driver session, has no headless mode, and retains login only while that session lives. `setup` therefore fails closed for Safari; use explicitly approved `import_session` from Firefox. The user must enable Allow remote automation manually; never run `safaridriver --enable` without explicit authorization. Behavior-only downloads require Firefox or Chrome.
7. If Google OAuth rejects an automated browser, use direct ChatGPT login or Firefox's explicitly approved cookie-import path; never weaken browser security or seek credentials.
8. Proceed only when setup/import establishes readiness. Otherwise report what remains; do not loop maintenance actions.
