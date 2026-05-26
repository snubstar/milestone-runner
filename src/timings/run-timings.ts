import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonArtifact, writeTextArtifact } from "../artifacts/planning-artifacts.js";
import { resolveRunArtifactPath, type RunPaths } from "../artifacts/paths.js";
import { buildTimingArtifactPaths } from "../artifacts/timing-artifacts.js";
import type { RunState } from "../state/state-types.js";
import type { CheckTimingCollector } from "./check-timing-collector.js";
import { formatTimingMarkdown } from "./timing-summary.js";
import type {
  CheckTiming,
  FinalTimingsDocument,
  RunnerPhaseTiming,
  TimingWarning,
  WorkflowInvocationTiming,
  WorkflowPhaseTiming,
  WorkflowTimelineEvent,
} from "./timing-types.js";

export interface BuildRunTimingsOptions {
  paths: RunPaths;
  state: RunState;
  runEndedAt: string;
  generatedAt?: string;
  finalizedAt?: string;
  checkTimingCollector?: CheckTimingCollector;
  structuredChecks?: CheckTiming[];
  warnings?: TimingWarning[];
}

export interface WriteRunTimingsResult {
  document: FinalTimingsDocument;
  statePaths: {
    timingsJson: string;
    timingsMarkdown: string;
  };
  warnings: TimingWarning[];
}

interface InvocationSpan {
  invocationId: string;
  startedAt: string;
  endedAt: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export async function writeRunTimings(
  options: BuildRunTimingsOptions,
): Promise<WriteRunTimingsResult> {
  const timingPaths = buildTimingArtifactPaths(options.paths);
  const document = await buildRunTimingsDocument(options);

  await writeTextArtifact(
    timingPaths.files.timingsMarkdown,
    formatTimingMarkdown(document),
  );
  await writeJsonArtifact(timingPaths.files.timingsJson, document);

  return {
    document,
    statePaths: {
      timingsJson: timingPaths.statePaths.timingsJson,
      timingsMarkdown: timingPaths.statePaths.timingsMarkdown,
    },
    warnings: document.warnings,
  };
}

export async function buildRunTimingsDocument(
  options: BuildRunTimingsOptions,
): Promise<FinalTimingsDocument> {
  const warnings = [...(options.warnings ?? [])];
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const finalizedAt = options.finalizedAt ?? generatedAt;

  const timelineEvents = await readTimelineEvents(options.paths, warnings);
  const invocations = buildInvocationTimings({
    events: timelineEvents,
    runEndedAt: options.runEndedAt,
    warnings,
  });
  const invocationSpans = invocationTimingsToSpans(invocations, warnings);
  const workflowPhases = buildWorkflowPhaseTimings({
    events: timelineEvents,
    invocationSpans,
    runEndedAt: options.runEndedAt,
    warnings,
  });
  const runnerPhases = await readRunnerPhaseTimings(options.paths, warnings);
  const checks = await buildCheckTimings({
    paths: options.paths,
    state: options.state,
    structuredChecks:
      options.structuredChecks ?? options.checkTimingCollector?.list() ?? [],
    warnings,
  });

  const lifecycleDurationMs = durationBetweenIsoTimestamps(
    options.state.createdAt,
    options.runEndedAt,
    warnings,
    "workflow",
  );
  const activeWorkflowDurationMs = sum(invocationSpans.map((span) => span.durationMs));
  const latestInvocation = latestInvocationTiming(invocations);
  const latestInvocationDurationMs = latestInvocation?.durationMs ?? 0;
  const latestInvocationStartedAt =
    latestInvocation?.startedAt ?? options.state.createdAt;

  return {
    schemaVersion: 1,
    runId: options.state.runId,
    generatedAt,
    runStartedAt: options.state.createdAt,
    latestInvocationStartedAt,
    runEndedAt: options.runEndedAt,
    finalizedAt,
    lifecycleDurationMs,
    activeWorkflowDurationMs,
    latestInvocationDurationMs,
    aggregates: {
      runnerDurationMs: sum(runnerPhases.map((phase) => phase.durationMs ?? 0)),
      checkDurationMs: sum(checks.map((check) => check.durationMs)),
      knownWorkflowPhaseDurationMs: sum(workflowPhases.map((phase) => phase.durationMs)),
      workflowDurationByPhaseMs: sumWorkflowPhases(workflowPhases),
      runnerDurationByPhaseMs: sumRunnerPhases(runnerPhases),
      checkDurationByMilestoneMs: sumChecksByMilestone(checks),
    },
    invocations,
    workflowPhases,
    runnerPhases,
    checks,
    warnings,
  };
}

export async function readTimelineEvents(
  paths: RunPaths,
  warnings: TimingWarning[] = [],
): Promise<WorkflowTimelineEvent[]> {
  const timelinePath = buildTimingArtifactPaths(paths).files.timeline;
  let raw: string;

  try {
    raw = await readFile(timelinePath, "utf8");
  } catch (error) {
    if (isNoEntryError(error)) {
      warnings.push(timingWarning("timeline_missing", "Timeline artifact is missing.", "timeline", {
        timeline: toRunRelative(paths, timelinePath),
      }));
      return [];
    }

    warnings.push(timingWarning(
      "timeline_incomplete",
      `Failed to read timeline artifact: ${formatError(error)}`,
      "timeline",
      { timeline: toRunRelative(paths, timelinePath) },
    ));
    return [];
  }

  const events: WorkflowTimelineEvent[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    if (line.trim().length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      warnings.push(timingWarning(
        "timeline_incomplete",
        `Timeline line ${index + 1} is not valid JSON: ${formatError(error)}`,
        "timeline",
        { timeline: toRunRelative(paths, timelinePath), line: index + 1 },
      ));
      return;
    }

    if (!isWorkflowTimelineEvent(parsed)) {
      warnings.push(timingWarning(
        "timeline_incomplete",
        `Timeline line ${index + 1} is missing required timing fields.`,
        "timeline",
        { timeline: toRunRelative(paths, timelinePath), line: index + 1 },
      ));
      return;
    }

    events.push(parsed);
  });

