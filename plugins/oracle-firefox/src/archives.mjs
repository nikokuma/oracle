import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { codedError } from "./errors.mjs";
import { writeSessionFile } from "./sessions.mjs";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;
const MAX_ARCHIVES = 5;
const MAX_ARCHIVE_BYTES = 100_000_000;
const MAX_TOTAL_ARCHIVE_BYTES = 250_000_000;
const MAX_ENTRIES = 10_000;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 500_000_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 1_000_000_000;
const MAX_COMPRESSION_RATIO = 200;

const SENSITIVE_BASENAMES = [
  /^\.env(?:\..+)?$/iu,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/iu,
  /^credentials\.json$/iu,
  /^service-account.*\.json$/iu,
];
const SENSITIVE_EXTENSIONS = new Set([".pem", ".p12", ".pfx", ".key", ".keystore"]);

function archiveError(code, message, details = {}) {
  return codedError(code, message, { safeToRetry: true, details });
}

function findEocd(buffer) {
  const earliest = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw archiveError("ZIP_STRUCTURE_INVALID", "The ZIP end-of-central-directory record was not valid.");
}

function decodeEntryName(bytes, flags) {
  if ((flags & 0x0800) !== 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw archiveError("ZIP_ENTRY_NAME_INVALID", "A ZIP entry name was marked UTF-8 but could not be decoded.");
    }
  }
  if (bytes.some((value) => value > 0x7f)) {
    throw archiveError(
      "ZIP_ENTRY_ENCODING_UNSUPPORTED",
      "ZIP entry names must be ASCII or explicitly marked UTF-8.",
    );
  }
  return bytes.toString("ascii");
}

function normalizeEntryName(value) {
  const normalized = String(value).replace(/\\/gu, "/");
  if (!normalized || normalized.includes("\0") || normalized.length > 1_024) {
    throw archiveError("ZIP_ENTRY_PATH_UNSAFE", "A ZIP entry had an empty, NUL-containing, or excessively long path.");
  }
  if (normalized.startsWith("/") || normalized.startsWith("//") || /^[a-z]:/iu.test(normalized)) {
    throw archiveError("ZIP_ENTRY_PATH_UNSAFE", `ZIP entry ${JSON.stringify(normalized)} used an absolute path.`);
  }
  const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
    throw archiveError("ZIP_ENTRY_PATH_UNSAFE", `ZIP entry ${JSON.stringify(normalized)} used an unsafe path segment.`);
  }
  const basename = segments.at(-1);
  if (
    SENSITIVE_BASENAMES.some((pattern) => pattern.test(basename)) ||
    SENSITIVE_EXTENSIONS.has(path.extname(basename).toLowerCase())
  ) {
    throw archiveError(
      "ZIP_SENSITIVE_ENTRY",
      `Refusing to send a ZIP containing a commonly sensitive entry: ${normalized}`,
    );
  }
  return normalized;
}

function assertRegularEntry(versionMadeBy, externalAttributes, name) {
  const host = versionMadeBy >>> 8;
  if (host !== 3 && host !== 19) return;
  const mode = (externalAttributes >>> 16) & 0xffff;
  const type = mode & 0o170000;
  if (type === 0 || type === 0o100000 || (type === 0o040000 && name.endsWith("/"))) return;
  throw archiveError("ZIP_SPECIAL_ENTRY", `ZIP entry ${JSON.stringify(name)} is a symlink or another special file.`);
}

