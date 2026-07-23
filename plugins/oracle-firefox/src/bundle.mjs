import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

const DEFAULT_IGNORES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/tmp/**",
];

const SENSITIVE_BASENAMES = [
  /^\.env(?:\..+)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials\.json$/i,
  /^service-account.*\.json$/i,
];

const SENSITIVE_EXTENSIONS = new Set([".pem", ".p12", ".pfx", ".key", ".keystore"]);

function slash(value) {
  return value.split(path.sep).join("/");
}

async function pathKind(candidate) {
  try {
    const info = await stat(candidate);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
  } catch {
    // Dynamic patterns do not stat as literal paths.
  }
  return null;
}

function assertNotSensitive(filePath) {
  const basename = path.basename(filePath);
  if (
    SENSITIVE_BASENAMES.some((pattern) => pattern.test(basename)) ||
    SENSITIVE_EXTENSIONS.has(path.extname(basename).toLowerCase())
  ) {
    throw new Error(`Refusing to bundle potentially sensitive file: ${filePath}`);
  }
}

function decodeText(buffer, filePath) {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`File is not valid UTF-8 text: ${filePath}`);
  }
}

function languageFor(filePath) {
  return (
    {
      ".c": "c",
      ".cc": "cpp",
      ".cpp": "cpp",
      ".css": "css",
      ".go": "go",
      ".html": "html",
      ".java": "java",
      ".js": "javascript",
      ".json": "json",
      ".jsx": "jsx",
      ".md": "markdown",
      ".mjs": "javascript",
      ".py": "python",
      ".rb": "ruby",
      ".rs": "rust",
      ".sh": "bash",
      ".sql": "sql",
      ".swift": "swift",
      ".toml": "toml",
      ".ts": "typescript",
      ".tsx": "tsx",
      ".xml": "xml",
      ".yaml": "yaml",
      ".yml": "yaml",
    }[path.extname(filePath).toLowerCase()] ?? "text"
  );
}

export async function resolveFiles(patterns = [], options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const maxFiles = options.maxFiles ?? 200;
  const includes = [];
  const excludes = [...DEFAULT_IGNORES];
  const literalFiles = [];

  for (const rawPattern of patterns) {
    const value = String(rawPattern ?? "").trim();
    if (!value) continue;
    if (value.startsWith("!")) {
      excludes.push(slash(value.slice(1)));
      continue;
    }
    const resolved = path.resolve(cwd, value);
    const kind = await pathKind(resolved);
    if (kind === "file") {
      literalFiles.push(resolved);
    } else if (kind === "directory") {
      includes.push(`${slash(resolved)}/**/*`);
    } else {
      includes.push(path.isAbsolute(value) ? slash(value) : value);
    }
  }

  const globbed = includes.length
    ? await fg(includes, {
        cwd,
        absolute: true,
        onlyFiles: true,
        unique: true,
        dot: true,
        followSymbolicLinks: false,
        ignore: excludes,
      })
    : [];
  const files = Array.from(new Set([...literalFiles, ...globbed].map((file) => path.resolve(file)))).sort();
  if (files.length > maxFiles) {
    throw new Error(`Matched ${files.length} files; the safety limit is ${maxFiles}. Narrow the patterns.`);
  }
  return { cwd, files };
}

export async function bundleContext({ prompt, files = [], cwd, maxFileBytes = 1_000_000, maxTotalChars = 1_500_000 }) {
  const normalizedPrompt = String(prompt ?? "").trim();
  if (!normalizedPrompt) throw new Error("Prompt is required.");

  const resolved = await resolveFiles(files, { cwd });
  const sections = [
    "[SYSTEM]",
    "You are a focused second-opinion reviewer. Answer the user's request directly and cite attached files as path:line when useful.",
    "",
    "[USER]",
    normalizedPrompt,
  ];
  const included = [];
  const skippedBinary = [];
  let totalChars = sections.join("\n").length;

  for (const filePath of resolved.files) {
    assertNotSensitive(filePath);
    const info = await stat(filePath);
    if (info.size > maxFileBytes) {
      throw new Error(`File exceeds the ${maxFileBytes}-byte safety limit: ${filePath}`);
    }
    const buffer = await readFile(filePath);
    const text = decodeText(buffer, filePath);
    if (text === null) {
      skippedBinary.push(filePath);
      continue;
    }
    const displayPath = slash(path.relative(resolved.cwd, filePath) || path.basename(filePath));
    const numbered = text
      .split(/\r?\n/)
      .map((line, index) => `${index + 1} | ${line}`)
      .join("\n");
    const section = [
      "",
      `### File: ${displayPath}`,
      `Lines: 1-${Math.max(1, text.split(/\r?\n/).length)}`,
      `\`\`\`\`${languageFor(filePath)}`,
      numbered,
      "````",
    ].join("\n");
    totalChars += section.length;
    if (totalChars > maxTotalChars) {
      throw new Error(
        `Bundle exceeds the ${maxTotalChars.toLocaleString()}-character safety limit after ${displayPath}. Narrow the file set.`,
      );
    }
    sections.push(section);
    included.push({ path: filePath, displayPath, bytes: info.size, lines: Math.max(1, text.split(/\r?\n/).length) });
  }

  return {
    bundle: sections.join("\n"),
    cwd: resolved.cwd,
    included,
    skippedBinary,
    characterCount: totalChars,
  };
}
