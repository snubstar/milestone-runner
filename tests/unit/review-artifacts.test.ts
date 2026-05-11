import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildBaseReviewArtifactPaths,
  buildFixAttemptArtifactPaths,
} from "../../src/artifacts/review-artifacts.js";
import { buildRunPaths } from "../../src/artifacts/paths.js";

test("buildBaseReviewArtifactPaths creates expected review artifact paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const reviewPaths = buildBaseReviewArtifactPaths(runPaths, 12);

  assert.equal(
    reviewPaths.files.review,
    path.resolve("/repo", ".agent-work", "run-1", "reviews", "20-milestone-12-review.json"),
  );
  assert.equal(
    reviewPaths.files.summary,
    path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "milestones",
      "25-milestone-12-review-summary.md",
    ),
  );
  assert.deepEqual(reviewPaths.statePaths, {
    review: path.join("reviews", "20-milestone-12-review.json"),
    summary: path.join("milestones", "25-milestone-12-review-summary.md"),
  });
  assert.deepEqual(reviewPaths.stateKeys, {
    review: "12",
    summary: "12-review",
  });
});

test("buildFixAttemptArtifactPaths creates expected fix attempt artifact paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const fixPaths = buildFixAttemptArtifactPaths(runPaths, 12, 3);

  assert.equal(fixPaths.attempt, 3);
  assert.equal(fixPaths.stateKey, "12-fix-3");
  assert.equal(
    fixPaths.files.fix,
    path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "fixes",
      "21-milestone-12-fix-attempt-3.md",
    ),
  );
  assert.equal(
    fixPaths.files.diff,
    path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "diffs",
      "22-milestone-12-diff-after-fix-3.diff",
    ),
  );
  assert.equal(
    fixPaths.files.checks,
    path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "checks",
      "23-milestone-12-checks-after-fix-3.txt",
    ),
  );
  assert.equal(
    fixPaths.files.review,
    path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "reviews",
      "24-milestone-12-review-after-fix-3.json",
    ),
  );
  assert.deepEqual(fixPaths.statePaths, {
    fix: path.join("fixes", "21-milestone-12-fix-attempt-3.md"),
    diff: path.join("diffs", "22-milestone-12-diff-after-fix-3.diff"),
    checks: path.join("checks", "23-milestone-12-checks-after-fix-3.txt"),
    review: path.join("reviews", "24-milestone-12-review-after-fix-3.json"),
  });
});

test("buildFixAttemptArtifactPaths rejects invalid attempt numbers", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });

  assert.throws(
    () => buildFixAttemptArtifactPaths(runPaths, 12, 0),
    /Fix attempt must be a positive integer/,
  );
});
