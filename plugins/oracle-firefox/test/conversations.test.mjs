import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  expandProjectConversationList,
  findChats,
  findConversationCandidates,
  findConversationCandidatesByQuery,
  findProjectCandidates,
  launchFirefox,
  normalizeConversationUrl,
  normalizeProjectUrl,
  projectUrlFromConversationUrl,
  selectUniqueConversationCandidate,
  selectUniqueProjectCandidate,
} from "../src/firefox.mjs";

test("normalizes and validates standalone and project ChatGPT URLs", () => {
  assert.equal(
    normalizeConversationUrl(
      "https://chatgpt.com/c/6a628f53-0450-83ea-94d9-c0626ccf2cdc?messageId=finalAgentTurnStart",
    ),
    "https://chatgpt.com/c/6a628f53-0450-83ea-94d9-c0626ccf2cdc",
  );
  assert.equal(
    normalizeProjectUrl("https://chatgpt.com/g/g-p-fixture-project/project/?source=sidebar#top"),
    "https://chatgpt.com/g/g-p-fixture-project/project",
  );
  assert.equal(
    normalizeConversationUrl(
      "https://chatgpt.com/g/g-p-fixture-project/c/6a628f53-0450-83ea-94d9-c0626ccf2cdc?messageId=latest",
    ),
    "https://chatgpt.com/g/g-p-fixture-project/c/6a628f53-0450-83ea-94d9-c0626ccf2cdc",
  );
  assert.equal(
    projectUrlFromConversationUrl(
      "https://chatgpt.com/g/g-p-fixture-project/c/6a628f53-0450-83ea-94d9-c0626ccf2cdc",
    ),
    "https://chatgpt.com/g/g-p-fixture-project/project",
  );
  assert.equal(
    projectUrlFromConversationUrl("https://chatgpt.com/c/6a628f53-0450-83ea-94d9-c0626ccf2cdc"),
    null,
  );
  assert.throws(() => normalizeConversationUrl("https://example.com/c/not-chatgpt"), /must be an/);
  assert.throws(
    () => normalizeProjectUrl("https://chatgpt.com/g/g-p-fixture-project/c/chat"),
    /Project URL/,
  );
});

