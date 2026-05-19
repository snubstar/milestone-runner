import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  formatEnvironmentDiagnostics,
  type EnvironmentDiagnostic,
} from "../diagnostics/environment-validator.js";
import type {
  MilestonePlanPolicy,
  MilestonePlanReviewPolicy,
} from "../config/config-types.js";
import type { GitMetadata } from "../git/git-types.js";
import type { RunState } from "../state/state-types.js";
import type { TimingWarning } from "../timings/timing-types.js";
import type { DryRunReport } from "./dry-run.js";

export interface RunReportOptions {
  mode: "new" | "resume";
  runId: string;
  paths: { runDir: string };
  goal: string;
  planningOnly: boolean;
  allowDirty: boolean;
  allowNonGitPlanning: boolean;
  targetMilestone: number | null;
  runnerType: string;
  configPath: string | null;
  configSource: string;
  artifactRoot: string;
  checks: string[];
  maxFixAttempts: number;
  savedMaxFixAttempts?: number;
  milestonePlanPolicy: MilestonePlanPolicy;
  savedMilestonePlanPolicy?: MilestonePlanPolicy;
  milestonePlanReviewPolicy: MilestonePlanReviewPolicy;
  savedMilestonePlanReviewPolicy?: MilestonePlanReviewPolicy;
  gitRequired: boolean;
  gitRoot: string;
  gitDirty: boolean;
  gitDirtyOverride: boolean;
  gitNonGitPlanningOverride: boolean;
  stateBeforeResume?: RunState["currentPhase"];
  nextAction?: string;
  finalState: RunState;
  timingWarnings?: TimingWarning[];
}

export interface CliJsonReport {
  mode: "new" | "resume";
  allowed: boolean;
  exitCode: 0 | 1;
  nextAction: string;
  warnings: string[];
  details: Record<string, unknown>;
  runId?: string | null;
  runDir?: string | null;
}

export function printRunReport(options: RunReportOptions): void {
  const constrainedStop = constrainedTargetStop(options);
  console.log("Agent milestone orchestrator");
  console.log(`Mode: ${options.mode}`);
  console.log(`Run id: ${options.runId}`);
  console.log(`Run dir: ${options.paths.runDir}`);
  console.log(`Goal: ${options.goal}`);
  console.log(`Planning only: ${options.planningOnly}`);
  console.log(`Allow dirty: ${options.allowDirty}`);
  console.log(`Allow non-Git planning: ${options.allowNonGitPlanning}`);
  console.log(`Target milestone: ${options.targetMilestone ?? "none"}`);
  console.log(`Runner: ${options.runnerType}`);
  console.log(`Config: ${options.configPath}`);
  console.log(`Config source: ${options.configSource}`);
  console.log(`Artifact root: ${options.artifactRoot}`);
  console.log(`Checks: ${formatChecks(options.checks)}`);
  console.log(`Effective max fix attempts: ${options.maxFixAttempts}`);
  if (
    options.savedMaxFixAttempts !== undefined &&
    options.savedMaxFixAttempts !== options.maxFixAttempts
  ) {
    console.log(`Saved max fix attempts: ${options.savedMaxFixAttempts}`);
  }
  console.log(`Milestone plan policy: ${options.milestonePlanPolicy}`);
  if (
    options.savedMilestonePlanPolicy !== undefined &&
    options.savedMilestonePlanPolicy !== options.milestonePlanPolicy
  ) {
    console.log(`Saved milestone plan policy: ${options.savedMilestonePlanPolicy}`);
  }
  console.log(`Milestone plan review policy: ${options.milestonePlanReviewPolicy}`);
  if (options.savedMilestonePlanReviewPolicy !== undefined) {
    console.log(`Saved milestone plan review policy: ${options.savedMilestonePlanReviewPolicy}`);
  }
  console.log(
    `Scrupulous review for next milestone: ${describeScrupulousReviewForNextMilestone({
      policy: options.milestonePlanReviewPolicy,
      planningOnly: options.planningOnly,
      state: options.finalState,
      nextAction: options.nextAction,
    })}`,
  );
  console.log(`Git required: ${options.gitRequired}`);
  console.log(`Git root: ${options.gitRoot}`);
  console.log(`Git dirty: ${options.gitDirty}`);
  console.log(`Git dirty override: ${options.gitDirtyOverride}`);
  console.log(`Non-Git planning override: ${options.gitNonGitPlanningOverride}`);
  if (options.stateBeforeResume) {
    console.log(`State before resume: ${options.stateBeforeResume}`);
  }
  console.log(`State: ${options.finalState.currentPhase}`);
  console.log(`Current milestone: ${options.finalState.currentMilestoneId ?? "none"}`);
  if (options.finalState.lastError) {
    console.log(`Last error: ${options.finalState.lastError.message}`);
    const runnerDiagnostic = runnerDiagnosticFromDetails(
      options.finalState.lastError.details,
    );
    if (runnerDiagnostic) {
      console.log(`Runner diagnostic: ${runnerDiagnostic}`);
    }
  }
  if (constrainedStop) {
    console.log(
      `Target milestone ${constrainedStop.targetMilestone} stopped before goal completion.`,
    );
    console.log(`Pending milestones remain: ${constrainedStop.pendingMilestones.join(", ")}.`);
  }
  if (options.nextAction) {
    console.log(`Next action: ${options.nextAction}`);
  }
  console.log("Milestones:");
  for (const line of formatMilestoneStatusLines(options.finalState)) {
    console.log(line);
  }
  const finalSummary = options.finalState.artifacts.summaries?.goal;
  if (finalSummary) {
    console.log(`Final summary artifact: ${finalSummary}`);
  }
  printTimingReport(options);
  if (options.timingWarnings && options.timingWarnings.length > 0) {
    console.log("Timing warnings:");
    for (const warning of options.timingWarnings) {
      console.log(`  [${warning.code}] ${warning.source}: ${warning.message}`);
    }
  }
}

