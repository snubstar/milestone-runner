import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildCheckFailureArtifactPath,
  buildCheckRepairAttemptArtifactPaths,
  buildMilestoneArtifactPaths,
  buildRecheckAttemptArtifactPaths,
} from "../../src/artifacts/milestone-artifacts.js";
import { buildRunPaths } from "../../src/artifacts/paths.js";

test("buildMilestoneArtifactPaths creates expected milestone artifact paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const milestonePaths = buildMilestoneArtifactPaths(runPaths, 12);

  assert.equal(
    milestonePaths.files.milestonePlanDraft,
    path.resolve("/repo", ".agent-work", "run-1", "milestones", "10-milestone-12-plan-draft.md"),
  );
  assert.equal(
    milestonePaths.files.milestonePlanReview,
    path.resolve("/repo", ".agent-work", "run-1", "milestones", "10-milestone-12-plan-review.md"),
  );
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
    milestonePlanDraft: path.join("milestones", "10-milestone-12-plan-draft.md"),
    milestonePlanReview: path.join("milestones", "10-milestone-12-plan-review.md"),
    milestonePlan: path.join("milestones", "10-milestone-12-plan.md"),
    implementation: path.join("milestones", "11-milestone-12-implementation.md"),
    diff: path.join("diffs", "12-milestone-12.diff"),
    checks: path.join("checks", "13-milestone-12-checks.txt"),
    summary: path.join("milestones", "14-milestone-12-summary.md"),
  });
});

test("buildCheckFailureArtifactPath creates expected failure summary paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const artifactPath = buildCheckFailureArtifactPath(runPaths, 12, 2);

  assert.deepEqual(artifactPath, {
    file: path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "checks",
      "13-milestone-12-check-failure-2.json",
    ),
    statePath: path.join("checks", "13-milestone-12-check-failure-2.json"),
    stateKey: "12-failed-2",
  });
});

test("buildCheckRepairAttemptArtifactPaths creates expected check repair paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const repairPaths = buildCheckRepairAttemptArtifactPaths(runPaths, 12, 2);

  assert.equal(repairPaths.attempt, 2);
  assert.equal(repairPaths.stateKey, "12-repair-2");
  assert.deepEqual(repairPaths.statePaths, {
    fix: path.join("fixes", "21-milestone-12-check-repair-2.md"),
    diff: path.join("diffs", "22-milestone-12-diff-after-check-repair-2.diff"),
    checks: path.join("checks", "23-milestone-12-checks-after-check-repair-2.txt"),
    checkFailure: path.join(
      "checks",
      "23-milestone-12-check-failure-after-check-repair-2.json",
    ),
  });
});

test("buildRecheckAttemptArtifactPaths creates expected recheck paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const recheckPaths = buildRecheckAttemptArtifactPaths(runPaths, 12, 2);

  assert.equal(recheckPaths.attempt, 2);
  assert.equal(recheckPaths.stateKey, "12-recheck-2");
  assert.deepEqual(recheckPaths.statePaths, {
    diff: path.join("diffs", "30-milestone-12-recheck-2.diff"),
    checks: path.join("checks", "31-milestone-12-recheck-2.txt"),
    checkFailure: path.join(
      "checks",
      "31-milestone-12-check-failure-after-recheck-2.json",
    ),
    summary: path.join("milestones", "32-milestone-12-recheck-2-summary.md"),
  });
});

test("check recovery artifact builders reject non-positive attempts", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });

  assert.throws(() => buildCheckFailureArtifactPath(runPaths, 12, 0), /positive integer/);
  assert.throws(() => buildCheckRepairAttemptArtifactPaths(runPaths, 12, 0), /positive integer/);
  assert.throws(() => buildRecheckAttemptArtifactPaths(runPaths, 12, 0), /positive integer/);
});
