import { readFile } from "node:fs/promises";

import { buildPlanningArtifactPaths } from "../artifacts/planning-artifacts.js";
import type { RunPaths } from "../artifacts/paths.js";
import type { OrchestratorConfig } from "../config/config-types.js";
import {
  formatEnvironmentDiagnostics,
  type EnvironmentDiagnostic,
} from "../diagnostics/environment-validator.js";
import type { GitMetadata } from "../git/git-types.js";
import { parseMilestoneMetadataJson } from "../milestones/milestone-validator.js";
import { normalizeStateForGoalResume } from "../orchestration/resume-state.js";
import type { RunState } from "../state/state-types.js";

export interface DryRunReport {
  mode: "new" | "resume";
  allowed: boolean;
  exitCode: 0 | 1;
  nextAction: string;
  warnings: string[];
  details: Record<string, string | number | boolean | null>;
}

export interface NewRunDryRunOptions {
  goal: string;
  config: OrchestratorConfig;
  configPath: string | null;
  planningOnly: boolean;
  allowDirty: boolean;
  allowNonGitPlanning: boolean;
  targetMilestone?: number;
  git: GitMetadata;
  runnerType: string;
  diagnostics?: EnvironmentDiagnostic[];
  blockedReason?: string;
}

export interface ResumeDryRunOptions {
  state: RunState;
  paths: RunPaths;
  config: OrchestratorConfig;
  planningOnly: boolean;
  allowDirty: boolean;
  allowNonGitPlanning: boolean;
  targetMilestone?: number;
  git: GitMetadata;
  runnerType: string;
  diagnostics?: EnvironmentDiagnostic[];
  warnings?: string[];
  blockedReason?: string;
}

export function buildNewRunDryRunReport(options: NewRunDryRunOptions): DryRunReport {
  const allowed = options.blockedReason === undefined;
  const nextAction =
    options.blockedReason ??
    (options.planningOnly ? "run_planning_only" : "run_full_goal");

  return {
    mode: "new",
    allowed,
    exitCode: allowed ? 0 : 1,
    nextAction,
    warnings: [
      ...warningsForChecks(options.config, options.diagnostics ?? []),
      ...diagnosticWarnings(options.diagnostics ?? []),
      ...warningsForGitOverrides(options.git, options.allowNonGitPlanning),
    ],
    details: {
      goal: options.goal,
      planningOnly: options.planningOnly,
      allowDirty: options.allowDirty,
      allowNonGitPlanning: options.allowNonGitPlanning,
      targetMilestone: options.targetMilestone ?? null,
      runner: options.runnerType,
      config: options.configPath,
      artifactRoot: options.config.artifactRoot,
      maxFixAttempts: options.config.maxFixAttempts,
      checks: formatChecks(options.config),
      environmentDiagnostics: formatDiagnostics(options.diagnostics ?? []),
      gitRequired: options.git.required,
      gitRoot: options.git.root ?? "unavailable",
      gitDirty: options.git.dirtyAtStart,
      gitDirtyOverride: options.git.dirtyOverride,
      gitNonGitPlanningOverride: nonGitPlanningOverride(
        options.git,
        options.allowNonGitPlanning,
      ),
    },
  };
}

