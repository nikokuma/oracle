import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { bundleContext } from "./bundle.mjs";
import { profileDirectory } from "./config.mjs";
import {
  assistantSnapshot,
  doctor,
  insertComposerText,
  launchFirefox,
  openChatGpt,
  openExistingConversation,
  probeLogin,
  setupLogin,
  submitComposer,
  uploadContextFile,
  waitForAssistant,
  waitForComposer,
  waitForUserMessage,
} from "./firefox.mjs";
import {
  discoverFirefoxProfiles,
  importChatGptCookies,
  isFirefoxProfileActive,
  resolveFirefoxProfile,
} from "./profiles.mjs";
import { createSession, writeSessionFile } from "./sessions.mjs";

export { doctor, setupLogin };

async function ensureDedicatedProfileInitialized() {
  const cookiesPath = path.join(profileDirectory(), "cookies.sqlite");
  try {
    await access(cookiesPath);
    return;
  } catch {
    // A brief headless launch creates Firefox's profile databases without opening a login flow.
  }
  const browser = await launchFirefox({ headless: true });
  await browser.close().catch(() => undefined);
  try {
    await access(cookiesPath);
  } catch {
    throw new Error(`Firefox did not initialize the dedicated cookie database at ${cookiesPath}.`);
  }
}

export async function listFirefoxProfiles() {
  return discoverFirefoxProfiles();
}

export async function importFirefoxSession({ sourceProfile, confirmImport = false } = {}) {
  if (confirmImport !== true) {
    throw new Error(
      "Session import requires explicit confirmation because it copies ChatGPT/OpenAI cookies. Retry with confirmImport: true after the user approves.",
    );
  }
  const destination = profileDirectory();
  if (await isFirefoxProfileActive(destination)) {
    throw new Error(
      `The dedicated Oracle Firefox window is still open. Close the Firefox window using ${destination}, then retry the session import.`,
    );
  }
  await ensureDedicatedProfileInitialized();
  const source = await resolveFirefoxProfile(sourceProfile);
  if (source.chatGptCookieCount === 0) {
    throw new Error(
      `Firefox profile ${source.name} has no ChatGPT/OpenAI cookies. Open chatgpt.com in normal Firefox, confirm you are signed in, then retry.`,
    );
  }
  const imported = await importChatGptCookies({
    sourceProfileDir: source.path,
    destinationProfileDir: destination,
  });
  return {
    imported: imported.importedCookieCount > 0,
    importedCookieCount: imported.importedCookieCount,
    domains: imported.domains,
    sourceProfile: { name: source.name, path: source.path },
    destinationProfile: destination,
  };
}

function resolveDelivery(requested, bundle) {
  if (requested === "inline" || requested === "attachment") return requested;
  return bundle.included.length > 0 && bundle.characterCount > 25_000 ? "attachment" : "inline";
}

function cleanAssistantText(text) {
  return String(text ?? "")
    .replace(/^ChatGPT said:\s*/i, "")
    .trim();
}

