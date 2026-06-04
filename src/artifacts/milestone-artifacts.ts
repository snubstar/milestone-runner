import path from "node:path";

import { toRunRelativePath, type RunPaths } from "./paths.js";

export interface MilestoneArtifactPaths {
  files: {
    milestonePlanDraft: string;
    milestonePlanReview: string;
    milestonePlan: string;
    implementation: string;
    diff: string;
    checks: string;
    summary: string;
  };
  statePaths: {
    milestonePlanDraft: string;
    milestonePlanReview: string;
    milestonePlan: string;
    implementation: string;
    diff: string;
    checks: string;
    summary: string;
  };
}

export interface CheckFailureArtifactPath {
  file: string;
  statePath: string;
  stateKey: string;
}

export interface CheckRepairAttemptArtifactPaths {
  attempt: number;
  stateKey: string;
  files: {
    fix: string;
    diff: string;
    checks: string;
    checkFailure: string;
  };
  statePaths: {
    fix: string;
    diff: string;
    checks: string;
    checkFailure: string;
  };
}

export interface RecheckAttemptArtifactPaths {
  attempt: number;
  stateKey: string;
  files: {
    diff: string;
    checks: string;
    checkFailure: string;
    summary: string;
  };
  statePaths: {
    diff: string;
    checks: string;
    checkFailure: string;
    summary: string;
  };
}

export function buildMilestoneArtifactPaths(
  paths: RunPaths,
  milestoneId: number,
): MilestoneArtifactPaths {
  const suffix = `milestone-${milestoneId}`;
  const files = {
    milestonePlanDraft: path.join(paths.dirs.milestones, `10-${suffix}-plan-draft.md`),
    milestonePlanReview: path.join(paths.dirs.milestones, `10-${suffix}-plan-review.md`),
    milestonePlan: path.join(paths.dirs.milestones, `10-${suffix}-plan.md`),
    implementation: path.join(paths.dirs.milestones, `11-${suffix}-implementation.md`),
    diff: path.join(paths.dirs.diffs, `12-${suffix}.diff`),
    checks: path.join(paths.dirs.checks, `13-${suffix}-checks.txt`),
    summary: path.join(paths.dirs.milestones, `14-${suffix}-summary.md`),
  };

  return {
    files,
    statePaths: {
      milestonePlanDraft: toRunRelativePath(paths.runDir, files.milestonePlanDraft),
      milestonePlanReview: toRunRelativePath(paths.runDir, files.milestonePlanReview),
      milestonePlan: toRunRelativePath(paths.runDir, files.milestonePlan),
      implementation: toRunRelativePath(paths.runDir, files.implementation),
      diff: toRunRelativePath(paths.runDir, files.diff),
      checks: toRunRelativePath(paths.runDir, files.checks),
      summary: toRunRelativePath(paths.runDir, files.summary),
    },
  };
}

export function buildCheckFailureArtifactPath(
  paths: RunPaths,
  milestoneId: number,
  attempt: number,
): CheckFailureArtifactPath {
  assertPositiveAttempt("Check failure attempt", attempt);

  const suffix = `milestone-${milestoneId}`;
  const file = path.join(
    paths.dirs.checks,
    `13-${suffix}-check-failure-${attempt}.json`,
  );

  return {
    file,
    statePath: toRunRelativePath(paths.runDir, file),
    stateKey: `${milestoneId}-failed-${attempt}`,
  };
}

export function buildCheckRepairAttemptArtifactPaths(
  paths: RunPaths,
  milestoneId: number,
  attempt: number,
): CheckRepairAttemptArtifactPaths {
  assertPositiveAttempt("Check repair attempt", attempt);

  const suffix = `milestone-${milestoneId}`;
  const stateKey = `${milestoneId}-repair-${attempt}`;
  const files = {
    fix: path.join(paths.dirs.fixes, `21-${suffix}-check-repair-${attempt}.md`),
    diff: path.join(
      paths.dirs.diffs,
      `22-${suffix}-diff-after-check-repair-${attempt}.diff`,
    ),
    checks: path.join(
      paths.dirs.checks,
      `23-${suffix}-checks-after-check-repair-${attempt}.txt`,
    ),
    checkFailure: path.join(
      paths.dirs.checks,
      `23-${suffix}-check-failure-after-check-repair-${attempt}.json`,
    ),
  };

  return {
    attempt,
    stateKey,
    files,
    statePaths: {
      fix: toRunRelativePath(paths.runDir, files.fix),
      diff: toRunRelativePath(paths.runDir, files.diff),
      checks: toRunRelativePath(paths.runDir, files.checks),
      checkFailure: toRunRelativePath(paths.runDir, files.checkFailure),
    },
  };
}

export function buildRecheckAttemptArtifactPaths(
  paths: RunPaths,
  milestoneId: number,
  attempt: number,
): RecheckAttemptArtifactPaths {
  assertPositiveAttempt("Recheck attempt", attempt);

  const suffix = `milestone-${milestoneId}`;
  const stateKey = `${milestoneId}-recheck-${attempt}`;
  const files = {
    diff: path.join(paths.dirs.diffs, `30-${suffix}-recheck-${attempt}.diff`),
    checks: path.join(paths.dirs.checks, `31-${suffix}-recheck-${attempt}.txt`),
    checkFailure: path.join(
      paths.dirs.checks,
      `31-${suffix}-check-failure-after-recheck-${attempt}.json`,
    ),
    summary: path.join(
      paths.dirs.milestones,
      `32-${suffix}-recheck-${attempt}-summary.md`,
    ),
  };

  return {
    attempt,
    stateKey,
    files,
    statePaths: {
      diff: toRunRelativePath(paths.runDir, files.diff),
      checks: toRunRelativePath(paths.runDir, files.checks),
      checkFailure: toRunRelativePath(paths.runDir, files.checkFailure),
      summary: toRunRelativePath(paths.runDir, files.summary),
    },
  };
}

function assertPositiveAttempt(label: string, attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`${label} must be a positive integer, got ${attempt}.`);
  }
}
