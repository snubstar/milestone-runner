import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRunArtifactPath, type RunPaths } from "../artifacts/paths.js";
import { captureGitDiff, type CaptureGitDiffResult } from "../git/git-diff.js";
import type { MilestoneMetadata } from "../milestones/milestone-types.js";
import type { CommandResult, CommandRunner } from "../shell/command-runner.js";
import type { RunState } from "../state/state-types.js";

export type MilestoneBaselineResult =
  | {
      ok: true;
      baselineTree: string;
      source: "stored" | "reconstructed";
    }
  | {
      ok: false;
      error: string;
      details?: CommandResult;
    };

export interface ResolveMilestoneBaselineOptions {
  state: RunState;
  metadata: MilestoneMetadata;
  milestoneId: number;
  paths: RunPaths;
  cwd: string;
  commandRunner: CommandRunner;
}

export interface CaptureReviewableMilestoneDiffOptions {
  cwd: string;
  commandRunner: CommandRunner;
  paths: RunPaths;
  baselineTree: string;
}

export async function resolveMilestoneBaseline(
  options: ResolveMilestoneBaselineOptions,
): Promise<MilestoneBaselineResult> {
  const storedBaseline = options.state.milestoneBaselines[String(options.milestoneId)];
  if (storedBaseline) {
    return {
      ok: true,
      baselineTree: storedBaseline,
      source: "stored",
    };
  }

  return reconstructLegacyMilestoneBaseline(options);
}

export function captureReviewableMilestoneDiff(
  options: CaptureReviewableMilestoneDiffOptions,
): Promise<CaptureGitDiffResult> {
  return captureGitDiff({
    cwd: options.cwd,
    commandRunner: options.commandRunner,
    excludedPaths: [options.paths.runDir],
    baseTree: options.baselineTree,
  });
}

async function reconstructLegacyMilestoneBaseline(
  options: ResolveMilestoneBaselineOptions,
): Promise<MilestoneBaselineResult> {
  if (!options.state.git.startSha) {
    return {
      ok: false,
      error: "Cannot reconstruct milestone baseline because state.git.startSha is missing.",
    };
  }

  const targetIndex = options.metadata.milestones.findIndex(
    (milestone) => milestone.id === options.milestoneId,
  );
  if (targetIndex === -1) {
    return {
      ok: false,
      error: `Cannot reconstruct milestone baseline because milestone ${options.milestoneId} is missing from metadata.`,
    };
  }

  const priorPassedMilestones = options.metadata.milestones
    .slice(0, targetIndex)
    .filter((milestone) => options.state.milestoneStatuses[String(milestone.id)] === "passed");

  const gitRootResult = await gitRootForCwd(options.commandRunner, options.cwd);
  if (!gitRootResult.ok) return gitRootResult;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-baseline-"));
  const tempIndex = path.join(tempDir, "index");
  const env = { GIT_INDEX_FILE: tempIndex };

  try {
    const readTreeResult = await options.commandRunner.run({
      command: "git",
      args: ["read-tree", options.state.git.startSha],
      cwd: gitRootResult.root,
      env,
    });
    if (readTreeResult.exitCode !== 0) {
      return {
        ok: false,
        error: "Failed to initialize temporary index for milestone baseline reconstruction.",
        details: readTreeResult,
      };
    }

    for (const milestone of priorPassedMilestones) {
      const diffPath = options.state.artifacts.diffs?.[String(milestone.id)];
      if (!diffPath) {
        return {
          ok: false,
          error: `Cannot reconstruct milestone baseline because passed milestone ${milestone.id} has no diff artifact.`,
        };
      }

      const diffResult = await readRunArtifact(options.paths.runDir, diffPath);
      if (!diffResult.ok) {
        return {
          ok: false,
          error: `Cannot reconstruct milestone baseline: ${diffResult.error}`,
        };
      }

      if (diffResult.content.trim().length === 0) continue;

      const applyResult = await options.commandRunner.run({
        command: "git",
        args: ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"],
        cwd: gitRootResult.root,
        env,
        stdin: diffResult.content,
      });
      if (applyResult.exitCode !== 0) {
        return {
          ok: false,
          error: `Failed to apply diff artifact for passed milestone ${milestone.id} while reconstructing milestone baseline.`,
          details: applyResult,
        };
      }
    }

    const writeTreeResult = await options.commandRunner.run({
      command: "git",
      args: ["write-tree"],
      cwd: gitRootResult.root,
      env,
    });
    if (writeTreeResult.exitCode !== 0) {
      return {
        ok: false,
        error: "Failed to write reconstructed milestone baseline tree.",
        details: writeTreeResult,
      };
    }

    return {
      ok: true,
      baselineTree: writeTreeResult.stdout.trim(),
      source: "reconstructed",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function gitRootForCwd(
  commandRunner: CommandRunner,
  cwd: string,
): Promise<{ ok: true; root: string } | { ok: false; error: string; details?: CommandResult }> {
  const result = await commandRunner.run({
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd,
  });

  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: "Failed to find Git root for milestone baseline reconstruction.",
      details: result,
    };
  }

  return { ok: true, root: result.stdout.trim() };
}

async function readRunArtifact(
  runDir: string,
  artifactPath: string,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const resolvedPath = resolveRunArtifactPath(runDir, artifactPath);
  if (!resolvedPath.ok) {
    return {
      ok: false,
      error: `Invalid run artifact path ${artifactPath}: ${resolvedPath.error}`,
    };
  }

  try {
    return { ok: true, content: await readFile(resolvedPath.path, "utf8") };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read run artifact ${artifactPath}: ${formatError(error)}`,
    };
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
