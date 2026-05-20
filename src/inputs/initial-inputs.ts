import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { toRunRelativePath, type RunPaths } from "../artifacts/paths.js";

export const goalFileMaxBytes = 1024 * 1024;
export const seedMajorPlanMaxBytes = goalFileMaxBytes;
export const contextFileMaxBytes = 512 * 1024;
export const totalContextMaxBytes = 2 * 1024 * 1024;

export interface InitialInputGoalSource {
  type: "argv" | "file";
  path: string | null;
}

export interface InitialInputContextState {
  path: string;
  artifactPath: string;
  sizeBytes: number;
  sha256: string;
}

export type InitialInputMajorPlanSource =
  | { type: "runner"; path: null }
  | {
      type: "seed";
      path: string;
      sizeBytes: number;
      sha256: string;
    };

export interface InitialInputsState {
  goalSource: InitialInputGoalSource;
  majorPlanSource?: InitialInputMajorPlanSource;
  context: InitialInputContextState[];
}

export interface InitialInputArtifactsState {
  manifest: string;
  context?: Record<string, string>;
}

export interface ResolvedInitialInputs {
  goal: string;
  goalArtifactText?: string;
  goalSource: InitialInputGoalSource & {
    sizeBytes?: number;
    sha256?: string;
  };
  seedMajorPlan?: ResolvedSeedMajorPlan;
  context: ResolvedContextInput[];
}

export interface ResolvedSeedMajorPlan {
  text: string;
  path: string;
  canonicalPath: string;
  sizeBytes: number;
  sha256: string;
}

export interface ResolvedContextInput {
  path: string;
  canonicalPath: string;
  sizeBytes: number;
  sha256: string;
  content: Buffer;
}

export type InitialInputsResult =
  | { ok: true; value: ResolvedInitialInputs }
  | { ok: false; error: string };

export type WriteInitialInputArtifactsResult = {
  manifestPath: string;
  stateInputs: InitialInputsState;
  stateArtifacts: InitialInputArtifactsState;
};

export async function resolveInitialInputs(options: {
  targetCwd: string;
  argvGoal: string | null;
  goalFile?: string;
  seedMajorPlanFile?: string;
  contextPaths?: string[];
}): Promise<InitialInputsResult> {
  const targetCwd = await canonicalPath(options.targetCwd);
  const contextPaths = options.contextPaths ?? [];

  const goalResult = await resolveGoal({
    targetCwd,
    argvGoal: options.argvGoal,
    goalFile: options.goalFile,
  });
  if (!goalResult.ok) return goalResult;

  const seedResult = await resolveSeedMajorPlan({
    targetCwd,
    seedMajorPlanFile: options.seedMajorPlanFile,
  });
  if (!seedResult.ok) return seedResult;

  const contextResult = await resolveContextFiles({
    targetCwd,
    contextPaths,
  });
  if (!contextResult.ok) return contextResult;

  return {
    ok: true,
    value: {
      goal: goalResult.value.goal,
      ...(goalResult.value.goalArtifactText === undefined
        ? {}
        : { goalArtifactText: goalResult.value.goalArtifactText }),
      goalSource: goalResult.value.goalSource,
      ...(seedResult.value === undefined
        ? {}
        : { seedMajorPlan: seedResult.value }),
      context: contextResult.value,
    },
  };
}

