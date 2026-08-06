import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CHATGPT_COOKIE_PREDICATE = `(
  lower(host) = 'chatgpt.com' OR lower(host) LIKE '%.chatgpt.com' OR
  lower(host) = 'openai.com' OR lower(host) LIKE '%.openai.com'
)`;

function defaultFirefoxRoot() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Firefox");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    return path.join(appData || path.join(os.homedir(), "AppData", "Roaming"), "Mozilla", "Firefox");
  }
  return path.join(os.homedir(), ".mozilla", "firefox");
}

export function firefoxProfilesIniPath() {
  const configured = process.env.ORACLE_FIREFOX_PROFILES_INI?.trim();
  return configured ? path.resolve(configured) : path.join(defaultFirefoxRoot(), "profiles.ini");
}

function parseIniSections(contents) {
  const sections = [];
  let current = null;
  for (const rawLine of String(contents).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\n]+)\]$/u);
    if (sectionMatch) {
      current = { section: sectionMatch[1], values: {} };
      sections.push(current);
      continue;
    }
    const separator = line.indexOf("=");
    if (!current || separator < 1) continue;
    current.values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return sections;
}

export function parseFirefoxProfilesIni(contents, { rootDirectory } = {}) {
  const root = path.resolve(rootDirectory || path.dirname(firefoxProfilesIniPath()));
  const sections = parseIniSections(contents);
  const installDefaults = new Set(
    sections
      .filter(({ section }) => section.startsWith("Install"))
      .map(({ values }) => values.Default)
      .filter(Boolean)
      .map((value) => path.normalize(value)),
  );

  return sections
    .filter(({ section }) => /^Profile\d+$/u.test(section))
    .map(({ section, values }) => {
      const configuredPath = values.Path;
      if (!configuredPath) return null;
      const profilePath =
        values.IsRelative === "0" ? path.resolve(configuredPath) : path.resolve(root, configuredPath);
      return {
        section,
        name: values.Name || path.basename(profilePath),
        path: profilePath,
        isDefault:
          installDefaults.size > 0
            ? installDefaults.has(path.normalize(configuredPath))
            : values.Default === "1",
      };
    })
    .filter(Boolean)
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
}

