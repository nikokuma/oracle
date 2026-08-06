import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { importSessionIntoManagedBrowser } from "../src/workflow.mjs";

const execFileAsync = promisify(execFile);

test("explicit import injects only ChatGPT/OpenAI cookies into a managed Safari session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-managed-cookie-import-"));
  const profile = path.join(directory, "source-profile");
  const profilesIni = path.join(directory, "profiles.ini");
  const previousProfilesIni = process.env.ORACLE_FIREFOX_PROFILES_INI;
  await mkdir(profile);
  await writeFile(profilesIni, `[Profile0]\nName=source\nIsRelative=0\nPath=${profile}\nDefault=1\n`);
  const schema = `
    CREATE TABLE moz_cookies (
      id INTEGER PRIMARY KEY,
      originAttributes TEXT NOT NULL DEFAULT '',
      name TEXT,
      value TEXT,
      host TEXT,
      path TEXT,
      expiry INTEGER,
      isSecure INTEGER,
      isHttpOnly INTEGER,
      sameSite INTEGER
    );
    INSERT INTO moz_cookies (name,value,host,path,expiry,isSecure,isHttpOnly,sameSite) VALUES
      ('session','private-chatgpt-value','.chatgpt.com','/',2000000000,1,1,1),
      ('auth','private-openai-value','auth.openai.com','/',2000000000,1,1,2),
      ('unrelated','must-not-import','.google.com','/',2000000000,1,1,1);
  `;
  await execFileAsync("/usr/bin/sqlite3", [path.join(profile, "cookies.sqlite"), schema]);
  process.env.ORACLE_FIREFOX_PROFILES_INI = profilesIni;
  let currentUrl = "about:blank";
  const injected = [];
  const page = {
    setDefaultTimeout() {},
    url() { return currentUrl; },
    async goto(url) { currentUrl = url; },
    async bringToFront() {},
    async setCookie(cookie) { injected.push(cookie); },
    async evaluate() {
      return {
        authenticated: true,
        sessionAuthenticated: true,
        composerVisible: true,
        accountSignal: true,
        loginCta: false,
        cloudflare: false,
        url: currentUrl,
      };
    },
  };
  const browser = { pages: async () => [page], newPage: async () => page };
  try {
    const result = await importSessionIntoManagedBrowser({
      browser,
      browserName: "safari",
      sourceProfile: "source",
      confirmImport: true,
    });
    assert.equal(result.authenticated, true);
    assert.equal(result.importedCookieCount, 2);
    assert.equal(result.authenticationPersistence, "automation-session-only");
    assert.deepEqual(injected.map((cookie) => cookie.domain).sort(), [".chatgpt.com", "auth.openai.com"]);
    assert.equal(JSON.stringify(result).includes("private-chatgpt-value"), false);
    assert.equal(JSON.stringify(result).includes("private-openai-value"), false);
  } finally {
    if (previousProfilesIni === undefined) delete process.env.ORACLE_FIREFOX_PROFILES_INI;
    else process.env.ORACLE_FIREFOX_PROFILES_INI = previousProfilesIni;
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed browser import requires explicit confirmation before reading cookies", async () => {
  await assert.rejects(
    () => importSessionIntoManagedBrowser({ browserName: "safari", confirmImport: false }),
    (error) => error.code === "IMPORT_CONFIRMATION_REQUIRED",
  );
});
