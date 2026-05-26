import { writeFile } from "node:fs/promises";
import path from "node:path";

import { toRunRelativePath, type RunPaths } from "./paths.js";

export interface PlanningArtifactPaths {
  files: {
    majorPlan: string;
    majorPlanReview: string;
    finalMajorPlanMarkdown: string;
    milestones: string;
  };
  statePaths: {
    majorPlan: string;
    majorPlanReview: string;
    finalMajorPlanMarkdown: string;
    milestones: string;
  };
}

export function buildPlanningArtifactPaths(paths: RunPaths): PlanningArtifactPaths {
  const files = {
    majorPlan: path.join(paths.dirs.plans, "01-major-plan.md"),
    majorPlanReview: path.join(paths.dirs.plans, "02-major-plan-review.md"),
    finalMajorPlanMarkdown: path.join(paths.dirs.plans, "03-final-major-plan.md"),
    milestones: path.join(paths.dirs.milestones, "05-milestones.json"),
  };

  return {
    files,
    statePaths: {
      majorPlan: toRunRelativePath(paths.runDir, files.majorPlan),
      majorPlanReview: toRunRelativePath(paths.runDir, files.majorPlanReview),
      finalMajorPlanMarkdown: toRunRelativePath(paths.runDir, files.finalMajorPlanMarkdown),
      milestones: toRunRelativePath(paths.runDir, files.milestones),
    },
  };
}

export async function writeTextArtifact(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, `${content.trimEnd()}\n`, "utf8");
}

export async function writeJsonArtifact(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