export async function writeInitialInputArtifacts(options: {
  paths: RunPaths;
  inputs: ResolvedInitialInputs;
  now?: Date;
}): Promise<WriteInitialInputArtifactsResult> {
  const manifestPath = path.join(options.paths.dirs.inputs, "01-inputs.json");
  const contextDir = path.join(options.paths.dirs.inputs, "context");
  const contextArtifacts: Record<string, string> = {};
  const contextState: InitialInputContextState[] = [];

  if (options.inputs.context.length > 0) {
    await mkdir(contextDir, { recursive: true });
  }

  for (const [index, input] of options.inputs.context.entries()) {
    const artifactFile = path.join(
      contextDir,
      `${String(index + 1).padStart(2, "0")}-${safeBasename(input.path)}`,
    );
    await writeFile(artifactFile, input.content);
    const artifactPath = toPosix(toRunRelativePath(options.paths.runDir, artifactFile));
    contextArtifacts[input.path] = artifactPath;
    contextState.push({
      path: input.path,
      artifactPath,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
    });
  }

  const majorPlanSource = majorPlanSourceForSeed(options.inputs.seedMajorPlan);
  const manifest = {
    createdAt: (options.now ?? new Date()).toISOString(),
    goalSource: options.inputs.goalSource,
    ...(majorPlanSource === undefined ? {} : { majorPlanSource }),
    context: contextState,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    manifestPath: toPosix(toRunRelativePath(options.paths.runDir, manifestPath)),
    stateInputs: {
      goalSource: {
        type: options.inputs.goalSource.type,
        path: options.inputs.goalSource.path,
      },
      ...(majorPlanSource === undefined ? {} : { majorPlanSource }),
      context: contextState,
    },
    stateArtifacts: {
      manifest: toPosix(toRunRelativePath(options.paths.runDir, manifestPath)),
      ...(contextState.length === 0 ? {} : { context: contextArtifacts }),
    },
  };
}

function majorPlanSourceForSeed(
  seed: ResolvedSeedMajorPlan | undefined,
): InitialInputMajorPlanSource | undefined {
  if (seed === undefined) return undefined;
  return {
    type: "seed",
    path: seed.path,
    sizeBytes: seed.sizeBytes,
    sha256: seed.sha256,
  };
}

async function resolveGoal(options: {
  targetCwd: string;
  argvGoal: string | null;
  goalFile?: string;
}): Promise<
  | {
      ok: true;
      value: {
        goal: string;
        goalArtifactText?: string;
        goalSource: ResolvedInitialInputs["goalSource"];
      };
    }
  | { ok: false; error: string }
> {
  if (options.goalFile === undefined) {
    if (options.argvGoal === null) {
      return { ok: false, error: "Missing goal." };
    }
    return {
      ok: true,
      value: {
        goal: options.argvGoal,
        goalSource: { type: "argv", path: null },
      },
    };
  }

  const fileResult = await readRepositoryFile({
    targetCwd: options.targetCwd,
    inputPath: options.goalFile,
    label: "Goal file",
    maxBytes: goalFileMaxBytes,
  });
  if (!fileResult.ok) return fileResult;

  const textResult = decodeUtf8(fileResult.value.content, "Goal file");
  if (!textResult.ok) return textResult;

  const goal = textResult.value;
  if (goal.length === 0) {
    return { ok: false, error: "Goal file must not be empty." };
  }

  return {
    ok: true,
    value: {
      goal,
      goalArtifactText: goal,
      goalSource: {
        type: "file",
        path: fileResult.value.relativePath,
        sizeBytes: fileResult.value.sizeBytes,
        sha256: fileResult.value.sha256,
      },
    },
  };
}

async function resolveContextFiles(options: {
  targetCwd: string;
  contextPaths: string[];
}): Promise<{ ok: true; value: ResolvedContextInput[] } | { ok: false; error: string }> {
  const resolved: ResolvedContextInput[] = [];
  const seenCanonicalPaths = new Set<string>();
  let totalSizeBytes = 0;

  for (const contextPath of options.contextPaths) {
    const fileResult = await readRepositoryFile({
      targetCwd: options.targetCwd,
      inputPath: contextPath,
      label: "Context file",
      maxBytes: contextFileMaxBytes,
    });
    if (!fileResult.ok) return fileResult;

    if (seenCanonicalPaths.has(fileResult.value.canonicalPath)) {
      return {
        ok: false,
        error: `Duplicate context file after resolving symlinks: ${contextPath}`,
      };
    }
    seenCanonicalPaths.add(fileResult.value.canonicalPath);

    totalSizeBytes += fileResult.value.sizeBytes;
    if (totalSizeBytes > totalContextMaxBytes) {
      return {
        ok: false,
        error:
          `Context files exceed the total size limit of ${totalContextMaxBytes} bytes.`,
      };
    }

    resolved.push({
      path: fileResult.value.relativePath,
      canonicalPath: fileResult.value.canonicalPath,
      sizeBytes: fileResult.value.sizeBytes,
      sha256: fileResult.value.sha256,
      content: fileResult.value.content,
    });
  }

  return { ok: true, value: resolved };
}

