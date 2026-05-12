#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { buildRunPaths, createRunId } from "../artifacts/paths.js";
import { createRunDirectory, writeRunLog } from "../artifacts/run-directory.js";
import {
  buildNewRunDryRunReport,
  buildResumeDryRunReport,
  printDryRunReport,
} from "./dry-run.js";
import { loadResumeRun } from "./run-loader.js";
import { parseArgs, usage, type CliOptions } from "./args.js";
import {
  applyConfigOverrides,
  loadConfig,
  validateConfig,
} from "../config/config-loader.js";
import {
  formatEnvironmentDiagnostics,
  validateEnvironment,
  type EnvironmentDiagnostic,
} from "../diagnostics/environment-validator.js";
import type { GitMetadata } from "../git/git-types.js";
import { runGitPreflight } from "../git/git-preflight.js";
import { runGoalWorkflow } from "../orchestration/goal-workflow.js";
import { createAgentRunner } from "../runners/create-runner.js";
import { nodeCommandRunner } from "../shell/command-runner.js";
import { createInitialState } from "../state/initial-state.js";
import type { RunState } from "../state/state-types.js";
import { writeState } from "../state/state-store.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const result = parseArgs(argv);

  if (!result.ok) {
    console.error(result.error);
    console.error(usage());
    return 1;
  }

  if (result.options.resume && result.options.runner) {
    console.error("--runner cannot be combined with --resume in Milestone 8.");
    return 1;
  }

  if (result.options.resume) {
    return runResumeWorkflow(result.options);
  }

  return runNewWorkflow(result.options);
}

