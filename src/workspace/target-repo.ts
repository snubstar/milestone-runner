import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceResolution {
  invocationCwd: string;
  targetCwd: string;
  targetCwdDisplay: string;
  repoExplicit: boolean;
}

export type WorkspaceResolutionResult =
  | { ok: true; value: WorkspaceResolution }
  | { ok: false; error: string };

export async function resolveTargetRepository(options: {
  repoPath?: string;
  invocationCwd?: string;
}): Promise<WorkspaceResolutionResult> {
  const invocationCwd = await canonicalPath(options.invocationCwd ?? process.cwd());
  const repoExplicit = options.repoPath !== undefined;
  const targetCandidate = repoExplicit
    ? path.resolve(invocationCwd, options.repoPath ?? "")
    : invocationCwd;

  let targetStat;
  try {
    targetStat = await stat(targetCandidate);
  } catch (error) {
    return {
      ok: false,
      error: `Target repository is unavailable at ${targetCandidate}: ${formatError(error)}`,
    };
  }

  if (!targetStat.isDirectory()) {
    return {
      ok: false,
      error: `Target repository is not a directory: ${targetCandidate}`,
    };
  }

  const targetCwd = await canonicalPath(targetCandidate);
  return {
    ok: true,
    value: {
      invocationCwd,
      targetCwd,
      targetCwdDisplay: targetCwd,
      repoExplicit,
    },
  };
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