export function buildRunJsonReport(
  options: RunReportOptions,
  exitCode: 0 | 1,
): CliJsonReport {
  const timingWarnings =
    options.timingWarnings?.map(
      (warning) => `[${warning.code}] ${warning.source}: ${warning.message}`,
    ) ?? [];
  const nextAction = options.nextAction ?? options.finalState.currentPhase;
  const constrainedStop = constrainedTargetStop(options);

  return {
    mode: options.mode,
    allowed: exitCode === 0,
    exitCode,
    nextAction,
    warnings: timingWarnings,
    runId: options.runId,
    runDir: options.paths.runDir,
    details: {
      runId: options.runId,
      runDir: options.paths.runDir,
      goal: options.goal,
      planningOnly: options.planningOnly,
      allowDirty: options.allowDirty,
      allowNonGitPlanning: options.allowNonGitPlanning,
      targetMilestone: options.targetMilestone,
      runner: options.runnerType,
      config: options.configPath,
      configSource: options.configSource,
      artifactRoot: options.artifactRoot,
      checks: options.checks,
      maxFixAttempts: options.maxFixAttempts,
      savedMaxFixAttempts: options.savedMaxFixAttempts,
      milestonePlanPolicy: options.milestonePlanPolicy,
      savedMilestonePlanPolicy: options.savedMilestonePlanPolicy,
      milestonePlanReviewPolicy: options.milestonePlanReviewPolicy,
      savedMilestonePlanReviewPolicy: options.savedMilestonePlanReviewPolicy,
      scrupulousReviewForNextMilestone: describeScrupulousReviewForNextMilestone({
        policy: options.milestonePlanReviewPolicy,
        planningOnly: options.planningOnly,
        state: options.finalState,
        nextAction: options.nextAction,
      }),
      gitRequired: options.gitRequired,
      gitRoot: options.gitRoot,
      gitDirty: options.gitDirty,
      gitDirtyOverride: options.gitDirtyOverride,
      gitNonGitPlanningOverride: options.gitNonGitPlanningOverride,
      stateBeforeResume: options.stateBeforeResume,
      state: options.finalState.currentPhase,
      status: options.finalState.status,
      currentMilestone: options.finalState.currentMilestoneId,
      milestoneStatuses: options.finalState.milestoneStatuses,
      ...(constrainedStop
        ? { pendingMilestones: constrainedStop.pendingMilestones }
        : {}),
      lastError: options.finalState.lastError ?? null,
      finalSummaryArtifact: options.finalState.artifacts.summaries?.goal ?? null,
    },
  };
}

export function printRunJsonReport(
  options: RunReportOptions,
  exitCode: 0 | 1,
): void {
  printJson(buildRunJsonReport(options, exitCode));
}

export function printDryRunReport(report: DryRunReport): void {
  console.log("Agent milestone orchestrator dry run");
  console.log(`Mode: ${report.mode}`);
  console.log(`Allowed: ${report.allowed}`);
  console.log(`Exit code: ${report.exitCode}`);
  console.log(`Next action: ${report.nextAction}`);
  console.log("Warnings:");
  if (report.warnings.length === 0) {
    console.log("  none");
  } else {
    for (const warning of report.warnings) {
      console.log(`  ${warning}`);
    }
  }
  console.log("Details:");
  for (const [key, value] of Object.entries(report.details)) {
    console.log(`  ${key}: ${value ?? "null"}`);
  }
}