  return events.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export async function readRunnerPhaseTimings(
  paths: RunPaths,
  warnings: TimingWarning[] = [],
): Promise<RunnerPhaseTiming[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.dirs.runner);
  } catch (error) {
    if (isNoEntryError(error)) return [];
    warnings.push(timingWarning(
      "runner_diagnostic_missing",
      `Failed to read runner diagnostics directory: ${formatError(error)}`,
      "runner",
      { directory: toRunRelative(paths, paths.dirs.runner) },
    ));
    return [];
  }

  const timings: RunnerPhaseTiming[] = [];
  for (const entry of entries.filter((value) => value.endsWith(".json")).sort()) {
    const filePath = path.join(paths.dirs.runner, entry);
    const sourceArtifact = toRunRelative(paths, filePath);
    let parsed: unknown;

    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      warnings.push(timingWarning(
        "runner_diagnostic_malformed",
        `Runner diagnostic ${entry} is malformed: ${formatError(error)}`,
        "runner",
        { sourceArtifact },
      ));
      continue;
    }

    if (!isRunnerDiagnostic(parsed)) {
      warnings.push(timingWarning(
        "runner_diagnostic_malformed",
        `Runner diagnostic ${entry} is missing required timing fields.`,
        "runner",
        { sourceArtifact },
      ));
      continue;
    }

    const computedDuration = optionalDurationBetweenIsoTimestamps(
      parsed.startedAt,
      parsed.endedAt,
      warnings,
      "runner",
      sourceArtifact,
    );
    const durationMs =
      typeof parsed.durationMs === "number" && parsed.durationMs >= 0
        ? parsed.durationMs
        : computedDuration;

    timings.push({
      phase: parsed.phase,
      milestoneId: typeof parsed.milestoneId === "number" ? parsed.milestoneId : null,
      startedAt: parsed.startedAt,
      endedAt: parsed.endedAt,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(typeof parsed.exitCode === "number" || parsed.exitCode === null
        ? { exitCode: parsed.exitCode }
        : {}),
      ...(typeof parsed.timedOut === "boolean" ? { timedOut: parsed.timedOut } : {}),
      sourceArtifact,
    });
  }

  return timings;
}

