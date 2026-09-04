import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  attachmentManifestKey,
  assistantSnapshot,
  classifyAssistantResponseFailure,
  clearOwnedComposerDraft,
  inspectComposerState,
  insertComposerText,
  installChatGptCooldownObserver,
  launchFirefox,
  normalizeSemanticText,
  probeAssistantAfterTurn,
  readComposerText,
  reconcileAssistantAfterTurn,
  semanticTextHash,
  submitComposer,
  uploadAttachmentFiles,
  uploadContextFile,
  waitForAssistantAfterTurn,
  waitForUserMessage,
} from "../src/firefox.mjs";
import { ensureModelRequirement, verifyModelRequirement } from "../src/model.mjs";

async function withPage(html, callback) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-safety-"));
  const browser = await launchFirefox({ headless: true, profileDir: profile });
  try {
    const page = await browser.newPage();
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

test("discards an existing text draft only with explicit one-shot authorization", async () => {
  await withPage(`
    <textarea id="prompt-textarea">user draft</textarea>
    <button data-testid="send-button" disabled>Send</button>
    <script>window.enterCount=0; document.addEventListener('keydown', event => { if (event.key === 'Enter') window.enterCount += 1; });</script>
  `, async (page) => {
    await insertComposerText(page, "authorized", { discardExistingDraft: true });
    assert.equal(await readComposerText(page), "authorized");
    assert.equal(await page.evaluate(() => window.enterCount), 0);
  });
});

test("explicit text-draft discard never removes a foreign attachment", async () => {
  await withPage(`
    <form>
      <textarea id="prompt-textarea">user draft</textarea>
      <div data-testid="attachment-chip" aria-label="Remove attachment foreign.txt">foreign.txt</div>
    </form>
  `, async (page) => {
    await assert.rejects(
      () => insertComposerText(page, "authorized", { discardExistingDraft: true }),
      /foreign attachments/u,
    );
    assert.equal(await readComposerText(page), "user draft");
    assert.equal((await inspectComposerState(page)).attachments.includes("foreign.txt"), true);
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

test("inserts contenteditable prompts atomically so Markdown shortcuts cannot rewrite them", async () => {
  const authorized = "1. Assess this response boundary";
  await withPage(`
    <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
    <script>
      const editor = document.querySelector("#prompt-textarea");
      window.composerKeydowns = 0;
      editor.addEventListener("keydown", event => {
        window.composerKeydowns += 1;
        if (event.key !== " " || editor.innerText !== "1.") return;
        event.preventDefault();
        editor.innerHTML = "<ol><li></li></ol>";
        const item = editor.querySelector("li");
        const range = document.createRange();
        range.selectNodeContents(item);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
    </script>
  `, async (page) => {
    await insertComposerText(page, authorized);
    assert.equal(await readComposerText(page), authorized);
    assert.equal((await inspectComposerState(page)).text, authorized);
    assert.equal(await page.evaluate(() => window.composerKeydowns), 0);
  });
});

test("accepts only ChatGPT's deterministic four-space expansion of composer tabs", async () => {
  const authorized = "left\tcenter\tright";
  await withPage(`
    <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
    <script>
      const editor = document.querySelector("#prompt-textarea");
      editor.addEventListener("input", () => {
        if (!editor.textContent.includes("\\t")) return;
        editor.textContent = editor.textContent.replaceAll("\\t", "    ");
      });
    </script>
  `, async (page) => {
    await insertComposerText(page, authorized);
    assert.equal(normalizeSemanticText(await readComposerText(page)), "left    center    right");
    assert.equal(normalizeSemanticText((await inspectComposerState(page)).text), "left    center    right");
  });
});

test("reconstructs mixed nested ProseMirror blocks without flattening paragraphs", async () => {
  const authorized = [
    "Wave checkpoint.",
    "",
    "I am a replacement agent.",
    "- first bounded item",
    "- second bounded item",
    "",
    "Archive digest follows.",
  ].join("\n");
  const html = [
    '<div id="prompt-textarea" role="textbox" contenteditable="true">',
    "<p>Wave checkpoint.</p>",
    "<p><br></p>",
    "<div>I am a replacement agent.</div>",
    "<ul><li>- first bounded item</li><li>- second bounded item</li></ul>",
    "<div><br></div>",
    "<section>Archive digest follows.</section>",
    "</div>",
  ].join("");
  await withPage(html, async (page) => {
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

test("waits for an exact multi-file attachment manifest", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-upload-multi-"));
  const first = path.join(directory, "first.zip");
  const second = path.join(directory, "second.zip");
  await writeFile(first, "first");
  await writeFile(second, "second");
  try {
    await withPage(`
      <form><textarea id="prompt-textarea">ready prompt</textarea><input id="file" type="file" multiple><button data-testid="send-button" disabled>Send</button></form>
      <script>
        document.querySelector('#file').addEventListener('change', event => {
          for (const file of event.target.files) {
            const chip=document.createElement('div'); chip.dataset.testid='attachment-chip'; chip.dataset.state='uploading'; chip.textContent=file.name; document.querySelector('form').append(chip);
          }
          setTimeout(()=>{ document.querySelectorAll('[data-testid=attachment-chip]').forEach(chip => { chip.dataset.state='ready'; }); document.querySelector('[data-testid=send-button]').disabled=false; }, 150);
        });
      </script>
    `, async (page) => {
      assert.deepEqual(
        await uploadAttachmentFiles(page, [first, second], { timeoutMs: 5_000 }),
        ["first.zip", "second.zip"],
      );
      assert.deepEqual((await inspectComposerState(page)).attachments.sort(), ["first.zip", "second.zip"]);
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
    assert.ok(response.monitorMetrics.probeCount >= 1);
    assert.ok(response.monitorMetrics.contentFetchCount >= 1);
    assert.ok(response.monitorMetrics.maxProbeLatencyMs >= 0);
    assert.ok(response.monitorMetrics.maxProbePayloadBytes > 0);
  });
});

test("accepts an exact user-turn ID without a hash and captures an ID-less assistant by stable hash", async () => {
  await withPage(`
    <main>
      <article data-message-author-role="user" data-message-id="id-only-user"><div data-message-content>exact prompt</div></article>
      <article data-message-author-role="assistant"><div class="markdown">ID-less exact answer</div><button data-testid="copy-turn-action-button">Copy</button></article>
    </main>
  `, async (page) => {
    const response = await waitForAssistantAfterTurn(page, { id: "id-only-user" }, {
      timeoutMs: 3_000,
      stableMs: 100,
    });
    assert.equal(response.exactTurnBinding, true);
    assert.equal(response.assistantTurn.id, null);
    assert.equal(semanticTextHash(response.assistantTurn.text), semanticTextHash("ID-less exact answer"));
  });
});

test("a 10,000-turn exact probe returns bounded metadata without serializing conversation HTML", { timeout: 30_000 }, async () => {
  const historical = Array.from({ length: 9_998 }, (_, index) =>
    `<article data-message-author-role="${index % 2 ? "assistant" : "user"}" data-message-id="old-${index}"><div data-message-content>historical ${index}</div></article>`,
  ).join("");
  await withPage(`<main>${historical}
    <article data-message-author-role="user" data-message-id="expected-user"><div data-message-content>exact prompt</div></article>
    <article data-message-author-role="assistant" data-message-id="expected-assistant"><div class="markdown">bounded answer</div><button data-testid="copy-turn-action-button">Copy</button></article>
  </main>`, async (page) => {
    const probe = await probeAssistantAfterTurn(page, { id: "expected-user" });
    assert.equal(probe.userMatchCount, 1);
    assert.equal(probe.assistantCount, 1);
    assert.equal(probe.assistant.id, "expected-assistant");
    assert.equal("text" in probe.assistant, false);
    assert.equal("html" in probe.assistant, false);
    assert.ok(probe.payloadBytes < 2_048, `probe payload was ${probe.payloadBytes} bytes`);
    assert.ok(probe.latencyMs >= 0);
  });
});

test("refuses to choose among duplicate user-turn hash matches during final reconciliation", async () => {
  await withPage(`
    <main>
      <article data-message-author-role="user" data-message-id="duplicate-1"><div data-message-content>duplicate prompt</div></article>
      <article data-message-author-role="assistant" data-message-id="answer-1"><div class="markdown">first answer</div><button data-testid="copy-turn-action-button">Copy</button></article>
      <article data-message-author-role="user" data-message-id="duplicate-2"><div data-message-content>duplicate prompt</div></article>
      <article data-message-author-role="assistant" data-message-id="answer-2"><div class="markdown">second answer</div><button data-testid="copy-turn-action-button">Copy</button></article>
    </main>
  `, async (page) => {
    const response = await reconcileAssistantAfterTurn(page, {
      hash: semanticTextHash("duplicate prompt"),
    });
    assert.equal(response, null);
  });
});

test("a hung assistant DOM probe fails closed without waiting for the response deadline", async () => {
  const page = { evaluate: () => new Promise(() => {}) };
  const started = Date.now();
  await assert.rejects(
    () => waitForAssistantAfterTurn(page, { id: "submitted-turn", hash: "hash" }, {
      timeoutMs: 60_000,
      probeTimeoutMs: 25,
    }),
    (error) => error.code === "RESPONSE_MONITOR_STALLED" && error.submissionMayHaveOccurred === true && error.safeToRetry === false,
  );
  assert.ok(Date.now() - started < 1_000);
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

test("reconstructs inline code source for exact submitted-turn correlation", async () => {
  await withPage(`
    <main id="thread">
      <article data-testid="conversation-turn-1" data-message-author-role="user" data-message-id="inline-code-user">
        <div data-testid="collapsible-user-message-content" class="whitespace-pre-wrap">Inline syntax: <code>code</code> remains literal.</div>
      </article>
    </main>
  `, async (page) => {
    const expected = "Inline syntax: `code` remains literal.";
    const snapshot = await assistantSnapshot(page);
    assert.equal(snapshot.turns[0].text, expected);
    const confirmed = await waitForUserMessage(page, 0, expected, {
      timeoutMs: 1_000,
      requireCanonicalUrl: false,
    });
    assert.equal(confirmed.userTurn.id, "inline-code-user");
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

test("accepts one exact submitted turn when ChatGPT omits the rendered attachment chip", async () => {
  await withPage(`
    <main><article data-testid="conversation-turn-1" data-message-author-role="user" data-message-id="attachment-user">
      <div data-message-content>attached prompt</div>
    </article></main>
  `, async (page) => {
    const confirmed = await waitForUserMessage(page, 0, "attached prompt", {
      expectedAttachments: ["review.zip"],
      timeoutMs: 1_000,
      requireCanonicalUrl: false,
    });
    assert.equal(confirmed.userTurn.id, "attachment-user");
    assert.equal(confirmed.userTurn.attachmentEvidence, "pre_submit_verified_post_submit_unavailable");
  });
});

test("still refuses a visible foreign post-submit attachment manifest", async () => {
  await withPage(`
    <main><article data-testid="conversation-turn-1" data-message-author-role="user" data-message-id="attachment-user">
      <div role="group" aria-label="foreign.zip"></div>
      <div data-message-content>attached prompt</div>
    </article></main>
  `, async (page) => {
    await assert.rejects(
      () => waitForUserMessage(page, 0, "attached prompt", {
        expectedAttachments: ["review.zip"],
        timeoutMs: 100,
        requireCanonicalUrl: false,
      }),
      (error) => error.code === "SUBMISSION_UNCERTAIN",
    );
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

test("retains a transient ChatGPT cooldown notice that disappears before the next poll", async () => {
  await withPage("<main></main>", async (page) => {
    await installChatGptCooldownObserver(page);
    await page.evaluate(() => {
      const notice = document.createElement("div");
      notice.setAttribute("role", "alert");
      notice.textContent = "You've reached your current Pro limit. Please wait before trying again.";
      document.body.append(notice);
      notice.remove();
    });
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


test("hash-only recovery binds Unicode and multiline messages after turn IDs change", async () => {
  const prompt = "résumé 🧿\nsecond line";
  await withPage(`<main>
    <article data-message-author-role="user" data-message-id="new-id"><div data-message-content>${prompt}</div></article>
    <article data-message-author-role="assistant" data-message-id="answer"><div class="markdown">Recovered answer</div><button data-testid="copy-turn-action-button">Copy</button></article>
  </main>`, async (page) => {
    const probe = await probeAssistantAfterTurn(page, { id: "obsolete-id", hash: semanticTextHash(prompt) });
    assert.equal(probe.userMatchCount, 1);
    assert.equal(probe.assistant.hash, semanticTextHash("Recovered answer"));
    const result = await reconcileAssistantAfterTurn(page, { hash: semanticTextHash(prompt) });
    assert.equal(result?.text, "Recovered answer");
  });
});

test("streaming probes defer full content until the exact answer is complete", async () => {
  await withPage(`<main>
    <article data-message-author-role="user" data-message-id="user"><div data-message-content>question</div></article>
    <article data-message-author-role="assistant" data-message-id="answer"><div class="markdown">draft 0</div></article>
    <button data-testid="stop-button">Stop</button>
  </main>`, async (page) => {
    await page.evaluate(() => {
      let count = 0;
      const timer = setInterval(() => {
        document.querySelector('.markdown').textContent = 'draft ' + ++count;
        if (count === 6) {
          clearInterval(timer);
          document.querySelector('.markdown').textContent = 'Complete answer';
          document.querySelector('[data-testid="stop-button"]').remove();
          document.querySelector('[data-message-id="answer"]').insertAdjacentHTML('beforeend', '<button data-testid="copy-turn-action-button">Copy</button>');
        }
      }, 200);
    });
    const result = await waitForAssistantAfterTurn(page, { id: "user" }, { timeoutMs: 6_000, stableMs: 100 });
    assert.equal(result.text, "Complete answer");
    assert.equal(result.monitorMetrics.contentFetchCount, 1);
  });
});

test("final reconciliation rejects a response that changes between metadata and content reads", async () => {
  let call = 0;
  const page = { evaluate: async () => ({
    userMatchCount: 1, assistantCount: 1, stopVisible: false,
    assistant: { id: "answer", hash: ++call === 1 ? "old" : "new", text: "changed answer", completionVisible: true, errorIndicators: [] },
  }) };
  assert.equal(await reconcileAssistantAfterTurn(page, { id: "user" }), null);
});

test("pre-send rollback removes only this execution's unchanged text-only draft", async () => {
  await withPage('<form><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></form>', async (page) => {
    await insertComposerText(page, "authorized");
    assert.equal(await clearOwnedComposerDraft(page), true);
    assert.equal(await readComposerText(page), "");
    await insertComposerText(page, "authorized");
    await page.evaluate(() => { document.querySelector('textarea').value = 'human edit'; });
    assert.equal(await clearOwnedComposerDraft(page), false);
    assert.equal(await readComposerText(page), "human edit");
    await page.evaluate(() => { document.querySelector('textarea').value = ''; });
    await insertComposerText(page, "authorized");
    await page.evaluate(() => { document.querySelector('form').insertAdjacentHTML('beforeend', '<div data-testid="attachment-chip">file.zip</div>'); });
    assert.equal(await clearOwnedComposerDraft(page), false);
    assert.equal(await readComposerText(page), "authorized");
    await page.evaluate(() => { document.querySelector('[data-testid="attachment-chip"]').remove(); document.querySelector('textarea').value = ''; });
    await insertComposerText(page, "authorized");
    await submitComposer(page);
    assert.equal(await clearOwnedComposerDraft(page), false);
  });
});


test("failed insertion can roll back its own synchronously transformed draft", async () => {
  await withPage(`<form><textarea id="prompt-textarea"></textarea></form>
    <script>document.querySelector('textarea').addEventListener('input', (event) => { if (event.inputType === 'insertFromPaste') event.target.value = 'transformed draft'; });</script>
  `, async (page) => {
    await assert.rejects(() => insertComposerText(page, "authorized"), { code: "COMPOSER_MISMATCH" });
    assert.equal(await clearOwnedComposerDraft(page), true);
    assert.equal(await readComposerText(page), "");
  });
});


test("Pro verification accepts compact model labels and never sidebar chat titles", async () => {
  await withPage(`<aside><button aria-label="Pin Search AI Models for Logic Pro">Pro chat</button></aside>
    <form><button class="__composer-pill">6Pro</button><textarea id="prompt-textarea"></textarea></form>
  `, async (page) => {
    const evidence = await verifyModelRequirement(page);
    assert.equal(evidence.resolvedLabel, "6Pro");
    assert.equal(evidence.source, "button.__composer-pill");
    await page.evaluate(() => { document.querySelector('.__composer-pill').textContent = 'Instant'; });
    await assert.rejects(() => verifyModelRequirement(page), { code: "MODEL_REQUIREMENT_NOT_MET" });
    await page.evaluate(() => { document.querySelector('.__composer-pill').remove(); });
    await assert.rejects(() => ensureModelRequirement(page), { code: "MODEL_REQUIREMENT_NOT_MET" });
  });
});
