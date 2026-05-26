import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { assertArtifactRootPathSafe } from "../artifacts/artifact-root.js";
import { nodeCommandRunner } from "../shell/command-runner.js";

export type DashboardSafetyResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export async function resolveDashboardTargetCwd(options: {
  cwd: string;
  targetCwd?: string;
}): Promise<DashboardSafetyResult<string>> {
  const candidate = options.targetCwd === undefined
    ? path.resolve(options.cwd)
    : path.resolve(options.cwd, options.targetCwd);

  let targetStat;
  try {
    targetStat = await stat(candidate);
  } catch (error) {
    return {
      ok: false,
      error: `Dashboard target repository is unavailable at ${candidate}: ${formatError(error)}`,
    };
  }

  if (!targetStat.isDirectory()) {
    return {
      ok: false,
      error: `Dashboard target repository is not a directory: ${candidate}`,
    };
  }

  return { ok: true, value: await canonicalPath(candidate) };
}

export async function validateDashboardArtifactRootForRead(options: {
  targetCwd: string;
  artifactRoot: string;
}): Promise<DashboardSafetyResult<string>> {
  const safety = await assertArtifactRootPathSafe(options);
  if (!safety.ok) return safety;
  return { ok: true, value: safety.value };
}

export async function validateDashboardArtifactRootForWrite(options: {
  targetCwd: string;
  artifactRoot: string;
  allowDirty: boolean;
}): Promise<DashboardSafetyResult<string>> {
  const safety = await validateDashboardArtifactRootForRead(options);
  if (!safety.ok) return safety;

  if (options.allowDirty) return safety;

  const ignored = await dashboardArtifactRootIsGitIgnored({
    targetCwd: options.targetCwd,
    artifactRoot: safety.value,
  });
  if (!ignored.ok) return ignored;

  return safety;
}

async function dashboardArtifactRootIsGitIgnored(options: {
  targetCwd: string;
  artifactRoot: string;
}): Promise<DashboardSafetyResult<true>> {
  const rootResult = await nodeCommandRunner.run({
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd: options.targetCwd,
  });
  if (rootResult.exitCode !== 0) return { ok: true, value: true };

  const gitRoot = await canonicalPath(rootResult.stdout.trim());
  const artifactPath = path.resolve(options.targetCwd, options.artifactRoot);
  const relativeArtifactPath = path.relative(gitRoot, artifactPath);
  if (
    relativeArtifactPath.length === 0 ||
    relativeArtifactPath.startsWith("..") ||
    path.isAbsolute(relativeArtifactPath)
  ) {
    return {
      ok: false,
      error: "Dashboard artifact root must stay inside the current Git repository.",
    };
  }

  const ignoreResult = await nodeCommandRunner.run({
    command: "git",
    args: ["check-ignore", "-q", "--", `${toPosix(relativeArtifactPath)}/`],
    cwd: gitRoot,
  });
  if (ignoreResult.exitCode === 0) return { ok: true, value: true };
  if (ignoreResult.exitCode === 1) {
    return {
      ok: false,
      error:
        `Dashboard artifact root "${options.artifactRoot}" is not ignored by Git. ` +
        "Add it to .gitignore or use allowDirty only when the dirty target is intentional.",
    };
  }

  return {
    ok: false,
    error:
      "Failed to verify whether the dashboard artifact root is ignored by Git: " +
      (ignoreResult.stderr.trim() || ignoreResult.error || `exit ${ignoreResult.exitCode}`),
  };
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
