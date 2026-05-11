import { randomBytes } from "node:crypto";
import path from "node:path";

export interface RunPathOptions {
  cwd: string;
  artifactRoot: string;
  runId: string;
}

export interface RunPaths {
  artifactRoot: string;
  runId: string;
  runDir: string;
  dirs: {
    logs: string;
    plans: string;
    milestones: string;
    reviews: string;
    checks: string;
    diffs: string;
    fixes: string;
  };
  files: {
    goal: string;
    state: string;
    runLog: string;
  };
}

export function createRunId(date = new Date(), entropy = randomBytes(4).toString("hex")): string {
  return `run-${date.toISOString().replace(/\D/g, "")}-${entropy}`;
}

export function buildRunPaths(options: RunPathOptions): RunPaths {
  const artifactRoot = path.resolve(options.cwd, options.artifactRoot);
  const runDir = path.join(artifactRoot, options.runId);
  const dirs = {
    logs: path.join(runDir, "logs"),
    plans: path.join(runDir, "plans"),
    milestones: path.join(runDir, "milestones"),
    reviews: path.join(runDir, "reviews"),
    checks: path.join(runDir, "checks"),
    diffs: path.join(runDir, "diffs"),
    fixes: path.join(runDir, "fixes"),
  };

  return {
    artifactRoot,
    runId: options.runId,
    runDir,
    dirs,
    files: {
      goal: path.join(runDir, "00-goal.txt"),
      state: path.join(runDir, "state.json"),
      runLog: path.join(dirs.logs, "run.log"),
    },
  };
}

export function toRunRelativePath(runDir: string, filePath: string): string {
  return path.relative(runDir, filePath);
}
