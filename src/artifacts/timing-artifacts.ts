import path from "node:path";

import { toRunRelativePath, type RunPaths } from "./paths.js";

export interface TimingArtifactPaths {
  files: {
    timeline: string;
    timingsJson: string;
    timingsMarkdown: string;
  };
  statePaths: {
    timeline: string;
    timingsJson: string;
    timingsMarkdown: string;
  };
}

export function buildTimingArtifactPaths(paths: RunPaths): TimingArtifactPaths {
  const files = {
    timeline: path.join(paths.dirs.logs, "timeline.jsonl"),
    timingsJson: path.join(paths.dirs.logs, "80-timings.json"),
    timingsMarkdown: path.join(paths.dirs.logs, "81-timings.md"),
  };

  return {
    files,
    statePaths: {
      timeline: toRunRelativePath(paths.runDir, files.timeline),
      timingsJson: toRunRelativePath(paths.runDir, files.timingsJson),
      timingsMarkdown: toRunRelativePath(paths.runDir, files.timingsMarkdown),
    },
  };
}
