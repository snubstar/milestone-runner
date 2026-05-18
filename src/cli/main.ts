#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { buildRunPaths, createRunId } from "../artifacts/paths.js";
import { createRunDirectory, writeRunLog } from "../artifacts/run-directory.js";
import { buildNewRunDryRunReport, buildResumeDryRunReport } from "./dry-run.js";
import { loadResumeRun } from "./run-loader.js";
import { parseArgs, usage, type CliOptions } from "./args.js";
import {
  nonGitPlanningOverride,
  printDryRunReport,
  printEnvironmentDiagnostics,
  printGitOverrideWarnings,
  printRunReport,
} from "./run-report.js";
import {
  applyConfigOverrides,
  loadConfig,
  validateConfig,
} from "../config/config-loader.js";
import { validateEnvironment, type EnvironmentDiagnostic } from "../diagnostics/environment-validator.js";
import type { GitMetadata } from "../git/git-types.js";
import { runGitPreflight } from "../git/git-preflight.js";
import { runGoalWorkflow } from "../orchestration/goal-workflow.js";
import { createAgentRunner } from "../runners/create-runner.js";
import { nodeCommandRunner } from "../shell/command-runner.js";
import { createInitialState } from "../state/initial-state.js";
import { writeState } from "../state/state-store.js";
import {
  appendInvocationTimelineEvent,
  appendStateTimelineEvent,
  nextTimelineInvocationId,
} from "../timings/state-timeline.js";
import { createTimingWarningCollector } from "../timings/timing-types.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const result = parseArgs(argv);

  if (!result.ok) {
    console.error(result.error);
    console.error(usage());
    return 1;
  }

  if (result.options.resume && result.options.runner) {
    console.error("--runner cannot be combined with --resume.");
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
    milestonePlanPolicy: options.milestonePlanPolicy,
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
  const timingWarnings = createTimingWarningCollector();
  await appendStateTimelineEvent({
    paths,
    previousState: null,
    nextState: state,
    warnings: timingWarnings,
  });
  const invocationId = await nextTimelineInvocationId(paths, timingWarnings);
  await appendInvocationTimelineEvent({
    paths,
    invocationId,
    event: "invocation_started",
    timestamp: new Date().toISOString(),
    state,
    warnings: timingWarnings,
  });

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
    invocationId,
    timingWarnings: timingWarnings.list(),
  });

  const finalState = workflowResult.state;

  if (!workflowResult.ok) {
    console.error(workflowResult.error ?? "Goal workflow failed.");
    printRunReport({
      mode: "new",
      runId,
      paths,
      goal,
      planningOnly: options.planningOnly,
      allowDirty: options.allowDirty,
      allowNonGitPlanning: options.allowNonGitPlanning,
      targetMilestone: options.milestone ?? null,
      runnerType: runnerResult.runner.type,
      configPath: loadedConfig.value.path,
      configSource: loadedConfig.value.path === null ? "default config" : "config file",
      artifactRoot: config.artifactRoot,
      checks: config.checks,
      maxFixAttempts: config.maxFixAttempts,
      milestonePlanPolicy: config.milestonePlanPolicy,
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
      timingWarnings: workflowResult.timingWarnings,
    });
    return 1;
  }

  printRunReport({
    mode: "new",
    runId,
    paths,
    goal,
    planningOnly: options.planningOnly,
    allowDirty: options.allowDirty,
    allowNonGitPlanning: options.allowNonGitPlanning,
    targetMilestone: options.milestone ?? null,
    runnerType: runnerResult.runner.type,
    configPath: loadedConfig.value.path,
    configSource: loadedConfig.value.path === null ? "default config" : "config file",
    artifactRoot: config.artifactRoot,
    checks: config.checks,
    maxFixAttempts: config.maxFixAttempts,
    milestonePlanPolicy: config.milestonePlanPolicy,
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
    timingWarnings: workflowResult.timingWarnings,
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
    milestonePlanPolicy: options.milestonePlanPolicy,
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

  const stateBeforeResume = resumeResult.state.currentPhase;
  const timingWarnings = createTimingWarningCollector();
  const invocationId = await nextTimelineInvocationId(
    resumeResult.paths,
    timingWarnings,
  );
  await appendInvocationTimelineEvent({
    paths: resumeResult.paths,
    invocationId,
    event: "invocation_started",
    timestamp: new Date().toISOString(),
    state: resumeResult.state,
    warnings: timingWarnings,
  });
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
    invocationId,
    timingWarnings: timingWarnings.list(),
  });

  const finalState = workflowResult.state;

  if (!workflowResult.ok) {
    console.error(workflowResult.error ?? "Goal workflow failed.");
    printRunReport({
      mode: "resume",
      runId: resumeResult.state.runId,
      paths: resumeResult.paths,
      goal: resumeResult.state.goal,
      planningOnly: resumePlanningOnly,
      allowDirty: options.allowDirty,
      allowNonGitPlanning: options.allowNonGitPlanning,
      targetMilestone: options.milestone ?? null,
      runnerType: runnerResult.runner.type,
      configPath: resumeResult.state.config.path,
      configSource: "state snapshot",
      artifactRoot: resumeResult.paths.artifactRoot,
      checks: config.checks,
      maxFixAttempts: config.maxFixAttempts,
      savedMaxFixAttempts: resumeResult.config.maxFixAttempts,
      milestonePlanPolicy: config.milestonePlanPolicy,
      savedMilestonePlanPolicy: resumeResult.config.milestonePlanPolicy,
      gitRequired: gitPreflight.metadata.required,
      gitRoot: gitPreflight.metadata.root ?? "unavailable",
      gitDirty: gitPreflight.metadata.dirtyAtStart,
      gitDirtyOverride: gitPreflight.metadata.dirtyOverride,
      gitNonGitPlanningOverride: nonGitPlanningOverride(
        gitPreflight.metadata,
        options.allowNonGitPlanning,
      ),
      stateBeforeResume,
      nextAction: workflowResult.nextAction,
      finalState,
      timingWarnings: workflowResult.timingWarnings,
    });
    return 1;
  }

  printRunReport({
    mode: "resume",
    runId: resumeResult.state.runId,
    paths: resumeResult.paths,
    goal: resumeResult.state.goal,
    planningOnly: resumePlanningOnly,
    allowDirty: options.allowDirty,
    allowNonGitPlanning: options.allowNonGitPlanning,
    targetMilestone: options.milestone ?? null,
    runnerType: runnerResult.runner.type,
    configPath: resumeResult.state.config.path,
    configSource: "state snapshot",
    artifactRoot: resumeResult.paths.artifactRoot,
    checks: config.checks,
    maxFixAttempts: config.maxFixAttempts,
    savedMaxFixAttempts: resumeResult.config.maxFixAttempts,
    milestonePlanPolicy: config.milestonePlanPolicy,
    savedMilestonePlanPolicy: resumeResult.config.milestonePlanPolicy,
    gitRequired: gitPreflight.metadata.required,
    gitRoot: gitPreflight.metadata.root ?? "unavailable",
    gitDirty: gitPreflight.metadata.dirtyAtStart,
    gitDirtyOverride: gitPreflight.metadata.dirtyOverride,
    gitNonGitPlanningOverride: nonGitPlanningOverride(
      gitPreflight.metadata,
      options.allowNonGitPlanning,
    ),
    stateBeforeResume,
    nextAction: workflowResult.nextAction,
    finalState,
    timingWarnings: workflowResult.timingWarnings,
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