export function buildDryRunJsonReport(report: DryRunReport): CliJsonReport {
  return {
    mode: report.mode,
    allowed: report.allowed,
    exitCode: report.exitCode,
    nextAction: report.nextAction,
    warnings: report.warnings,
    details: report.details,
    runId: stringDetail(report.details.runId),
    runDir: stringDetail(report.details.runDir),
  };
}

export function printDryRunJsonReport(report: DryRunReport): void {
  printJson(buildDryRunJsonReport(report));
}

export function printEnvironmentDiagnostics(
  diagnostics: EnvironmentDiagnostic[],
): void {
  for (const line of formatEnvironmentDiagnostics(diagnostics)) {
    console.error(line);
  }
}

export function printGitOverrideWarnings(
  git: GitMetadata,
  allowNonGitPlanning: boolean,
): void {
  if (git.dirtyOverride) {
    console.error("Warning: dirty Git working tree allowed by --allow-dirty.");
  }
  if (nonGitPlanningOverride(git, allowNonGitPlanning)) {
    console.error("Warning: planning outside Git allowed by --allow-non-git-planning.");
  }
}

export function warningsForGitOverrides(
  git: GitMetadata,
  allowNonGitPlanning: boolean,
): string[] {
  const warnings: string[] = [];
  if (git.dirtyOverride) {
    warnings.push("Dirty Git working tree allowed by --allow-dirty.");
  }
  if (nonGitPlanningOverride(git, allowNonGitPlanning)) {
    warnings.push("Planning outside Git allowed by --allow-non-git-planning.");
  }
  return warnings;
}

export function nonGitPlanningOverride(
  git: GitMetadata,
  allowNonGitPlanning: boolean,
): boolean {
  return allowNonGitPlanning && git.planningOnly && !git.required && git.root === null;
}

export function describeScrupulousReviewForNextMilestone(options: {
  policy: MilestonePlanReviewPolicy;
  planningOnly: boolean;
  state?: RunState;
  nextAction?: string;
  allowed?: boolean;
}): string {
  if (options.policy !== "scrupulous") return "no (policy normal)";
  if (options.planningOnly) return "no (planning only)";
  if (options.allowed === false) return "no (blocked)";

  if (options.nextAction === "run_full_goal") return "yes (after planning)";
  if (options.nextAction === "continue_planning") return "yes (after planning)";
  if (options.nextAction === "continue_milestone") return "yes";
  if (options.nextAction === "advance_to_next_milestone") return "yes";
  if (options.nextAction === "run_planning_only") return "no (planning only)";

  if (options.state !== undefined) {
    if (
      options.state.currentPhase === "ready_for_milestone" &&
      options.state.currentMilestoneId !== null
    ) {
      return "yes";
    }

    if (
      options.state.currentPhase === "initialized" ||
      options.state.currentPhase === "planning" ||
      options.state.currentPhase === "plan_reviewing"
    ) {
      return "yes (after planning)";
    }

    if (
      options.state.currentPhase === "passed" &&
      Object.values(options.state.milestoneStatuses).some((status) => status === "pending")
    ) {
      return "yes (pending milestone on resume)";
    }
  }

  return "no (no runnable milestone)";
}

export function formatChecks(checks: string[]): string {
  return checks.length === 0 ? "none" : checks.join(" && ");
}

export function formatDiagnostics(diagnostics: EnvironmentDiagnostic[]): string {
  if (diagnostics.length === 0) return "none";
  return formatEnvironmentDiagnostics(diagnostics).join(" | ");
}

export function formatMilestoneStatusesCompact(state: RunState): string {
  const entries = sortedMilestoneStatusEntries(state);
  if (entries.length === 0) return "none";
  return entries.map(([id, status]) => `${id}:${status}`).join(", ");
}

function formatMilestoneStatusLines(state: RunState): string[] {
  const entries = sortedMilestoneStatusEntries(state);
  if (entries.length === 0) return ["  none"];
  return entries.map(([milestoneId, status]) => `  ${milestoneId}: ${status}`);
}

function sortedMilestoneStatusEntries(state: RunState) {
  return Object.entries(state.milestoneStatuses).sort(
    ([left], [right]) => Number(left) - Number(right),
  );
}

function constrainedTargetStop(
  options: RunReportOptions,
): { targetMilestone: number; pendingMilestones: string[] } | null {
  if (options.targetMilestone === null) return null;
  if (options.finalState.currentPhase !== "passed") return null;
  if (
    options.finalState.milestoneStatuses[String(options.targetMilestone)] !== "passed"
  ) {
    return null;
  }

  const pendingMilestones = sortedMilestoneStatusEntries(options.finalState)
    .filter(([, status]) => status === "pending")
    .map(([milestoneId]) => milestoneId);
  if (pendingMilestones.length === 0) return null;

  return {
    targetMilestone: options.targetMilestone,
    pendingMilestones,
  };
}

