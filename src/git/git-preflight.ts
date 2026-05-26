import type { CommandRunner } from "../shell/command-runner.js";
import type { GitMetadata, GitPreflightResult } from "./git-types.js";

export interface GitPreflightOptions {
  cwd: string;
  planningOnly: boolean;
  allowDirty: boolean;
  allowNonGitPlanning: boolean;
  commandRunner: CommandRunner;
}

export async function runGitPreflight(
  options: GitPreflightOptions,
): Promise<GitPreflightResult> {
  const metadata: GitMetadata = {
    required: !options.planningOnly,
    planningOnly: options.planningOnly,
    root: null,
    startSha: null,
    dirtyAtStart: false,
    dirtyOverride: false,
    statusPorcelain: "",
  };

  const rootResult = await options.commandRunner.run({
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd: options.cwd,
  });

  if (rootResult.exitCode !== 0) {
    if (options.planningOnly) {
      if (options.allowNonGitPlanning) {
        return { ok: true, metadata };
      }

      return {
        ok: false,
        error:
          "Not inside a Git repository. Rerun planning-only with --allow-non-git-planning to continue without Git metadata.",
        metadata,
      };
    }

    return {
      ok: false,
      error: "Not inside a Git repository.",
      metadata,
    };
  }

  metadata.root = rootResult.stdout.trim();

  const headResult = await options.commandRunner.run({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: options.cwd,
  });

  if (headResult.exitCode !== 0) {
    if (options.planningOnly) {
      return { ok: true, metadata };
    }

    return {
      ok: false,
      error: "Git repository has no commits.",
      metadata,
    };
  }

  metadata.startSha = headResult.stdout.trim();

  const statusResult = await options.commandRunner.run({
    command: "git",
    args: ["status", "--porcelain"],
    cwd: options.cwd,
  });

  if (statusResult.exitCode !== 0) {
    if (options.planningOnly) {
      return { ok: true, metadata };
    }

    return {
      ok: false,
      error: "Failed to read Git working tree status.",
      metadata,
    };
  }

  metadata.statusPorcelain = statusResult.stdout;
  metadata.dirtyAtStart = statusResult.stdout.trim().length > 0;

  if (metadata.dirtyAtStart && !options.allowDirty && !options.planningOnly) {
    return {
      ok: false,
      error: "Git working tree is dirty. Commit changes or rerun with --allow-dirty.",
      metadata,
    };
  }

  metadata.dirtyOverride = metadata.dirtyAtStart && options.allowDirty;

  return { ok: true, metadata };
}
