import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { sessionsDirectory } from "./config.mjs";

export async function createSession() {
  const id = randomUUID();
  const directory = path.join(sessionsDirectory(), id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return { id, directory };
}

export async function writeSessionFile(session, filename, contents) {
  const target = path.join(session.directory, filename);
  const temporary = path.join(session.directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return target;
}
