import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildMilestoneArtifactPaths } from "../../src/artifacts/milestone-artifacts.js";
import { buildRunPaths } from "../../src/artifacts/paths.js";

test("buildMilestoneArtifactPaths creates expected milestone artifact paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const milestonePaths = buildMilestoneArtifactPaths(runPaths, 12);

  assert.equal(
    milestonePaths.files.milestonePlan,
    path.resolve("/repo", ".agent-work", "run-1", "milestones", "10-milestone-12-plan.md"),
  );
  assert.equal(
    milestonePaths.files.implementation,
    path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "milestones",
      "11-milestone-12-implementation.md",
    ),
  );
  assert.equal(
    milestonePaths.files.diff,
    path.resolve("/repo", ".agent-work", "run-1", "diffs", "12-milestone-12.diff"),
  );
  assert.equal(
    milestonePaths.files.checks,
    path.resolve("/repo", ".agent-work", "run-1", "checks", "13-milestone-12-checks.txt"),
  );
  assert.equal(
    milestonePaths.files.summary,
    path.resolve("/repo", ".agent-work", "run-1", "milestones", "14-milestone-12-summary.md"),
  );
  assert.deepEqual(milestonePaths.statePaths, {
    milestonePlan: path.join("milestones", "10-milestone-12-plan.md"),
    implementation: path.join("milestones", "11-milestone-12-implementation.md"),
    diff: path.join("diffs", "12-milestone-12.diff"),
    checks: path.join("checks", "13-milestone-12-checks.txt"),
    summary: path.join("milestones", "14-milestone-12-summary.md"),
  });
});
