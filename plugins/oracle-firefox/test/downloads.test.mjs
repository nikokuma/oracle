import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  downloadAssistantArtifact,
  listAssistantDownloadCandidates,
  normalizeChatGptDownloadSource,
  publicDownloadCandidates,
  selectAssistantDownloadCandidate,
} from "../src/downloads.mjs";
import { launchFirefox } from "../src/firefox.mjs";

async function withPage(html, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-download-page-"));
  const browser = await launchFirefox({ headless: true, profileDir: path.join(directory, "profile") });
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.setContent(html);
    return await callback(page, directory);
  } finally {
    await browser.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

test("accepts only known ChatGPT file endpoints and safe sandbox paths", () => {
  assert.deepEqual(normalizeChatGptDownloadSource("sandbox:/mnt/data/Nono%20Inputs.zip"), {
    downloadUrl: "https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2FNono+Inputs.zip",
    sourceKind: "sandbox",
    sourceFilename: "Nono Inputs.zip",
  });
  assert.equal(
    normalizeChatGptDownloadSource("https://chatgpt.com/backend-api/files/file_123/download?token=secret")?.sourceKind,
    "chatgpt-file-endpoint",
  );
  assert.equal(normalizeChatGptDownloadSource("sandbox:/mnt/data/../private.txt"), null);
  assert.equal(normalizeChatGptDownloadSource("https://example.com/file.zip"), null);
  assert.equal(normalizeChatGptDownloadSource("https://chatgpt.com/account"), null);
  assert.equal(normalizeChatGptDownloadSource("blob:https://chatgpt.com/private"), null);
});

test("lists only safe links from the last assistant turn without exposing signed URLs", async () => {
  await withPage(`<!doctype html><main>
    <article data-testid="conversation-turn-1" data-message-author-role="assistant" data-message-id="old-assistant">
      <a href="sandbox:/mnt/data/old.zip">Old file</a>
    </article>
    <article data-testid="conversation-turn-2" data-message-author-role="user" data-message-id="user"><div>request</div></article>
    <article data-testid="conversation-turn-3" data-message-author-role="assistant" data-message-id="last-assistant">
      <a href="https://example.com/tracker">External</a>
      <a href="sandbox:/mnt/data/Nono%20Messages.zip">Download the Codex-ready Nono Messages inputs</a>
    </article>
  </main>`, async (page) => {
    const candidates = await listAssistantDownloadCandidates(page);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].label, "Download the Codex-ready Nono Messages inputs");
    assert.equal(candidates[0].filename, "Nono Messages.zip");
    assert.equal(candidates[0].assistantTurnId, "last-assistant");
    const exposed = publicDownloadCandidates(candidates);
    assert.equal("downloadUrl" in exposed[0], false);
    assert.equal("rawHref" in exposed[0], false);
    assert.equal(selectAssistantDownloadCandidate(candidates, " download  the codex-ready nono messages inputs ").linkId, candidates[0].linkId);
  });
});

test("fails closed when exact download link text is duplicated", async () => {
  await withPage(`<!doctype html><main>
    <article data-testid="conversation-turn-1" data-message-author-role="assistant" data-message-id="assistant">
      <a href="sandbox:/mnt/data/A.zip">Download bundle</a>
      <a href="sandbox:/mnt/data/B.zip">Download bundle</a>
    </article>
  </main>`, async (page) => {
    const candidates = await listAssistantDownloadCandidates(page);
    assert.throws(
      () => selectAssistantDownloadCandidate(candidates, "Download bundle"),
      (error) => error.code === "DOWNLOAD_LINK_AMBIGUOUS",
    );
  });
});

test("discovers a ChatGPT file URL carried by a button-shaped file control", async () => {
  await withPage(`<!doctype html><main>
    <article data-testid="conversation-turn-1" data-message-author-role="assistant" data-message-id="assistant">
      <button data-download-url="https://chatgpt.com/backend-api/files/file_123/download?token=private">Download generated bundle</button>
    </article>
  </main>`, async (page) => {
    const candidates = await listAssistantDownloadCandidates(page);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].label, "Download generated bundle");
    assert.equal("downloadUrl" in publicDownloadCandidates(candidates)[0], false);
  });
});

