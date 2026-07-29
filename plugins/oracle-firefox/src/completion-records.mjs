import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function completionRecordPath(directory, rootJobId) {
  return path.join(directory, `${rootJobId}.json`);
}

export async function removeCompletionRecord(directory, rootJobId) {
  await rm(completionRecordPath(directory, rootJobId), { force: true });
}

export async function writeCompletionRecord(directory, record) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = completionRecordPath(directory, record.rootJobId);
  const temporary = path.join(directory, `.${record.rootJobId}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
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
