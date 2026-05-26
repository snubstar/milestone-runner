import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { toRunRelativePath, type RunPaths } from "./paths.js";
import { writeJsonArtifact } from "./planning-artifacts.js";

export interface RunnerDiagnosticArtifact {
  file: string;
  statePath: string;
  sequence: number;
}

export async function writeRunnerDiagnosticArtifact(
  paths: RunPaths,
  phase: string,
  value: unknown,
): Promise<RunnerDiagnosticArtifact> {
  await mkdir(paths.dirs.runner, { recursive: true });

  const sequence = await nextRunnerDiagnosticSequence(paths.dirs.runner);
  const file = path.join(
    paths.dirs.runner,
    `${sanitizePhaseForFileName(phase)}-${String(sequence).padStart(2, "0")}.json`,
  );

  await writeJsonArtifact(file, value);

  return {
    file,
    statePath: toRunRelativePath(paths.runDir, file),
    sequence,
  };
}

async function nextRunnerDiagnosticSequence(directory: string): Promise<number> {
  const entries = await readdir(directory).catch((error: unknown) => {
    if (isNoEntryError(error)) return [];
    throw error;
  });

  const maxSequence = entries.reduce((max, entry) => {
    const match = /-(\d+)\.json$/.exec(entry);
    if (!match) return max;

    const parsed = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);

  return maxSequence + 1;
}

function sanitizePhaseForFileName(phase: string): string {
  return phase
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "runner";
}

function isNoEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
