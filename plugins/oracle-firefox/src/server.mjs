#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  consult,
  continueChat,
  doctor,
  importFirefoxSession,
  listFirefoxProfiles,
  setupLogin,
} from "./workflow.mjs";

const server = new McpServer(
  { name: "oracle-firefox", version: "0.1.0" },
  { capabilities: { logging: {} } },
);

server.registerTool(
  "continue_chat",
  {
    title: "Continue an existing ChatGPT conversation",
    description:
      "Find one existing ChatGPT conversation by exact title or exact conversation URL, send one new prompt in that conversation, wait for a confirmed complete reply, and return it. This changes the user's ChatGPT conversation. Exact-title ambiguity fails closed; use conversationUrl to disambiguate.",
    inputSchema: {
      chatTitle: z
        .string()
        .optional()
        .describe("Exact existing ChatGPT conversation title. Matching is case-insensitive but not fuzzy."),
      conversationUrl: z
        .string()
        .optional()
        .describe("Exact https://chatgpt.com conversation URL; preferred when titles are duplicated."),
      prompt: z.string().min(1).describe("The one new message to send in the existing conversation."),
      timeoutSeconds: z.number().int().min(30).max(3600).default(600),
      headless: z
        .boolean()
        .default(false)
        .describe("Headful is safer for ChatGPT/Cloudflare; headless may be blocked."),
    },
  },
  async ({ chatTitle, conversationUrl, prompt, timeoutSeconds, headless }) =>
    serializedBrowserTask(async () => {
      try {
        const result = await continueChat({
          chatTitle,
          conversationUrl,
          prompt,
          timeoutMs: timeoutSeconds * 1_000,
          headless,
        });
        return {
          content: textContent(result.answer),
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: textContent(error instanceof Error ? error.message : String(error)),
        };
      }
    }),
);

let browserQueue = Promise.resolve();
function serializedBrowserTask(task) {
  const run = browserQueue.then(task, task);
  browserQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function textContent(value) {
  return [{ type: "text", text: value }];
}

server.registerTool(
  "doctor",
  {
    title: "Check Oracle Firefox readiness",
    description:
      "Check the installed Firefox executable and whether the dedicated Oracle Firefox profile exists. This does not open a browser.",
    inputSchema: {},
  },
  async () => {
    const result = await doctor();
    return {
      content: textContent(JSON.stringify(result, null, 2)),
      structuredContent: result,
    };
  },
);

server.registerTool(
  "setup",
  {
    title: "Sign into ChatGPT in dedicated Firefox",
    description:
      "Open a dedicated persistent Firefox profile at chatgpt.com and wait for the user to finish login. Google may reject sign-in inside an automated browser; in that case use profiles and import_session instead.",
    inputSchema: {
      timeoutSeconds: z.number().int().min(30).max(900).default(300),
    },
  },
  async ({ timeoutSeconds }) =>
    serializedBrowserTask(async () => {
      try {
        const result = await setupLogin({ timeoutMs: timeoutSeconds * 1_000 });
        return {
          content: textContent(
            result.alreadyAuthenticated
              ? "The dedicated Firefox profile is already signed into ChatGPT."
              : "Login completed and was saved in the dedicated Firefox profile.",
          ),
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: textContent(error instanceof Error ? error.message : String(error)),
        };
      }
    }),
);

server.registerTool(
  "profiles",
  {
    title: "Find Firefox profiles with ChatGPT cookies",
    description:
      "List normal Firefox profiles and report only the count of ChatGPT/OpenAI cookies in each. Cookie names and values are never returned. If Firefox locks its database, the count is null and active is true.",
    inputSchema: {},
  },
  async () => {
    try {
      const profiles = await listFirefoxProfiles();
      return {
        content: textContent(JSON.stringify(profiles, null, 2)),
        structuredContent: { profiles },
      };
    } catch (error) {
      return {
        isError: true,
        content: textContent(error instanceof Error ? error.message : String(error)),
      };
    }
  },
);

server.registerTool(
  "import_session",
  {
    title: "Import ChatGPT login from normal Firefox",
    description:
      "Copy only ChatGPT/OpenAI cookies from a normal Firefox profile into Oracle Firefox's dedicated profile. This avoids Google OAuth inside WebDriver. Never copies passwords, history, Google cookies, or unrelated site cookies. Requires explicit user confirmation; both normal Firefox and the dedicated Oracle Firefox window must be closed briefly for a consistent database copy.",
    inputSchema: {
      sourceProfile: z
        .string()
        .optional()
        .describe("Optional Firefox profile name, directory basename, or absolute path. Defaults to a profile containing ChatGPT cookies."),
      confirmImport: z
        .boolean()
        .describe("Must be true after the user explicitly approves copying ChatGPT/OpenAI cookies."),
    },
  },
  async ({ sourceProfile, confirmImport }) =>
    serializedBrowserTask(async () => {
      try {
        const result = await importFirefoxSession({ sourceProfile, confirmImport });
        return {
          content: textContent(
            `Imported ${result.importedCookieCount} ChatGPT/OpenAI cookies from Firefox profile ${result.sourceProfile.name}. Passwords, history, Google cookies, and unrelated site cookies were not copied.`,
          ),
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: textContent(error instanceof Error ? error.message : String(error)),
        };
      }
    }),
);

server.registerTool(
  "consult",
  {
    title: "Consult ChatGPT through Firefox",
    description:
      "Bundle a prompt and selected UTF-8 text files, submit them to ChatGPT through a dedicated Firefox profile over WebDriver BiDi, wait for a confirmed complete answer, and return it. Paths/globs resolve from cwd. Sensitive key/env files are refused by default.",
    inputSchema: {
      prompt: z.string().min(1).describe("The exact second-opinion question."),
      files: z
        .array(z.string())
        .default([])
        .describe("Optional files, directories, globs, and !exclude patterns."),
      cwd: z
        .string()
        .optional()
        .describe("Absolute working directory used to resolve relative file patterns."),
      delivery: z
        .enum(["auto", "inline", "attachment"])
        .default("auto")
        .describe("Auto attaches larger bundles and pastes smaller bundles inline."),
      timeoutSeconds: z.number().int().min(30).max(3600).default(600),
      headless: z
        .boolean()
        .default(false)
        .describe("Headful is safer for ChatGPT/Cloudflare; headless may be blocked."),
    },
  },
  async ({ prompt, files, cwd, delivery, timeoutSeconds, headless }) =>
    serializedBrowserTask(async () => {
      try {
        const result = await consult({
          prompt,
          files,
          cwd,
          delivery,
          timeoutMs: timeoutSeconds * 1_000,
          headless,
        });
        return {
          content: textContent(result.answer),
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: textContent(error instanceof Error ? error.message : String(error)),
        };
      }
    }),
);

const transport = new StdioServerTransport();
transport.onerror = (error) => console.error("Oracle Firefox MCP transport error:", error);
const closed = new Promise((resolve) => {
  transport.onclose = resolve;
});
await server.connect(transport);
await closed;
