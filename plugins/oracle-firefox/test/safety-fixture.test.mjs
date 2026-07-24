import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assistantSnapshot,
  insertComposerText,
  launchFirefox,
  submitComposer,
  uploadContextFile,
  waitForAssistantAfterTurn,
  waitForUserMessage,
} from "../src/firefox.mjs";
import { ensureModelRequirement } from "../src/model.mjs";

async function withPage(html, callback) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-safety-"));
  const browser = await launchFirefox({ headless: true, profileDir: profile });
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.setContent(html);
    return await callback(page);
  } finally {
    await browser.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
}

test("refuses foreign drafts and never uses Enter when Send is disabled", async () => {
  await withPage(`
    <textarea id="prompt-textarea">user draft</textarea>
    <button data-testid="send-button" disabled>Send</button>
    <script>window.enterCount=0; document.addEventListener('keydown', event => { if (event.key === 'Enter') window.enterCount += 1; });</script>
  `, async (page) => {
    await assert.rejects(() => insertComposerText(page, "authorized"), /existing draft/u);
    await assert.rejects(() => submitComposer(page), /No submission was attempted/u);
    assert.equal(await page.evaluate(() => window.enterCount), 0);
  });
});

test("selects one visible Pro option and verifies the replaced composer pill", async () => {
  await withPage(`
    <textarea id="prompt-textarea"></textarea>
    <button data-testid="model-switcher-dropdown-button" onclick="openMenu()">Auto</button>
    <script>
      function openMenu() {
        const menu = document.createElement('div'); menu.id='menu'; menu.setAttribute('role','menu');
        const pro = document.createElement('button'); pro.setAttribute('role','menuitem'); pro.textContent='Pro';
        pro.onclick=()=>{ const old=document.querySelector('[data-testid=model-switcher-dropdown-button]'); const next=old.cloneNode(true); next.textContent='Pro'; old.replaceWith(next); menu.remove(); };
        menu.append(pro); document.body.append(menu);
      }
    </script>
  `, async (page) => {
    const evidence = await ensureModelRequirement(page, "pro");
    assert.equal(evidence.verified, true);
    assert.match(evidence.resolvedLabel, /Pro/u);
  });
});

test("waits through slow attachment processing and requires the exact ready file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-upload-"));
  const attachment = path.join(directory, "oracle-context.md");
  await writeFile(attachment, "context");
  try {
    await withPage(`
      <form><textarea id="prompt-textarea">ready prompt</textarea><input id="file" type="file"><button data-testid="send-button" disabled>Send</button></form>
      <script>
        document.querySelector('#file').addEventListener('change', event => {
          const chip=document.createElement('div'); chip.dataset.testid='attachment-chip'; chip.dataset.state='uploading'; chip.textContent=event.target.files[0].name; document.querySelector('form').append(chip);
          setTimeout(()=>{ chip.dataset.state='ready'; document.querySelector('[data-testid=send-button]').disabled=false; }, 250);
        });
      </script>
    `, async (page) => {
      const started = Date.now();
      assert.equal(await uploadContextFile(page, attachment, { timeoutMs: 5_000 }), "oracle-context.md");
      assert.ok(Date.now() - started >= 200);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("binds completion to the exact new user turn and ignores Pro-thinking placeholders", async () => {
  await withPage(`
    <main id="thread">
      <article data-testid="conversation-turn-1" data-message-author-role="user" data-message-id="old"><div data-message-content>same prompt</div></article>
      <article data-testid="conversation-turn-2" data-message-author-role="assistant" data-message-id="old-a"><div class="markdown">old answer</div><button data-testid="copy-turn-action-button">Copy</button></article>
    </main>
  `, async (page) => {
    const baseline = await assistantSnapshot(page);
    await page.evaluate(() => {
      setTimeout(() => {
        const user=document.createElement('article'); user.dataset.testid='conversation-turn-3'; user.dataset.messageAuthorRole='user'; user.dataset.messageId='new-user'; user.innerHTML='<div data-message-content>same prompt</div>'; document.querySelector('#thread').append(user);
      }, 100);
    });
    const confirmed = await waitForUserMessage(page, baseline.userCount, "same prompt", { timeoutMs: 3_000 });
    assert.equal(confirmed.userTurn.id, "new-user");
    await page.evaluate(() => {
      const assistant=document.createElement('article'); assistant.dataset.testid='conversation-turn-4'; assistant.dataset.messageAuthorRole='assistant'; assistant.dataset.messageId='new-assistant'; assistant.innerHTML='<div class="markdown">Pro thinking — Answer now</div><button data-testid="copy-turn-action-button">Copy</button>'; document.querySelector('#thread').append(assistant);
      setTimeout(()=>{ assistant.querySelector('.markdown').textContent='final exact answer'; }, 300);
    });
    const response = await waitForAssistantAfterTurn(page, confirmed.userTurn, { timeoutMs: 4_000, stableMs: 300 });
    assert.equal(response.text, "final exact answer");
    assert.equal(response.assistantTurn.id, "new-assistant");
  });
});
