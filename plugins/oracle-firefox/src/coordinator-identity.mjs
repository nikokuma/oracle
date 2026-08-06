import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  brokerCoordinatorIdPath,
  brokerEndpoint,
  brokerLeaseDatabasePath,
  brokerLocatorPath,
  brokerRuntimeRoot,
  legacyBrokerEndpoints,
  coordinatorDatabasePath,
  coordinatorDirectory,
  oracleFirefoxHome,
  profileDirectory,
  profileLeaseDatabasePath,
} from "./config.mjs";
import { codedError } from "./errors.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw codedError("PRIVATE_DIRECTORY_INVALID", `${directory} must be a private real directory.`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw codedError("PRIVATE_DIRECTORY_OWNER_MISMATCH", `${directory} is not owned by the current user.`);
  }
  await chmod(directory, 0o700);
  return realpath(directory);
}

async function canonicalPath(candidate, { directory = false } = {}) {
  if (directory) return ensurePrivateDirectory(candidate);
  const parent = await ensurePrivateDirectory(path.dirname(candidate));
  return path.join(parent, path.basename(candidate));
}

async function canonicalProfilePath(candidate) {
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw codedError("PROFILE_PATH_INVALID", `${candidate} must be a private real directory.`);
    }
    return ensurePrivateDirectory(candidate);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return canonicalPath(candidate);
  }
}

async function canonicalRuntimeRoot(candidate) {
  await mkdir(candidate, { recursive: true });
  const resolved = await realpath(candidate);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw codedError("RUNTIME_ROOT_INVALID", `${candidate} is not a directory.`);
  return resolved;
}

async function readOrCreateCoordinatorUuid() {
  const target = brokerCoordinatorIdPath();
  const readExisting = async () => {
    const value = (await readFile(target, "utf8")).trim();
    if (!UUID_PATTERN.test(value)) throw codedError("COORDINATOR_ID_INVALID", `Oracle Firefox cannot trust ${target}.`);
    return value.toLowerCase();
  };
  try {
    return await readExisting();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw codedError("COORDINATOR_ID_INVALID", `Oracle Firefox cannot trust ${target}.`, { cause: error });
    }
  }
  const value = randomUUID();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(`${value}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await link(temporary, target);
      return value;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return await readExisting();
    }
  } catch (error) {
    try { await handle.close(); } catch {}
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function resolveCoordinatorIdentity() {
  const coordinatorPath = await canonicalPath(coordinatorDirectory(), { directory: true });
  const homePath = await canonicalPath(oracleFirefoxHome(), { directory: true });
  const profilePath = await canonicalProfilePath(profileDirectory());
  const coordinatorUuid = await readOrCreateCoordinatorUuid();
  const userIdentity = typeof process.getuid === "function"
    ? `uid:${process.getuid()}`
    : `user:${process.env.USERNAME || process.env.USER || os.userInfo().username}`;
  const coordinatorId = digest(`${userIdentity}\0${coordinatorPath}\0${profilePath}\0${coordinatorUuid}`);
  const profileId = digest(`${userIdentity}\0${profilePath}`);
  const runtimeRoot = await canonicalRuntimeRoot(brokerRuntimeRoot());
  const runtimeDirectory = await canonicalPath(
    path.join(runtimeRoot, `oracle-firefox-${userIdentity.replace(/[^a-z0-9_-]/giu, "-")}-${coordinatorId.slice(0, 16)}`),
    { directory: true },
  );
  const endpoint = brokerEndpoint({ runtimeDirectory, coordinatorId });
  if (process.platform !== "win32") {
    const maximumBytes = process.platform === "darwin" ? 103 : 107;
    if (Buffer.byteLength(endpoint) > maximumBytes) {
      throw codedError(
        "BROKER_ENDPOINT_TOO_LONG",
        `The canonical broker socket path is ${Buffer.byteLength(endpoint)} bytes; this platform permits at most ${maximumBytes}. Choose a shorter ORACLE_FIREFOX_RUNTIME_ROOT.`,
      );
    }
  }
  const databaseExists = await stat(coordinatorDatabasePath()).then(() => true, () => false);
  return {
    version: 1,
    userIdentity,
    coordinatorUuid,
    coordinatorId,
    profileId,
    coordinatorPath,
    homePath,
    profilePath,
    runtimeRoot,
    runtimeDirectory,
    endpoint,
    legacyEndpoints: legacyBrokerEndpoints().filter((candidate) => candidate !== endpoint),
    locatorPath: brokerLocatorPath(),
    coordinatorLeasePath: brokerLeaseDatabasePath(),
    profileLeasePath: profileLeaseDatabasePath(),
    databasePath: coordinatorDatabasePath(),
    databaseExists,
  };
}
