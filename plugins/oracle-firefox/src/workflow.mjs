import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { bundleContext } from "./bundle.mjs";
import { profileDirectory } from "./config.mjs";
import {
  assistantSnapshot,
  doctor,
  findChats,
  insertComposerText,
  launchFirefox,
  listProjects,
  normalizeConversationTitle,
  normalizeConversationUrl,
  normalizeProjectTitle,
  openChatGpt,
  openExistingConversation,
  openProject,
  probeLogin,
  projectUrlFromConversationUrl,
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

function assertProjectSelector(projectTitle, projectUrl) {
  if (normalizeProjectTitle(projectTitle) && projectUrl) {
    throw new Error("Provide either projectTitle or projectUrl, not both.");
  }
}

async function requireAuthenticatedPage(browser) {
  const page = await openChatGpt(browser);
  const login = await probeLogin(page);
  if (!login.authenticated) {
    throw new Error(
      "The dedicated Firefox profile is not signed into ChatGPT. Import or set up the session, then retry.",
    );
  }
  return page;
}

export async function listChatGptProjects({ query = "", headless = false } = {}) {
  let browser = null;
  try {
    browser = await launchFirefox({ headless });
    const page = await requireAuthenticatedPage(browser);
    const normalizedQuery = normalizeProjectTitle(query);
    const projects = await listProjects(page, normalizedQuery);
    return { query: normalizedQuery || null, projects };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export async function findChatGptConversations({
  query,
  projectTitle,
  projectUrl,
  timeoutMs = 15_000,
  headless = false,
} = {}) {
  const normalizedQuery = normalizeConversationTitle(query);
  if (!normalizedQuery) throw new Error("A non-empty chat search query is required.");
  assertProjectSelector(projectTitle, projectUrl);
  let browser = null;
  try {
    browser = await launchFirefox({ headless });
    const page = await requireAuthenticatedPage(browser);
    const result = await findChats(page, normalizedQuery, {
      projectTitle,
      projectUrl,
      timeoutMs,
    });
    return {
      query: result.query,
      projectTitle: result.project?.title || null,
      projectUrl: result.project?.url || null,
      chats: result.conversations.map((conversation) => ({
        chatTitle: conversation.title,
        conversationUrl: conversation.url,
        projectUrl: conversation.projectUrl,
      })),
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export async function consult({
  prompt,
  files = [],
  cwd,
  delivery = "auto",
  projectTitle,
  projectUrl,
  timeoutMs = 600_000,
  headless = false,
} = {}) {
  assertProjectSelector(projectTitle, projectUrl);
  const context = await bundleContext({ prompt, files, cwd });
  const selectedDelivery = resolveDelivery(delivery, context);
  const session = await createSession(prompt);
  const requestPath = await writeSessionFile(session, "request.md", context.bundle);
  let attachmentPath = null;
  let browser = null;
  let project = null;
  const startedAt = new Date().toISOString();

  try {
    browser = await launchFirefox({ headless });
    const page = await requireAuthenticatedPage(browser);
    if (normalizeProjectTitle(projectTitle) || projectUrl) {
      project = await openProject(page, { title: projectTitle, projectUrl });
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
    const conversationUrl = normalizeConversationUrl(response.url);
    const resultingProjectUrl = projectUrlFromConversationUrl(conversationUrl);
    if (project?.url && resultingProjectUrl !== project.url) {
      throw new Error("The new conversation was not created inside the requested project.");
    }
    if (!project && resultingProjectUrl) {
      throw new Error("The standalone consultation unexpectedly opened inside a ChatGPT project.");
    }
    const answer = cleanAssistantText(response.text);
    const responsePath = await writeSessionFile(session, "response.md", answer);
    const metadata = {
      id: session.id,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "completed",
      mode: "new-chat",
      projectTitle: project?.title || null,
      projectUrl: project?.url || null,
      conversationUrl,
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
          mode: "new-chat",
          projectTitle: project?.title || normalizeProjectTitle(projectTitle) || null,
          projectUrl: project?.url || projectUrl || null,
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
  projectTitle,
  projectUrl,
  prompt,
  timeoutMs = 600_000,
  headless = false,
} = {}) {
  if (!String(prompt ?? "").trim()) throw new Error("A non-empty prompt is required.");
  if (!String(chatTitle ?? "").trim() && !String(conversationUrl ?? "").trim()) {
    throw new Error("Provide an exact chatTitle or conversationUrl.");
  }
  assertProjectSelector(projectTitle, projectUrl);
  if (conversationUrl && (normalizeProjectTitle(projectTitle) || projectUrl)) {
    throw new Error(
      "A conversationUrl already identifies its project. Do not combine it with projectTitle or projectUrl.",
    );
  }
  const session = await createSession(`Continue ${chatTitle || conversationUrl}: ${prompt}`);
  const requestPath = await writeSessionFile(session, "request.md", `${String(prompt).trim()}\n`);
  const startedAt = new Date().toISOString();
  let browser = null;
  let target = null;
  try {
    browser = await launchFirefox({ headless });
    const page = await requireAuthenticatedPage(browser);
    target = await openExistingConversation(page, {
      title: chatTitle,
      conversationUrl,
      projectTitle,
      projectUrl,
    });
    const baseline = await assistantSnapshot(page);
    const insertedCharacters = await insertComposerText(page, String(prompt).trim());
    const submitMethod = await submitComposer(page);
    await waitForUserMessage(page, baseline.userCount, String(prompt).trim(), {
      timeoutMs: 30_000,
    });
    const response = await waitForAssistant(page, baseline.count, { timeoutMs });
    const observedConversationUrl = normalizeConversationUrl(response.url);
    if (observedConversationUrl !== target.url) {
      throw new Error("ChatGPT navigated away from the selected conversation after submission.");
    }
    const answer = cleanAssistantText(response.text);
    const responsePath = await writeSessionFile(session, "response.md", answer);
    const metadata = {
      id: session.id,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "completed",
      mode: "continue-chat",
      targetTitle: target.title || chatTitle || null,
      projectTitle: target.projectTitle || normalizeProjectTitle(projectTitle) || null,
      projectUrl: target.projectUrl || null,
      conversationUrl: observedConversationUrl,
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
          projectTitle: target?.projectTitle || normalizeProjectTitle(projectTitle) || null,
          projectUrl: target?.projectUrl || projectUrl || null,
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
