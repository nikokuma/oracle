import { lstat, rm } from "node:fs/promises";
import { readSignedJson, writeSignedJson } from "./atomic-json.mjs";

export async function endpointFileIdentity(endpoint) {
  if (process.platform === "win32") return { device: null, inode: null };
  const info = await lstat(endpoint);
  return { device: String(info.dev), inode: String(info.ino), socket: info.isSocket() };
}

export async function readBrokerLocator(identity, token) {
  try {
    const locator = await readSignedJson(identity.locatorPath, token);
    if (
      locator.version !== 1 ||
      locator.coordinatorId !== identity.coordinatorId ||
      locator.endpoint?.path !== identity.endpoint
    ) return null;
    return locator;
  } catch {
    return null;
  }
}

export async function writeBrokerLocator(identity, token, value) {
  return writeSignedJson(identity.locatorPath, {
    version: 1,
    coordinatorId: identity.coordinatorId,
    profileId: identity.profileId,
    ...value,
  }, token);
}

export async function compareAndUnlinkEndpoint(identity, token, expected) {
  if (process.platform === "win32") return true;
  const locator = await readBrokerLocator(identity, token);
  if (
    !locator || locator.instanceId !== expected.instanceId ||
    Number(locator.leaseGeneration || 0) !== Number(expected.leaseGeneration || 0)
  ) return false;
  const current = await endpointFileIdentity(identity.endpoint).catch(() => null);
  if (!current) return true;
  if (
    String(current.device) !== String(expected.endpointDevice) ||
    String(current.inode) !== String(expected.endpointInode)
  ) return false;
  await rm(identity.endpoint, { force: true });
  return true;
}