export async function buildCheckTimings(options: {
  paths: RunPaths;
  state: RunState;
  structuredChecks: CheckTiming[];
  warnings?: TimingWarning[];
}): Promise<CheckTiming[]> {
  const warnings = options.warnings ?? [];
  const timings = options.structuredChecks.map((entry) => ({ ...entry }));
  const structuredKeys = new Set(timings.map((entry) => entry.stateKey));

  for (const [stateKey, artifactPath] of Object.entries(options.state.artifacts.checks ?? {})) {
    if (structuredKeys.has(stateKey)) continue;

    const parsedKey = parseCheckArtifactStateKey(stateKey);
    if (!parsedKey) {
      warnings.push(timingWarning(
        "check_report_malformed",
        `Check artifact key ${stateKey} is not recognized.`,
        "checks",
        { stateKey, artifactPath },
      ));
      continue;
    }

    const resolvedPath = resolveRunArtifactPath(options.paths.runDir, artifactPath);
    if (!resolvedPath.ok) {
      warnings.push(timingWarning(
        "check_report_malformed",
        `Check report ${artifactPath} has an invalid artifact path: ${resolvedPath.error}`,
        "checks",
        { stateKey, artifactPath },
      ));
      continue;
    }

    let report: string;
    try {
      report = await readFile(resolvedPath.path, "utf8");
    } catch (error) {
      warnings.push(timingWarning(
        "check_report_missing",
        `Check report ${artifactPath} is missing: ${formatError(error)}`,
        "checks",
        { stateKey, artifactPath },
      ));
      continue;
    }

    timings.push(...parseCheckReport({
      stateKey,
      milestoneId: parsedKey.milestoneId,
      attempt: parsedKey.attempt,
      artifactPath,
      report,
      warnings,
    }));
  }

  return timings.sort(compareCheckTimings);
}

export function parseCheckArtifactStateKey(
  stateKey: string,
): { milestoneId: number; attempt: number | null } | null {
  const baseMatch = /^(\d+)$/.exec(stateKey);
  if (baseMatch) {
    return {
      milestoneId: Number.parseInt(baseMatch[1] ?? "", 10),
      attempt: null,
    };
  }

  const fixMatch = /^(\d+)-fix-(\d+)$/.exec(stateKey);
  if (fixMatch) {
    return {
      milestoneId: Number.parseInt(fixMatch[1] ?? "", 10),
      attempt: Number.parseInt(fixMatch[2] ?? "", 10),
    };
  }

  return null;
}

export function parseCheckReport(options: {
  stateKey: string;
  milestoneId: number;
  attempt: number | null;
  artifactPath: string;
  report: string;
  warnings?: TimingWarning[];
}): CheckTiming[] {
  const warnings = options.warnings ?? [];
  const lines = options.report.split(/\r?\n/);
  if (lines.some((line) => line.trim() === "No configured checks.")) {
    return [];
  }

  const timings: CheckTiming[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^## Check (\d+):\s*(.*)$/.exec(lines[index]?.trim() ?? "");
    if (!heading) continue;

    const commandIndex = Number.parseInt(heading[1] ?? "", 10);
    const command = heading[2]?.trim();
    const section = lines.slice(index + 1, nextCheckHeadingIndex(lines, index + 1));
    const exitCode = parseExitCode(section);
    const durationMs = parseDurationMs(section);

    if (durationMs === null) {
      warnings.push(timingWarning(
        "check_report_malformed",
        `Check report ${options.artifactPath} is missing duration for check ${commandIndex}.`,
        "checks",
        { stateKey: options.stateKey, artifactPath: options.artifactPath, commandIndex },
      ));
      continue;
    }

    timings.push({
      stateKey: options.stateKey,
      milestoneId: options.milestoneId,
      attempt: options.attempt,
      commandIndex,
      ...(command ? { command } : {}),
      durationMs,
      ...(exitCode === undefined ? {} : { exitCode }),
      source: "parsed_report",
      confidence: command && exitCode !== undefined ? "medium" : "low",
      sourceArtifact: options.artifactPath,
    });
  }

  if (timings.length === 0 && options.report.trim().length > 0) {
    warnings.push(timingWarning(
      "check_report_malformed",
      `Check report ${options.artifactPath} did not contain parseable duration entries.`,
      "checks",
      { stateKey: options.stateKey, artifactPath: options.artifactPath },
    ));
  }

  return timings;
}