export async function consult({
  prompt,
  files = [],
  cwd,
  delivery = "auto",
  timeoutMs = 600_000,
  headless = false,
} = {}) {
  const context = await bundleContext({ prompt, files, cwd });
  const selectedDelivery = resolveDelivery(delivery, context);
  const session = await createSession(prompt);
  const requestPath = await writeSessionFile(session, "request.md", context.bundle);
  let attachmentPath = null;
  let browser = null;
  const startedAt = new Date().toISOString();

  try {
    browser = await launchFirefox({ headless });
    const page = await openChatGpt(browser);
    const login = await probeLogin(page);
    if (!login.authenticated) {
      throw new Error(
        "The dedicated Firefox profile is not signed into ChatGPT. Run oracle_firefox_setup once, finish login in the opened Firefox window, then retry.",
      );
    }
    await waitForComposer(page);
    const baseline = await assistantSnapshot(page);
    let composerPrompt = context.bundle;
    if (selectedDelivery === "attachment") {
      attachmentPath = path.join(session.directory, "oracle-context.md");
      await writeFile(attachmentPath, context.bundle, { mode: 0o600 });
      await uploadContextFile(page, attachmentPath);
      composerPrompt = [
        "Read the attached oracle-context.md before answering.",
        "Follow the [USER] request in that file and use its line-numbered source context.",
        "Return only the substantive answer.",
      ].join("\n");
    }
    const insertedCharacters = await insertComposerText(page, composerPrompt);
    const submitMethod = await submitComposer(page);
    const response = await waitForAssistant(page, baseline.count, { timeoutMs });
    const answer = cleanAssistantText(response.text);
    const responsePath = await writeSessionFile(session, "response.md", answer);
    const metadata = {
      id: session.id,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "completed",
      conversationUrl: response.url,
      delivery: selectedDelivery,
      insertedCharacters,
      submitMethod,
      requestPath,
      responsePath,
      attachmentPath,
      includedFiles: context.included.map((entry) => entry.displayPath),
      skippedBinaryFiles: context.skippedBinary,
      bundleCharacters: context.characterCount,
    };
    await writeSessionFile(session, "metadata.json", `${JSON.stringify(metadata, null, 2)}\n`);
    return { ...metadata, answer };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeSessionFile(
      session,
      "metadata.json",
      `${JSON.stringify(
        {
          id: session.id,
          startedAt,
          completedAt: new Date().toISOString(),
          status: "failed",
          error: message,
          requestPath,
          delivery: selectedDelivery,
          includedFiles: context.included.map((entry) => entry.displayPath),
          bundleCharacters: context.characterCount,
        },
        null,
        2,
      )}\n`,
    );
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export async function continueChat({
  chatTitle,
  conversationUrl,
  prompt,
  timeoutMs = 600_000,
  headless = false,
} = {}) {
  if (!String(prompt ?? "").trim()) throw new Error("A non-empty prompt is required.");
  if (!String(chatTitle ?? "").trim() && !String(conversationUrl ?? "").trim()) {
    throw new Error("Provide an exact chatTitle or conversationUrl.");
  }
  const session = await createSession(`Continue ${chatTitle || conversationUrl}: ${prompt}`);
  const requestPath = await writeSessionFile(session, "request.md", `${String(prompt).trim()}\n`);
  const startedAt = new Date().toISOString();
  let browser = null;
  let target = null;
  try {
    browser = await launchFirefox({ headless });
    const page = await openChatGpt(browser);
    const login = await probeLogin(page);
    if (!login.authenticated) {
      throw new Error(
        "The dedicated Firefox profile is not signed into ChatGPT. Import or set up the session, then retry.",
      );
    }
    target = await openExistingConversation(page, { title: chatTitle, conversationUrl });
    const baseline = await assistantSnapshot(page);
    const insertedCharacters = await insertComposerText(page, String(prompt).trim());
    const submitMethod = await submitComposer(page);
    await waitForUserMessage(page, baseline.userCount, String(prompt).trim(), { timeoutMs: 30_000 });
    const response = await waitForAssistant(page, baseline.count, { timeoutMs });
    const answer = cleanAssistantText(response.text);
    const responsePath = await writeSessionFile(session, "response.md", answer);
    const metadata = {
      id: session.id,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "completed",
      mode: "continue-chat",
      targetTitle: target.title || chatTitle || null,
      conversationUrl: response.url,
      insertedCharacters,
      submitMethod,
      requestPath,
      responsePath,
    };
    await writeSessionFile(session, "metadata.json", `${JSON.stringify(metadata, null, 2)}\n`);
    return { ...metadata, answer };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeSessionFile(
      session,
      "metadata.json",
      `${JSON.stringify(
        {
          id: session.id,
          startedAt,
          completedAt: new Date().toISOString(),
          status: "failed",
          mode: "continue-chat",
          targetTitle: target?.title || chatTitle || null,
          conversationUrl: target?.url || conversationUrl || null,
          error: message,
          requestPath,
        },
        null,
        2,
      )}\n`,
    );
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
