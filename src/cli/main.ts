#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { buildRunPaths, createRunId } from "../artifacts/paths.js";
import { createRunDirectory, writeRunLog } from "../artifacts/run-directory.js";
import { parseArgs, usage } from "./args.js";
import {
  applyConfigOverrides,
  loadConfig,
  validateConfig,
} from "../config/config-loader.js";
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

  if (result.options.allowDirty && !result.options.planningOnly) {
    console.error("--allow-dirty is only supported with --planning-only.");
    return 1;
  }

  const loadedConfig = await loadConfig({
    cwd: process.cwd(),
    configPath: result.options.configPath,
  });

  if (!loadedConfig.ok) {
    console.error(loadedConfig.error);
    return 1;
  }

  const configWithOverrides = applyConfigOverrides(loadedConfig.value.config, {
    artifactRoot: result.options.artifactRoot,
    runnerType: result.options.runner,
  });
  const configValidation = validateConfig(configWithOverrides);
  if (!configValidation.ok) {
    console.error(`Invalid config after CLI overrides: ${configValidation.error}`);
    return 1;
  }
  const config = configValidation.value;

  const gitPreflight = await runGitPreflight({
    cwd: process.cwd(),
    planningOnly: result.options.planningOnly,
    allowDirty: result.options.allowDirty,
    commandRunner: nodeCommandRunner,
  });

  if (!gitPreflight.ok) {
    console.error(gitPreflight.error);
    return 1;
  }

  const runnerResult = createAgentRunner(config.runner);
  if (!runnerResult.ok) {
    console.error(runnerResult.error);
    return 1;
  }

  if (!result.options.planningOnly && runnerResult.runner.type !== "fake") {
    console.error("Milestone 7 execution currently requires --runner fake.");
    return 1;
  }

  const runId = createRunId();
  const paths = buildRunPaths({
    cwd: process.cwd(),
    artifactRoot: config.artifactRoot,
    runId,
  });

  await createRunDirectory(paths, result.options.goal);
  await writeRunLog(paths, `Initialized run ${runId}`);

  const state = createInitialState({
    runId,
    goal: result.options.goal,
    paths,
    git: gitPreflight.metadata,
    configPath: loadedConfig.value.path,
    configSnapshot: config,
  });
  await writeState(paths.files.state, state);

  const workflowResult = await runGoalWorkflow({
    goal: result.options.goal,
    config,
    paths,
    initialState: state,
    runner: runnerResult.runner,
    commandRunner: nodeCommandRunner,
    cwd: process.cwd(),
    planningOnly: result.options.planningOnly,
  });

  const finalState = workflowResult.state;

  if (!workflowResult.ok) {
    console.error(workflowResult.error ?? "Goal workflow failed.");
    printRunReport({
      runId,
      paths,
      goal: result.options.goal,
      planningOnly: result.options.planningOnly,
      allowDirty: result.options.allowDirty,
      runnerType: runnerResult.runner.type,
      configPath: loadedConfig.value.path,
      artifactRoot: config.artifactRoot,
      gitRequired: gitPreflight.metadata.required,
      gitRoot: gitPreflight.metadata.root ?? "unavailable",
      gitDirty: gitPreflight.metadata.dirtyAtStart,
      finalState,
    });
    return 1;
  }

  printRunReport({
    runId,
    paths,
    goal: result.options.goal,
    planningOnly: result.options.planningOnly,
    allowDirty: result.options.allowDirty,
    runnerType: runnerResult.runner.type,
    configPath: loadedConfig.value.path,
    artifactRoot: config.artifactRoot,
    gitRequired: gitPreflight.metadata.required,
    gitRoot: gitPreflight.metadata.root ?? "unavailable",
    gitDirty: gitPreflight.metadata.dirtyAtStart,
    finalState,
  });
  return 0;
}

function printRunReport(options: {
  runId: string;
  paths: { runDir: string };
  goal: string;
  planningOnly: boolean;
  allowDirty: boolean;
  runnerType: string;
  configPath: string | null;
  artifactRoot: string;
  gitRequired: boolean;
  gitRoot: string;
  gitDirty: boolean;
  finalState: RunState;
}): void {
  console.log("Agent milestone orchestrator");
  console.log(`Run id: ${options.runId}`);
  console.log(`Run dir: ${options.paths.runDir}`);
  console.log(`Goal: ${options.goal}`);
  console.log(`Planning only: ${options.planningOnly}`);
  console.log(`Allow dirty: ${options.allowDirty}`);
  console.log(`Runner: ${options.runnerType}`);
  console.log(`Config: ${options.configPath}`);
  console.log(`Artifact root: ${options.artifactRoot}`);
  console.log(`Git required: ${options.gitRequired}`);
  console.log(`Git root: ${options.gitRoot}`);
  console.log(`Git dirty: ${options.gitDirty}`);
  console.log(`State: ${options.finalState.currentPhase}`);
  console.log(`Current milestone: ${options.finalState.currentMilestoneId ?? "none"}`);
  console.log("Milestones:");
  for (const line of formatMilestoneStatuses(options.finalState)) {
    console.log(line);
  }
  const finalSummary = options.finalState.artifacts.summaries?.goal;
  if (finalSummary) {
    console.log(`Final summary artifact: ${finalSummary}`);
  }
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
