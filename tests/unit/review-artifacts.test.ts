import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildBaseMalformedReviewArtifactPath,
  buildBaseReviewArtifactPaths,
  buildBaseReviewRepairArtifactPath,
  buildBaseReviewResolutionArtifactPath,
  buildFixAttemptArtifactPaths,
  buildFixAttemptMalformedReviewArtifactPath,
  buildFixAttemptReviewRepairArtifactPath,
  buildFixAttemptReviewResolutionArtifactPath,
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
    reviewPaths.files.evidence,
    path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "reviews",
      "19-milestone-12-review-evidence.md",
    ),
  );
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
    evidence: path.join("reviews", "19-milestone-12-review-evidence.md"),
    review: path.join("reviews", "20-milestone-12-review.json"),
    summary: path.join("milestones", "25-milestone-12-review-summary.md"),
  });
  assert.deepEqual(reviewPaths.stateKeys, {
    evidence: "12-evidence",
    review: "12",
    summary: "12-review",
  });
});

test("buildBaseMalformedReviewArtifactPath creates expected malformed review paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const artifactPath = buildBaseMalformedReviewArtifactPath(runPaths, 12);

  assert.deepEqual(artifactPath, {
    file: path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "reviews",
      "20-milestone-12-review-malformed.json",
    ),
    statePath: path.join("reviews", "20-milestone-12-review-malformed.json"),
    stateKey: "12-malformed",
  });
});

test("buildBaseReviewRepairArtifactPath creates expected repair diagnostic paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const artifactPath = buildBaseReviewRepairArtifactPath(runPaths, 12, 2);

  assert.deepEqual(artifactPath, {
    file: path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "reviews",
      "21-milestone-12-review-repair-2.json",
    ),
    statePath: path.join("reviews", "21-milestone-12-review-repair-2.json"),
    stateKey: "12-repair-2",
  });
});

test("buildBaseReviewResolutionArtifactPath creates expected resolution paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const artifactPath = buildBaseReviewResolutionArtifactPath(runPaths, 12, 2);

  assert.deepEqual(artifactPath, {
    file: path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "reviews",
      "22-milestone-12-autonomous-resolution-2.json",
    ),
    statePath: path.join("reviews", "22-milestone-12-autonomous-resolution-2.json"),
    stateKey: "12-resolution-2",
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
    fixPaths.files.evidence,
    path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "reviews",
      "23-milestone-12-review-evidence-after-fix-3.md",
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
    evidence: path.join("reviews", "23-milestone-12-review-evidence-after-fix-3.md"),
    review: path.join("reviews", "24-milestone-12-review-after-fix-3.json"),
  });
  assert.deepEqual(fixPaths.stateKeys, {
    evidence: "12-fix-3-evidence",
  });
});

test("buildFixAttemptMalformedReviewArtifactPath creates expected malformed post-fix paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const artifactPath = buildFixAttemptMalformedReviewArtifactPath(runPaths, 12, 3);

  assert.deepEqual(artifactPath, {
    file: path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "reviews",
      "24-milestone-12-review-after-fix-3-malformed.json",
    ),
    statePath: path.join("reviews", "24-milestone-12-review-after-fix-3-malformed.json"),
    stateKey: "12-fix-3-malformed",
  });
});

test("buildFixAttemptReviewRepairArtifactPath creates expected post-fix repair paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const artifactPath = buildFixAttemptReviewRepairArtifactPath(runPaths, 12, 3, 2);

  assert.deepEqual(artifactPath, {
    file: path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "reviews",
      "61-milestone-12-post-fix-3-review-repair-2.json",
    ),
    statePath: path.join("reviews", "61-milestone-12-post-fix-3-review-repair-2.json"),
    stateKey: "12-fix-3-repair-2",
  });
});

test("buildFixAttemptReviewResolutionArtifactPath creates expected post-fix resolution paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const artifactPath = buildFixAttemptReviewResolutionArtifactPath(runPaths, 12, 3, 2);

  assert.deepEqual(artifactPath, {
    file: path.resolve(
      "/repo",
      ".agent-work",
      "run-1",
      "reviews",
      "62-milestone-12-post-fix-3-autonomous-resolution-2.json",
    ),
    statePath: path.join("reviews", "62-milestone-12-post-fix-3-autonomous-resolution-2.json"),
    stateKey: "12-fix-3-resolution-2",
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
  assert.throws(
    () => buildBaseReviewRepairArtifactPath(runPaths, 12, 0),
    /Review repair attempt must be a positive integer/,
  );
  assert.throws(
    () => buildBaseReviewResolutionArtifactPath(runPaths, 12, 0),
    /Review resolution attempt must be a positive integer/,
  );
  assert.throws(
    () => buildFixAttemptMalformedReviewArtifactPath(runPaths, 12, 0),
    /Fix attempt must be a positive integer/,
  );
  assert.throws(
    () => buildFixAttemptReviewRepairArtifactPath(runPaths, 12, 1, 0),
    /Review repair attempt must be a positive integer/,
  );
  assert.throws(
    () => buildFixAttemptReviewResolutionArtifactPath(runPaths, 12, 1, 0),
    /Review resolution attempt must be a positive integer/,
  );
});