export function inspectZipBuffer(buffer, { filename = "archive.zip" } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw archiveError("ZIP_STRUCTURE_INVALID", `${filename} is too small to be a valid ZIP archive.`);
  }
  const eocd = findEocd(buffer);
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw archiveError("ZIP_MULTIDISK_UNSUPPORTED", `${filename} is a split or multi-disk ZIP archive.`);
  }
  if (entryCount === 0) throw archiveError("ZIP_EMPTY", `${filename} contains no entries.`);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw archiveError("ZIP64_UNSUPPORTED", `${filename} requires ZIP64, which is outside Oracle's upload limits.`);
  }
  if (entryCount > MAX_ENTRIES) {
    throw archiveError("ZIP_ENTRY_LIMIT", `${filename} contains ${entryCount} entries; the limit is ${MAX_ENTRIES}.`);
  }
  if (centralOffset + centralSize > eocd || centralOffset + centralSize > buffer.length) {
    throw archiveError("ZIP_STRUCTURE_INVALID", `${filename} has a central directory outside the archive bounds.`);
  }

  let offset = centralOffset;
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;
  const names = new Set();
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw archiveError("ZIP_STRUCTURE_INVALID", `${filename} has an invalid central-directory entry at index ${index}.`);
    }
    const versionMadeBy = buffer.readUInt16LE(offset + 4);
    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedBytes = buffer.readUInt32LE(offset + 20);
    const uncompressedBytes = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const diskStart = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length || nameLength === 0) {
      throw archiveError("ZIP_STRUCTURE_INVALID", `${filename} has a truncated central-directory entry.`);
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || (flags & 0x2000) !== 0) {
      throw archiveError("ZIP_ENCRYPTED_UNSUPPORTED", `${filename} contains an encrypted entry.`);
    }
    if (![0, 8].includes(compressionMethod)) {
      throw archiveError(
        "ZIP_COMPRESSION_UNSUPPORTED",
        `${filename} uses unsupported compression method ${compressionMethod}; use stored or deflated ZIP entries.`,
      );
    }
    if (diskStart !== 0 || compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff || localOffset === 0xffffffff) {
      throw archiveError("ZIP64_UNSUPPORTED", `${filename} contains a ZIP64 or split entry.`);
    }
    if (localOffset + 4 > centralOffset || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw archiveError("ZIP_STRUCTURE_INVALID", `${filename} contains an invalid local-file reference.`);
    }
    const name = normalizeEntryName(decodeEntryName(buffer.subarray(offset + 46, offset + 46 + nameLength), flags));
    assertRegularEntry(versionMadeBy, externalAttributes, name);
    const key = name.toLocaleLowerCase("en-US");
    if (names.has(key)) throw archiveError("ZIP_DUPLICATE_ENTRY", `${filename} contains a duplicate entry path: ${name}`);
    names.add(key);
    if (uncompressedBytes > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw archiveError("ZIP_EXPANSION_LIMIT", `${filename} contains an entry larger than ${MAX_ENTRY_UNCOMPRESSED_BYTES} uncompressed bytes.`);
    }
    const ratio = uncompressedBytes / Math.max(1, compressedBytes);
    if (ratio > MAX_COMPRESSION_RATIO) {
      throw archiveError("ZIP_COMPRESSION_RATIO", `${filename} contains an entry with an unsafe compression ratio.`);
    }
    totalCompressedBytes += compressedBytes;
    totalUncompressedBytes += uncompressedBytes;
    if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw archiveError("ZIP_EXPANSION_LIMIT", `${filename} exceeds the ${MAX_TOTAL_UNCOMPRESSED_BYTES}-byte uncompressed limit.`);
    }
    entries.push({ name, compressedBytes, uncompressedBytes, compressionMethod });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) {
    throw archiveError("ZIP_STRUCTURE_INVALID", `${filename} central-directory size did not match its entries.`);
  }
  return { filename, entryCount, totalCompressedBytes, totalUncompressedBytes, entries };
}

