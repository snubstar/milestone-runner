import path from "node:path";

import { toRunRelativePath, type RunPaths } from "./paths.js";

export interface BaseReviewArtifactPaths {
  files: {
    review: string;
    summary: string;
  };
  statePaths: {
    review: string;
    summary: string;
  };
  stateKeys: {
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
    review: string;
  };
  statePaths: {
    fix: string;
    diff: string;
    checks: string;
    review: string;
  };
}

export function buildBaseReviewArtifactPaths(
  paths: RunPaths,
  milestoneId: number,
): BaseReviewArtifactPaths {
  const suffix = `milestone-${milestoneId}`;
  const files = {
    review: path.join(paths.dirs.reviews, `20-${suffix}-review.json`),
    summary: path.join(paths.dirs.milestones, `25-${suffix}-review-summary.md`),
  };

  return {
    files,
    statePaths: {
      review: toRunRelativePath(paths.runDir, files.review),
      summary: toRunRelativePath(paths.runDir, files.summary),
    },
    stateKeys: {
      review: String(milestoneId),
      summary: `${milestoneId}-review`,
    },
  };
}

export function buildFixAttemptArtifactPaths(
  paths: RunPaths,
  milestoneId: number,
  attempt: number,
): FixAttemptArtifactPaths {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`Fix attempt must be a positive integer, got ${attempt}.`);
  }

  const suffix = `milestone-${milestoneId}`;
  const stateKey = `${milestoneId}-fix-${attempt}`;
  const files = {
    fix: path.join(paths.dirs.fixes, `21-${suffix}-fix-attempt-${attempt}.md`),
    diff: path.join(paths.dirs.diffs, `22-${suffix}-diff-after-fix-${attempt}.diff`),
    checks: path.join(paths.dirs.checks, `23-${suffix}-checks-after-fix-${attempt}.txt`),
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
      review: toRunRelativePath(paths.runDir, files.review),
    },
  };
}
