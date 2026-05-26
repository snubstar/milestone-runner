import path from "node:path";

import { toRunRelativePath, type RunPaths } from "./paths.js";

export interface GoalArtifactPaths {
  files: {
    summary: string;
  };
  statePaths: {
    summary: string;
  };
  stateKeys: {
    summary: "goal";
  };
}

export function buildGoalArtifactPaths(paths: RunPaths): GoalArtifactPaths {
  const files = {
    summary: path.join(paths.dirs.milestones, "90-goal-summary.md"),
  };

  return {
    files,
    statePaths: {
      summary: toRunRelativePath(paths.runDir, files.summary),
    },
    stateKeys: {
      summary: "goal",
    },
  };
}
