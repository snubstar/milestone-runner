import {
  formatEnvironmentDiagnostics,
  type EnvironmentDiagnostic,
} from "../diagnostics/environment-validator.js";
import type { GitMetadata } from "../git/git-types.js";
import type { RunState } from "../state/state-types.js";
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
  gitRequired: boolean;
  gitRoot: string;
  gitDirty: boolean;
  gitDirtyOverride: boolean;
  gitNonGitPlanningOverride: boolean;
  stateBeforeResume?: RunState["currentPhase"];
  nextAction?: string;
  finalState: RunState;
}

export function printRunReport(options: RunReportOptions): void {
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

function runnerDiagnosticFromDetails(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  if (!("diagnosticArtifact" in details)) return null;

  const value = details.diagnosticArtifact;
  return typeof value === "string" && value.length > 0 ? value : null;
}
