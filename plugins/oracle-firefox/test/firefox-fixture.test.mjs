import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assistantSnapshot,
  insertComposerText,
  launchFirefox,
  openProject,
  probeLogin,
  projectUrlFromConversationUrl,
  submitComposer,
  uploadContextFile,
  waitForAssistant,
  waitForConversationHistoryStable,
} from "../src/firefox.mjs";

test(
  "controls installed Firefox over BiDi and captures a terminal answer",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-bidi-"));
    const uploadPath = path.join(directory, "oracle-context.md");
    await writeFile(uploadPath, "fixture context\n");
    const browser = await launchFirefox({
      headless: true,
      profileDir: path.join(directory, "profile"),
    });
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html>
      <form id="composer">
        <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
        <input id="file" type="file" hidden>
        <span id="filename"></span>
        <button data-testid="send-button" type="submit">Send</button>
      </form>
      <main id="turns"></main>
      <script>
        file.addEventListener('change', () => { filename.textContent = file.files[0]?.name || ''; });
        composer.addEventListener('submit', (event) => {
          event.preventDefault();
          const turn = document.createElement('article');
          turn.dataset.testid = 'conversation-turn-1';
          turn.innerHTML = '<div data-message-author-role="assistant"><div class="markdown">Fixture answer: ' +
            document.getElementById('prompt-textarea').innerText +
            '</div><button data-testid="copy-turn-action-button">Copy</button></div>';
          turns.appendChild(turn);
        });
      </script>`);

      await uploadContextFile(page, uploadPath, { timeoutMs: 5_000 });
      const baseline = await assistantSnapshot(page);
      const stable = await waitForConversationHistoryStable(page, {
        timeoutMs: 2_000,
        stableMs: 250,
      });
      assert.equal(stable.count, baseline.count);
      await insertComposerText(page, "hello from Firefox");
      await submitComposer(page);
      const response = await waitForAssistant(page, baseline.count, { timeoutMs: 10_000 });
      assert.match(response.text, /Fixture answer: hello from Firefox/);
      assert.equal(response.completionVisible, true);
      assert.match(await browser.version(), /^firefox\//);
    } finally {
      await browser.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("creates a conversation from a project home fixture", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-project-bidi-"));
  const browser = await launchFirefox({
    headless: true,
    profileDir: path.join(directory, "profile"),
  });
  try {
    const page = await browser.newPage();
    const projectUrl = "https://chatgpt.com/g/g-p-fixture-project/project";
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) {
        await request.abort().catch(() => undefined);
        return;
      }
      await request.respond({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
          <button data-testid="project-modal-trigger">Fixture Project</button>
          <form id="composer">
            <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
            <button data-testid="send-button" type="submit">Send</button>
          </form>
          <main id="turns"></main>
          <script>
            composer.addEventListener('submit', (event) => {
              event.preventDefault();
              history.pushState({}, '', '/g/g-p-fixture-project/c/fixture-conversation-id');
              const turn = document.createElement('article');
              turn.dataset.testid = 'conversation-turn-1';
              turn.innerHTML = '<div data-message-author-role="assistant"><div class="markdown">Project fixture answer</div><button data-testid="copy-turn-action-button">Copy</button></div>';
              turns.appendChild(turn);
            });
          </script>`,
      });
    });

    const project = await openProject(page, { projectUrl });
    assert.deepEqual(project, { title: "Fixture Project", url: projectUrl });
    const baseline = await assistantSnapshot(page);
    await insertComposerText(page, "create this project chat");
    await submitComposer(page);
    const response = await waitForAssistant(page, baseline.count, { timeoutMs: 10_000 });
    assert.equal(projectUrlFromConversationUrl(response.url), projectUrl);
    assert.match(response.text, /Project fixture answer/);
  } finally {
    await browser.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "does not mistake a dormant Cloudflare script for an active challenge",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-cloudflare-"));
    const browser = await launchFirefox({
      headless: true,
      profileDir: path.join(directory, "profile"),
    });
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><title>Healthy project</title>
      <script src="/challenge-platform/dormant.js"></script>
      <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
      <div data-testid="history-item-1"></div>`);
      assert.equal((await probeLogin(page)).cloudflare, false);
      await page.setContent(`<!doctype html><title>Just a moment...</title>
      <script src="/challenge-platform/active.js"></script>
      <p>Verify you are human</p>`);
      assert.equal((await probeLogin(page)).cloudflare, true);
    } finally {
      await browser.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
