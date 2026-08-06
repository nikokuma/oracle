import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  importChatGptCookies,
  parseFirefoxProfilesIni,
  readChatGptCookies,
} from "../src/profiles.mjs";

const execFileAsync = promisify(execFile);

test("parses Firefox profiles and honors the install default", () => {
  const profiles = parseFirefoxProfilesIni(
    `[Profile1]
Name=default
IsRelative=1
Path=Profiles/unused.default
Default=1

[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/live.default-release

[InstallABC]
Default=Profiles/live.default-release
Locked=1
`,
    { rootDirectory: "/tmp/firefox" },
  );
  assert.equal(profiles[0].name, "default-release");
  assert.equal(profiles[0].isDefault, true);
  assert.equal(profiles[0].path, "/tmp/firefox/Profiles/live.default-release");
});

test("imports only ChatGPT and OpenAI cookies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-profiles-"));
  const source = path.join(directory, "source");
  const destination = path.join(directory, "destination");
  await mkdir(source);
  await mkdir(destination);
  const schema = `
    CREATE TABLE moz_cookies (
      id INTEGER PRIMARY KEY,
      originAttributes TEXT NOT NULL DEFAULT '',
      name TEXT,
      value TEXT,
      host TEXT,
      path TEXT,
      expiry INTEGER,
      lastAccessed INTEGER,
      creationTime INTEGER,
      isSecure INTEGER,
      isHttpOnly INTEGER,
      inBrowserElement INTEGER,
      sameSite INTEGER,
      rawSameSite INTEGER,
      schemeMap INTEGER,
      CONSTRAINT moz_uniqueid UNIQUE (name, host, path, originAttributes)
    );
  `;
  try {
    await Promise.all([
      execFileAsync("/usr/bin/sqlite3", [path.join(source, "cookies.sqlite"), schema]),
      execFileAsync("/usr/bin/sqlite3", [path.join(destination, "cookies.sqlite"), schema]),
    ]);
    await execFileAsync("/usr/bin/sqlite3", [
      path.join(source, "cookies.sqlite"),
      `INSERT INTO moz_cookies (name,value,host,path) VALUES
        ('chat','secret-one','.chatgpt.com','/'),
        ('openai','secret-two','auth.openai.com','/'),
        ('google','do-not-copy','.google.com','/');`,
    ]);
    await execFileAsync("/usr/bin/sqlite3", [
      path.join(destination, "cookies.sqlite"),
      "INSERT INTO moz_cookies (name,value,host,path) VALUES ('old','stale','.chatgpt.com','/');",
    ]);

    const readable = await readChatGptCookies({
      sourceProfileDir: source,
      sqlitePath: "/usr/bin/sqlite3",
    });
    assert.deepEqual(readable.map((cookie) => `${cookie.domain}|${cookie.name}`).sort(), [
      ".chatgpt.com|chat",
      "auth.openai.com|openai",
    ]);

    const result = await importChatGptCookies({
      sourceProfileDir: source,
      destinationProfileDir: destination,
      sqlitePath: "/usr/bin/sqlite3",
    });
    assert.equal(result.importedCookieCount, 2);
    const { stdout } = await execFileAsync("/usr/bin/sqlite3", [
      path.join(destination, "cookies.sqlite"),
      "SELECT host || '|' || name FROM moz_cookies ORDER BY host;",
    ]);
    assert.deepEqual(stdout.trim().split("\n"), [".chatgpt.com|chat", "auth.openai.com|openai"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
