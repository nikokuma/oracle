#!/usr/bin/env node
import {
  consult,
  continueChat,
  doctor,
  importFirefoxSession,
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
    const timeoutSeconds = Number(readOption(args, ["--timeout-seconds"], "600"));
    const headless = args.includes("--headless");
    const result = await consult({
      prompt,
      files,
      cwd,
      delivery,
      timeoutMs: timeoutSeconds * 1_000,
      headless,
    });
    console.log(result.answer);
  } else if (command === "continue-chat") {
    const chatTitle = readOption(args, ["--title"]);
    const conversationUrl = readOption(args, ["--url"]);
    const prompt = readOption(args, ["-p", "--prompt"]);
    const timeoutSeconds = Number(readOption(args, ["--timeout-seconds"], "600"));
    const headless = args.includes("--headless");
    const result = await continueChat({
      chatTitle,
      conversationUrl,
      prompt,
      timeoutMs: timeoutSeconds * 1_000,
      headless,
    });
    console.log(result.answer);
  } else {
    throw new Error(
      "Usage: cli.mjs doctor | profiles | import-session [--source-profile <name|path>] --confirm | setup [--timeout-seconds 300] | consult -p <prompt> [-f <path/glob>] [--cwd <dir>] [--delivery auto|inline|attachment] [--headless] | continue-chat (--title <exact-title> | --url <conversation-url>) -p <prompt> [--timeout-seconds 600] [--headless]",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