function runnerDiagnosticFromDetails(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  if (!("diagnosticArtifact" in details)) return null;

  const value = details.diagnosticArtifact;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function stringDetail(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface TimingReportDurations {
  lifecycleDurationMs?: number;
  activeWorkflowDurationMs?: number;
  latestInvocationDurationMs?: number;
  runnerDurationMs?: number;
  checkDurationMs?: number;
}

function printTimingReport(options: RunReportOptions): void {
  const timingArtifacts = timingArtifactsFromState(options);
  if (
    timingArtifacts.timeline === null &&
    timingArtifacts.timingsJson === null &&
    timingArtifacts.timingsMarkdown === null
  ) {
    return;
  }

  if (timingArtifacts.timeline) {
    console.log(`Timing timeline artifact: ${timingArtifacts.timeline}`);
  }
  if (timingArtifacts.timingsJson) {
    console.log(`Timing JSON artifact: ${timingArtifacts.timingsJson}`);
  }
  if (timingArtifacts.timingsMarkdown) {
    console.log(`Timing Markdown artifact: ${timingArtifacts.timingsMarkdown}`);
  }

  const durations = timingArtifacts.timingsJson
    ? readTimingReportDurations(options.paths.runDir, timingArtifacts.timingsJson)
    : null;
  if (durations === null) return;

  console.log(
    `Lifecycle duration: ${formatReportDurationMs(durations.lifecycleDurationMs)}`,
  );
  console.log(
    `Active workflow duration: ${formatReportDurationMs(durations.activeWorkflowDurationMs)}`,
  );
  console.log(
    `Latest invocation duration: ${formatReportDurationMs(
      durations.latestInvocationDurationMs,
    )}`,
  );
  console.log(`Runner duration: ${formatReportDurationMs(durations.runnerDurationMs)}`);
  console.log(`Check duration: ${formatReportDurationMs(durations.checkDurationMs)}`);
}

function timingArtifactsFromState(options: RunReportOptions): {
  timeline: string | null;
  timingsJson: string | null;
  timingsMarkdown: string | null;
} {
  const logs = options.finalState.artifacts.logs ?? {};
  const timeline = stringField(logs.timeline) ?? existingTimelinePath(options.paths.runDir);

  return {
    timeline,
    timingsJson: stringField(logs.timingsJson),
    timingsMarkdown: stringField(logs.timingsMarkdown),
  };
}

function existingTimelinePath(runDir: string): string | null {
  const timelinePath = path.join("logs", "timeline.jsonl");
  return existsSync(path.join(runDir, timelinePath)) ? timelinePath : null;
}

function readTimingReportDurations(
  runDir: string,
  artifactPath: string,
): TimingReportDurations | null {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(runDir, artifactPath), "utf8"),
    ) as unknown;
    if (!isRecord(parsed)) return null;

    const aggregates = isRecord(parsed.aggregates) ? parsed.aggregates : {};
    return {
      lifecycleDurationMs: numberField(parsed.lifecycleDurationMs),
      activeWorkflowDurationMs: numberField(parsed.activeWorkflowDurationMs),
      latestInvocationDurationMs: numberField(parsed.latestInvocationDurationMs),
      runnerDurationMs: numberField(aggregates.runnerDurationMs),
      checkDurationMs: numberField(aggregates.checkDurationMs),
    };
  } catch {
    return null;
  }
}

function formatReportDurationMs(durationMs: number | undefined): string {
  if (
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return "unknown";
  }

  const totalMs = Math.trunc(durationMs);
  if (totalMs === 0) return "0ms";
  if (totalMs < 1_000) return `${totalMs}ms`;

  let remainingMs = totalMs;
  const hours = Math.floor(remainingMs / 3_600_000);
  remainingMs -= hours * 3_600_000;
  const minutes = Math.floor(remainingMs / 60_000);
  remainingMs -= minutes * 60_000;
  const seconds = Math.floor(remainingMs / 1_000);

  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${padDurationPart(minutes)}m`);
    if (seconds > 0) parts.push(`${padDurationPart(seconds)}s`);
  } else if (minutes > 0) {
    parts.push(`${minutes}m`);
    if (seconds > 0) parts.push(`${padDurationPart(seconds)}s`);
  } else if (seconds > 0) {
    parts.push(`${seconds}s`);
  }

  return parts.length === 0 ? `${totalMs}ms` : parts.join("");
}

function padDurationPart(value: number): string {
  return String(value).padStart(2, "0");
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
