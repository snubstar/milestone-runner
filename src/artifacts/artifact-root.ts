import path from "node:path";
import { lstat, realpath } from "node:fs/promises";

export type ArtifactRootResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function normalizeArtifactRoot(artifactRoot: string): ArtifactRootResult {
  const trimmed = artifactRoot.trim();
  if (!trimmed) return { ok: false, error: "artifactRoot must not be empty." };
  if (path.isAbsolute(trimmed)) {
    return { ok: false, error: "artifactRoot must be a relative path." };
  }

  const normalized = path.normalize(trimmed).replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    segments.some((segment) => segment === ".." || segment.length === 0)
  ) {
    return {
      ok: false,
      error: "artifactRoot must stay inside the target repository.",
    };
  }

  return { ok: true, value: normalized };
}

export async function assertArtifactRootPathSafe(options: {
  targetCwd: string;
  artifactRoot: string;
}): Promise<ArtifactRootResult> {
  const normalized = normalizeArtifactRoot(options.artifactRoot);
  if (!normalized.ok) return normalized;

  const targetCwd = await realpath(options.targetCwd).catch(() => {
    return path.resolve(options.targetCwd);
  });
  let currentPath = targetCwd;
  for (const segment of normalized.value.split("/")) {
    const nextPath = path.join(currentPath, segment);
    const nextStat = await lstat(nextPath).catch((error: unknown) => {
      if (isNoEntryError(error)) return null;
      throw error;
    });
    if (nextStat === null) break;
    if (nextStat.isSymbolicLink()) {
      return {
        ok: false,
        error: `artifactRoot must not traverse a symbolic link: ${normalized.value}`,
      };
    }
    if (!nextStat.isDirectory()) {
      return {
        ok: false,
        error: `artifactRoot path segment is not a directory: ${normalized.value}`,
      };
    }
    currentPath = nextPath;
  }

  return { ok: true, value: normalized.value };
}

function isNoEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