test("finds only exact existing-chat titles and fails closed on ambiguity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-conversations-"));
  const browser = await launchFirefox({
    headless: true,
    profileDir: path.join(directory, "profile"),
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <a href="https://chatgpt.com/c/first-id"> Firefox compatibility   plan </a>
      <a href="https://chatgpt.com/c/second-id">Firefox compatibility planning</a>`);
    let candidates = await findConversationCandidates(page, "Firefox compatibility plan");
    assert.deepEqual(candidates, [
      {
        title: "Firefox compatibility plan",
        url: "https://chatgpt.com/c/first-id",
        projectUrl: null,
      },
    ]);
    assert.deepEqual(
      selectUniqueConversationCandidate(candidates, "Firefox compatibility plan"),
      candidates[0],
    );

    await page.evaluate(() => {
      const duplicate = document.createElement("a");
      duplicate.href = "https://chatgpt.com/c/duplicate-id";
      duplicate.textContent = "Firefox compatibility plan";
      document.body.appendChild(duplicate);
    });
    candidates = await findConversationCandidates(page, "Firefox compatibility plan");
    assert.throws(
      () => selectUniqueConversationCandidate(candidates, "Firefox compatibility plan"),
      /More than one ChatGPT conversation/,
    );
  } finally {
    await browser.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("discovers project names without fuzzy auto-selection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-projects-"));
  const browser = await launchFirefox({
    headless: true,
    profileDir: path.join(directory, "profile"),
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><ul>
      <li><button aria-label="Open project home"></button><button aria-label="Open project options for Firefox Work"></button></li>
      <li><button aria-label="Open project home"></button><button aria-label="Open project options for Firefox Personal"></button></li>
    </ul>`);
    assert.deepEqual(await findProjectCandidates(page, "firefox"), [
      { title: "Firefox Work" },
      { title: "Firefox Personal" },
    ]);
    const exact = await findProjectCandidates(page, " firefox   work ", { exact: true });
    assert.deepEqual(exact, [{ title: "Firefox Work" }]);
    assert.deepEqual(selectUniqueProjectCandidate(exact, "Firefox Work"), exact[0]);
    const ambiguous = await findProjectCandidates(page, "firefox");
    assert.throws(
      () => selectUniqueProjectCandidate(ambiguous, "firefox"),
      /More than one ChatGPT project/,
    );
  } finally {
    await browser.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("finds partial chat titles and scopes project conversations by project URL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-project-chats-"));
  const browser = await launchFirefox({
    headless: true,
    profileDir: path.join(directory, "profile"),
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <a href="https://chatgpt.com/c/standalone-id">Firefox standalone notes</a>
      <a href="https://chatgpt.com/g/g-p-work/c/work-id">Firefox compatibility plan</a>
      <a href="https://chatgpt.com/g/g-p-personal/c/personal-id">Firefox shopping</a>`);
    const all = await findConversationCandidatesByQuery(page, "firefox");
    assert.equal(all.length, 3);
    const scoped = await findConversationCandidatesByQuery(page, "firefox", {
      projectUrl: "https://chatgpt.com/g/g-p-work/project",
    });
    assert.deepEqual(scoped, [
      {
        title: "Firefox compatibility plan",
        url: "https://chatgpt.com/g/g-p-work/c/work-id",
        projectUrl: "https://chatgpt.com/g/g-p-work/project",
      },
    ]);
  } finally {
    await browser.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads every project conversation before scoped matching", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-project-pages-"));
  const browser = await launchFirefox({
    headless: true,
    profileDir: path.join(directory, "profile"),
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><section><ol id="project-chats">
      <li><a href="https://chatgpt.com/g/g-p-work/c/first-id">First project chat</a></li>
      <button id="more">Load more conversations</button>
    </ol></section>
    <script>
      more.addEventListener('click', () => {
        const item = document.createElement('li');
        item.innerHTML = '<a href="https://chatgpt.com/g/g-p-work/c/second-id">Compatibility archive</a>';
        document.getElementById('project-chats').insertBefore(item, more);
        more.remove();
      });
    </script>`);
    await expandProjectConversationList(page, { timeoutMs: 2_000 });
    assert.deepEqual(
      await findConversationCandidatesByQuery(page, "compatibility", {
        projectUrl: "https://chatgpt.com/g/g-p-work/project",
      }),
      [
        {
          title: "Compatibility archive",
          url: "https://chatgpt.com/g/g-p-work/c/second-id",
          projectUrl: "https://chatgpt.com/g/g-p-work/project",
        },
      ],
    );
  } finally {
    await browser.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses ChatGPT's history-search control instead of the project/file search control", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-chat-search-"));
  const browser = await launchFirefox({
    headless: true,
    profileDir: path.join(directory, "profile"),
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><nav>
      <button id="wrong-search">Search</button>
      <button id="chat-search" aria-label="Search"></button>
    </nav>
    <div id="search-dialog" role="dialog" hidden>
      <input id="chat-query" placeholder="Search...">
      <div id="results"></div>
    </div>
    <script>
      document.getElementById('wrong-search').addEventListener('click', () => {
        document.body.dataset.wrongSearchClicked = 'true';
      });
      document.getElementById('chat-search').addEventListener('click', () => {
        document.getElementById('search-dialog').hidden = false;
      });
      document.getElementById('chat-query').addEventListener('input', (event) => {
        if (!event.target.value.toLowerCase().includes('compat')) return;
        document.getElementById('results').innerHTML =
          '<a href="https://chatgpt.com/c/search-result-id">Firefox compatibility plan</a>';
      });
    </script>`);
    const result = await findChats(page, "compat", { timeoutMs: 3_000 });
    assert.equal(await page.evaluate(() => document.body.dataset.wrongSearchClicked), undefined);
    assert.deepEqual(result.conversations, [
      {
        title: "Firefox compatibility plan",
        url: "https://chatgpt.com/c/search-result-id",
        projectUrl: null,
      },
    ]);
  } finally {
    await browser.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