async function runNewWorkflow(options: CliOptions): Promise<number> {
  const goal = options.goal;
  if (goal === null) {
    console.error("Missing goal.");
    return 1;
  }

  const loadedConfig = await loadConfig({
    cwd: process.cwd(),
    configPath: options.configPath,
  });

  if (!loadedConfig.ok) {
    console.error(loadedConfig.error);
    return 1;
  }

  const configWithOverrides = applyConfigOverrides(loadedConfig.value.config, {
    artifactRoot: options.artifactRoot,
    runnerType: options.runner,
    maxFixAttempts: options.maxFixAttempts,
  });
  const configValidation = validateConfig(configWithOverrides);
  if (!configValidation.ok) {
    console.error(`Invalid config after CLI overrides: ${configValidation.error}`);
    return 1;
  }
  const config = configValidation.value;

  const environment = await validateEnvironment({
    cwd: process.cwd(),
    config,
    commandRunner: nodeCommandRunner,
    requireGitCommand: shouldRequireGitCommand({
      planningOnly: options.planningOnly,
      allowNonGitPlanning: options.allowNonGitPlanning,
    }),
  });

  if (!environment.ok) {
    if (options.dryRun) {
      const report = buildNewRunDryRunReport({
        goal,
        config,
        configPath: loadedConfig.value.path,
        planningOnly: options.planningOnly,
        allowDirty: options.allowDirty,
        allowNonGitPlanning: options.allowNonGitPlanning,
        targetMilestone: options.milestone,
        git: emptyGitMetadata(options.planningOnly),
        runnerType: config.runner.type,
        diagnostics: environment.diagnostics,
        blockedReason: classifyEnvironmentFailure(environment.diagnostics),
      });
      printDryRunReport(report);
      return report.exitCode;
    }

    printEnvironmentDiagnostics(environment.diagnostics);
    return 1;
  }

  if (!options.dryRun) {
    printEnvironmentDiagnostics(environment.diagnostics);
  }

  const gitPreflight = await runGitPreflight({
    cwd: process.cwd(),
    planningOnly: options.planningOnly,
    allowDirty: options.allowDirty,
    allowNonGitPlanning: options.allowNonGitPlanning,
    commandRunner: nodeCommandRunner,
  });

  if (!gitPreflight.ok) {
    if (options.dryRun) {
      const report = buildNewRunDryRunReport({
        goal,
        config,
        configPath: loadedConfig.value.path,
        planningOnly: options.planningOnly,
        allowDirty: options.allowDirty,
        allowNonGitPlanning: options.allowNonGitPlanning,
        targetMilestone: options.milestone,
        git: gitPreflight.metadata,
        runnerType: config.runner.type,
        diagnostics: environment.diagnostics,
        blockedReason: classifyGitPreflightFailure(gitPreflight.error),
      });
      printDryRunReport(report);
      return report.exitCode;
    }

    console.error(gitPreflight.error);
    return 1;
  }

  if (!options.dryRun) {
    printGitOverrideWarnings(gitPreflight.metadata, options.allowNonGitPlanning);
  }

  const runnerResult = createAgentRunner(config.runner);
  if (!runnerResult.ok) {
    if (options.dryRun) {
      const report = buildNewRunDryRunReport({
        goal,
        config,
        configPath: loadedConfig.value.path,
        planningOnly: options.planningOnly,
        allowDirty: options.allowDirty,
        allowNonGitPlanning: options.allowNonGitPlanning,
        targetMilestone: options.milestone,
        git: gitPreflight.metadata,
        runnerType: config.runner.type,
        diagnostics: environment.diagnostics,
        blockedReason: "blocked_runner_configuration",
      });
      printDryRunReport(report);
      return report.exitCode;
    }

    console.error(runnerResult.error);
    return 1;
  }

  if (!options.planningOnly && runnerResult.runner.type !== "fake") {
    if (options.dryRun) {
      const report = buildNewRunDryRunReport({
        goal,
        config,
        configPath: loadedConfig.value.path,
        planningOnly: options.planningOnly,
        allowDirty: options.allowDirty,
        allowNonGitPlanning: options.allowNonGitPlanning,
        targetMilestone: options.milestone,
        git: gitPreflight.metadata,
        runnerType: runnerResult.runner.type,
        diagnostics: environment.diagnostics,
        blockedReason: "blocked_runner_not_supported",
      });
      printDryRunReport(report);
      return report.exitCode;
    }

    console.error("Milestone 7 execution currently requires --runner fake.");
    return 1;
  }

  if (options.dryRun) {
    const report = buildNewRunDryRunReport({
      goal,
      config,
      configPath: loadedConfig.value.path,
      planningOnly: options.planningOnly,
      allowDirty: options.allowDirty,
      allowNonGitPlanning: options.allowNonGitPlanning,
      targetMilestone: options.milestone,
      git: gitPreflight.metadata,
      runnerType: runnerResult.runner.type,
      diagnostics: environment.diagnostics,
    });
    printDryRunReport(report);
    return report.exitCode;
  }

  const runId = createRunId();
  const paths = buildRunPaths({
    cwd: process.cwd(),
    artifactRoot: config.artifactRoot,
    runId,
  });

  await createRunDirectory(paths, goal);
  await writeRunLog(paths, `Initialized run ${runId}`);

  const state = createInitialState({
    runId,
    goal,
    paths,
    git: gitPreflight.metadata,
    configPath: loadedConfig.value.path,
    configSnapshot: config,
  });
  await writeState(paths.files.state, state);

  const workflowResult = await runGoalWorkflow({
    goal,
    config,
    paths,
    initialState: state,
    runner: runnerResult.runner,
    commandRunner: nodeCommandRunner,
    cwd: process.cwd(),
    planningOnly: options.planningOnly,
    executionLimits: executionLimitsForOptions(options),
  });

  const finalState = workflowResult.state;

  if (!workflowResult.ok) {
    console.error(workflowResult.error ?? "Goal workflow failed.");
    printRunReport({
      runId,
      paths,
      goal,
      planningOnly: options.planningOnly,
      allowDirty: options.allowDirty,
      allowNonGitPlanning: options.allowNonGitPlanning,
      targetMilestone: options.milestone ?? null,
      runnerType: runnerResult.runner.type,
      configPath: loadedConfig.value.path,
      artifactRoot: config.artifactRoot,
      checks: config.checks,
      gitRequired: gitPreflight.metadata.required,
      gitRoot: gitPreflight.metadata.root ?? "unavailable",
      gitDirty: gitPreflight.metadata.dirtyAtStart,
      gitDirtyOverride: gitPreflight.metadata.dirtyOverride,
      gitNonGitPlanningOverride: nonGitPlanningOverride(
        gitPreflight.metadata,
        options.allowNonGitPlanning,
      ),
      nextAction: workflowResult.nextAction,
      finalState,
    });
    return 1;
  }

  printRunReport({
    runId,
    paths,
    goal,
    planningOnly: options.planningOnly,
    allowDirty: options.allowDirty,
    allowNonGitPlanning: options.allowNonGitPlanning,
    targetMilestone: options.milestone ?? null,
    runnerType: runnerResult.runner.type,
    configPath: loadedConfig.value.path,
    artifactRoot: config.artifactRoot,
    checks: config.checks,
    gitRequired: gitPreflight.metadata.required,
    gitRoot: gitPreflight.metadata.root ?? "unavailable",
    gitDirty: gitPreflight.metadata.dirtyAtStart,
    gitDirtyOverride: gitPreflight.metadata.dirtyOverride,
    gitNonGitPlanningOverride: nonGitPlanningOverride(
      gitPreflight.metadata,
      options.allowNonGitPlanning,
    ),
    nextAction: workflowResult.nextAction,
    finalState,
  });
  return 0;
}

