import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  attachmentManifestKey,
  assistantSnapshot,
  classifyAssistantResponseFailure,
  inspectComposerState,
  insertComposerText,
  launchFirefox,
  readComposerText,
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

test("reconstructs Firefox contenteditable block boundaries exactly", async () => {
  await withPage('<div id="prompt-textarea" role="textbox" contenteditable="true"></div>', async (page) => {
    const authorized = "first line\n\nthird line\nfourth line";
    await insertComposerText(page, authorized);
    assert.equal(await readComposerText(page), authorized);
    assert.equal((await inspectComposerState(page)).text, authorized);
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

test("accepts ChatGPT's duplicate suffix only for the authorized attachment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-upload-suffix-"));
  const attachment = path.join(directory, "oracle-context.md");
  await writeFile(attachment, "context");
  try {
    await withPage(`
      <form><textarea id="prompt-textarea">ready prompt</textarea><input id="file" type="file"><button data-testid="send-button" disabled>Send</button></form>
      <script>
        document.querySelector('#file').addEventListener('change', (event) => {
          const chip=document.createElement('div'); chip.dataset.testid='attachment-chip'; chip.dataset.state='ready'; chip.textContent='oracle-context(2).md'; document.querySelector('form').append(chip);
          event.target.value='';
          document.querySelector('[data-testid=send-button]').disabled=false;
        });
      </script>
    `, async (page) => {
      assert.equal(await uploadContextFile(page, attachment, { timeoutMs: 5_000 }), "oracle-context.md");
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
    const confirmed = await waitForUserMessage(page, baseline.userCount, "same prompt", {
      timeoutMs: 3_000,
      requireCanonicalUrl: false,
    });
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

test("excludes ChatGPT's Show more control from long user-turn correlation", async () => {
  await withPage(`
    <main id="thread">
      <article data-testid="conversation-turn-1" data-message-author-role="user" data-message-id="new-user">
        <div data-testid="collapsible-user-message-root">
          <div data-testid="collapsible-user-message-content" class="whitespace-pre-wrap">exact authorized prompt</div>
          <button data-testid="collapsible-user-message-toggle">Show more</button>
        </div>
      </article>
    </main>
  `, async (page) => {
    const snapshot = await assistantSnapshot(page);
    assert.equal(snapshot.turns[0].text, "exact authorized prompt");
  });
});

test("reconstructs fenced code source for exact submitted-turn correlation", async () => {
  await withPage(`
    <main id="thread">
      <article data-testid="conversation-turn-1" data-message-author-role="user" data-message-id="evidence-user">
        <div data-testid="collapsible-user-message-content" class="whitespace-pre-wrap">ORACLE_LOCAL_DATA_RESPONSE_V1\n\n<pre><code>json\n{\n  &quot;value&quot;: true\n}</code></pre></div>
      </article>
    </main>
  `, async (page) => {
    const expected = 'ORACLE_LOCAL_DATA_RESPONSE_V1\n\n```json\n{\n  "value": true\n}\n```';
    const snapshot = await assistantSnapshot(page);
    assert.equal(snapshot.turns[0].text, expected);
    const confirmed = await waitForUserMessage(page, 0, expected, {
      timeoutMs: 1_000,
      requireCanonicalUrl: false,
    });
    assert.equal(confirmed.userTurn.id, "evidence-user");
  });
});

test("finds a new exact turn by ID when ChatGPT virtualizes below the baseline count", async () => {
  await withPage(`
    <main id="thread">
      <article data-testid="conversation-turn-1" data-message-author-role="user" data-message-id="old-1"><div data-message-content>old one</div></article>
      <article data-testid="conversation-turn-2" data-message-author-role="user" data-message-id="old-2"><div data-message-content>old two</div></article>
      <article data-testid="conversation-turn-3" data-message-author-role="user" data-message-id="old-3"><div data-message-content>old three</div></article>
      <article data-testid="conversation-turn-4" data-message-author-role="user" data-message-id="old-4"><div data-message-content>old four</div></article>
    </main>
  `, async (page) => {
    const baseline = await assistantSnapshot(page);
    await page.evaluate(() => {
      document.querySelector('[data-message-id="old-1"]').remove();
      document.querySelector('[data-message-id="old-2"]').remove();
      const turn = document.createElement("article");
      turn.dataset.testid = "conversation-turn-5";
      turn.dataset.messageAuthorRole = "user";
      turn.dataset.messageId = "new-5";
      turn.innerHTML = '<div data-message-content>exact new prompt</div>';
      document.querySelector("#thread").append(turn);
    });
    const confirmed = await waitForUserMessage(page, baseline.userCount, "exact new prompt", {
      timeoutMs: 1_000,
      requireCanonicalUrl: false,
      baselineTurnIds: baseline.turns.filter((turn) => turn.role === "user").map((turn) => turn.id),
    });
    assert.equal(confirmed.userCount, 3);
    assert.equal(confirmed.userTurn.id, "new-5");
  });
});

test("correlates ChatGPT duplicate-suffixed attachment names exactly", async () => {
  await withPage(`
    <main><article data-testid="conversation-turn-1" data-message-author-role="user" data-message-id="attachment-user">
      <div role="group" aria-label="oracle-context(2).md"></div>
      <div data-message-content>attached prompt</div>
    </article></main>
  `, async (page) => {
    const snapshot = await assistantSnapshot(page);
    assert.deepEqual(snapshot.turns[0].attachments, ["oracle-context(2).md"]);
    assert.equal(attachmentManifestKey(snapshot.turns[0].attachments), attachmentManifestKey(["oracle-context.md"]));
    const confirmed = await waitForUserMessage(page, 0, "attached prompt", {
      expectedAttachments: ["oracle-context.md"],
      timeoutMs: 1_000,
      requireCanonicalUrl: false,
    });
    assert.equal(confirmed.userTurn.id, "attachment-user");
  });
});

test("classifies ChatGPT's visible request throttle as account cooldown", async () => {
  await withPage(`
    <main></main>
    <div role="alert" style="width:200px;height:30px">You're making too many requests too quickly. Try again later.</div>
  `, async (page) => {
    await assert.rejects(
      () => waitForUserMessage(page, 0, "authorized prompt", { timeoutMs: 1_000, requireCanonicalUrl: false }),
      (error) => error.code === "ACCOUNT_COOLDOWN" && error.submissionMayHaveOccurred === false,
    );
  });
});

test("classifies a terminal ChatGPT throttle response as account cooldown", async () => {
  await withPage(`
    <main>
      <article data-testid="conversation-turn-1" data-message-author-role="user" data-message-id="submitted-user"><div data-message-content>authorized prompt</div></article>
      <article data-testid="conversation-turn-2" data-message-author-role="assistant" data-message-id="throttle-assistant"><div class="markdown">You're making too many requests too quickly. Please try again later.</div><button data-testid="copy-turn-action-button">Copy</button></article>
    </main>
  `, async (page) => {
    await assert.rejects(
      () => waitForAssistantAfterTurn(page, { id: "submitted-user", hash: "unused" }, { timeoutMs: 4_000, stableMs: 100 }),
      (error) => error.code === "ACCOUNT_COOLDOWN" && error.submissionMayHaveOccurred === true,
    );
  });
});

test("classifies a stable Stopped reasoning turn as a retryable response failure", async () => {
  await withPage(`
    <main>
      <article data-testid="conversation-turn-1" data-message-author-role="user" data-message-id="submitted-user"><div data-message-content>authorized prompt</div></article>
      <article data-testid="conversation-turn-2" data-message-author-role="assistant" data-message-id="stopped-assistant"><div class="markdown">Stopped reasoning</div><button>Try again</button></article>
    </main>
  `, async (page) => {
    const response = await waitForAssistantAfterTurn(
      page,
      { id: "submitted-user", hash: "unused" },
      { timeoutMs: 4_000, stableMs: 100 },
    );
    assert.equal(response.responseFailure.code, "PRO_REASONING_STOPPED");
    assert.equal(response.responseFailure.disposition, "reasoning_stopped");
    assert.equal(response.responseFailure.retryable, true);
    assert.deepEqual(response.responseFailure.visibleErrorControls, ["Try again"]);
  });
});

test("does not mistake normal prose mentioning stopped reasoning for a failed response", () => {
  assert.equal(classifyAssistantResponseFailure({
    id: "normal-assistant",
    text: "I stopped reasoning about the discarded option and completed the requested analysis.",
    errorIndicators: [],
  }), null);
});

test("classifies a visible generation error but never marks it retryable from prose alone", () => {
  const failure = classifyAssistantResponseFailure({
    id: "error-assistant",
    text: "Something went wrong while generating the response.",
    errorIndicators: ["Try again"],
  });
  assert.equal(failure.code, "CHATGPT_TRANSIENT_FAILURE");
  assert.equal(failure.retryable, true);
  assert.equal(classifyAssistantResponseFailure({
    id: "prose-assistant",
    text: "Something went wrong in the old implementation, so here is the corrected plan with all requested details.",
    errorIndicators: [],
  }), null);
});
