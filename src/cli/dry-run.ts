import { readFile } from "node:fs/promises";

import { buildPlanningArtifactPaths } from "../artifacts/planning-artifacts.js";
import type { RunPaths } from "../artifacts/paths.js";
import { effectiveMaxCheckFixAttempts } from "../config/check-fix-attempts.js";
import type { OrchestratorConfig } from "../config/config-types.js";
import type { EnvironmentDiagnostic } from "../diagnostics/environment-validator.js";
import { captureGitTree } from "../git/git-diff.js";
import type { GitMetadata } from "../git/git-types.js";
import type { MilestoneMetadata } from "../milestones/milestone-types.js";
import { parseMilestoneMetadataJson } from "../milestones/milestone-validator.js";
import { resolveMilestoneBaseline } from "../orchestration/milestone-baseline.js";
import {
  actionForResumeRecoveryMode,
  type ResumeRecoveryMode,
} from "../orchestration/resume-recovery.js";
import { normalizeStateForGoalResume } from "../orchestration/resume-state.js";
import { runnerIdentityDetails } from "../runners/runner-identity.js";
import type { CommandRunner } from "../shell/command-runner.js";
import type { RunState } from "../state/state-types.js";
import {
  describeHumanReviewPolicyMode,
  describeScrupulousReviewForNextMilestone,
  formatChecks,
  formatDiagnostics,
  formatMilestoneStatusesCompact,
  nonGitPlanningOverride,
  warningsForGitOverrides,
} from "./run-report.js";

export { printDryRunReport } from "./run-report.js";

export interface DryRunReport {
  mode: "new" | "resume";
  allowed: boolean;
  exitCode: 0 | 1;
  nextAction: string;
  warnings: string[];
  details: Record<string, unknown>;
}

export type DryRunMajorPlanSource =
  | { type: "runner"; path: null }
  | { type: "seed"; path: string };

export interface NewRunDryRunOptions {
  goal: string;
  runId?: string;
  runDir?: string;
  invocationCwd: string;
  targetCwd: string;
  goalSourceType: "argv" | "file";
  goalSourcePath: string | null;
  majorPlanSource?: DryRunMajorPlanSource;
  contextPaths: string[];
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
  resumeRecoveryMode?: ResumeRecoveryMode;
  cwd?: string;
  commandRunner?: CommandRunner;
  git: GitMetadata;
  runnerType: string;
  diagnostics?: EnvironmentDiagnostic[];
  warnings?: string[];
  blockedReason?: string;
}

