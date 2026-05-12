import { randomBytes } from "node:crypto";
import path from "node:path";

export interface RunPathOptions {
  cwd: string;
  artifactRoot: string;
  runId: string;
}

export interface RunDirPathOptions {
  runDir: string;
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
  return buildRunPathsFromResolvedParts({
    artifactRoot,
    runDir,
    runId: options.runId,
  });
}

export function buildRunPathsFromRunDir(options: RunDirPathOptions): RunPaths {
  const runDir = path.resolve(options.runDir);
  return buildRunPathsFromResolvedParts({
    artifactRoot: path.dirname(runDir),
    runDir,
    runId: options.runId,
  });
}

function buildRunPathsFromResolvedParts(options: {
  artifactRoot: string;
  runDir: string;
  runId: string;
}): RunPaths {
  const dirs = {
    logs: path.join(options.runDir, "logs"),
    plans: path.join(options.runDir, "plans"),
    milestones: path.join(options.runDir, "milestones"),
    reviews: path.join(options.runDir, "reviews"),
    checks: path.join(options.runDir, "checks"),
    diffs: path.join(options.runDir, "diffs"),
    fixes: path.join(options.runDir, "fixes"),
  };

  return {
    artifactRoot: options.artifactRoot,
    runId: options.runId,
    runDir: options.runDir,
    dirs,
    files: {
      goal: path.join(options.runDir, "00-goal.txt"),
      state: path.join(options.runDir, "state.json"),
      runLog: path.join(dirs.logs, "run.log"),
    },
  };
}

export function toRunRelativePath(runDir: string, filePath: string): string {
  return path.relative(runDir, filePath);
}
