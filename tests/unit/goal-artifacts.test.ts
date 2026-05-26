import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildGoalArtifactPaths } from "../../src/artifacts/goal-artifacts.js";
import { buildRunPaths } from "../../src/artifacts/paths.js";

test("buildGoalArtifactPaths creates expected final goal summary paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const goalPaths = buildGoalArtifactPaths(runPaths);

  assert.equal(
    goalPaths.files.summary,
    path.resolve("/repo", ".agent-work", "run-1", "milestones", "90-goal-summary.md"),
  );
  assert.deepEqual(goalPaths.statePaths, {
    summary: path.join("milestones", "90-goal-summary.md"),
  });
  assert.deepEqual(goalPaths.stateKeys, {
    summary: "goal",
  });
});