function buildInvocationTimings(options: {
  events: WorkflowTimelineEvent[];
  runEndedAt: string;
  warnings: TimingWarning[];
}): WorkflowInvocationTiming[] {
  const byId = new Map<string, WorkflowInvocationTiming>();

  for (const event of options.events) {
    if (!event.invocationId) continue;

    if (event.event === "invocation_started") {
      byId.set(event.invocationId, {
        invocationId: event.invocationId,
        startedAt: event.timestamp,
        startPhase: event.phase,
      });
      continue;
    }

    if (event.event !== "invocation_ended") continue;

    const existing = byId.get(event.invocationId);
    if (!existing) {
      options.warnings.push(timingWarning(
        "timeline_incomplete",
        `Invocation ${event.invocationId} ended without a matching start event.`,
        "timeline",
        { invocationId: event.invocationId },
      ));
      byId.set(event.invocationId, {
        invocationId: event.invocationId,
        startedAt: event.timestamp,
        endedAt: event.timestamp,
        durationMs: 0,
        startPhase: event.phase,
        terminalPhase: event.phase,
        terminalStatus: event.status,
      });
      continue;
    }

    const durationMs = durationBetweenIsoTimestamps(
      existing.startedAt,
      event.timestamp,
      options.warnings,
      "timeline",
      event.invocationId,
    );
    byId.set(event.invocationId, {
      ...existing,
      endedAt: event.timestamp,
      durationMs,
      terminalPhase: event.phase,
      terminalStatus: event.status,
    });
  }

  for (const [invocationId, invocation] of byId) {
    if (invocation.endedAt !== undefined) continue;

    options.warnings.push(timingWarning(
      "timeline_incomplete",
      `Invocation ${invocationId} is missing an end event; closing it at runEndedAt.`,
      "timeline",
      { invocationId, runEndedAt: options.runEndedAt },
    ));
    const durationMs = durationBetweenIsoTimestamps(
      invocation.startedAt,
      options.runEndedAt,
      options.warnings,
      "timeline",
      invocationId,
    );
    byId.set(invocationId, {
      ...invocation,
      endedAt: options.runEndedAt,
      durationMs,
    });
  }

  return [...byId.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function invocationTimingsToSpans(
  invocations: WorkflowInvocationTiming[],
  warnings: TimingWarning[],
): InvocationSpan[] {
  const spans: InvocationSpan[] = [];
  for (const invocation of invocations) {
    if (invocation.endedAt === undefined) continue;

    const startMs = Date.parse(invocation.startedAt);
    const endMs = Date.parse(invocation.endedAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      warnings.push(timingWarning(
        "timeline_incomplete",
        `Invocation ${invocation.invocationId} has invalid timestamps.`,
        "timeline",
        { invocationId: invocation.invocationId },
      ));
      continue;
    }

    spans.push({
      invocationId: invocation.invocationId,
      startedAt: invocation.startedAt,
      endedAt: invocation.endedAt,
      startMs,
      endMs,
      durationMs: endMs - startMs,
    });
  }
  return spans;
}

function buildWorkflowPhaseTimings(options: {
  events: WorkflowTimelineEvent[];
  invocationSpans: InvocationSpan[];
  runEndedAt: string;
  warnings: TimingWarning[];
}): WorkflowPhaseTiming[] {
  const phaseEvents = options.events.filter(
    (event) => event.event === "state_initialized" || event.event === "phase_changed",
  );
  if (phaseEvents.length === 0) {
    if (options.events.length > 0) {
      options.warnings.push(timingWarning(
        "phase_interval_incomplete",
        "Timeline does not contain phase baseline events.",
        "timeline",
      ));
    }
    return [];
  }

  const runEndedMs = Date.parse(options.runEndedAt);
  if (!Number.isFinite(runEndedMs)) {
    options.warnings.push(timingWarning(
      "phase_interval_incomplete",
      "runEndedAt is not a valid timestamp; workflow phase intervals cannot be closed.",
      "timeline",
      { runEndedAt: options.runEndedAt },
    ));
    return [];
  }

  const intervals: WorkflowPhaseTiming[] = [];
  for (let index = 0; index < phaseEvents.length; index += 1) {
    const event = phaseEvents[index];
    if (!event) continue;

    const startMs = Date.parse(event.timestamp);
    const nextEvent = phaseEvents[index + 1];
    const endMs = nextEvent ? Date.parse(nextEvent.timestamp) : runEndedMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      options.warnings.push(timingWarning(
        "phase_interval_incomplete",
        `Phase interval for ${event.phase} has invalid timestamps.`,
        "timeline",
        { phase: event.phase, startedAt: event.timestamp },
      ));
      continue;
    }

    const clippingSpans =
      options.invocationSpans.length > 0
        ? options.invocationSpans
        : [
            {
              invocationId: "fallback",
              startedAt: new Date(startMs).toISOString(),
              endedAt: new Date(endMs).toISOString(),
              startMs,
              endMs,
              durationMs: endMs - startMs,
            },
          ];

    for (const span of clippingSpans) {
      const clippedStartMs = Math.max(startMs, span.startMs);
      const clippedEndMs = Math.min(endMs, span.endMs);
      if (clippedEndMs <= clippedStartMs) continue;

      intervals.push({
        phase: event.phase,
        milestoneId: event.currentMilestoneId,
        startedAt: new Date(clippedStartMs).toISOString(),
        endedAt: new Date(clippedEndMs).toISOString(),
        durationMs: clippedEndMs - clippedStartMs,
      });
    }
  }

  return intervals;
}

function latestInvocationTiming(
  invocations: WorkflowInvocationTiming[],
): WorkflowInvocationTiming | undefined {
  return invocations.at(-1);
}

function durationBetweenIsoTimestamps(
  startedAt: string,
  endedAt: string,
  warnings: TimingWarning[],
  source: TimingWarning["source"],
  sourceArtifact?: string,
): number {
  return (
    optionalDurationBetweenIsoTimestamps(
      startedAt,
      endedAt,
      warnings,
      source,
      sourceArtifact,
    ) ?? 0
  );
}

function optionalDurationBetweenIsoTimestamps(
  startedAt: string,
  endedAt: string,
  warnings: TimingWarning[],
  source: TimingWarning["source"],
  sourceArtifact?: string,
): number | undefined {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    warnings.push(timingWarning(
      source === "runner" ? "runner_duration_invalid" : "phase_interval_incomplete",
      `Invalid duration timestamps: ${startedAt} to ${endedAt}.`,
      source,
      sourceArtifact ? { sourceArtifact } : { startedAt, endedAt },
    ));
    return undefined;
  }

  return end - start;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumWorkflowPhases(
  phases: WorkflowPhaseTiming[],
): FinalTimingsDocument["aggregates"]["workflowDurationByPhaseMs"] {
  const totals: Record<string, number> = {};
  for (const phase of phases) {
    totals[phase.phase] = (totals[phase.phase] ?? 0) + phase.durationMs;
  }
  return totals as FinalTimingsDocument["aggregates"]["workflowDurationByPhaseMs"];
}

function sumRunnerPhases(phases: RunnerPhaseTiming[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const phase of phases) {
    totals[phase.phase] = (totals[phase.phase] ?? 0) + (phase.durationMs ?? 0);
  }
  return totals;
}

function sumChecksByMilestone(checks: CheckTiming[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const check of checks) {
    const key = String(check.milestoneId);
    totals[key] = (totals[key] ?? 0) + check.durationMs;
  }
  return totals;
}

function nextCheckHeadingIndex(lines: string[], startIndex: number): number {
  const nextIndex = lines.findIndex(
    (line, index) => index >= startIndex && /^## Check \d+:/.test(line.trim()),
  );
  return nextIndex === -1 ? lines.length : nextIndex;
}

function parseExitCode(lines: string[]): number | null | undefined {
  for (const line of lines) {
    const match = /^Exit code:\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    if (match[1] === "null") return null;
    const exitCode = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(exitCode) ? exitCode : undefined;
  }
  return undefined;
}

function parseDurationMs(lines: string[]): number | null {
  for (const line of lines) {
    const match = /^Duration:\s*(\d+)ms$/.exec(line.trim());
    if (!match) continue;
    return Number.parseInt(match[1] ?? "", 10);
  }
  return null;
}

function compareCheckTimings(left: CheckTiming, right: CheckTiming): number {
  return (
    left.milestoneId - right.milestoneId ||
    (left.attempt ?? 0) - (right.attempt ?? 0) ||
    left.commandIndex - right.commandIndex
  );
}

function isWorkflowTimelineEvent(value: unknown): value is WorkflowTimelineEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkflowTimelineEvent>;
  return (
    typeof candidate.timestamp === "string" &&
    typeof candidate.event === "string" &&
    typeof candidate.phase === "string" &&
    typeof candidate.status === "string" &&
    (typeof candidate.currentMilestoneId === "number" ||
      candidate.currentMilestoneId === null)
  );
}

function isRunnerDiagnostic(value: unknown): value is {
  phase: string;
  milestoneId?: number;
  startedAt: string;
  endedAt: string;
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.phase === "string" &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.endedAt === "string"
  );
}

function timingWarning(
  code: TimingWarning["code"],
  message: string,
  source: TimingWarning["source"],
  details?: object,
): TimingWarning {
  return {
    code,
    message,
    source,
    ...(details === undefined ? {} : { details }),
  };
}

function toRunRelative(paths: RunPaths, filePath: string): string {
  return path.relative(paths.runDir, filePath);
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
