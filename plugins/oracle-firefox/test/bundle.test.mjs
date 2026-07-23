import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundleContext } from "../src/bundle.mjs";

test("bundles line-numbered UTF-8 files and applies excludes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-bundle-"));
  try {
    await mkdir(path.join(directory, "src"));
    await writeFile(path.join(directory, "src", "keep.js"), "export const answer = 42;\n");
    await writeFile(path.join(directory, "src", "skip.test.js"), "throw new Error('skip');\n");
    const result = await bundleContext({
      prompt: "Review this module.",
      files: ["src/**/*.js", "!src/**/*.test.js"],
      cwd: directory,
    });
    assert.equal(result.included.length, 1);
    assert.match(result.bundle, /### File: src\/keep\.js/);
    assert.match(result.bundle, /1 \| export const answer = 42;/);
    assert.doesNotMatch(result.bundle, /skip\.test\.js/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses common secret files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-firefox-secret-"));
  try {
    await writeFile(path.join(directory, ".env"), "TOKEN=secret\n");
    await assert.rejects(
      bundleContext({ prompt: "Review", files: [".env"], cwd: directory }),
      /Refusing to bundle potentially sensitive file/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