export async function buildResumeDryRunReport(
  options: ResumeDryRunOptions,
): Promise<DryRunReport> {
  const warnings = [
    ...(options.warnings ?? []),
    ...warningsForChecks(options.config, options.diagnostics ?? []),
    ...diagnosticWarnings(options.diagnostics ?? []),
    ...warningsForGitOverrides(options.git, options.allowNonGitPlanning),
  ];

  let nextAction = options.blockedReason;
  let allowed = nextAction === undefined;

  if (!nextAction) {
    const action = await resumeNextAction(options.state, options.paths);
    nextAction = action.nextAction;
    allowed = action.allowed;
    warnings.push(...action.warnings);
  }

  return {
    mode: "resume",
    allowed,
    exitCode: allowed ? 0 : 1,
    nextAction,
    warnings,
    details: {
      runId: options.state.runId,
      runDir: options.paths.runDir,
      goal: options.state.goal,
      currentPhase: options.state.currentPhase,
      currentMilestone: options.state.currentMilestoneId ?? "none",
      milestones: formatMilestoneStatuses(options.state),
      planningOnly: options.planningOnly,
      allowDirty: options.allowDirty,
      allowNonGitPlanning: options.allowNonGitPlanning,
      targetMilestone: options.targetMilestone ?? null,
      runner: options.runnerType,
      artifactRoot: options.paths.artifactRoot,
      maxFixAttempts: options.config.maxFixAttempts,
      checks: formatChecks(options.config),
      environmentDiagnostics: formatDiagnostics(options.diagnostics ?? []),
      gitRequired: options.git.required,
      gitRoot: options.git.root ?? "unavailable",
      gitDirty: options.git.dirtyAtStart,
      gitDirtyOverride: options.git.dirtyOverride,
      gitNonGitPlanningOverride: nonGitPlanningOverride(
        options.git,
        options.allowNonGitPlanning,
      ),
      lastError: options.state.lastError?.message ?? null,
    },
  };
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

async function resumeNextAction(
  state: RunState,
  paths: RunPaths,
): Promise<{ allowed: boolean; nextAction: string; warnings: string[] }> {
  if (isPlanningResumePhase(state.currentPhase)) {
    return { allowed: true, nextAction: "continue_planning", warnings: [] };
  }

  const metadataResult = await readMilestoneMetadata(paths);
  if (!metadataResult.ok) {
    return {
      allowed: false,
      nextAction: "blocked_unsafe_resume",
      warnings: [metadataResult.error],
    };
  }

  const decision = normalizeStateForGoalResume(state, metadataResult.metadata);
  switch (decision.kind) {
    case "continue":
      return {
        allowed: true,
        nextAction: actionForContinuablePhase(decision.state.currentPhase),
        warnings: [],
      };
    case "advance":
      return {
        allowed: true,
        nextAction: "advance_to_next_milestone",
        warnings: [],
      };
    case "complete":
      return {
        allowed: true,
        nextAction: decision.summaryRequired ? "complete_goal_summary" : "goal_complete",
        warnings: [],
      };
    case "stopped":
      return {
        allowed: false,
        nextAction:
          decision.state.status === "failed"
            ? "stopped_failed"
            : "stopped_needs_human_review",
        warnings: [],
      };
    case "normalize_to_ready_for_review":
      return {
        allowed: true,
        nextAction: "normalize_to_ready_for_review",
        warnings: [],
      };
    case "normalize_to_passed":
      return {
        allowed: true,
        nextAction: "normalize_to_passed",
        warnings: [],
      };
    case "needs_human_review":
      return {
        allowed: false,
        nextAction: "blocked_unsafe_resume",
        warnings: [decision.message],
      };
  }
}

async function readMilestoneMetadata(paths: RunPaths) {
  const planningPaths = buildPlanningArtifactPaths(paths);
  try {
    const raw = await readFile(planningPaths.files.milestones, "utf8");
    const parsed = parseMilestoneMetadataJson(raw);
    if (!parsed.ok) {
      return { ok: false as const, error: parsed.error };
    }

    return { ok: true as const, metadata: parsed.value };
  } catch (error) {
    return {
      ok: false as const,
      error: `Failed to read milestone metadata: ${formatError(error)}`,
    };
  }
}

function actionForContinuablePhase(phase: RunState["currentPhase"]): string {
  if (
    phase === "initialized" ||
    phase === "planning" ||
    phase === "plan_reviewing"
  ) {
    return "continue_planning";
  }

  if (phase === "ready_for_milestone") return "continue_milestone";
  if (phase === "ready_for_review") return "continue_review";
  return `continue_${phase}`;
}

function isPlanningResumePhase(phase: RunState["currentPhase"]): boolean {
  return (
    phase === "initialized" ||
    phase === "planning" ||
    phase === "plan_reviewing"
  );
}

function warningsForChecks(
  config: OrchestratorConfig,
  diagnostics: EnvironmentDiagnostic[],
): string[] {
  if (diagnostics.some((diagnostic) => diagnostic.code === "checks_empty")) {
    return [];
  }
  return config.checks.length === 0 ? ["No deterministic checks are configured."] : [];
}

function diagnosticWarnings(diagnostics: EnvironmentDiagnostic[]): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.level === "warning")
    .map((diagnostic) => diagnostic.message);
}

function formatDiagnostics(diagnostics: EnvironmentDiagnostic[]): string {
  if (diagnostics.length === 0) return "none";
  return formatEnvironmentDiagnostics(diagnostics).join(" | ");
}

function warningsForGitOverrides(
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

function nonGitPlanningOverride(
  git: GitMetadata,
  allowNonGitPlanning: boolean,
): boolean {
  return allowNonGitPlanning && git.planningOnly && !git.required && git.root === null;
}

function formatChecks(config: OrchestratorConfig): string {
  return config.checks.length === 0 ? "none" : config.checks.join(" && ");
}

function formatMilestoneStatuses(state: RunState): string {
  const entries = Object.entries(state.milestoneStatuses).sort(
    ([left], [right]) => Number(left) - Number(right),
  );
  if (entries.length === 0) return "none";
  return entries.map(([id, status]) => `${id}:${status}`).join(", ");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
