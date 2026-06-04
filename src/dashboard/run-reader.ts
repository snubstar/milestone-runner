import { Buffer } from "node:buffer";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { buildMilestoneArtifactPaths } from "../artifacts/milestone-artifacts.js";
import {
  buildRunPathsFromRunDir,
  isSafeRunId,
  toRunRelativePath,
  type RunPaths,
} from "../artifacts/paths.js";
import { buildPlanningArtifactPaths } from "../artifacts/planning-artifacts.js";
import { buildTimingArtifactPaths } from "../artifacts/timing-artifacts.js";
import type { RunState, StateArtifacts } from "../state/state-types.js";
import type {
  DashboardArtifactGroup,
  DashboardArtifactLink,
  DashboardError,
  DashboardRunInputs,
  DashboardRunDetail,
  DashboardRunSummary,
  DashboardTimelineEvent,
  DashboardWarning,
} from "./api-types.js";

export interface DashboardRunReaderOptions {
  cwd: string;
  artifactRoot: string;
}

export interface ReadDashboardRunOptions extends DashboardRunReaderOptions {
  runId: string;
}

export type ReadDashboardRunResult =
  | { ok: true; run: DashboardRunDetail }
  | { ok: false; error: DashboardError };

const artifactGroups: DashboardArtifactGroup[] = [
  "goal",
  "inputs",
  "plans",
  "milestones",
  "diffs",
  "checks",
  "reviews",
  "summaries",
  "fixes",
  "logs",
  "runner",
];

const terminalStatuses = new Set(["passed", "failed", "needs_human_review"]);

export async function listDashboardRuns(
  options: DashboardRunReaderOptions,
): Promise<DashboardRunSummary[]> {
  const artifactRoot = resolveArtifactRoot(options);
  let entries: Dirent[];

  try {
    entries = await readdir(artifactRoot, { withFileTypes: true });
  } catch (error) {
    if (isNoEntryError(error)) return [];
    throw error;
  }

  const summaries: DashboardRunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeRunId(entry.name)) continue;

    const runDir = path.join(artifactRoot, entry.name);
    const summary = await readDashboardRunSummary(runDir, entry.name);
    if (summary !== null) summaries.push(summary);
  }

  return summaries.sort((left, right) => runSortTime(right) - runSortTime(left));
}

export async function readDashboardRun(
  options: ReadDashboardRunOptions,
): Promise<ReadDashboardRunResult> {
  if (!isSafeRunId(options.runId)) {
    return {
      ok: false,
      error: {
        code: "invalid_run_id",
        message: `Invalid run id: ${options.runId}`,
      },
    };
  }

  const artifactRoot = resolveArtifactRoot(options);
  const runDir = path.join(artifactRoot, options.runId);
  const stateResult = await readRunState(path.join(runDir, "state.json"));
  if (!stateResult.ok) {
    return {
      ok: false,
      error: {
        code: stateResult.code,
        message: stateResult.message,
        details: { runId: options.runId, runDir },
      },
    };
  }

  const state = stateResult.state;
  if (state.runId !== options.runId) {
    return {
      ok: false,
      error: {
        code: "state_malformed",
        message: stateRunIdMismatchMessage(
          path.join(runDir, "state.json"),
          options.runId,
          state.runId,
        ),
        details: { runId: options.runId, stateRunId: state.runId, runDir },
      },
    };
  }

  const warnings: DashboardWarning[] = [];
  const paths = buildRunPathsFromRunDir({ runDir, runId: state.runId });
  const artifacts = await readRunArtifacts({
    paths,
    state,
    warnings,
  });
  const inputs = buildInputSummary(state, artifacts.byGroup.inputs);
  const timeline = await readRunTimeline(paths, warnings);

  return {
    ok: true,
    run: {
      ...summaryFromState(state, paths.runDir, warnings),
      milestoneStatuses: normalizeStringRecord(state.milestoneStatuses),
      lastError: state.lastError ?? null,
      ...(inputs === undefined ? {} : { inputs }),
      artifacts: artifacts.byGroup,
      timeline,
      timingArtifacts: artifacts.timingArtifacts,
      runnerDiagnostics: artifacts.runnerDiagnostics,
      statePath: paths.files.state,
    },
  };
}