async function runResumeWorkflow(options: CliOptions): Promise<number> {
  if (!options.resume) {
    console.error("Missing resume value.");
    return 1;
  }

  const resumeResult = await loadResumeRun({
    cwd: process.cwd(),
    artifactRoot: options.artifactRoot ?? ".agent-work",
    resumeValue: options.resume,
    commandRunner: nodeCommandRunner,
  });

  if (!resumeResult.ok) {
    console.error(resumeResult.error);
    return 1;
  }

  if (!options.dryRun) {
    for (const warning of resumeResult.warnings) {
      console.error(`Warning: ${warning}`);
    }
  }

  const resumePlanningOnly = options.planningOnly || resumeResult.state.git.root === null;
  const configWithOverrides = applyConfigOverrides(resumeResult.config, {
    maxFixAttempts: options.maxFixAttempts,
  });
  const configValidation = validateConfig(configWithOverrides);
  if (!configValidation.ok) {
    console.error(`Invalid resume config after CLI overrides: ${configValidation.error}`);
    return 1;
  }
  const config = configValidation.value;

  const environment = await validateEnvironment({
    cwd: resumeResult.targetCwd,
    config,
    commandRunner: nodeCommandRunner,
    requireGitCommand: shouldRequireGitCommand({
      planningOnly: resumePlanningOnly,
      allowNonGitPlanning: options.allowNonGitPlanning,
    }),
  });

  if (!environment.ok) {
    if (options.dryRun) {
      const report = await buildResumeDryRunReport({
        state: resumeResult.state,
        paths: resumeResult.paths,
        config,
        planningOnly: resumePlanningOnly,
        allowDirty: options.allowDirty,
        allowNonGitPlanning: options.allowNonGitPlanning,
        targetMilestone: options.milestone,
        git: emptyGitMetadata(resumePlanningOnly),
        runnerType: config.runner.type,
        diagnostics: environment.diagnostics,
        warnings: resumeResult.warnings,
        blockedReason: classifyEnvironmentFailure(environment.diagnostics),
      });
      printDryRunReport(report);
      return report.exitCode;
    }

    printEnvironmentDiagnostics(environment.diagnostics);
    return 1;
  }

  if (!options.dryRun) {
    printEnvironmentDiagnostics(environment.diagnostics);
  }

  const gitPreflight = await runGitPreflight({
    cwd: resumeResult.targetCwd,
    planningOnly: resumePlanningOnly,
    allowDirty: options.allowDirty,
    allowNonGitPlanning: options.allowNonGitPlanning,
    commandRunner: nodeCommandRunner,
  });

  if (!gitPreflight.ok) {
    if (options.dryRun) {
      const report = await buildResumeDryRunReport({
        state: resumeResult.state,
        paths: resumeResult.paths,
        config,
        planningOnly: resumePlanningOnly,
        allowDirty: options.allowDirty,
        allowNonGitPlanning: options.allowNonGitPlanning,
        targetMilestone: options.milestone,
        git: gitPreflight.metadata,
        runnerType: config.runner.type,
        diagnostics: environment.diagnostics,
        warnings: resumeResult.warnings,
        blockedReason: classifyGitPreflightFailure(gitPreflight.error),
      });
      printDryRunReport(report);
      return report.exitCode;
    }

    console.error(gitPreflight.error);
    return 1;
  }

  if (!options.dryRun) {
    printGitOverrideWarnings(gitPreflight.metadata, options.allowNonGitPlanning);
  }

  const runnerResult = createAgentRunner(config.runner);
  if (!runnerResult.ok) {
    if (options.dryRun) {
      const report = await buildResumeDryRunReport({
        state: resumeResult.state,
        paths: resumeResult.paths,
        config,
        planningOnly: resumePlanningOnly,
        allowDirty: options.allowDirty,
        allowNonGitPlanning: options.allowNonGitPlanning,
        targetMilestone: options.milestone,
        git: gitPreflight.metadata,
        runnerType: config.runner.type,
        diagnostics: environment.diagnostics,
        warnings: resumeResult.warnings,
        blockedReason: "blocked_runner_configuration",
      });
      printDryRunReport(report);
      return report.exitCode;
    }

    console.error(runnerResult.error);
    return 1;
  }

  if (!resumePlanningOnly && runnerResult.runner.type !== "fake") {
    if (options.dryRun) {
      const report = await buildResumeDryRunReport({
        state: resumeResult.state,
        paths: resumeResult.paths,
        config,
        planningOnly: resumePlanningOnly,
        allowDirty: options.allowDirty,
        allowNonGitPlanning: options.allowNonGitPlanning,
        targetMilestone: options.milestone,
        git: gitPreflight.metadata,
        runnerType: runnerResult.runner.type,
        diagnostics: environment.diagnostics,
        warnings: resumeResult.warnings,
        blockedReason: "blocked_runner_not_supported",
      });
      printDryRunReport(report);
      return report.exitCode;
    }

    console.error("Milestone 8 resume execution currently requires a fake runner for implementation-capable phases.");
    return 1;
  }

  if (options.dryRun) {
    const report = await buildResumeDryRunReport({
      state: resumeResult.state,
      paths: resumeResult.paths,
      config,
      planningOnly: resumePlanningOnly,
      allowDirty: options.allowDirty,
      allowNonGitPlanning: options.allowNonGitPlanning,
      targetMilestone: options.milestone,
      git: gitPreflight.metadata,
      runnerType: runnerResult.runner.type,
      diagnostics: environment.diagnostics,
      warnings: resumeResult.warnings,
    });
    printDryRunReport(report);
    return report.exitCode;
  }

  const workflowResult = await runGoalWorkflow({
    goal: resumeResult.state.goal,
    config,
    paths: resumeResult.paths,
    initialState: resumeResult.state,
    runner: runnerResult.runner,
    commandRunner: nodeCommandRunner,
    cwd: resumeResult.targetCwd,
    planningOnly: resumePlanningOnly,
    executionLimits: executionLimitsForOptions(options),
  });

  const finalState = workflowResult.state;

  if (!workflowResult.ok) {
    console.error(workflowResult.error ?? "Goal workflow failed.");
    printRunReport({
      runId: resumeResult.state.runId,
      paths: resumeResult.paths,
      goal: resumeResult.state.goal,
      planningOnly: resumePlanningOnly,
      allowDirty: options.allowDirty,
      allowNonGitPlanning: options.allowNonGitPlanning,
      targetMilestone: options.milestone ?? null,
      runnerType: runnerResult.runner.type,
      configPath: resumeResult.state.config.path,
      artifactRoot: resumeResult.paths.artifactRoot,
      checks: config.checks,
      gitRequired: gitPreflight.metadata.required,
      gitRoot: gitPreflight.metadata.root ?? "unavailable",
      gitDirty: gitPreflight.metadata.dirtyAtStart,
      gitDirtyOverride: gitPreflight.metadata.dirtyOverride,
      gitNonGitPlanningOverride: nonGitPlanningOverride(
        gitPreflight.metadata,
        options.allowNonGitPlanning,
      ),
      nextAction: workflowResult.nextAction,
      finalState,
    });
    return 1;
  }

  printRunReport({
    runId: resumeResult.state.runId,
    paths: resumeResult.paths,
    goal: resumeResult.state.goal,
    planningOnly: resumePlanningOnly,
    allowDirty: options.allowDirty,
    allowNonGitPlanning: options.allowNonGitPlanning,
    targetMilestone: options.milestone ?? null,
    runnerType: runnerResult.runner.type,
    configPath: resumeResult.state.config.path,
    artifactRoot: resumeResult.paths.artifactRoot,
    checks: config.checks,
    gitRequired: gitPreflight.metadata.required,
    gitRoot: gitPreflight.metadata.root ?? "unavailable",
    gitDirty: gitPreflight.metadata.dirtyAtStart,
    gitDirtyOverride: gitPreflight.metadata.dirtyOverride,
    gitNonGitPlanningOverride: nonGitPlanningOverride(
      gitPreflight.metadata,
      options.allowNonGitPlanning,
    ),
    nextAction: workflowResult.nextAction,
    finalState,
  });
  return 0;
}