export async function prepareZipAttachments({ zipFiles = [], cwd, session } = {}) {
  if (!Array.isArray(zipFiles)) throw archiveError("ZIP_INPUT_INVALID", "zipFiles must be an array of explicit file paths.");
  if (zipFiles.length > MAX_ARCHIVES) {
    throw archiveError("ZIP_FILE_LIMIT", `At most ${MAX_ARCHIVES} ZIP archives may be attached to one message.`);
  }
  const root = path.resolve(cwd || process.cwd());
  const seenNames = new Set();
  const prepared = [];
  let totalBytes = 0;
  for (const raw of zipFiles) {
    const value = String(raw ?? "").trim();
    if (!value) throw archiveError("ZIP_INPUT_INVALID", "ZIP attachment paths must be non-empty.");
    const sourcePath = path.resolve(root, value);
    const filename = path.basename(sourcePath);
    if (path.extname(filename).toLowerCase() !== ".zip") {
      throw archiveError("ZIP_EXTENSION_REQUIRED", `Raw archive attachments must use the .zip extension: ${filename}`);
    }
    if (/\(\d+\)(?=\.zip$)/iu.test(filename)) {
      throw archiveError("ZIP_FILENAME_AMBIGUOUS", `${filename} conflicts with ChatGPT's duplicate-filename notation; rename it before sending.`);
    }
    const filenameKey = filename.toLocaleLowerCase("en-US");
    if (seenNames.has(filenameKey)) throw archiveError("ZIP_FILENAME_DUPLICATE", `More than one ZIP attachment is named ${filename}.`);
    seenNames.add(filenameKey);
    let info;
    try {
      info = await lstat(sourcePath);
    } catch {
      throw archiveError("ZIP_NOT_FOUND", `ZIP attachment was not found: ${filename}`);
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw archiveError("ZIP_NOT_REGULAR_FILE", `ZIP attachment must be a regular file, not a symlink: ${filename}`);
    }
    if (info.size < 22 || info.size > MAX_ARCHIVE_BYTES) {
      throw archiveError("ZIP_SIZE_LIMIT", `${filename} must be between 22 and ${MAX_ARCHIVE_BYTES} bytes.`);
    }
    totalBytes += info.size;
    if (totalBytes > MAX_TOTAL_ARCHIVE_BYTES) {
      throw archiveError("ZIP_TOTAL_SIZE_LIMIT", `ZIP attachments exceed the ${MAX_TOTAL_ARCHIVE_BYTES}-byte total limit.`);
    }
    const contents = await readFile(sourcePath);
    const inspection = inspectZipBuffer(contents, { filename });
    const sha256 = createHash("sha256").update(contents).digest("hex");
    const snapshotPath = await writeSessionFile(session, filename, contents);
    prepared.push({
      filename,
      snapshotPath,
      sizeBytes: contents.length,
      sha256,
      entryCount: inspection.entryCount,
      uncompressedBytes: inspection.totalUncompressedBytes,
    });
  }
  return prepared;
}

export async function verifyPreparedZipAttachments(attachments = [], sessionPath) {
  if (!Array.isArray(attachments) || attachments.length > MAX_ARCHIVES) {
    throw archiveError("ZIP_SNAPSHOT_INVALID", "The durable ZIP attachment manifest is invalid.");
  }
  const directory = path.resolve(sessionPath);
  const verified = [];
  for (const attachment of attachments) {
    const filename = String(attachment?.filename ?? "");
    const snapshotPath = path.resolve(String(attachment?.snapshotPath ?? ""));
    if (
      path.dirname(snapshotPath) !== directory ||
      path.basename(snapshotPath) !== filename ||
      path.extname(filename).toLowerCase() !== ".zip"
    ) {
      throw archiveError("ZIP_SNAPSHOT_INVALID", "A durable ZIP snapshot escaped its private Oracle session directory.");
    }
    const info = await lstat(snapshotPath).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw archiveError("ZIP_SNAPSHOT_INVALID", `Durable ZIP snapshot is missing or is not a regular file: ${filename}`);
    }
    const contents = await readFile(snapshotPath);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    if (contents.length !== attachment.sizeBytes || sha256 !== attachment.sha256) {
      throw archiveError("ZIP_SNAPSHOT_CHANGED", `Durable ZIP snapshot changed after authorization: ${filename}`);
    }
    const inspection = inspectZipBuffer(contents, { filename });
    if (
      inspection.entryCount !== attachment.entryCount ||
      inspection.totalUncompressedBytes !== attachment.uncompressedBytes
    ) {
      throw archiveError("ZIP_SNAPSHOT_CHANGED", `Durable ZIP metadata changed after authorization: ${filename}`);
    }
    verified.push(snapshotPath);
  }
  return verified;
}

export const ZIP_LIMITS = Object.freeze({
  maxArchives: MAX_ARCHIVES,
  maxArchiveBytes: MAX_ARCHIVE_BYTES,
  maxTotalArchiveBytes: MAX_TOTAL_ARCHIVE_BYTES,
  maxEntries: MAX_ENTRIES,
  maxEntryUncompressedBytes: MAX_ENTRY_UNCOMPRESSED_BYTES,
  maxTotalUncompressedBytes: MAX_TOTAL_UNCOMPRESSED_BYTES,
  maxCompressionRatio: MAX_COMPRESSION_RATIO,
});
