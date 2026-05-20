import { mkdir, writeFile } from "node:fs/promises";

import type { RunPaths } from "./paths.js";

export async function createRunDirectory(
  paths: RunPaths,
  goal: string,
  options: { goalArtifactText?: string } = {},
): Promise<void> {
  await mkdir(paths.artifactRoot, { recursive: true });
  try {
    await mkdir(paths.runDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`Run directory already exists: ${paths.runDir}`);
    }
    throw error;
  }

  await Promise.all(Object.values(paths.dirs).map((dir) => mkdir(dir)));
  await writeFile(paths.files.goal, options.goalArtifactText ?? `${goal}\n`, "utf8");
}

export async function writeRunLog(paths: RunPaths, message: string): Promise<void> {
  await writeFile(paths.files.runLog, `${message.trimEnd()}\n`, "utf8");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