function classifyGitPreflightFailure(error: string): string {
  if (error.includes("working tree is dirty")) return "blocked_dirty_tree";
  if (error.includes("Not inside a Git repository")) return "blocked_non_git";
  if (error.includes("no commits")) return "blocked_git_no_commits";
  return "blocked_git_preflight";
}

function classifyEnvironmentFailure(diagnostics: EnvironmentDiagnostic[]): string {
  return diagnostics.some((diagnostic) => diagnostic.level === "error")
    ? "blocked_missing_tool"
    : "blocked_environment";
}

function printRunReport(options: {
  runId: string;
  paths: { runDir: string };
  goal: string;
  planningOnly: boolean;
  allowDirty: boolean;
  allowNonGitPlanning: boolean;
  targetMilestone: number | null;
  runnerType: string;
  configPath: string | null;
  artifactRoot: string;
  checks: string[];
  gitRequired: boolean;
  gitRoot: string;
  gitDirty: boolean;
  gitDirtyOverride: boolean;
  gitNonGitPlanningOverride: boolean;
  nextAction?: string;
  finalState: RunState;
}): void {
  console.log("Agent milestone orchestrator");
  console.log(`Run id: ${options.runId}`);
  console.log(`Run dir: ${options.paths.runDir}`);
  console.log(`Goal: ${options.goal}`);
  console.log(`Planning only: ${options.planningOnly}`);
  console.log(`Allow dirty: ${options.allowDirty}`);
  console.log(`Allow non-Git planning: ${options.allowNonGitPlanning}`);
  console.log(`Target milestone: ${options.targetMilestone ?? "none"}`);
  console.log(`Runner: ${options.runnerType}`);
  console.log(`Config: ${options.configPath}`);
  console.log(`Artifact root: ${options.artifactRoot}`);
  console.log(`Checks: ${formatChecks(options.checks)}`);
  console.log(`Git required: ${options.gitRequired}`);
  console.log(`Git root: ${options.gitRoot}`);
  console.log(`Git dirty: ${options.gitDirty}`);
  console.log(`Git dirty override: ${options.gitDirtyOverride}`);
  console.log(`Non-Git planning override: ${options.gitNonGitPlanningOverride}`);
  console.log(`State: ${options.finalState.currentPhase}`);
  console.log(`Current milestone: ${options.finalState.currentMilestoneId ?? "none"}`);
  if (options.nextAction) {
    console.log(`Next action: ${options.nextAction}`);
  }
  console.log("Milestones:");
  for (const line of formatMilestoneStatuses(options.finalState)) {
    console.log(line);
  }
  const finalSummary = options.finalState.artifacts.summaries?.goal;
  if (finalSummary) {
    console.log(`Final summary artifact: ${finalSummary}`);
  }
}

