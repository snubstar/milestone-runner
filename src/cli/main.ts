#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import {
  assertArtifactRootPathSafe,
  normalizeArtifactRoot,
} from "../artifacts/artifact-root.js";
import { buildRunPaths, createRunId } from "../artifacts/paths.js";
import { createRunDirectory, writeRunLog } from "../artifacts/run-directory.js";
import {
  buildNewRunDryRunReport,
  buildResumeDryRunReport,
  type DryRunReport,
} from "./dry-run.js";
import { loadResumeRun } from "./run-loader.js";
import { parseArgs, usage, type CliOptions } from "./args.js";
import {
  nonGitPlanningOverride,
  printDryRunJsonReport,
  printDryRunReport,
  printEnvironmentDiagnostics,
  printGitOverrideWarnings,
  printRunJsonReport,
  printRunReport,
  type RunReportOptions,
} from "./run-report.js";
import {
  applyConfigOverrides,
  loadConfig,
  validateConfig,
} from "../config/config-loader.js";
import { validateEnvironment, type EnvironmentDiagnostic } from "../diagnostics/environment-validator.js";
import type { GitMetadata } from "../git/git-types.js";
import { runGitPreflight } from "../git/git-preflight.js";
import {
  resolveInitialInputs,
  writeInitialInputArtifacts,
} from "../inputs/initial-inputs.js";
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
import { resolveOrchestratorResources } from "../workspace/orchestrator-resources.js";
import { resolveTargetRepository } from "../workspace/target-repo.js";

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
  const workspaceResult = await resolveTargetRepository({
    repoPath: options.repoPath,
    invocationCwd: process.cwd(),
  });
  if (!workspaceResult.ok) {
    console.error(workspaceResult.error);
    return 1;
  }
  const workspace = workspaceResult.value;

  const resourcesResult = await resolveOrchestratorResources({
    moduleUrl: import.meta.url,
    cwd: workspace.invocationCwd,
  });
  if (!resourcesResult.ok) {
    console.error(resourcesResult.error);
    return 1;
  }
  const resources = resourcesResult.value;

  const initialInputsResult = await resolveInitialInputs({
    targetCwd: workspace.targetCwd,
    argvGoal: options.goal,
    goalFile: options.goalFile,
    seedMajorPlanFile: options.seedMajorPlanFile,
    contextPaths: options.contextPaths,
  });
  if (!initialInputsResult.ok) {
    console.error(initialInputsResult.error);
    return 1;
  }
  const initialInputs = initialInputsResult.value;
  const goal = initialInputs.goal;
  const dryRunInputDetails = {
    invocationCwd: workspace.invocationCwd,
    targetCwd: workspace.targetCwd,
    goalSourceType: initialInputs.goalSource.type,
    goalSourcePath: initialInputs.goalSource.path,
    majorPlanSource: initialInputs.seedMajorPlan
      ? {
          type: "seed" as const,
          path: initialInputs.seedMajorPlan.path,
        }
      : { type: "runner" as const, path: null },
    contextPaths: initialInputs.context.map((entry) => entry.path),
  };

  const loadedConfig = await loadConfig({
    cwd: workspace.targetCwd,
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
    milestonePlanReviewPolicy: options.milestonePlanReviewPolicy,
  });
  const configValidation = validateConfig(configWithOverrides);
  if (!configValidation.ok) {
    console.error(`Invalid config after CLI overrides: ${configValidation.error}`);
    return 1;
  }
  const artifactRootResult = normalizeArtifactRoot(configValidation.value.artifactRoot);
  if (!artifactRootResult.ok) {
    console.error(`Invalid artifactRoot: ${artifactRootResult.error}`);
    return 1;
  }
  const config = {
    ...configValidation.value,
    artifactRoot: artifactRootResult.value,
  };
  const artifactRootSafety = await assertArtifactRootPathSafe({
    targetCwd: workspace.targetCwd,
    artifactRoot: config.artifactRoot,
  });
  if (!artifactRootSafety.ok) {
    console.error(`Invalid artifactRoot: ${artifactRootSafety.error}`);
    return 1;
  }

  const environment = await validateEnvironment({
    cwd: workspace.targetCwd,
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
        ...newRunDryRunIdentity(options, config.artifactRoot, workspace.targetCwd),
        ...dryRunInputDetails,
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
      printDryRunReportForCli(options, report);
      return report.exitCode;
    }

    printEnvironmentDiagnostics(environment.diagnostics);
    return 1;
  }

  if (!options.dryRun) {
    printEnvironmentDiagnostics(environment.diagnostics);
  }

  const gitPreflight = await runGitPreflight({
    cwd: workspace.targetCwd,
    planningOnly: options.planningOnly,
    allowDirty: options.allowDirty,
    allowNonGitPlanning: options.allowNonGitPlanning,
    commandRunner: nodeCommandRunner,
  });

  if (!gitPreflight.ok) {
    if (options.dryRun) {
      const report = buildNewRunDryRunReport({
        goal,
        ...newRunDryRunIdentity(options, config.artifactRoot, workspace.targetCwd),
        ...dryRunInputDetails,
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
      printDryRunReportForCli(options, report);
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
        ...newRunDryRunIdentity(options, config.artifactRoot, workspace.targetCwd),
        ...dryRunInputDetails,
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
      printDryRunReportForCli(options, report);
      return report.exitCode;
    }

    console.error(runnerResult.error);
    return 1;
  }

  if (options.dryRun) {
    const report = buildNewRunDryRunReport({
      goal,
      ...newRunDryRunIdentity(options, config.artifactRoot, workspace.targetCwd),
      ...dryRunInputDetails,
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
    printDryRunReportForCli(options, report);
    return report.exitCode;
  }

  const runId = options.runId ?? createRunId();
  const paths = buildRunPaths({
    cwd: workspace.targetCwd,
    artifactRoot: config.artifactRoot,
    runId,
  });

  await createRunDirectory(paths, goal, {
    goalArtifactText: initialInputs.goalArtifactText,
  });
  await writeRunLog(paths, `Initialized run ${runId}`);
  const inputArtifacts = await writeInitialInputArtifacts({
    paths,
    inputs: initialInputs,
  });

  const state = createInitialState({
    runId,
    goal,
    paths,
    git: gitPreflight.metadata,
    configPath: loadedConfig.value.path,
    configSnapshot: config,
    workspace: {
      invocationCwd: workspace.invocationCwd,
      targetCwd: workspace.targetCwd,
    },
    inputs: inputArtifacts.stateInputs,
    inputArtifacts: inputArtifacts.stateArtifacts,
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
    cwd: workspace.targetCwd,
    promptDir: resources.promptDir,
    schemaRoot: resources.schemaRoot,
    resolvedSeedMajorPlan: initialInputs.seedMajorPlan,
    planningOnly: options.planningOnly,
    executionLimits: executionLimitsForOptions(options),
    invocationId,
    timingWarnings: timingWarnings.list(),
  });

  const finalState = workflowResult.state;

  if (!workflowResult.ok) {
    console.error(workflowResult.error ?? "Goal workflow failed.");
    printRunReportForCli(options, {
      mode: "new",
      runId,
      paths,
      goal,
      planningOnly: options.planningOnly,
      allowDirty: options.allowDirty,
      allowNonGitPlanning: options.allowNonGitPlanning,
      targetMilestone: options.milestone ?? null,
      runnerType: runnerResult.runner.type,
      runnerConfig: config.runner,
      configPath: loadedConfig.value.path,
      configSource: loadedConfig.value.path === null ? "default config" : "config file",
      artifactRoot: config.artifactRoot,
      checks: config.checks,
      maxFixAttempts: config.maxFixAttempts,
      milestonePlanPolicy: config.milestonePlanPolicy,
      milestonePlanReviewPolicy: config.milestonePlanReviewPolicy,
      humanReviewPolicy: config.humanReviewPolicy,
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
    }, 1);
    return 1;
  }

  printRunReportForCli(options, {
    mode: "new",
    runId,
    paths,
    goal,
    planningOnly: options.planningOnly,
    allowDirty: options.allowDirty,
    allowNonGitPlanning: options.allowNonGitPlanning,
    targetMilestone: options.milestone ?? null,
    runnerType: runnerResult.runner.type,
    runnerConfig: config.runner,
    configPath: loadedConfig.value.path,
    configSource: loadedConfig.value.path === null ? "default config" : "config file",
    artifactRoot: config.artifactRoot,
    checks: config.checks,
    maxFixAttempts: config.maxFixAttempts,
    milestonePlanPolicy: config.milestonePlanPolicy,
    milestonePlanReviewPolicy: config.milestonePlanReviewPolicy,
    humanReviewPolicy: config.humanReviewPolicy,
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
  }, 0);
  return 0;
}

async function runResumeWorkflow(options: CliOptions): Promise<number> {
  if (!options.resume) {
    console.error("Missing resume value.");
    return 1;
  }

  const workspaceResult = await resolveTargetRepository({
    repoPath: options.repoPath,
    invocationCwd: process.cwd(),
  });
  if (!workspaceResult.ok) {
    console.error(workspaceResult.error);
    return 1;
  }
  const workspace = workspaceResult.value;

  const resourcesResult = await resolveOrchestratorResources({
    moduleUrl: import.meta.url,
    cwd: workspace.invocationCwd,
  });
  if (!resourcesResult.ok) {
    console.error(resourcesResult.error);
    return 1;
  }
  const resources = resourcesResult.value;

  const artifactRootResult = normalizeArtifactRoot(options.artifactRoot ?? ".agent-work");
  if (!artifactRootResult.ok) {
    console.error(`Invalid artifactRoot: ${artifactRootResult.error}`);
    return 1;
  }

  const resumeResult = await loadResumeRun({
    cwd: workspace.targetCwd,
    targetCwd: workspace.targetCwd,
    repoExplicit: workspace.repoExplicit,
    invocationCwd: workspace.invocationCwd,
    artifactRoot: artifactRootResult.value,
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
    milestonePlanReviewPolicy: options.milestonePlanReviewPolicy,
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
      printDryRunReportForCli(options, report);
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
      printDryRunReportForCli(options, report);
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
      printDryRunReportForCli(options, report);
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
    printDryRunReportForCli(options, report);
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
    promptDir: resources.promptDir,
    schemaRoot: resources.schemaRoot,
    planningOnly: resumePlanningOnly,
    executionLimits: executionLimitsForOptions(options),
    invocationId,
    timingWarnings: timingWarnings.list(),
  });

  const finalState = workflowResult.state;

  if (!workflowResult.ok) {
    console.error(workflowResult.error ?? "Goal workflow failed.");
    printRunReportForCli(options, {
      mode: "resume",
      runId: resumeResult.state.runId,
      paths: resumeResult.paths,
      goal: resumeResult.state.goal,
      planningOnly: resumePlanningOnly,
      allowDirty: options.allowDirty,
      allowNonGitPlanning: options.allowNonGitPlanning,
      targetMilestone: options.milestone ?? null,
      runnerType: runnerResult.runner.type,
      runnerConfig: config.runner,
      configPath: resumeResult.state.config.path,
      configSource: "state snapshot",
      artifactRoot: resumeResult.paths.artifactRoot,
      checks: config.checks,
      maxFixAttempts: config.maxFixAttempts,
      savedMaxFixAttempts: resumeResult.config.maxFixAttempts,
      milestonePlanPolicy: config.milestonePlanPolicy,
      savedMilestonePlanPolicy: resumeResult.config.milestonePlanPolicy,
      milestonePlanReviewPolicy: config.milestonePlanReviewPolicy,
      savedMilestonePlanReviewPolicy:
        resumeResult.config.milestonePlanReviewPolicy,
      humanReviewPolicy: config.humanReviewPolicy,
      savedHumanReviewPolicy: resumeResult.config.humanReviewPolicy,
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
    }, 1);
    return 1;
  }

  printRunReportForCli(options, {
    mode: "resume",
    runId: resumeResult.state.runId,
    paths: resumeResult.paths,
    goal: resumeResult.state.goal,
    planningOnly: resumePlanningOnly,
    allowDirty: options.allowDirty,
    allowNonGitPlanning: options.allowNonGitPlanning,
    targetMilestone: options.milestone ?? null,
    runnerType: runnerResult.runner.type,
    runnerConfig: config.runner,
    configPath: resumeResult.state.config.path,
    configSource: "state snapshot",
    artifactRoot: resumeResult.paths.artifactRoot,
    checks: config.checks,
    maxFixAttempts: config.maxFixAttempts,
    savedMaxFixAttempts: resumeResult.config.maxFixAttempts,
    milestonePlanPolicy: config.milestonePlanPolicy,
    savedMilestonePlanPolicy: resumeResult.config.milestonePlanPolicy,
    milestonePlanReviewPolicy: config.milestonePlanReviewPolicy,
    savedMilestonePlanReviewPolicy:
      resumeResult.config.milestonePlanReviewPolicy,
    humanReviewPolicy: config.humanReviewPolicy,
    savedHumanReviewPolicy: resumeResult.config.humanReviewPolicy,
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
  }, 0);
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

function newRunDryRunIdentity(
  options: CliOptions,
  artifactRoot: string,
  targetCwd: string,
): { runId?: string; runDir?: string } {
  if (!options.runId) return {};
  const paths = buildRunPaths({
    cwd: targetCwd,
    artifactRoot,
    runId: options.runId,
  });
  return { runId: options.runId, runDir: paths.runDir };
}

function printDryRunReportForCli(options: CliOptions, report: DryRunReport): void {
  if (options.json) {
    printDryRunJsonReport(report);
    return;
  }
  printDryRunReport(report);
}

function printRunReportForCli(
  options: CliOptions,
  report: RunReportOptions,
  exitCode: 0 | 1,
): void {
  if (options.json) {
    printRunJsonReport(report, exitCode);
    return;
  }
  printRunReport(report);
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