export function buildNewRunDryRunReport(options: NewRunDryRunOptions): DryRunReport {
  const allowed = options.blockedReason === undefined;
  const majorPlanSource = options.majorPlanSource ?? { type: "runner" as const, path: null };
  const nextAction =
    options.blockedReason ??
    (majorPlanSource.type === "seed" ? "review_seeded_major_plan" : undefined) ??
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
      runId: options.runId ?? null,
      runDir: options.runDir ?? null,
      invocationCwd: options.invocationCwd,
      targetCwd: options.targetCwd,
      goalSource: formatGoalSource(options.goalSourceType, options.goalSourcePath),
      majorPlanSource,
      contextInputs: formatContextInputs(options.contextPaths),
      planningOnly: options.planningOnly,
      allowDirty: options.allowDirty,
      allowNonGitPlanning: options.allowNonGitPlanning,
      targetMilestone: options.targetMilestone ?? null,
      runner: options.runnerType,
      runnerExecution: runnerExecutionDescription(options.config),
      ...runnerIdentityDetails(options.config),
      config: options.configPath,
      artifactRoot: options.config.artifactRoot,
      maxFixAttempts: options.config.maxFixAttempts,
      maxCheckFixAttempts: effectiveMaxCheckFixAttempts(options.config),
      milestonePlanPolicy: options.config.milestonePlanPolicy,
      milestonePlanReviewPolicy: options.config.milestonePlanReviewPolicy,
      humanReviewPolicy: options.config.humanReviewPolicy,
      humanReviewHandling: describeHumanReviewPolicyMode(
        options.config.humanReviewPolicy,
      ),
      scrupulousReviewForNextMilestone: describeScrupulousReviewForNextMilestone({
        policy: options.config.milestonePlanReviewPolicy,
        planningOnly: options.planningOnly,
        nextAction,
        allowed,
      }),
      checks: formatChecks(options.config.checks),
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
  const resumeRecoveryMode = options.resumeRecoveryMode ?? "none";
  const savedPlanPolicy = savedMilestonePlanPolicy(options.state);
  const savedReviewPolicy = savedMilestonePlanReviewPolicy(options.state);
  const savedHumanPolicy = savedHumanReviewPolicy(options.state);
  const warnings = [
    ...(options.warnings ?? []),
    ...warningsForChecks(options.config, options.diagnostics ?? []),
    ...diagnosticWarnings(options.diagnostics ?? []),
    ...warningsForGitOverrides(options.git, options.allowNonGitPlanning),
  ];

  let nextAction = options.blockedReason;
  let allowed = nextAction === undefined;

  if (!nextAction) {
    const action = await resumeNextAction({
      state: options.state,
      paths: options.paths,
      config: options.config,
      targetMilestone: options.targetMilestone,
      resumeRecoveryMode,
      cwd: options.cwd,
      commandRunner: options.commandRunner,
    });
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
      invocationCwd: options.state.workspace?.invocationCwd ?? null,
      targetCwd: options.state.workspace?.targetCwd ?? null,
      goalSource: formatGoalSource(
        options.state.inputs?.goalSource.type ?? "argv",
        options.state.inputs?.goalSource.path ?? null,
      ),
      majorPlanSource: majorPlanSourceFromState(options.state),
      contextInputs: formatContextInputs(
        options.state.inputs?.context.map((entry) => entry.path) ?? [],
      ),
      currentPhase: options.state.currentPhase,
      currentMilestone: options.state.currentMilestoneId ?? "none",
      milestones: formatMilestoneStatusesCompact(options.state),
      planningOnly: options.planningOnly,
      allowDirty: options.allowDirty,
      allowNonGitPlanning: options.allowNonGitPlanning,
      targetMilestone: options.targetMilestone ?? null,
      resumeRecoveryMode,
      runner: options.runnerType,
      runnerExecution: runnerExecutionDescription(options.config),
      ...runnerIdentityDetails(options.config),
      artifactRoot: options.paths.artifactRoot,
      maxFixAttempts: options.config.maxFixAttempts,
      maxCheckFixAttempts: effectiveMaxCheckFixAttempts(options.config),
      milestonePlanPolicy: options.config.milestonePlanPolicy,
      ...(savedPlanPolicy !== options.config.milestonePlanPolicy
        ? { savedMilestonePlanPolicy: savedPlanPolicy }
        : {}),
      milestonePlanReviewPolicy: options.config.milestonePlanReviewPolicy,
      savedMilestonePlanReviewPolicy: savedReviewPolicy,
      humanReviewPolicy: options.config.humanReviewPolicy,
      savedHumanReviewPolicy: savedHumanPolicy,
      humanReviewHandling: describeHumanReviewPolicyMode(
        options.config.humanReviewPolicy,
      ),
      scrupulousReviewForNextMilestone: describeScrupulousReviewForNextMilestone({
        policy: options.config.milestonePlanReviewPolicy,
        planningOnly: options.planningOnly,
        state: options.state,
        nextAction,
        allowed,
      }),
      checks: formatChecks(options.config.checks),
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

function savedMilestonePlanPolicy(state: RunState): OrchestratorConfig["milestonePlanPolicy"] {
  return state.config.snapshot?.milestonePlanPolicy ?? "always";
}

function formatGoalSource(type: "argv" | "file", goalPath: string | null): string {
  return type === "file" && goalPath ? `file:${goalPath}` : "argv";
}

function formatContextInputs(paths: string[]): string {
  return paths.length === 0 ? "none" : paths.join(", ");
}

function majorPlanSourceFromState(state: RunState): DryRunMajorPlanSource {
  const source = state.inputs?.majorPlanSource;
  if (source?.type === "seed" && source.path) {
    return { type: "seed", path: source.path };
  }
  return { type: "runner", path: null };
}

function savedMilestonePlanReviewPolicy(
  state: RunState,
): OrchestratorConfig["milestonePlanReviewPolicy"] {
  return state.config.snapshot?.milestonePlanReviewPolicy ?? "normal";
}

function savedHumanReviewPolicy(state: RunState): OrchestratorConfig["humanReviewPolicy"] {
  return state.config.snapshot?.humanReviewPolicy ?? "stop";
}

async function resumeNextAction(
  options: {
    state: RunState;
    paths: RunPaths;
    config: OrchestratorConfig;
    targetMilestone?: number;
    resumeRecoveryMode: ResumeRecoveryMode;
    cwd?: string;
    commandRunner?: CommandRunner;
  },
): Promise<{ allowed: boolean; nextAction: string; warnings: string[] }> {
  if (
    options.resumeRecoveryMode === "none" &&
    isPlanningResumePhase(options.state.currentPhase)
  ) {
    return { allowed: true, nextAction: "continue_planning", warnings: [] };
  }

  const metadataResult = await readMilestoneMetadata(options.paths);
  if (!metadataResult.ok) {
    return {
      allowed: false,
      nextAction: "blocked_unsafe_resume",
      warnings: [metadataResult.error],
    };
  }

  if (options.resumeRecoveryMode !== "none") {
    return resumeRecoveryNextAction({
      ...options,
      metadata: metadataResult.metadata,
      recoveryMode: options.resumeRecoveryMode,
    });
  }

  const decision = normalizeStateForGoalResume(
    options.state,
    metadataResult.metadata,
  );
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
      if (options.config.humanReviewPolicy === "autonomous") {
        return {
          allowed: true,
          nextAction: "resolve_resume_state",
          warnings: [decision.message],
        };
      }

      if (options.config.humanReviewPolicy === "fail") {
        return {
          allowed: true,
          nextAction: "fail_unsafe_resume",
          warnings: [decision.message],
        };
      }

      return {
        allowed: false,
        nextAction: "blocked_unsafe_resume",
        warnings: [decision.message],
      };
    case "recover":
      return {
        allowed: false,
        nextAction: "blocked_unsafe_resume",
        warnings: ["Recovery decisions require an explicit recovery mode."],
      };
  }
}

async function resumeRecoveryNextAction(options: {
  state: RunState;
  paths: RunPaths;
  config: OrchestratorConfig;
  metadata: MilestoneMetadata;
  targetMilestone?: number;
  recoveryMode: Exclude<ResumeRecoveryMode, "none">;
  cwd?: string;
  commandRunner?: CommandRunner;
}): Promise<{ allowed: boolean; nextAction: string; warnings: string[] }> {
  const decision = normalizeStateForGoalResume(options.state, options.metadata, {
    recoveryMode: options.recoveryMode,
  });
  if (decision.kind !== "recover") {
    return {
      allowed: false,
      nextAction: "blocked_unsafe_resume",
      warnings: [messageForNonRecoveryDecision(decision)],
    };
  }

  if (
    options.targetMilestone !== undefined &&
    options.targetMilestone !== decision.milestoneId
  ) {
    return {
      allowed: false,
      nextAction: "blocked_unsafe_resume",
      warnings: [
        `Recovery mode ${options.recoveryMode} targets active failed milestone ${decision.milestoneId}; requested milestone ${options.targetMilestone} is not recoverable.`,
      ],
    };
  }

  const dependencyBlock = failedRecoveryDependencyBlock(
    options.state,
    options.metadata,
    decision.milestoneId,
  );
  if (dependencyBlock) {
    return {
      allowed: false,
      nextAction: "blocked_unsafe_resume",
      warnings: [dependencyBlock],
    };
  }

  const missingArtifacts = missingRecoveryArtifacts(
    options.state,
    decision.milestoneId,
    options.recoveryMode,
  );
  if (missingArtifacts.length > 0) {
    return {
      allowed: false,
      nextAction: "blocked_unsafe_resume",
      warnings: [
        `Recovery mode ${options.recoveryMode} is missing required milestone artifacts: ${missingArtifacts.join(", ")}.`,
      ],
    };
  }

  const baseline = await resolveRecoveryBaseline({
    state: options.state,
    metadata: options.metadata,
    milestoneId: decision.milestoneId,
    paths: options.paths,
    cwd: options.cwd,
    commandRunner: options.commandRunner,
  });
  if (!baseline.ok) {
    return {
      allowed: false,
      nextAction: "blocked_missing_milestone_baseline",
      warnings: [baseline.error],
    };
  }

  if (options.recoveryMode === "retry_failed") {
    if (!options.cwd || !options.commandRunner) {
      return {
        allowed: false,
        nextAction: "blocked_unsafe_resume",
        warnings: [
          "Retry dry-run requires a target cwd and command runner to compare the current worktree with the milestone baseline.",
        ],
      };
    }

    const treeResult = await captureGitTree({
      cwd: options.cwd,
      commandRunner: options.commandRunner,
      excludedPaths: [options.paths.runDir],
    });
    if (!treeResult.ok) {
      return {
        allowed: false,
        nextAction: "blocked_unsafe_resume",
        warnings: [treeResult.error],
      };
    }

    if (treeResult.tree !== baseline.baselineTree) {
      return {
        allowed: false,
        nextAction: "blocked_dirty_retry_worktree",
        warnings: [
          `Retry requires the worktree to match the milestone ${decision.milestoneId} baseline. Use --repair-failed or --recheck, or restore the worktree manually before retrying.`,
        ],
      };
    }
  }

  const warnMissingCheckFailureSummary =
    options.recoveryMode === "repair_failed" &&
    !hasRecoveryCheckFailureSummary(options.state, decision.milestoneId);

  return {
    allowed: true,
    nextAction: actionForResumeRecoveryMode(options.recoveryMode),
    warnings: [
      ...(baseline.source === "reconstructed"
        ? [
            `Milestone ${decision.milestoneId} baseline was reconstructed from legacy artifacts.`,
          ]
        : []),
      ...(warnMissingCheckFailureSummary
        ? [
            `Milestone ${decision.milestoneId} has no structured check-failure summary; repair recovery will synthesize one from the saved check report.`,
          ]
        : []),
    ],
  };
}

function messageForNonRecoveryDecision(
  decision: ReturnType<typeof normalizeStateForGoalResume>,
): string {
  if (decision.kind === "needs_human_review") return decision.message;
  if (decision.kind === "stopped") {
    return `Recovery cannot resume stopped state ${decision.state.currentPhase}/${decision.state.status}.`;
  }
  return `Recovery cannot resume from decision ${decision.kind}.`;
}

function failedRecoveryDependencyBlock(
  state: RunState,
  metadata: MilestoneMetadata,
  milestoneId: number,
): string | null {
  const milestone = metadata.milestones.find((candidate) => candidate.id === milestoneId);
  if (!milestone) return `Milestone ${milestoneId} is missing from metadata.`;

  const unmetDependencies = milestone.dependencies.filter(
    (dependencyId) => state.milestoneStatuses[String(dependencyId)] !== "passed",
  );
  if (unmetDependencies.length === 0) return null;

  return `Milestone ${milestoneId} cannot be recovered because dependencies are not passed: ${unmetDependencies.join(", ")}.`;
}

function missingRecoveryArtifacts(
  state: RunState,
  milestoneId: number,
  recoveryMode: Exclude<ResumeRecoveryMode, "none">,
): string[] {
  const key = String(milestoneId);
  const missing: string[] = [];

  if (!state.artifacts.milestonePlans?.[key]) missing.push("milestonePlans");
  if (!state.artifacts.implementations?.[key]) missing.push("implementations");
  if (!state.artifacts.checks?.[key]) missing.push("checks");
  if (recoveryMode === "repair_failed" && !state.artifacts.diffs?.[key]) {
    missing.push("diffs");
  }

  return missing;
}

function hasRecoveryCheckFailureSummary(
  state: RunState,
  milestoneId: number,
): boolean {
  const pattern = new RegExp(`^${milestoneId}-(failed|repair|recheck)-\\d+$`);
  return Object.keys(state.artifacts.checkFailures ?? {}).some((artifactKey) =>
    pattern.test(artifactKey),
  );
}

async function resolveRecoveryBaseline(options: {
  state: RunState;
  metadata: MilestoneMetadata;
  milestoneId: number;
  paths: RunPaths;
  cwd?: string;
  commandRunner?: CommandRunner;
}): Promise<
  | { ok: true; baselineTree: string; source: "stored" | "reconstructed" }
  | { ok: false; error: string }
> {
  const storedBaseline = options.state.milestoneBaselines[String(options.milestoneId)];
  if (storedBaseline) {
    return {
      ok: true,
      baselineTree: storedBaseline,
      source: "stored",
    };
  }

  if (!options.state.git.startSha) {
    return {
      ok: false,
      error:
        "Missing milestone baseline and state.git.startSha; legacy baseline reconstruction is unavailable.",
    };
  }

  if (!options.cwd || !options.commandRunner) {
    return {
      ok: false,
      error:
        "Missing milestone baseline and dry-run was not provided the Git context required for legacy baseline reconstruction.",
    };
  }

  const baselineResult = await resolveMilestoneBaseline({
    state: options.state,
    metadata: options.metadata,
    milestoneId: options.milestoneId,
    paths: options.paths,
    cwd: options.cwd,
    commandRunner: options.commandRunner,
  });

  if (!baselineResult.ok) {
    return {
      ok: false,
      error: baselineResult.error,
    };
  }

  return baselineResult;
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

function runnerExecutionDescription(config: OrchestratorConfig): string {
  return config.runner.type === "codex-exec"
    ? `codex exec via ${config.runner.command ?? "codex"}`
    : "fake runner";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