async function pathExists(candidate) {
  try {
    await access(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveSqlitePath() {
  const configured = process.env.ORACLE_FIREFOX_SQLITE_PATH?.trim();
  const candidates = configured
    ? [configured]
    : process.platform === "win32"
      ? ["sqlite3.exe"]
      : ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3", "sqlite3"];
  for (const candidate of candidates) {
    try {
      if (candidate.includes(path.sep)) await access(candidate, fsConstants.X_OK);
      else await execFileAsync(candidate, ["--version"], { timeout: 5_000 });
      return candidate;
    } catch {
      // Try the next known location.
    }
  }
  throw new Error(
    "The sqlite3 command is required to import Firefox session cookies but was not found. Set ORACLE_FIREFOX_SQLITE_PATH and retry.",
  );
}

async function runSqlite(databasePath, sql, { sqlitePath } = {}) {
  const executable = sqlitePath || (await resolveSqlitePath());
  const { stdout } = await execFileAsync(executable, [databasePath, sql], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function relevantCookieCount(cookiesPath, options = {}) {
  if (!(await pathExists(cookiesPath))) return 0;
  try {
    const output = await runSqlite(
      cookiesPath,
      `SELECT count(*) FROM moz_cookies WHERE ${CHATGPT_COOKIE_PREDICATE};`,
      options,
    );
    return Number.parseInt(output, 10) || 0;
  } catch {
    return null;
  }
}

export async function discoverFirefoxProfiles({ profilesIniPath = firefoxProfilesIniPath() } = {}) {
  let contents;
  try {
    contents = await readFile(profilesIniPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const profiles = parseFirefoxProfilesIni(contents, {
    rootDirectory: path.dirname(profilesIniPath),
  });
  return Promise.all(
    profiles.map(async (profile) => {
      const cookiesPath = path.join(profile.path, "cookies.sqlite");
      return {
        ...profile,
        exists: await pathExists(profile.path),
        active: await isFirefoxProfileActive(profile.path),
        chatGptCookieCount: await relevantCookieCount(cookiesPath),
      };
    }),
  );
}

export async function resolveFirefoxProfile(selector, options = {}) {
  const profiles = await discoverFirefoxProfiles(options);
  if (!profiles.length) {
    throw new Error(`No Firefox profiles were found in ${options.profilesIniPath || firefoxProfilesIniPath()}.`);
  }
  if (!selector) {
    return (
      profiles.find((profile) => profile.isDefault && profile.chatGptCookieCount > 0) ||
      profiles.find((profile) => profile.chatGptCookieCount > 0) ||
      profiles.find((profile) => profile.isDefault) ||
      profiles[0]
    );
  }
  const absoluteSelector = path.isAbsolute(selector) ? path.resolve(selector) : null;
  const selected = profiles.find(
    (profile) =>
      profile.name === selector ||
      path.basename(profile.path) === selector ||
      (absoluteSelector && profile.path === absoluteSelector),
  );
  if (selected) return selected;
  if (absoluteSelector && (await pathExists(absoluteSelector))) {
    return {
      section: null,
      name: path.basename(absoluteSelector),
      path: absoluteSelector,
      isDefault: false,
      exists: true,
      active: await isFirefoxProfileActive(absoluteSelector),
      chatGptCookieCount: await relevantCookieCount(path.join(absoluteSelector, "cookies.sqlite")),
    };
  }
  throw new Error(
    `Firefox profile ${JSON.stringify(selector)} was not found. Available profiles: ${profiles.map((profile) => profile.name).join(", ")}.`,
  );
}

export async function isFirefoxProfileActive(profilePath) {
  const resolved = path.resolve(profilePath);
  if (process.platform === "win32") {
    const lockCandidates = ["parent.lock", ".parentlock", "lock"];
    return (
      await Promise.all(lockCandidates.map((name) => pathExists(path.join(resolved, name))))
    ).some(Boolean);
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "command="], {
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout
      .split(/\r?\n/u)
      .some((command) => command.toLowerCase().includes("firefox") && command.includes(resolved));
  } catch {
    return false;
  }
}

function quoteSqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function tableColumns(databasePath, options = {}) {
  const output = await runSqlite(databasePath, "PRAGMA table_info(moz_cookies);", options);
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.split("|")[1])
    .filter(Boolean);
}

export async function importChatGptCookies({
  sourceProfileDir,
  destinationProfileDir,
  sqlitePath,
} = {}) {
  const source = path.resolve(sourceProfileDir);
  const destination = path.resolve(destinationProfileDir);
  if (source === destination) throw new Error("Source and destination Firefox profiles must differ.");
  if (await isFirefoxProfileActive(source)) {
    throw new Error(
      `The source Firefox profile is still open. Quit normal Firefox temporarily so its cookie database can be copied consistently, then retry: ${source}`,
    );
  }
  if (await isFirefoxProfileActive(destination)) {
    throw new Error(
      `The dedicated Oracle Firefox window is still open. Close the Firefox window using ${destination}, then retry the session import.`,
    );
  }

  const sourceCookies = path.join(source, "cookies.sqlite");
  const destinationCookies = path.join(destination, "cookies.sqlite");
  if (!(await pathExists(sourceCookies))) {
    throw new Error(`The source Firefox profile has no cookies database: ${sourceCookies}`);
  }
  if (!(await pathExists(destinationCookies))) {
    throw new Error(
      `The dedicated Firefox profile is not initialized yet: ${destinationCookies}. Initialize it before importing a session.`,
    );
  }

  const executable = sqlitePath || (await resolveSqlitePath());
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-cookie-import-"));
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  const snapshotPath = path.join(temporaryDirectory, "source-cookies.sqlite");
  try {
    await runSqlite(sourceCookies, `.backup ${quoteSqlString(snapshotPath)}`, {
      sqlitePath: executable,
    });
    const sourceColumns = await tableColumns(snapshotPath, { sqlitePath: executable });
    const destinationColumns = await tableColumns(destinationCookies, { sqlitePath: executable });
    const sourceColumnSet = new Set(sourceColumns);
    const columns = destinationColumns.filter(
      (column) => column !== "id" && sourceColumnSet.has(column),
    );
    if (!columns.includes("host") || !columns.includes("name") || !columns.includes("value")) {
      throw new Error("The Firefox cookie database schema is not compatible with session import.");
    }
    const columnList = columns.map(quoteIdentifier).join(", ");
    const sql = `
      ATTACH DATABASE ${quoteSqlString(snapshotPath)} AS source;
      BEGIN IMMEDIATE;
      DELETE FROM main.moz_cookies WHERE ${CHATGPT_COOKIE_PREDICATE};
      INSERT OR REPLACE INTO main.moz_cookies (${columnList})
        SELECT ${columnList} FROM source.moz_cookies WHERE ${CHATGPT_COOKIE_PREDICATE};
      COMMIT;
      DETACH DATABASE source;
    `;
    await runSqlite(destinationCookies, sql, { sqlitePath: executable });
    return {
      importedCookieCount: await relevantCookieCount(destinationCookies, {
        sqlitePath: executable,
      }),
      domains: ["chatgpt.com", "openai.com"],
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function readChatGptCookies({ sourceProfileDir, sqlitePath } = {}) {
  const source = path.resolve(sourceProfileDir);
  if (await isFirefoxProfileActive(source)) {
    throw new Error(
      `The source Firefox profile is still open. Quit normal Firefox temporarily so its cookie database can be snapshotted consistently, then retry: ${source}`,
    );
  }
  const sourceCookies = path.join(source, "cookies.sqlite");
  if (!(await pathExists(sourceCookies))) {
    throw new Error(`The source Firefox profile has no cookies database: ${sourceCookies}`);
  }
  const executable = sqlitePath || (await resolveSqlitePath());
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-cookie-read-"));
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  const snapshotPath = path.join(temporaryDirectory, "source-cookies.sqlite");
  try {
    await runSqlite(sourceCookies, `.backup ${quoteSqlString(snapshotPath)}`, { sqlitePath: executable });
    const columns = new Set(await tableColumns(snapshotPath, { sqlitePath: executable }));
    for (const required of ["host", "name", "value", "path"]) {
      if (!columns.has(required)) throw new Error("The Firefox cookie database schema is not compatible with browser session import.");
    }
    const field = (name, fallback) => columns.has(name) ? quoteIdentifier(name) : fallback;
    const originFilter = columns.has("originAttributes") ? "AND originAttributes = ''" : "";
    const query = `
      SELECT json_group_array(json_object(
        'domain', host,
        'name', name,
        'value', value,
        'path', path,
        'expires', ${field("expiry", "0")},
        'secure', ${field("isSecure", "0")},
        'httpOnly', ${field("isHttpOnly", "0")},
        'sameSite', ${field("sameSite", "0")}
      ))
      FROM moz_cookies
      WHERE ${CHATGPT_COOKIE_PREDICATE} ${originFilter};
    `;
    const raw = await runSqlite(snapshotPath, query, { sqlitePath: executable });
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) throw new Error("Firefox returned an invalid cookie snapshot.");
    return parsed.slice(0, 500).map((cookie) => ({
      domain: String(cookie.domain || ""),
      name: String(cookie.name || ""),
      value: String(cookie.value || ""),
      path: String(cookie.path || "/") || "/",
      expires: Number(cookie.expires) || undefined,
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: Number(cookie.sameSite) === 2 ? "Strict" : Number(cookie.sameSite) === 1 ? "Lax" : "None",
    })).filter((cookie) => cookie.domain && cookie.name);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function directoryExists(candidate) {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}