export function findDashboardArtifact(
  run: DashboardRunDetail,
  artifactId: string,
): DashboardArtifactLink | null {
  for (const links of Object.values(run.artifacts)) {
    const match = links.find((link) => link.id === artifactId);
    if (match) return match;
  }
  return null;
}

async function readDashboardRunSummary(
  runDir: string,
  fallbackRunId: string,
): Promise<DashboardRunSummary | null> {
  const statePath = path.join(runDir, "state.json");
  const stateResult = await readRunState(statePath);
  if (stateResult.ok) {
    if (stateResult.state.runId !== fallbackRunId) {
      return unreadableRunSummary({
        runDir,
        fallbackRunId,
        statePath,
        code: "state_malformed",
        message: stateRunIdMismatchMessage(
          statePath,
          fallbackRunId,
          stateResult.state.runId,
        ),
      });
    }

    const paths = buildRunPathsFromRunDir({
      runDir,
      runId: stateResult.state.runId,
    });
    return summaryFromState(stateResult.state, paths.runDir, []);
  }

  if (stateResult.code === "state_missing") return null;

  return unreadableRunSummary({
    runDir,
    fallbackRunId,
    statePath,
    code: stateResult.code,
    message: stateResult.message,
  });
}

async function unreadableRunSummary(options: {
  runDir: string;
  fallbackRunId: string;
  statePath: string;
  code: "state_malformed";
  message: string;
}): Promise<DashboardRunSummary> {
  const runStat = await stat(options.runDir).catch(() => null);
  const timestamp = runStat ? new Date(runStat.mtimeMs).toISOString() : null;
  const goal = await readOptionalText(path.join(options.runDir, "00-goal.txt"));

  return {
    runId: options.fallbackRunId,
    runDir: options.runDir,
    goal: goal?.trim() ?? "",
    status: "unreadable",
    currentPhase: "unreadable",
    currentMilestoneId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    active: false,
    warnings: [
      {
        code: options.code,
        message: options.message,
        source: "state",
        details: { statePath: options.statePath },
      },
    ],
  };
}

async function readRunState(
  statePath: string,
): Promise<
  | { ok: true; state: RunState }
  | { ok: false; code: "state_missing" | "state_malformed"; message: string }
> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if (isNoEntryError(error)) {
      return {
        ok: false,
        code: "state_missing",
        message: `Missing state.json at ${statePath}.`,
      };
    }
    return {
      ok: false,
      code: "state_malformed",
      message: `Failed to read state.json at ${statePath}: ${formatError(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      code: "state_malformed",
      message: `Invalid JSON in state.json at ${statePath}: ${formatError(error)}`,
    };
  }

  if (!isRunStateLike(parsed)) {
    return {
      ok: false,
      code: "state_malformed",
      message: `state.json at ${statePath} is missing required run state fields.`,
    };
  }

  return { ok: true, state: normalizeRunState(parsed) };
}

async function readRunArtifacts(options: {
  paths: RunPaths;
  state: RunState;
  warnings: DashboardWarning[];
}): Promise<{
  byGroup: Record<DashboardArtifactGroup, DashboardArtifactLink[]>;
  timingArtifacts: DashboardArtifactLink[];
  runnerDiagnostics: DashboardArtifactLink[];
}> {
  const collector = createArtifactCollector(options.paths, options.warnings);

  await collectKnownArtifacts(collector, options.paths, options.state);
  await collectStateArtifacts(collector, options.state.artifacts);

  const byGroup = collector.byGroup();
  const timingPaths = new Set([
    "logs/timeline.jsonl",
    "logs/80-timings.json",
    "logs/81-timings.md",
  ]);

  return {
    byGroup,
    timingArtifacts: byGroup.logs.filter((link) => timingPaths.has(link.relativePath)),
    runnerDiagnostics: byGroup.runner,
  };
}

function buildInputSummary(
  state: RunState,
  inputArtifactLinks: DashboardArtifactLink[],
): DashboardRunInputs | undefined {
  const inputs = state.inputs;
  if (!isRecord(inputs)) return undefined;

  const inputLinksByPath = new Map(
    inputArtifactLinks.map((link) => [link.relativePath, link]),
  );
  const manifestPath = isRecord(state.artifacts.inputs)
    ? stringField(state.artifacts.inputs.manifest)
    : null;
  const manifestArtifact =
    manifestPath === null ? null : inputArtifactForPath(inputLinksByPath, manifestPath);

  return {
    goalSource: normalizeInputGoalSource(inputs.goalSource),
    majorPlanSource: normalizeInputMajorPlanSource(inputs.majorPlanSource),
    context: normalizeInputContext(inputs.context, inputLinksByPath),
    ...(manifestArtifact === null ? {} : { manifestArtifact }),
  };
}

function normalizeInputGoalSource(value: unknown): DashboardRunInputs["goalSource"] {
  if (!isRecord(value)) {
    return { type: "argv", path: null };
  }
  return {
    type: value.type === "file" ? "file" : "argv",
    path: stringField(value.path),
  };
}

function normalizeInputMajorPlanSource(
  value: unknown,
): DashboardRunInputs["majorPlanSource"] {
  if (!isRecord(value)) {
    return { type: "runner", path: null };
  }

  const sizeBytes = numberField(value.sizeBytes);
  return {
    type: value.type === "seed" ? "seed" : "runner",
    path: stringField(value.path),
    ...(sizeBytes === null ? {} : { sizeBytes }),
    ...(typeof value.sha256 === "string" && value.sha256.length > 0
      ? { sha256: value.sha256 }
      : {}),
  };
}

function normalizeInputContext(
  value: unknown,
  inputLinksByPath: Map<string, DashboardArtifactLink>,
): DashboardRunInputs["context"] {
  if (!Array.isArray(value)) return [];

  const context: DashboardRunInputs["context"] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;

    const inputPath = stringField(entry.path);
    const artifactPath = stringField(entry.artifactPath);
    const sizeBytes = numberField(entry.sizeBytes);
    const sha256 = stringField(entry.sha256);
    if (
      inputPath === null ||
      artifactPath === null ||
      sizeBytes === null ||
      sha256 === null
    ) {
      continue;
    }

    context.push({
      path: inputPath,
      artifactPath,
      artifact: inputArtifactForPath(inputLinksByPath, artifactPath),
      sizeBytes,
      sha256,
    });
  }

  return context;
}

function inputArtifactForPath(
  inputLinksByPath: Map<string, DashboardArtifactLink>,
  artifactPath: string,
): DashboardArtifactLink | null {
  const exact = inputLinksByPath.get(artifactPath);
  if (exact) return exact;
  const normalized = normalizeArtifactLookupPath(artifactPath);
  return normalized === null ? null : inputLinksByPath.get(normalized) ?? null;
}

function normalizeArtifactLookupPath(artifactPath: string): string | null {
  const trimmed = artifactPath.trim();
  if (trimmed.length === 0 || path.isAbsolute(trimmed)) return null;

  const segments = trimmed.split(/[\\/]+/);
  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return null;
  }

  return segments.join("/");
}

async function collectKnownArtifacts(
  collector: ArtifactCollector,
  paths: RunPaths,
  state: RunState,
): Promise<void> {
  await collector.add({
    group: "goal",
    relativePath: toRunRelativePath(paths.runDir, paths.files.goal),
    source: "known-path",
    includeMissing: true,
    warnIfMissing: true,
  });

  await collector.add({
    group: "logs",
    relativePath: toRunRelativePath(paths.runDir, paths.files.runLog),
    source: "known-path",
    includeMissing: false,
    warnIfMissing: false,
  });

  const planningPaths = buildPlanningArtifactPaths(paths);
  await collector.addExistingKnown("plans", planningPaths.statePaths.majorPlan);
  await collector.addExistingKnown("plans", planningPaths.statePaths.majorPlanReview);
  await collector.addExistingKnown(
    "plans",
    planningPaths.statePaths.finalMajorPlanMarkdown,
  );
  await collector.addExistingKnown("milestones", planningPaths.statePaths.milestones);

  const timingPaths = buildTimingArtifactPaths(paths);
  await collector.add({
    group: "logs",
    relativePath: timingPaths.statePaths.timeline,
    source: "known-path",
    includeMissing: true,
    warnIfMissing: false,
  });
  await collector.add({
    group: "logs",
    relativePath: timingPaths.statePaths.timingsJson,
    source: "known-path",
    includeMissing: true,
    warnIfMissing: false,
  });
  await collector.add({
    group: "logs",
    relativePath: timingPaths.statePaths.timingsMarkdown,
    source: "known-path",
    includeMissing: true,
    warnIfMissing: false,
  });

  for (const milestoneKey of Object.keys(state.milestoneStatuses)) {
    const milestoneId = Number.parseInt(milestoneKey, 10);
    if (!Number.isSafeInteger(milestoneId)) continue;
    const milestonePaths = buildMilestoneArtifactPaths(paths, milestoneId);
    await collector.addExistingKnown(
      "milestones",
      milestonePaths.statePaths.milestonePlanDraft,
      milestoneId,
    );
    await collector.addExistingKnown(
      "milestones",
      milestonePaths.statePaths.milestonePlanReview,
      milestoneId,
    );
    await collector.addExistingKnown(
      "milestones",
      milestonePaths.statePaths.milestonePlan,
      milestoneId,
    );
    await collector.addExistingKnown(
      "milestones",
      milestonePaths.statePaths.implementation,
      milestoneId,
    );
    await collector.addExistingKnown(
      "diffs",
      milestonePaths.statePaths.diff,
      milestoneId,
    );
    await collector.addExistingKnown(
      "checks",
      milestonePaths.statePaths.checks,
      milestoneId,
    );
    await collector.addExistingKnown(
      "summaries",
      milestonePaths.statePaths.summary,
      milestoneId,
    );
  }

  await collectRunnerDirectoryArtifacts(collector, paths);
  const diagnosticArtifact = runnerDiagnosticFromDetails(state.lastError?.details);
  if (diagnosticArtifact) {
    await collector.add({
      group: "runner",
      relativePath: diagnosticArtifact,
      source: "state",
      includeMissing: true,
      warnIfMissing: true,
    });
  }
}

async function collectRunnerDirectoryArtifacts(
  collector: ArtifactCollector,
  paths: RunPaths,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(paths.dirs.runner, { withFileTypes: true });
  } catch (error) {
    if (isNoEntryError(error)) return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    await collector.add({
      group: "runner",
      relativePath: toRunRelativePath(paths.runDir, path.join(paths.dirs.runner, entry.name)),
      source: "known-path",
      includeMissing: false,
      warnIfMissing: false,
    });
  }
}

async function collectStateArtifacts(
  collector: ArtifactCollector,
  artifacts: StateArtifacts,
): Promise<void> {
  for (const [field, value] of Object.entries(artifacts)) {
    const group = groupForStateArtifact(field);
    if (!group) continue;
    await collectStateArtifactValue(collector, {
      group,
      field,
      value,
      keyPath: [],
    });
  }
}

async function collectStateArtifactValue(
  collector: ArtifactCollector,
  options: {
    group: DashboardArtifactGroup;
    field: string;
    value: unknown;
    keyPath: string[];
  },
): Promise<void> {
  if (typeof options.value === "string") {
    await collector.add({
      group: options.group,
      relativePath: options.value,
      source: "state",
      milestoneId: milestoneIdFromKeyPath(options.keyPath),
      includeMissing: true,
      warnIfMissing: true,
    });
    return;
  }

  if (!isRecord(options.value)) return;
  for (const [key, value] of Object.entries(options.value)) {
    await collectStateArtifactValue(collector, {
      group: options.group,
      field: options.field,
      value,
      keyPath: [...options.keyPath, key],
    });
  }
}

async function readRunTimeline(
  paths: RunPaths,
  warnings: DashboardWarning[],
): Promise<DashboardTimelineEvent[]> {
  const timelinePath = buildTimingArtifactPaths(paths).files.timeline;
  let raw: string;
  try {
    raw = await readFile(timelinePath, "utf8");
  } catch (error) {
    if (isNoEntryError(error)) {
      warnings.push({
        code: "timeline_missing",
        message: `Missing timeline at ${toRunRelativePath(paths.runDir, timelinePath)}.`,
        source: "timeline",
      });
      return [];
    }
    warnings.push({
      code: "timeline_incomplete",
      message: `Failed to read timeline: ${formatError(error)}`,
      source: "timeline",
      details: { timeline: toRunRelativePath(paths.runDir, timelinePath) },
    });
    return [];
  }

  const events: DashboardTimelineEvent[] = [];
  const lines = raw.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]?.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push({
        code: "timeline_malformed",
        message: `Malformed timeline JSON on line ${lineIndex + 1}.`,
        source: "timeline",
        details: {
          timeline: toRunRelativePath(paths.runDir, timelinePath),
          line: lineIndex + 1,
        },
      });
      continue;
    }

    events.push(normalizeTimelineEvent(events.length, parsed));
  }

  return events;
}

function createArtifactCollector(
  paths: RunPaths,
  warnings: DashboardWarning[],
): ArtifactCollector {
  const byRelativePath = new Map<string, DashboardArtifactLink>();

  return {
    async add(options) {
      const normalized = normalizeArtifactPath(paths.runDir, options.relativePath);
      if (!normalized.ok) {
        warnings.push({
          code: "artifact_path_invalid",
          message: normalized.message,
          source: "artifact",
          details: {
            group: options.group,
            relativePath: options.relativePath,
          },
        });
        return null;
      }

      if (byRelativePath.has(normalized.relativePath)) {
        return byRelativePath.get(normalized.relativePath) ?? null;
      }

      const artifactStat = await lstat(normalized.absolutePath).catch((error: unknown) => {
        if (isNoEntryError(error)) return null;
        throw error;
      });
      if (artifactStat !== null && artifactStat.isSymbolicLink()) {
        warnings.push({
          code: "artifact_symlink_unsupported",
          message: `Artifact must be a regular file, not a symbolic link: ${normalized.relativePath}.`,
          source: "artifact",
          details: {
            group: options.group,
            relativePath: normalized.relativePath,
          },
        });
        return null;
      }

      if (artifactStat !== null && !artifactStat.isFile()) {
        warnings.push({
          code: "artifact_not_file",
          message: `Artifact is not a file: ${normalized.relativePath}.`,
          source: "artifact",
          details: {
            group: options.group,
            relativePath: normalized.relativePath,
          },
        });
        return null;
      }

      if (artifactStat === null && !options.includeMissing) return null;
      if (artifactStat === null && options.warnIfMissing) {
        warnings.push({
          code: "artifact_missing",
          message: `Artifact is missing: ${normalized.relativePath}.`,
          source: "artifact",
          details: {
            group: options.group,
            relativePath: normalized.relativePath,
          },
        });
      }

      const link: DashboardArtifactLink = {
        id: artifactIdForPath(normalized.relativePath),
        group: options.group,
        label: labelForArtifact(normalized.relativePath),
        relativePath: normalized.relativePath,
        href: `/api/runs/${encodeURIComponent(paths.runId)}/artifacts/${encodeURIComponent(
          artifactIdForPath(normalized.relativePath),
        )}`,
        mediaType: mediaTypeForPath(normalized.relativePath),
        exists: artifactStat !== null,
        ...(artifactStat === null
          ? {}
          : {
              sizeBytes: artifactStat.size,
              updatedAt: artifactStat.mtime.toISOString(),
            }),
        ...(options.milestoneId === undefined ? {} : { milestoneId: options.milestoneId }),
        source: options.source,
      };
      byRelativePath.set(normalized.relativePath, link);
      return link;
    },

    async addExistingKnown(group, relativePath, milestoneId) {
      return this.add({
        group,
        relativePath,
        source: "known-path",
        milestoneId,
        includeMissing: false,
        warnIfMissing: false,
      });
    },

    byGroup() {
      const result = emptyArtifactGroups();
      for (const link of [...byRelativePath.values()].sort(compareArtifactLinks)) {
        result[link.group].push(link);
      }
      return result;
    },
  };
}

interface ArtifactCollector {
  add(options: {
    group: DashboardArtifactGroup;
    relativePath: string;
    source: DashboardArtifactLink["source"];
    milestoneId?: number | null;
    includeMissing: boolean;
    warnIfMissing: boolean;
  }): Promise<DashboardArtifactLink | null>;
  addExistingKnown(
    group: DashboardArtifactGroup,
    relativePath: string,
    milestoneId?: number | null,
  ): Promise<DashboardArtifactLink | null>;
  byGroup(): Record<DashboardArtifactGroup, DashboardArtifactLink[]>;
}

function normalizeArtifactPath(
  runDir: string,
  artifactPath: string,
): { ok: true; relativePath: string; absolutePath: string } | { ok: false; message: string } {
  const trimmed = artifactPath.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "Artifact path is empty." };
  }
  if (path.isAbsolute(trimmed)) {
    return { ok: false, message: `Artifact path must be run-relative: ${artifactPath}.` };
  }

  const segments = trimmed.split(/[\\/]+/);
  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return { ok: false, message: `Artifact path contains unsafe segments: ${artifactPath}.` };
  }

  const relativePath = segments.join("/");
  const absolutePath = path.resolve(runDir, relativePath);
  const relativeFromRunDir = path.relative(path.resolve(runDir), absolutePath);
  if (
    relativeFromRunDir === "" ||
    relativeFromRunDir.startsWith("..") ||
    path.isAbsolute(relativeFromRunDir)
  ) {
    return { ok: false, message: `Artifact path escapes run directory: ${artifactPath}.` };
  }

  return { ok: true, relativePath, absolutePath };
}

function normalizeTimelineEvent(index: number, value: unknown): DashboardTimelineEvent {
  if (!isRecord(value)) {
    return {
      index,
      timestamp: null,
      event: "unknown",
      raw: value,
    };
  }

  return {
    index,
    timestamp: stringField(value.timestamp),
    event: stringField(value.event) ?? "unknown",
    ...(typeof value.phase === "string" ? { phase: value.phase } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.currentMilestoneId === "number" || value.currentMilestoneId === null
      ? { currentMilestoneId: value.currentMilestoneId }
      : {}),
    ...(typeof value.invocationId === "string" ? { invocationId: value.invocationId } : {}),
    raw: value,
  };
}

function summaryFromState(
  state: RunState,
  runDir: string,
  warnings: DashboardWarning[],
): DashboardRunSummary {
  return {
    runId: state.runId,
    runDir,
    goal: state.goal,
    status: state.status,
    currentPhase: state.currentPhase,
    currentMilestoneId:
      typeof state.currentMilestoneId === "number" ? state.currentMilestoneId : null,
    createdAt: stringField(state.createdAt),
    updatedAt: stringField(state.updatedAt),
    active: !terminalStatuses.has(state.status),
    warnings,
  };
}

function emptyArtifactGroups(): Record<DashboardArtifactGroup, DashboardArtifactLink[]> {
  return artifactGroups.reduce(
    (result, group) => {
      result[group] = [];
      return result;
    },
    {} as Record<DashboardArtifactGroup, DashboardArtifactLink[]>,
  );
}

function groupForStateArtifact(field: string): DashboardArtifactGroup | null {
  switch (field) {
    case "goal":
      return "goal";
    case "inputs":
      return "inputs";
    case "majorPlan":
    case "majorPlanReview":
    case "finalMajorPlanMarkdown":
    case "finalMajorPlanJson":
      return "plans";
    case "milestones":
    case "milestonePlanDrafts":
    case "milestonePlanReviews":
    case "milestonePlans":
    case "implementations":
      return "milestones";
    case "diffs":
      return "diffs";
    case "checks":
    case "checkFailures":
      return "checks";
    case "reviews":
      return "reviews";
    case "summaries":
      return "summaries";
    case "fixes":
      return "fixes";
    case "logs":
      return "logs";
    default:
      return null;
  }
}

function normalizeRunState(state: RunState): RunState {
  return {
    ...state,
    checkFixAttempts: normalizeNumberRecord(state.checkFixAttempts),
    milestoneBaselines: normalizeStringRecord(state.milestoneBaselines),
  };
}

function normalizeNumberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => {
      return entry[0].length > 0 &&
        typeof entry[1] === "number" &&
        Number.isInteger(entry[1]) &&
        entry[1] >= 0;
    }),
  );
}

function milestoneIdFromKeyPath(keyPath: string[]): number | null {
  const firstKey = keyPath[0];
  const match = firstKey?.match(/^(\d+)(?:$|-)/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function labelForArtifact(relativePath: string): string {
  return path.basename(relativePath);
}

function artifactIdForPath(relativePath: string): string {
  return Buffer.from(relativePath, "utf8").toString("base64url");
}

function mediaTypeForPath(relativePath: string): string {
  switch (path.extname(relativePath).toLowerCase()) {
    case ".json":
      return "application/json; charset=utf-8";
    case ".md":
    case ".markdown":
      return "text/markdown; charset=utf-8";
    case ".diff":
    case ".patch":
      return "text/x-diff; charset=utf-8";
    case ".txt":
    case ".log":
      return "text/plain; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
}

function compareArtifactLinks(left: DashboardArtifactLink, right: DashboardArtifactLink): number {
  return left.relativePath.localeCompare(right.relativePath);
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

function runnerDiagnosticFromDetails(details: unknown): string | null {
  if (!isRecord(details)) return null;
  return typeof details.diagnosticArtifact === "string" &&
    details.diagnosticArtifact.length > 0
    ? details.diagnosticArtifact
    : null;
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNoEntryError(error)) return null;
    throw error;
  }
}

function runSortTime(summary: DashboardRunSummary): number {
  return Date.parse(summary.updatedAt ?? summary.createdAt ?? "") || 0;
}

function resolveArtifactRoot(options: DashboardRunReaderOptions): string {
  return path.resolve(options.cwd, options.artifactRoot);
}

function isRunStateLike(value: unknown): value is RunState {
  if (!isRecord(value)) return false;

  return (
    typeof value.runId === "string" &&
    typeof value.goal === "string" &&
    typeof value.currentPhase === "string" &&
    typeof value.status === "string" &&
    (typeof value.currentMilestoneId === "number" || value.currentMilestoneId === null) &&
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isNoEntryError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function stateRunIdMismatchMessage(
  statePath: string,
  expectedRunId: string,
  actualRunId: string,
): string {
  return `state.json at ${statePath} has runId ${actualRunId}, expected ${expectedRunId}.`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