function printEnvironmentDiagnostics(diagnostics: EnvironmentDiagnostic[]): void {
  for (const line of formatEnvironmentDiagnostics(diagnostics)) {
    console.error(line);
  }
}

function shouldRequireGitCommand(options: {
  planningOnly: boolean;
  allowNonGitPlanning: boolean;
}): boolean {
  return !(options.planningOnly && options.allowNonGitPlanning);
}

function executionLimitsForOptions(options: CliOptions) {
  if (options.milestone === undefined) return undefined;
  return {
    targetMilestoneId: options.milestone,
    stopAfterTargetMilestone: true,
  };
}

function emptyGitMetadata(planningOnly: boolean): GitMetadata {
  return {
    required: !planningOnly,
    planningOnly,
    root: null,
    startSha: null,
    dirtyAtStart: false,
    dirtyOverride: false,
    statusPorcelain: "",
  };
}

function printGitOverrideWarnings(
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

function nonGitPlanningOverride(
  git: GitMetadata,
  allowNonGitPlanning: boolean,
): boolean {
  return allowNonGitPlanning && git.planningOnly && !git.required && git.root === null;
}

function formatChecks(checks: string[]): string {
  return checks.length === 0 ? "none" : checks.join(" && ");
}

function formatMilestoneStatuses(state: RunState): string[] {
  const entries = Object.entries(state.milestoneStatuses).sort(
    ([left], [right]) => Number(left) - Number(right),
  );

  if (entries.length === 0) return ["  none"];
  return entries.map(([milestoneId, status]) => `  ${milestoneId}: ${status}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
