import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectCoordinatorDatabase } from "../src/coordinator-diagnostics.mjs";
import { StateStore } from "../src/state-store.mjs";

test("offline coordinator inspection is read-only and reports schema fencing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-coordinator-inspect-"));
  const databasePath = path.join(root, "coordinator.sqlite");
  const priorCoordinator = process.env.ORACLE_FIREFOX_COORDINATOR_HOME;
  process.env.ORACLE_FIREFOX_COORDINATOR_HOME = root;
  const store = await new StateStore(databasePath).open();
  store.close();
  try {
    const inspected = await inspectCoordinatorDatabase(databasePath);
    assert.equal(inspected.readable, true);
    assert.equal(inspected.schemaVersion, 6);
    assert.equal(inspected.integrity, "ok");
    assert.equal(inspected.foreignKeyViolations, 0);
    assert.equal(inspected.broker.minimumWriterProtocol, 7);
    assert.equal(inspected.repairRequired, false);
  } finally {
    if (priorCoordinator === undefined) delete process.env.ORACLE_FIREFOX_COORDINATOR_HOME;
    else process.env.ORACLE_FIREFOX_COORDINATOR_HOME = priorCoordinator;
    await rm(root, { recursive: true, force: true });
  }
});
