import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionsDirectory } from "./config.mjs";

function slugify(value) {
  const compact = String(value ?? "consult")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return compact || "consult";
}

export async function createSession(prompt) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = `${timestamp}-${slugify(prompt)}`;
  const directory = path.join(sessionsDirectory(), id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return { id, directory };
}

export async function writeSessionFile(session, filename, contents) {
  const target = path.join(session.directory, filename);
  await writeFile(target, contents, { mode: 0o600 });
  return target;
}
