import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  buildRunPathsFromRunDir,
  type RunPaths,
} from "../artifacts/paths.js";
import { assertArtifactRootPathSafe } from "../artifacts/artifact-root.js";
import { validateConfig } from "../config/config-loader.js";
import type { OrchestratorConfig } from "../config/config-types.js";
import type { CommandRunner } from "../shell/command-runner.js";
import type { RunState } from "../state/state-types.js";

export interface LoadResumeRunOptions {
  cwd: string;
  targetCwd?: string;
  repoExplicit?: boolean;
  invocationCwd?: string;
  artifactRoot: string;
  resumeValue: string;
  commandRunner: CommandRunner;
}

export type LoadResumeRunResult =
  | {
      ok: true;
      state: RunState;
      paths: RunPaths;
      statePath: string;
      runDir: string;
      config: OrchestratorConfig;
      targetCwd: string;
      warnings: string[];
    }
  | { ok: false; error: string };

const planningOnlyResumePhases = new Set([
  "initialized",
  "planning",
  "plan_reviewing",
  "ready_for_milestone",
]);

export async function loadResumeRun(
  options: LoadResumeRunOptions,
): Promise<LoadResumeRunResult> {
  const selectedTargetCwd = path.resolve(options.targetCwd ?? options.cwd);
  const invocationCwd = await canonicalPath(options.invocationCwd ?? options.cwd);
  const statePathResult = await resolveResumeStatePath({
    ...options,
    targetCwd: selectedTargetCwd,
  });
  if (!statePathResult.ok) return statePathResult;

  let raw: string;
  try {
    raw = await readFile(statePathResult.statePath, "utf8");
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read resume state at ${statePathResult.statePath}: ${formatError(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON in resume state at ${statePathResult.statePath}: ${formatError(error)}`,
    };
  }

  if (!isRunStateLike(parsed)) {
    return {
      ok: false,
      error: `Resume state at ${statePathResult.statePath} is missing required run state fields.`,
    };
  }

  const state = parsed;
  const malformedSeedSourceError = validateSavedMajorPlanSource(state.inputs);
  if (malformedSeedSourceError) {
    return {
      ok: false,
      error: malformedSeedSourceError,
    };
  }

  const configResult = validateConfig(state.config.snapshot);
  if (!configResult.ok) {
    return {
      ok: false,
      error: `Resume state is missing a valid config snapshot: ${configResult.error}`,
    };
  }

  const runDir = path.dirname(statePathResult.statePath);
  const warnings: string[] = [];
  const runDirBasename = path.basename(runDir);
  if (state.runId !== runDirBasename) {
    if (!statePathResult.directPath) {
      return {
        ok: false,
        error: `Resume run id "${state.runId}" does not match run directory "${runDirBasename}".`,
      };
    }

    if (!artifactPathsAreRunRelative(state)) {
      return {
        ok: false,
        error:
          "Moved resume run directories are supported only when artifact paths are run-relative.",
      };
    }

    warnings.push(
      `Resume run directory basename "${runDirBasename}" differs from state run id "${state.runId}".`,
    );
  }

  if ((await canonicalPath(state.runDir)) !== runDir) {
    warnings.push(
      `State runDir "${state.runDir}" differs from resolved run directory "${runDir}".`,
    );
  }

  const targetResult = await resolveTargetCwd({
    selectedTargetCwd,
    repoExplicit: options.repoExplicit ?? false,
    directPath: statePathResult.directPath,
    state,
    commandRunner: options.commandRunner,
  });
  if (!targetResult.ok) return targetResult;

  const paths = buildRunPathsFromRunDir({
    runDir,
    runId: state.runId,
  });
  const normalizedState = normalizeLoadedState({
    state,
    paths,
    targetCwd: targetResult.targetCwd,
    invocationCwd,
  });

  return {
    ok: true,
    state: normalizedState,
    paths,
    statePath: statePathResult.statePath,
    runDir,
    config: configResult.value,
    targetCwd: targetResult.targetCwd,
    warnings,
  };
}

async function resolveResumeStatePath(
  options: LoadResumeRunOptions & { targetCwd: string },
): Promise<
  | { ok: true; statePath: string; directPath: boolean }
  | { ok: false; error: string }
> {
  const resumePath = path.resolve(options.cwd, options.resumeValue);
  const directStatePath = await statePathFromDirectValue(resumePath);
  if (directStatePath) {
    return {
      ok: true,
      statePath: await canonicalPath(directStatePath),
      directPath: true,
    };
  }

  const artifactRootSafety = await assertArtifactRootPathSafe({
    targetCwd: options.targetCwd,
    artifactRoot: options.artifactRoot,
  });
  if (!artifactRootSafety.ok) {
    return {
      ok: false,
      error: `Invalid artifactRoot: ${artifactRootSafety.error}`,
    };
  }

  const byRunId = path.resolve(
    options.targetCwd,
    artifactRootSafety.value,
    options.resumeValue,
    "state.json",
  );
  if (await fileExists(byRunId)) {
    return {
      ok: true,
      statePath: await canonicalPath(byRunId),
      directPath: false,
    };
  }

  return {
    ok: false,
    error: `Could not find resume state for "${options.resumeValue}".`,
  };
}

async function statePathFromDirectValue(resumePath: string): Promise<string | null> {
  try {
    const valueStat = await stat(resumePath);
    if (valueStat.isDirectory()) {
      const candidate = path.join(resumePath, "state.json");
      return (await fileExists(candidate)) ? candidate : null;
    }

    if (valueStat.isFile() && path.basename(resumePath) === "state.json") {
      return resumePath;
    }
  } catch {
    return null;
  }

  return null;
}

async function resolveTargetCwd(options: {
  selectedTargetCwd: string;
  repoExplicit: boolean;
  directPath: boolean;
  state: RunState;
  commandRunner: CommandRunner;
}): Promise<{ ok: true; targetCwd: string } | { ok: false; error: string }> {
  const canonicalSelectedTargetCwd = await canonicalPath(options.selectedTargetCwd);
  const savedWorkspaceTarget = await savedWorkspaceTargetCwd(options.state);
  if (savedWorkspaceTarget) {
    if (!options.directPath || options.repoExplicit) {
      if (savedWorkspaceTarget !== canonicalSelectedTargetCwd) {
        return {
          ok: false,
          error: `Selected target repository "${canonicalSelectedTargetCwd}" does not match saved workspace target "${savedWorkspaceTarget}". Use the saved workspace target when resuming this run.`,
        };
      }
    }

    return { ok: true, targetCwd: savedWorkspaceTarget };
  }

  const savedRoot = options.state.git.root;
  if (!savedRoot) {
    if (
      options.state.git.required === false &&
      options.state.git.planningOnly === true &&
      planningOnlyResumePhases.has(options.state.currentPhase)
    ) {
      return { ok: true, targetCwd: options.selectedTargetCwd };
    }

    return {
      ok: false,
      error: "Resume state does not record a Git root for a phase that may need Git.",
    };
  }

  const savedRootPath = path.resolve(savedRoot);
  try {
    const savedRootStat = await stat(savedRootPath);
    if (!savedRootStat.isDirectory()) {
      return {
        ok: false,
        error: `Saved Git root is not a directory: ${savedRootPath}`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: `Saved Git root is unavailable at ${savedRootPath}: ${formatError(error)}`,
    };
  }

  const canonicalSavedRoot = await canonicalPath(savedRootPath);
  if (options.repoExplicit) {
    if (canonicalSavedRoot !== canonicalSelectedTargetCwd) {
      return {
        ok: false,
        error: `Selected target repository "${canonicalSelectedTargetCwd}" does not match saved Git root "${canonicalSavedRoot}". Use the saved repository when resuming this run.`,
      };
    }

    return { ok: true, targetCwd: canonicalSavedRoot };
  }

  const currentRoot = await gitRootForCwd(
    options.commandRunner,
    options.selectedTargetCwd,
  );
  if (!currentRoot.ok) return currentRoot;

  const canonicalCurrentRoot = await canonicalPath(currentRoot.root);
  if (canonicalSavedRoot !== canonicalCurrentRoot) {
    return {
      ok: false,
      error: `Current Git root "${canonicalCurrentRoot}" does not match saved Git root "${canonicalSavedRoot}". Change into the saved repository before resuming.`,
    };
  }

  return { ok: true, targetCwd: canonicalSavedRoot };
}

async function gitRootForCwd(
  commandRunner: CommandRunner,
  cwd: string,
): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
  const result = await commandRunner.run({
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd,
  });

  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: `Failed to resolve current Git root from ${cwd}. Change into the saved repository before resuming.`,
    };
  }

  return { ok: true, root: result.stdout.trim() };
}

async function savedWorkspaceTargetCwd(state: RunState): Promise<string | null> {
  const targetCwd = state.workspace?.targetCwd;
  if (typeof targetCwd !== "string" || targetCwd.length === 0) return null;

  const targetPath = path.resolve(targetCwd);
  try {
    const targetStat = await stat(targetPath);
    if (!targetStat.isDirectory()) return null;
  } catch {
    return null;
  }

  return canonicalPath(targetPath);
}

function normalizeLoadedState(options: {
  state: RunState;
  paths: RunPaths;
  targetCwd: string;
  invocationCwd: string;
}): RunState {
  return {
    ...options.state,
    workspace: {
      invocationCwd:
        stringField(options.state.workspace?.invocationCwd) ?? options.invocationCwd,
      targetCwd: options.targetCwd,
    },
    inputs: normalizeStateInputs(options.state.inputs),
    artifactRoot: options.paths.artifactRoot,
    runDir: options.paths.runDir,
  };
}

function normalizeStateInputs(inputs: RunState["inputs"] | undefined): RunState["inputs"] {
  if (!isRecord(inputs)) {
    return {
      goalSource: { type: "argv", path: null },
      context: [],
    };
  }

  const goalSource: Record<string, unknown> = isRecord(inputs.goalSource)
    ? inputs.goalSource
    : {};
  const goalSourceType = goalSource.type === "file" ? "file" : "argv";
  const goalSourcePath =
    typeof goalSource.path === "string" && goalSource.path.length > 0
      ? goalSource.path
      : null;
  const context = Array.isArray(inputs.context)
    ? inputs.context.filter(isStateInputContextEntry)
    : [];
  const majorPlanSource = normalizeMajorPlanSource(inputs.majorPlanSource);

  return {
    goalSource: {
      type: goalSourceType,
      path: goalSourceType === "file" ? goalSourcePath : null,
    },
    ...(majorPlanSource === undefined ? {} : { majorPlanSource }),
    context,
  };
}

function normalizeMajorPlanSource(
  value: unknown,
): NonNullable<RunState["inputs"]>["majorPlanSource"] | undefined {
  if (!isRecord(value)) return undefined;

  if (value.type === "runner") {
    return { type: "runner", path: null };
  }

  if (
    value.type === "seed" &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    typeof value.sizeBytes === "number" &&
    Number.isFinite(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    typeof value.sha256 === "string" &&
    value.sha256.length > 0
  ) {
    return {
      type: "seed",
      path: value.path,
      sizeBytes: value.sizeBytes,
      sha256: value.sha256,
    };
  }

  return undefined;
}

function validateSavedMajorPlanSource(inputs: unknown): string | null {
  if (!isRecord(inputs)) return null;
  const source = inputs.majorPlanSource;
  if (!isRecord(source) || source.type !== "seed") return null;

  if (
    typeof source.path === "string" &&
    source.path.length > 0 &&
    typeof source.sizeBytes === "number" &&
    Number.isFinite(source.sizeBytes) &&
    source.sizeBytes >= 0 &&
    typeof source.sha256 === "string" &&
    source.sha256.length > 0
  ) {
    return null;
  }

  return (
    "Resume state records a seeded major plan source with incomplete metadata. " +
    "Expected majorPlanSource.path, sizeBytes, and sha256."
  );
}

function isStateInputContextEntry(
  value: unknown,
): value is NonNullable<RunState["inputs"]>["context"][number] {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.artifactPath === "string" &&
    typeof value.sizeBytes === "number" &&
    Number.isFinite(value.sizeBytes) &&
    typeof value.sha256 === "string"
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const valueStat = await stat(filePath);
    return valueStat.isFile();
  } catch {
    return false;
  }
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isRunStateLike(value: unknown): value is RunState {
  if (!isRecord(value)) return false;

  return (
    typeof value.runId === "string" &&
    typeof value.goal === "string" &&
    typeof value.currentPhase === "string" &&
    typeof value.status === "string" &&
    (typeof value.currentMilestoneId === "number" ||
      value.currentMilestoneId === null) &&
    typeof value.artifactRoot === "string" &&
    typeof value.runDir === "string" &&
    isRecord(value.git) &&
    isRecord(value.config) &&
    isRecord(value.milestoneStatuses) &&
    isRecord(value.fixAttempts) &&
    isRecord(value.artifacts) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function artifactPathsAreRunRelative(state: RunState): boolean {
  return artifactPathValues(state.artifacts).every((artifactPath) => {
    if (artifactPath.length === 0) return false;
    return !path.isAbsolute(artifactPath) && !artifactPath.split(/[\\/]/).includes("..");
  });
}

function artifactPathValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!isRecord(value)) return [];

  return Object.values(value).flatMap((entry) => artifactPathValues(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
