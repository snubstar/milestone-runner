import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CommandResult, CommandRunner } from "../shell/command-runner.js";

export interface CaptureGitDiffOptions {
  cwd: string;
  commandRunner: CommandRunner;
  excludedPaths?: string[];
  baseTree?: string;
}

export interface CaptureGitTreeOptions {
  cwd: string;
  commandRunner: CommandRunner;
  excludedPaths?: string[];
}

export type CaptureGitDiffResult =
  | { ok: true; diff: string }
  | { ok: false; error: string; details?: CommandResult };

export type CaptureGitTreeResult =
  | { ok: true; tree: string }
  | { ok: false; error: string; details?: CommandResult };

export async function captureGitDiff(
  options: CaptureGitDiffOptions,
): Promise<CaptureGitDiffResult> {
  const setup = await prepareGitDiffSetup(options);
  if (!setup.ok) return setup;

  const index = await populateTemporaryIndex(setup.value);
  if (!index.ok) return index;

  try {
    const diffResult = await options.commandRunner.run({
      command: "git",
      args: [
        "diff",
        "--cached",
        "--binary",
        options.baseTree ?? "HEAD",
        "--",
        ...setup.value.pathspecs,
      ],
      cwd: setup.value.gitRoot,
      env: index.env,
    });
    if (diffResult.exitCode !== 0) {
      return {
        ok: false,
        error: "Failed to capture Git diff.",
        details: diffResult,
      };
    }

    return { ok: true, diff: diffResult.stdout };
  } finally {
    await rm(index.tempDir, { recursive: true, force: true });
  }
}

export async function captureGitTree(
  options: CaptureGitTreeOptions,
): Promise<CaptureGitTreeResult> {
  const setup = await prepareGitDiffSetup(options);
  if (!setup.ok) return setup;

  const index = await populateTemporaryIndex(setup.value);
  if (!index.ok) return index;

  try {
    const treeResult = await options.commandRunner.run({
      command: "git",
      args: ["write-tree"],
      cwd: setup.value.gitRoot,
      env: index.env,
    });
    if (treeResult.exitCode !== 0) {
      return {
        ok: false,
        error: "Failed to capture Git tree.",
        details: treeResult,
      };
    }

    return { ok: true, tree: treeResult.stdout.trim() };
  } finally {
    await rm(index.tempDir, { recursive: true, force: true });
  }
}

interface GitDiffSetup {
  gitRoot: string;
  gitDir: string;
  pathspecs: string[];
  commandRunner: CommandRunner;
}

async function prepareGitDiffSetup(options: {
  cwd: string;
  commandRunner: CommandRunner;
  excludedPaths?: string[];
}): Promise<{ ok: true; value: GitDiffSetup } | { ok: false; error: string; details?: CommandResult }> {
  const rootResult = await options.commandRunner.run({
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd: options.cwd,
  });
  if (rootResult.exitCode !== 0) {
    return {
      ok: false,
      error: "Failed to find Git root for diff capture.",
      details: rootResult,
    };
  }
  const gitRoot = await resolveExistingPath(rootResult.stdout.trim());

  const gitDirResult = await options.commandRunner.run({
    command: "git",
    args: ["rev-parse", "--git-dir"],
    cwd: gitRoot,
  });
  if (gitDirResult.exitCode !== 0) {
    return {
      ok: false,
      error: "Failed to find Git directory for diff capture.",
      details: gitDirResult,
    };
  }

  const gitDir = path.resolve(gitRoot, gitDirResult.stdout.trim());
  const pathspecs = await buildGitPathspecs(gitRoot, options.excludedPaths ?? []);
  return {
    ok: true,
    value: {
      gitRoot,
      gitDir,
      pathspecs,
      commandRunner: options.commandRunner,
    },
  };
}

async function populateTemporaryIndex(
  setup: GitDiffSetup,
): Promise<
  | { ok: true; tempDir: string; env: NodeJS.ProcessEnv }
  | { ok: false; error: string; details?: CommandResult }
> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-git-index-"));
  const tempIndex = path.join(tempDir, "index");

  try {
    try {
      await copyFile(path.join(setup.gitDir, "index"), tempIndex);
    } catch (error) {
      if (!isNoEntryError(error)) {
        await rm(tempDir, { recursive: true, force: true });
        return {
          ok: false,
          error: `Failed to copy Git index for diff capture: ${formatError(error)}`,
        };
      }
    }

    const env = { GIT_INDEX_FILE: tempIndex };
    const addResult = await setup.commandRunner.run({
      command: "git",
      args: ["add", "-A"],
      cwd: setup.gitRoot,
      env,
    });
    if (addResult.exitCode !== 0) {
      await rm(tempDir, { recursive: true, force: true });
      return {
        ok: false,
        error: "Failed to populate temporary Git index for diff capture.",
        details: addResult,
      };
    }

    return { ok: true, tempDir, env };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function buildGitPathspecs(
  gitRoot: string,
  excludedPaths: string[],
): Promise<string[]> {
  const exclusions = (
    await Promise.all(
      excludedPaths.map((excludedPath) => toExcludedGitPathspec(gitRoot, excludedPath)),
    )
  ).filter((pathspec): pathspec is string => pathspec !== null);

  return [".", ...new Set(exclusions)];
}

async function toExcludedGitPathspec(
  gitRoot: string,
  excludedPath: string,
): Promise<string | null> {
  const resolvedRoot = path.resolve(gitRoot);
  const candidatePath = path.isAbsolute(excludedPath)
    ? path.resolve(excludedPath)
    : path.resolve(resolvedRoot, excludedPath);
  const resolvedPath = await resolveExistingPath(candidatePath);
  const relativePath = path.relative(resolvedRoot, resolvedPath);

  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  return `:(exclude)${relativePath.split(path.sep).join(path.posix.sep)}`;
}

async function resolveExistingPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isNoEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
