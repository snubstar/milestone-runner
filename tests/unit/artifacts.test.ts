import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildRunPaths,
  createRunId,
  toRunRelativePath,
} from "../../src/artifacts/paths.js";

test("createRunId creates a filesystem-safe id", () => {
  const runId = createRunId(new Date("2026-05-10T12:34:56.789Z"), "deadbeef");

  assert.equal(runId, "run-20260510123456789-deadbeef");
});

test("createRunId adds random entropy by default", () => {
  const runId = createRunId(new Date("2026-05-10T12:34:56.789Z"));

  assert.match(runId, /^run-20260510123456789-[0-9a-f]{8}$/);
});

test("buildRunPaths creates expected run paths", () => {
  const paths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });

  assert.equal(paths.artifactRoot, path.resolve("/repo", ".agent-work"));
  assert.equal(paths.runDir, path.resolve("/repo", ".agent-work", "run-1"));
  assert.equal(paths.files.goal, path.resolve("/repo", ".agent-work", "run-1", "00-goal.txt"));
  assert.equal(paths.files.state, path.resolve("/repo", ".agent-work", "run-1", "state.json"));
  assert.equal(paths.files.runLog, path.resolve("/repo", ".agent-work", "run-1", "logs", "run.log"));
  assert.equal(paths.dirs.fixes, path.resolve("/repo", ".agent-work", "run-1", "fixes"));
});

test("toRunRelativePath returns path relative to run directory", () => {
  assert.equal(
    toRunRelativePath("/repo/.agent-work/run-1", "/repo/.agent-work/run-1/logs/run.log"),
    "logs/run.log",
  );
});
