import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { codedError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

async function assertLeaseTarget(pathname, label) {
  const info = await lstat(pathname).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (info && (info.isSymbolicLink() || !info.isFile())) {
    throw codedError("BROKER_LEASE_PATH_INVALID", `The ${label} lifetime lease path is not a regular file.`);
  }
}

function leasePathIdentity(pathname, label) {
  const info = lstatSync(pathname);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw codedError("BROKER_LEASE_PATH_INVALID", `The ${label} lifetime lease path is not a regular file.`);
  }
  return { device: String(info.dev), inode: String(info.ino) };
}

function acquireDatabaseLease(databasePath, label) {
  let db;
  try {
    db = new DatabaseSync(databasePath);
    db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=0;
      CREATE TABLE IF NOT EXISTS lease_guard (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        marker INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO lease_guard(id, marker) VALUES (1, 0);
      BEGIN EXCLUSIVE;
      UPDATE lease_guard SET marker = marker WHERE id = 1;
    `);
    return db;
  } catch (error) {
    try { db?.close(); } catch {}
    throw codedError("BROKER_LEASE_HELD", `Another Oracle Firefox service holds the ${label} lifetime lease.`, {
      safeToRetry: true,
      details: { label },
      cause: error,
    });
  }
}

export async function processStartIdentity(pid = process.pid) {
  if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]);
      return stdout.trim() || null;
    } catch { return null; }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]);
      return stdout.trim() || null;
    } catch { return null; }
  }
  return null;
}

export async function processMatchesStartIdentity(pid, expected) {
  if (!expected) return false;
  return (await processStartIdentity(pid)) === expected;
}

export class BrokerLifetimeLease {
  static async acquire(identity) {
    await mkdir(path.dirname(identity.coordinatorLeasePath), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(identity.profileLeasePath), { recursive: true, mode: 0o700 });
    await assertLeaseTarget(identity.coordinatorLeasePath, "coordinator");
    await assertLeaseTarget(identity.profileLeasePath, "Firefox profile");
    const coordinator = acquireDatabaseLease(identity.coordinatorLeasePath, "coordinator");
    let profile;
    try {
      profile = acquireDatabaseLease(identity.profileLeasePath, "Firefox profile");
      return new BrokerLifetimeLease(identity, coordinator, profile, {
        coordinator: leasePathIdentity(identity.coordinatorLeasePath, "coordinator"),
        profile: leasePathIdentity(identity.profileLeasePath, "Firefox profile"),
      });
    } catch (error) {
      try { profile?.exec("ROLLBACK"); } catch {}
      try { profile?.close(); } catch {}
      try { coordinator.exec("ROLLBACK"); } catch {}
      coordinator.close();
      throw error;
    }
  }

  constructor(identity, coordinator, profile, pathIdentities) {
    this.identity = identity;
    this.coordinator = coordinator;
    this.profile = profile;
    this.pathIdentities = pathIdentities;
    this.released = false;
  }

  assertHeld() {
    if (this.released) throw codedError("BROKER_LEASE_LOST", "The Oracle Firefox lifetime lease is no longer held.");
    for (const [key, pathname, label] of [
      ["coordinator", this.identity.coordinatorLeasePath, "coordinator"],
      ["profile", this.identity.profileLeasePath, "Firefox profile"],
    ]) {
      let current;
      try { current = leasePathIdentity(pathname, label); }
      catch (error) {
        throw codedError("BROKER_LEASE_LOST", `The ${label} lifetime lease path changed while the broker was running.`, { cause: error });
      }
      const expected = this.pathIdentities[key];
      if (current.device !== expected.device || current.inode !== expected.inode) {
        throw codedError("BROKER_LEASE_LOST", `The ${label} lifetime lease file was replaced while the broker was running.`);
      }
    }
    this.coordinator.prepare("SELECT marker FROM lease_guard WHERE id = 1").get();
    this.profile.prepare("SELECT marker FROM lease_guard WHERE id = 1").get();
    return true;
  }

  release() {
    if (this.released) return;
    this.released = true;
    for (const db of [this.profile, this.coordinator]) {
      try { db.exec("ROLLBACK"); } catch {}
      try { db.close(); } catch {}
    }
  }
}

export class BrokerLaunchLease {
  static async acquire(databasePath) {
    await mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    await assertLeaseTarget(databasePath, "broker launch");
    const db = acquireDatabaseLease(databasePath, "broker launch");
    return new BrokerLaunchLease(db);
  }

  constructor(db) {
    this.db = db;
    this.released = false;
  }

  release() {
    if (this.released) return;
    this.released = true;
    try { this.db.exec("ROLLBACK"); } catch {}
    try { this.db.close(); } catch {}
  }
}
