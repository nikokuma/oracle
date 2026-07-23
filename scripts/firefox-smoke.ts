import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import puppeteer, { type Browser } from "puppeteer-core";

const execFileAsync = promisify(execFile);

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveFirefoxPath(): Promise<string> {
  const explicit = process.env.ORACLE_BROWSER_PATH?.trim() || process.env.FIREFOX_PATH?.trim();
  const candidates = explicit
    ? [explicit]
    : process.platform === "darwin"
      ? [
          "/Applications/Firefox.app/Contents/MacOS/firefox",
          path.join(os.homedir(), "Applications", "Firefox.app", "Contents", "MacOS", "firefox"),
        ]
      : process.platform === "win32"
        ? [
            path.join(
              process.env.PROGRAMFILES || "C:\\Program Files",
              "Mozilla Firefox",
              "firefox.exe",
            ),
            path.join(
              process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
              "Mozilla Firefox",
              "firefox.exe",
            ),
          ]
        : ["/usr/bin/firefox", "/usr/local/bin/firefox", "/snap/bin/firefox"];

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw new Error(
    `Firefox executable not found. Tried: ${candidates.join(", ")}. Set ORACLE_BROWSER_PATH or FIREFOX_PATH.`,
  );
}

async function createFixtureServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/nested") {
      response.end("<!doctype html><p id=deep>nested-frame-ready</p>");
      return;
    }
    if (request.url === "/frame") {
      response.end("<!doctype html><p>outer-frame</p><iframe src=/nested></iframe>");
      return;
    }
    response.end(`<!doctype html>
      <meta charset="utf-8">
      <title>Oracle Firefox smoke</title>
      <button id="trusted">Trusted click</button>
      <output id="click-result">pending</output>
      <textarea id="keyboard"></textarea>
      <input id="upload" type="file">
      <output id="upload-result">pending</output>
      <button id="dialog">Dialog</button>
      <iframe src="/frame"></iframe>
      <script>
        trusted.addEventListener("click", (event) => {
          document.querySelector("#click-result").textContent = event.isTrusted ? "trusted" : "synthetic";
        });
        upload.addEventListener("change", () => {
          document.querySelector("#upload-result").textContent = upload.files?.[0]?.name || "missing";
        });
        dialog.addEventListener("click", () => alert("firefox-smoke-dialog"));
      </script>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server has no TCP address.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function waitForProcessExit(
  browserProcess: ReturnType<Browser["process"]>,
): Promise<boolean> {
  if (!browserProcess || browserProcess.exitCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5_000);
    browserProcess.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

const firefoxPath = await resolveFirefoxPath();
const [{ stdout: versionStdout, stderr: versionStderr }, fixture, temporaryDirectory] =
  await Promise.all([
    execFileAsync(firefoxPath, ["--version"], { timeout: 10_000 }),
    createFixtureServer(),
    mkdtemp(path.join(os.tmpdir(), "oracle-firefox-smoke-")),
  ]);
const profileDirectory = path.join(temporaryDirectory, "profile");
const uploadPath = path.join(temporaryDirectory, "firefox-smoke-upload.txt");
await writeFile(uploadPath, "Oracle Firefox upload fixture\n", { mode: 0o600 });

let browser: Browser | null = null;
let browserProcess: ReturnType<Browser["process"]> = null;
let cleanProcessExit = false;
try {
  browser = await puppeteer.launch({
    browser: "firefox",
    protocol: "webDriverBiDi",
    executablePath: firefoxPath,
    userDataDir: profileDirectory,
    headless: true,
    defaultViewport: { width: 1_280, height: 900 },
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  browserProcess = browser.process();
  const page = await browser.newPage();
  await page.goto(fixture.baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const evaluation = await page.evaluate(() => 1 + 1);

  const clickPoint = await page.$eval("#trusted", (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(clickPoint.x, clickPoint.y);
  const trustedClick = await page.$eval("#click-result", (element) => element.textContent);

  await page.click("#keyboard");
  await page.keyboard.type("Firefox 153 trusted keyboard input");
  const keyboardInput = await page.$eval(
    "#keyboard",
    (element) => (element as HTMLTextAreaElement).value,
  );

  const upload = await page.$("input#upload");
  if (!upload) throw new Error("Fixture file input was not found.");
  await upload.uploadFile(uploadPath);
  await page.waitForFunction(
    () => document.querySelector("#upload-result")?.textContent === "firefox-smoke-upload.txt",
  );
  const uploadedFile = await page.$eval("#upload-result", (element) => element.textContent);

  const context = browser.defaultBrowserContext();
  await context.setCookie({
    name: "oracle_firefox_smoke",
    value: "ok",
    domain: "127.0.0.1",
    path: "/",
    expires: Math.floor(Date.now() / 1_000) + 300,
  });
  const storedCookie = (await context.cookies()).find(
    (cookie) => cookie.name === "oracle_firefox_smoke" && cookie.value === "ok",
  );
  if (!storedCookie)
    throw new Error("Firefox did not return the cookie written by BrowserContext.");
  await context.deleteCookie(storedCookie);
  const cookieDeleted = !(await context.cookies()).some(
    (cookie) => cookie.name === "oracle_firefox_smoke",
  );

  await page.waitForFunction(() => window.frames.length > 0);
  const nestedFrame = page.frames().find((frame) => frame.url().endsWith("/nested"));
  if (!nestedFrame) throw new Error("Nested Firefox frame was not exposed through Puppeteer.");
  const nestedFrameText = await nestedFrame.$eval("#deep", (element) => element.textContent);

  let dialogMessage: string | null = null;
  page.once("dialog", async (dialog) => {
    dialogMessage = dialog.message();
    await dialog.accept();
  });
  await page.click("#dialog");
  await page.waitForFunction(() => document.hasFocus());

  const browserVersion = await browser.version();
  await browser.close();
  browser = null;
  cleanProcessExit = await waitForProcessExit(browserProcess);

  const result = {
    ok:
      evaluation === 2 &&
      trustedClick === "trusted" &&
      keyboardInput === "Firefox 153 trusted keyboard input" &&
      uploadedFile === "firefox-smoke-upload.txt" &&
      Boolean(storedCookie) &&
      cookieDeleted &&
      nestedFrameText === "nested-frame-ready" &&
      dialogMessage === "firefox-smoke-dialog" &&
      cleanProcessExit,
    firefoxPath,
    firefoxVersion: `${versionStdout}${versionStderr}`.trim(),
    puppeteerBrowserVersion: browserVersion,
    transport: "webdriver-bidi",
    checks: {
      navigation: true,
      evaluation,
      trustedClick,
      keyboardInput,
      uploadedFile,
      cookieSetReadDelete: Boolean(storedCookie) && cookieDeleted,
      nestedFrameText,
      dialogMessage,
      cleanProcessExit,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await fixture.close().catch(() => undefined);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