test("lists a behavior-only download button without exposing an invented URL", async () => {
  await withPage(`<!doctype html><main>
    <article data-testid="conversation-turn-1" data-message-author-role="assistant" data-message-id="assistant">
      <button>Download the Codex-ready Nono Messages inputs</button>
    </article>
  </main>`, async (page) => {
    const exposed = publicDownloadCandidates(await listAssistantDownloadCandidates(page));
    assert.equal(exposed.length, 1);
    assert.equal(exposed[0].sourceKind, "browser-download");
    assert.equal(exposed[0].linkText, "Download the Codex-ready Nono Messages inputs");
  });
});

test("captures one behavior-only Firefox download into a private unique directory", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-download-"));
  const profile = path.join(directory, "profile");
  const staging = path.join(directory, "staging");
  const output = path.join(directory, "output");
  await mkdir(staging, { recursive: true });
  const browser = await launchFirefox({ headless: true, profileDir: profile, downloadPath: staging });
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.setContent(`<!doctype html><main>
      <article data-testid="conversation-turn-1" data-message-author-role="assistant" data-message-id="assistant">
        <button onclick="const a=document.createElement('a');a.href='data:text/plain,behavior-download-ok';a.download='behavior.txt';a.click()">Download behavior artifact</button>
      </article>
    </main>`);
    const result = await downloadAssistantArtifact(page, {
      linkText: "Download behavior artifact",
      rootDirectory: output,
      stagingDirectory: staging,
      maxBytes: 1_000,
    });
    assert.equal(result.sourceKind, "browser-download");
    assert.equal(result.filename, "behavior.txt");
    assert.equal((await readFile(result.path, "utf8")), "behavior-download-ok");
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  } finally {
    await browser.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloads one authenticated artifact atomically with size, hash, and ZIP validation", async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-download-output-"));
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x66, 0x69, 0x78, 0x74, 0x75, 0x72, 0x65]);
  try {
    await withPage(`<!doctype html><main>
      <article data-testid="conversation-turn-1" data-message-author-role="assistant" data-message-id="assistant">
        <a href="sandbox:/mnt/data/source.zip">Download the Codex-ready Nono Messages inputs</a>
      </article>
    </main>`, async (page) => {
      await page.setCookie({ name: "fixture_session", value: "private", url: "https://chatgpt.com" });
      let request = null;
      const result = await downloadAssistantArtifact(page, {
        linkText: "Download the Codex-ready Nono Messages inputs",
        rootDirectory: outputRoot,
        maxBytes: 1_000,
        fetchImpl: async (url, options) => {
          request = { url: String(url), cookie: options.headers.cookie };
          return new Response(zip, {
            status: 200,
            headers: {
              "content-type": "application/zip",
              "content-length": String(zip.length),
              "content-disposition": "attachment; filename*=UTF-8''Codex-ready%20Nono%20Messages.zip",
            },
          });
        },
      });
      assert.match(request.url, /^https:\/\/chatgpt\.com\/backend-api\/sandbox\/download/u);
      assert.match(request.cookie, /fixture_session=private/u);
      assert.equal(result.filename, "Codex-ready Nono Messages.zip");
      assert.equal(result.sizeBytes, zip.length);
      assert.equal(result.sha256, createHash("sha256").update(zip).digest("hex"));
      assert.deepEqual(await readFile(result.path), zip);
      assert.equal((await stat(result.path)).mode & 0o777, 0o600);
      assert.equal(path.resolve(result.path).startsWith(`${path.resolve(outputRoot)}${path.sep}`), true);
    });
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("rejects oversized responses before writing an artifact", async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-download-oversize-"));
  try {
    await withPage(`<!doctype html><main><article data-testid="conversation-turn-1" data-message-author-role="assistant">
      <a href="sandbox:/mnt/data/large.zip">Download large</a>
    </article></main>`, async (page) => {
      await page.setCookie({ name: "fixture_session", value: "private", url: "https://chatgpt.com" });
      await assert.rejects(
        () => downloadAssistantArtifact(page, {
          linkText: "Download large",
          rootDirectory: outputRoot,
          maxBytes: 4,
          fetchImpl: async () => new Response(Buffer.from("too large"), {
            status: 200,
            headers: { "content-type": "application/zip", "content-length": "9" },
          }),
        }),
        (error) => error.code === "DOWNLOAD_TOO_LARGE",
      );
    });
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
