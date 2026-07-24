#!/usr/bin/env node
import {
  consult,
  continueChat,
  doctor,
  findChatGptConversations,
  importFirefoxSession,
  listChatGptProjects,
  listFirefoxProfiles,
  setupLogin,
} from "./workflow.mjs";

function readOption(args, names, fallback = undefined) {
  const index = args.findIndex((value) => names.includes(value));
  return index >= 0 ? args[index + 1] : fallback;
}

function readRepeated(args, names) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (names.includes(args[index]) && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

const [, , command = "doctor", ...args] = process.argv;

try {
  if (command === "doctor") {
    console.log(JSON.stringify(await doctor(), null, 2));
  } else if (command === "setup") {
    const timeoutSeconds = Number(readOption(args, ["--timeout-seconds"], "300"));
    console.log(JSON.stringify(await setupLogin({ timeoutMs: timeoutSeconds * 1_000 }), null, 2));
  } else if (command === "profiles") {
    console.log(JSON.stringify(await listFirefoxProfiles(), null, 2));
  } else if (command === "projects") {
    const query = readOption(args, ["-q", "--query"], "");
    const headless = args.includes("--headless");
    console.log(JSON.stringify(await listChatGptProjects({ query, headless }), null, 2));
  } else if (command === "find-chats") {
    const query = readOption(args, ["-q", "--query"]);
    const projectTitle = readOption(args, ["--project-title"]);
    const projectUrl = readOption(args, ["--project-url"]);
    const timeoutSeconds = Number(readOption(args, ["--timeout-seconds"], "15"));
    const headless = args.includes("--headless");
    console.log(
      JSON.stringify(
        await findChatGptConversations({
          query,
          projectTitle,
          projectUrl,
          timeoutMs: timeoutSeconds * 1_000,
          headless,
        }),
        null,
        2,
      ),
    );
  } else if (command === "import-session") {
    const sourceProfile = readOption(args, ["--source-profile"]);
    const confirmImport = args.includes("--confirm");
    console.log(
      JSON.stringify(await importFirefoxSession({ sourceProfile, confirmImport }), null, 2),
    );
  } else if (command === "consult") {
    const prompt = readOption(args, ["-p", "--prompt"]);
    const files = readRepeated(args, ["-f", "--file"]);
    const cwd = readOption(args, ["--cwd"]);
    const delivery = readOption(args, ["--delivery"], "auto");
    const projectTitle = readOption(args, ["--project-title"]);
    const projectUrl = readOption(args, ["--project-url"]);
    const timeoutSeconds = Number(readOption(args, ["--timeout-seconds"], "600"));
    const headless = args.includes("--headless");
    const result = await consult({
      prompt,
      files,
      cwd,
      delivery,
      projectTitle,
      projectUrl,
      timeoutMs: timeoutSeconds * 1_000,
      headless,
    });
    console.log(result.answer);
  } else if (command === "continue-chat") {
    const chatTitle = readOption(args, ["--title"]);
    const conversationUrl = readOption(args, ["--url"]);
    const projectTitle = readOption(args, ["--project-title"]);
    const projectUrl = readOption(args, ["--project-url"]);
    const prompt = readOption(args, ["-p", "--prompt"]);
    const timeoutSeconds = Number(readOption(args, ["--timeout-seconds"], "600"));
    const headless = args.includes("--headless");
    const result = await continueChat({
      chatTitle,
      conversationUrl,
      projectTitle,
      projectUrl,
      prompt,
      timeoutMs: timeoutSeconds * 1_000,
      headless,
    });
    console.log(result.answer);
  } else {
    throw new Error(
      "Usage: cli.mjs doctor | profiles | projects [-q <name-fragment>] [--headless] | find-chats -q <title-fragment> [--project-title <exact-title> | --project-url <url>] [--headless] | import-session [--source-profile <name|path>] --confirm | setup [--timeout-seconds 300] | consult -p <prompt> [-f <path/glob>] [--cwd <dir>] [--delivery auto|inline|attachment] [--project-title <exact-title> | --project-url <url>] [--headless] | continue-chat (--title <exact-title> | --url <conversation-url>) -p <prompt> [--project-title <exact-title> | --project-url <url>] [--timeout-seconds 600] [--headless]",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
