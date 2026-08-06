import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectZipBuffer, prepareZipAttachments, verifyPreparedZipAttachments, ZIP_LIMITS } from "../src/archives.mjs";
import { createStoredZip, writeStoredZip } from "../test-support/zip-fixture.mjs";

test("validates, hashes, and snapshots an explicit ZIP before browser work", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-zip-"));
  const session = { id: "fixture", directory: path.join(directory, "session") };
  await mkdir(session.directory, { mode: 0o700 });
  try {
    await writeStoredZip(path.join(directory, "review.zip"), [
      { name: "src/index.js", contents: "export const marker = 42;\n" },
      { name: "README.md", contents: "safe archive\n" },
    ]);
    const prepared = await prepareZipAttachments({ zipFiles: ["review.zip"], cwd: directory, session });
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].filename, "review.zip");
    assert.equal(prepared[0].entryCount, 2);
    assert.match(prepared[0].sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await verifyPreparedZipAttachments(prepared, session.directory), [prepared[0].snapshotPath]);
    assert.deepEqual(await readFile(prepared[0].snapshotPath), await readFile(path.join(directory, "review.zip")));
    await appendFile(prepared[0].snapshotPath, "tampered");
    await assert.rejects(
      () => verifyPreparedZipAttachments(prepared, session.directory),
      (error) => error.code === "ZIP_SNAPSHOT_CHANGED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects traversal, secret, encrypted, symlink, duplicate, and bomb-like ZIP entries", () => {
  const cases = [
    [createStoredZip([{ name: "../escape.txt", contents: "x" }]), "ZIP_ENTRY_PATH_UNSAFE"],
    [createStoredZip([{ name: ".env", contents: "TOKEN=x" }]), "ZIP_SENSITIVE_ENTRY"],
    [createStoredZip([{ name: "secret.txt", contents: "x", flags: 0x0801 }]), "ZIP_ENCRYPTED_UNSUPPORTED"],
    [createStoredZip([{ name: "link", contents: "target", mode: 0o120777 }]), "ZIP_SPECIAL_ENTRY"],
    [createStoredZip([{ name: "same.txt", contents: "a" }, { name: "SAME.txt", contents: "b" }]), "ZIP_DUPLICATE_ENTRY"],
    [createStoredZip([{ name: "bomb.txt", contents: "x", method: 8, compressedBytes: 1, uncompressedBytes: ZIP_LIMITS.maxCompressionRatio + 1 }]), "ZIP_COMPRESSION_RATIO"],
  ];
  for (const [buffer, code] of cases) {
    assert.throws(() => inspectZipBuffer(buffer), (error) => error.code === code, code);
  }
});

test("accepts only explicit regular .zip files and bounded unique filenames", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-zip-input-"));
  const session = { id: "fixture", directory };
  try {
    await assert.rejects(
      () => prepareZipAttachments({ zipFiles: ["not-a-zip.txt"], cwd: directory, session }),
      (error) => error.code === "ZIP_EXTENSION_REQUIRED",
    );
    await assert.rejects(
      () => prepareZipAttachments({ zipFiles: Array.from({ length: ZIP_LIMITS.maxArchives + 1 }, (_, i) => `${i}.zip`), cwd: directory, session }),
      (error) => error.code === "ZIP_FILE_LIMIT",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
