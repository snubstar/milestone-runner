import path from "node:path";

import { toRunRelativePath, type RunPaths } from "./paths.js";

export interface BaseReviewArtifactPaths {
  files: {
    evidence: string;
    review: string;
    summary: string;
  };
  statePaths: {
    evidence: string;
    review: string;
    summary: string;
  };
  stateKeys: {
    evidence: string;
    review: string;
    summary: string;
  };
}

export interface FixAttemptArtifactPaths {
  attempt: number;
  stateKey: string;
  files: {
    fix: string;
    diff: string;
    checks: string;
    evidence: string;
    review: string;
  };
  statePaths: {
    fix: string;
    diff: string;
    checks: string;
    evidence: string;
    review: string;
  };
  stateKeys: {
    evidence: string;
  };
}

export interface ReviewDiagnosticArtifactPath {
  file: string;
  statePath: string;
  stateKey: string;
}

export function buildBaseReviewArtifactPaths(
  paths: RunPaths,
  milestoneId: number,
): BaseReviewArtifactPaths {
  const suffix = `milestone-${milestoneId}`;
  const files = {
    evidence: path.join(paths.dirs.reviews, `19-${suffix}-review-evidence.md`),
    review: path.join(paths.dirs.reviews, `20-${suffix}-review.json`),
    summary: path.join(paths.dirs.milestones, `25-${suffix}-review-summary.md`),
  };

  return {
    files,
    statePaths: {
      evidence: toRunRelativePath(paths.runDir, files.evidence),
      review: toRunRelativePath(paths.runDir, files.review),
      summary: toRunRelativePath(paths.runDir, files.summary),
    },
    stateKeys: {
      evidence: `${milestoneId}-evidence`,
      review: String(milestoneId),
      summary: `${milestoneId}-review`,
    },
  };
}

export function buildBaseMalformedReviewArtifactPath(
  paths: RunPaths,
  milestoneId: number,
): ReviewDiagnosticArtifactPath {
  const suffix = `milestone-${milestoneId}`;
  const file = path.join(paths.dirs.reviews, `20-${suffix}-review-malformed.json`);

  return {
    file,
    statePath: toRunRelativePath(paths.runDir, file),
    stateKey: `${milestoneId}-malformed`,
  };
}

export function buildBaseReviewRepairArtifactPath(
  paths: RunPaths,
  milestoneId: number,
  repairAttempt: number,
): ReviewDiagnosticArtifactPath {
  assertPositiveAttempt("Review repair attempt", repairAttempt);

  const suffix = `milestone-${milestoneId}`;
  const file = path.join(
    paths.dirs.reviews,
    `21-${suffix}-review-repair-${repairAttempt}.json`,
  );

  return {
    file,
    statePath: toRunRelativePath(paths.runDir, file),
    stateKey: `${milestoneId}-repair-${repairAttempt}`,
  };
}

export function buildBaseReviewResolutionArtifactPath(
  paths: RunPaths,
  milestoneId: number,
  resolutionAttempt: number,
): ReviewDiagnosticArtifactPath {
  assertPositiveAttempt("Review resolution attempt", resolutionAttempt);

  const suffix = `milestone-${milestoneId}`;
  const file = path.join(
    paths.dirs.reviews,
    `22-${suffix}-autonomous-resolution-${resolutionAttempt}.json`,
  );

  return {
    file,
    statePath: toRunRelativePath(paths.runDir, file),
    stateKey: `${milestoneId}-resolution-${resolutionAttempt}`,
  };
}

export function buildFixAttemptArtifactPaths(
  paths: RunPaths,
  milestoneId: number,
  attempt: number,
): FixAttemptArtifactPaths {
  assertPositiveAttempt("Fix attempt", attempt);

  const suffix = `milestone-${milestoneId}`;
  const stateKey = `${milestoneId}-fix-${attempt}`;
  const files = {
    fix: path.join(paths.dirs.fixes, `21-${suffix}-fix-attempt-${attempt}.md`),
    diff: path.join(paths.dirs.diffs, `22-${suffix}-diff-after-fix-${attempt}.diff`),
    checks: path.join(paths.dirs.checks, `23-${suffix}-checks-after-fix-${attempt}.txt`),
    evidence: path.join(
      paths.dirs.reviews,
      `23-${suffix}-review-evidence-after-fix-${attempt}.md`,
    ),
    review: path.join(paths.dirs.reviews, `24-${suffix}-review-after-fix-${attempt}.json`),
  };

  return {
    attempt,
    stateKey,
    files,
    statePaths: {
      fix: toRunRelativePath(paths.runDir, files.fix),
      diff: toRunRelativePath(paths.runDir, files.diff),
      checks: toRunRelativePath(paths.runDir, files.checks),
      evidence: toRunRelativePath(paths.runDir, files.evidence),
      review: toRunRelativePath(paths.runDir, files.review),
    },
    stateKeys: {
      evidence: `${stateKey}-evidence`,
    },
  };
}

export function buildFixAttemptMalformedReviewArtifactPath(
  paths: RunPaths,
  milestoneId: number,
  fixAttempt: number,
): ReviewDiagnosticArtifactPath {
  assertPositiveAttempt("Fix attempt", fixAttempt);

  const suffix = `milestone-${milestoneId}`;
  const file = path.join(
    paths.dirs.reviews,
    `24-${suffix}-review-after-fix-${fixAttempt}-malformed.json`,
  );

  return {
    file,
    statePath: toRunRelativePath(paths.runDir, file),
    stateKey: `${milestoneId}-fix-${fixAttempt}-malformed`,
  };
}

export function buildFixAttemptReviewRepairArtifactPath(
  paths: RunPaths,
  milestoneId: number,
  fixAttempt: number,
  repairAttempt: number,
): ReviewDiagnosticArtifactPath {
  assertPositiveAttempt("Fix attempt", fixAttempt);
  assertPositiveAttempt("Review repair attempt", repairAttempt);

  const suffix = `milestone-${milestoneId}`;
  const file = path.join(
    paths.dirs.reviews,
    `61-${suffix}-post-fix-${fixAttempt}-review-repair-${repairAttempt}.json`,
  );

  return {
    file,
    statePath: toRunRelativePath(paths.runDir, file),
    stateKey: `${milestoneId}-fix-${fixAttempt}-repair-${repairAttempt}`,
  };
}

export function buildFixAttemptReviewResolutionArtifactPath(
  paths: RunPaths,
  milestoneId: number,
  fixAttempt: number,
  resolutionAttempt: number,
): ReviewDiagnosticArtifactPath {
  assertPositiveAttempt("Fix attempt", fixAttempt);
  assertPositiveAttempt("Review resolution attempt", resolutionAttempt);

  const suffix = `milestone-${milestoneId}`;
  const file = path.join(
    paths.dirs.reviews,
    `62-${suffix}-post-fix-${fixAttempt}-autonomous-resolution-${resolutionAttempt}.json`,
  );

  return {
    file,
    statePath: toRunRelativePath(paths.runDir, file),
    stateKey: `${milestoneId}-fix-${fixAttempt}-resolution-${resolutionAttempt}`,
  };
}

function assertPositiveAttempt(label: string, attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`${label} must be a positive integer, got ${attempt}.`);
  }
}
