import { DatabaseSync } from "node:sqlite";
import { readFile, stat } from "node:fs/promises";
import { brokerCoordinatorIdPath, coordinatorDatabasePath } from "./config.mjs";
import { BROKER_SCHEMA_VERSION } from "./build-info.mjs";

async function fileStatus(pathname) {
  try {
    const info = await stat(pathname);
    return { path: pathname, exists: true, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() };
  } catch (error) {
    if (error?.code === "ENOENT") return { path: pathname, exists: false };
    throw error;
  }
}

export async function inspectCoordinatorDatabase(databasePath = coordinatorDatabasePath()) {
  const database = await fileStatus(databasePath);
  const backup = await fileStatus(`${databasePath}.pre-v${BROKER_SCHEMA_VERSION}.bak`);
  const coordinatorUuid = await readFile(brokerCoordinatorIdPath(), "utf8")
    .then((value) => value.trim() || null, () => null);
  if (!database.exists) {
    return { database, backup, coordinatorUuidPresent: Boolean(coordinatorUuid), readable: true, initialized: false };
  }
  let db;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
    const schemaVersion = Number(db.prepare("SELECT COALESCE(MAX(version), 0) version FROM schema_migrations").get()?.version || 0);
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check || "unknown";
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
    let broker = null;
    if (schemaVersion >= 6) {
      const row = db.prepare(`
        SELECT coordinator_id, current_instance_id, current_lease_generation,
               minimum_reader_protocol, minimum_writer_protocol,
               qualified_concurrency, updated_at
        FROM broker_state WHERE id=1
      `).get();
      broker = row ? {
        coordinatorId: row.coordinator_id,
        currentInstanceId: row.current_instance_id,
        leaseGeneration: row.current_lease_generation,
        minimumReaderProtocol: row.minimum_reader_protocol,
        minimumWriterProtocol: row.minimum_writer_protocol,
        qualifiedConcurrency: row.qualified_concurrency,
        updatedAt: row.updated_at,
      } : null;
    }
    return {
      database,
      backup,
      coordinatorUuidPresent: Boolean(coordinatorUuid),
      readable: true,
      initialized: true,
      schemaVersion,
      expectedSchemaVersion: BROKER_SCHEMA_VERSION,
      integrity,
      foreignKeyViolations,
      broker,
      repairRequired: integrity !== "ok" || foreignKeyViolations > 0 || schemaVersion > BROKER_SCHEMA_VERSION,
    };
  } catch (error) {
    return {
      database,
      backup,
      coordinatorUuidPresent: Boolean(coordinatorUuid),
      readable: false,
      error: {
        code: "COORDINATOR_DATABASE_UNAVAILABLE",
        message: "The coordinator database could not be inspected read-only. A live broker may hold it exclusively, or it may require offline repair.",
        cause: error.message,
      },
    };
  } finally {
    try { db?.close(); } catch {}
  }
}