export async function resolveSeedMajorPlan(options: {
  targetCwd: string;
  seedMajorPlanFile?: string;
}): Promise<
  | { ok: true; value?: ResolvedSeedMajorPlan }
  | { ok: false; error: string }
> {
  const targetCwd = await canonicalPath(options.targetCwd);

  if (options.seedMajorPlanFile === undefined) {
    return { ok: true, value: undefined };
  }

  const fileResult = await readRepositoryFile({
    targetCwd,
    inputPath: options.seedMajorPlanFile,
    label: "Seed major plan file",
    maxBytes: seedMajorPlanMaxBytes,
  });
  if (!fileResult.ok) return fileResult;

  const textResult = decodeUtf8(fileResult.value.content, "Seed major plan file");
  if (!textResult.ok) return textResult;

  if (textResult.value.trim().length === 0) {
    return {
      ok: false,
      error: "Seed major plan file must not be empty or whitespace-only.",
    };
  }

  return {
    ok: true,
    value: {
      text: textResult.value,
      path: fileResult.value.relativePath,
      canonicalPath: fileResult.value.canonicalPath,
      sizeBytes: fileResult.value.sizeBytes,
      sha256: fileResult.value.sha256,
    },
  };
}

async function readRepositoryFile(options: {
  targetCwd: string;
  inputPath: string;
  label: string;
  maxBytes: number;
}): Promise<
  | {
      ok: true;
      value: {
        canonicalPath: string;
        relativePath: string;
        sizeBytes: number;
        sha256: string;
        content: Buffer;
      };
    }
  | { ok: false; error: string }
> {
  const candidatePath = path.isAbsolute(options.inputPath)
    ? path.resolve(options.inputPath)
    : path.resolve(options.targetCwd, options.inputPath);

  let canonicalInputPath: string;
  try {
    canonicalInputPath = await realpath(candidatePath);
  } catch (error) {
    return {
      ok: false,
      error: `${options.label} is unavailable at ${candidatePath}: ${formatError(error)}`,
    };
  }

  const relativePath = path.relative(options.targetCwd, canonicalInputPath);
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.split(path.sep).includes("..")
  ) {
    return {
      ok: false,
      error: `${options.label} must stay inside the target repository: ${options.inputPath}`,
    };
  }

  let fileStat;
  try {
    fileStat = await stat(canonicalInputPath);
  } catch (error) {
    return {
      ok: false,
      error: `${options.label} is unavailable at ${candidatePath}: ${formatError(error)}`,
    };
  }

  if (!fileStat.isFile()) {
    return {
      ok: false,
      error: `${options.label} must be a regular file: ${options.inputPath}`,
    };
  }

  if (fileStat.size > options.maxBytes) {
    return {
      ok: false,
      error:
        `${options.label} exceeds the size limit of ${options.maxBytes} bytes: ` +
        `${options.inputPath}`,
    };
  }

  const content = await readFile(canonicalInputPath);
  return {
    ok: true,
    value: {
      canonicalPath: canonicalInputPath,
      relativePath: toPosix(relativePath),
      sizeBytes: fileStat.size,
      sha256: sha256(content),
      content,
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

function safeBasename(filePath: string): string {
  const basename = path.basename(filePath);
  const safe = basename.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length === 0 ? "context" : safe;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function decodeUtf8(
  content: Buffer,
  label: string,
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    return {
      ok: true,
      value: new TextDecoder("utf-8", { fatal: true }).decode(content),
    };
  } catch {
    return { ok: false, error: `${label} must be valid UTF-8 text.` };
  }
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
