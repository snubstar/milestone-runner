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
