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
import { runImplementationWorkflow } from "../implementation/implementation-workflow.js";
import { runPlanningWorkflow } from "../planning/planning-workflow.js";
import { runReviewWorkflow } from "../review/review-workflow.js";
import { createAgentRunner } from "../runners/create-runner.js";
import { nodeCommandRunner } from "../shell/command-runner.js";
import { createInitialState } from "../state/initial-state.js";
import { writeState } from "../state/state-store.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const result = parseArgs(argv);

  if (!result.ok) {
    console.error(result.error);
    console.error(usage());
    return 1;
  }

  if (result.options.allowDirty && !result.options.planningOnly) {
    console.error("--allow-dirty is only supported with --planning-only in Milestone 5.");
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
    console.error("Milestone 5 prototype execution currently requires --runner fake.");
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

  const planningResult = await runPlanningWorkflow({
    goal: result.options.goal,
    config,
    paths,
    initialState: state,
    runner: runnerResult.runner,
    cwd: process.cwd(),
  });

  if (!planningResult.ok) {
    console.error(planningResult.error);
    console.error(`Run dir: ${paths.runDir}`);
    return 1;
  }

  let finalState = planningResult.state;
  let implementationRan = false;
  let reviewRan = false;

  if (!result.options.planningOnly) {
    const implementationResult = await runImplementationWorkflow({
      goal: result.options.goal,
      config,
      paths,
      initialState: planningResult.state,
      runner: runnerResult.runner,
      commandRunner: nodeCommandRunner,
      cwd: process.cwd(),
    });

    implementationRan = true;
    finalState = implementationResult.state;

    if (!implementationResult.ok) {
      console.error(implementationResult.error);
      console.error(`Run dir: ${paths.runDir}`);
      return 1;
    }

    const reviewResult = await runReviewWorkflow({
      goal: result.options.goal,
      config,
      paths,
      initialState: implementationResult.state,
      runner: runnerResult.runner,
      commandRunner: nodeCommandRunner,
      cwd: process.cwd(),
    });

    reviewRan = true;
    finalState = reviewResult.state;

    if (!reviewResult.ok) {
      console.error(reviewResult.error);
      console.error(`Run dir: ${paths.runDir}`);
      return 1;
    }
  }

  console.log("Agent milestone orchestrator");
  console.log(`Run id: ${runId}`);
  console.log(`Run dir: ${paths.runDir}`);
  console.log(`Goal: ${result.options.goal}`);
  console.log(`Planning only: ${result.options.planningOnly}`);
  console.log(`Allow dirty: ${result.options.allowDirty}`);
  console.log(`Runner: ${runnerResult.runner.type}`);
  console.log(`Config: ${loadedConfig.value.path}`);
  console.log(`Artifact root: ${config.artifactRoot}`);
  console.log(`Git required: ${gitPreflight.metadata.required}`);
  console.log(`Git root: ${gitPreflight.metadata.root ?? "unavailable"}`);
  console.log(`Git dirty: ${gitPreflight.metadata.dirtyAtStart}`);
  console.log(`State: ${finalState.currentPhase}`);
  console.log(`Current milestone: ${finalState.currentMilestoneId}`);
  if (implementationRan && finalState.currentMilestoneId !== null) {
    const milestoneId = String(finalState.currentMilestoneId);
    console.log(`Diff artifact: ${finalState.artifacts.diffs?.[milestoneId] ?? "unavailable"}`);
    console.log(`Checks artifact: ${finalState.artifacts.checks?.[milestoneId] ?? "unavailable"}`);
    if (reviewRan) {
      const fixAttempts = finalState.fixAttempts[milestoneId] ?? 0;
      const latestArtifactKey = fixAttempts > 0 ? `${milestoneId}-fix-${fixAttempts}` : milestoneId;
      console.log(`Review artifact: ${finalState.artifacts.reviews?.[latestArtifactKey] ?? "unavailable"}`);
      console.log(`Fix attempts: ${fixAttempts}`);
      console.log(`Latest diff artifact: ${finalState.artifacts.diffs?.[latestArtifactKey] ?? finalState.artifacts.diffs?.[milestoneId] ?? "unavailable"}`);
      console.log(`Latest checks artifact: ${finalState.artifacts.checks?.[latestArtifactKey] ?? finalState.artifacts.checks?.[milestoneId] ?? "unavailable"}`);
      console.log(`Summary artifact: ${finalState.artifacts.summaries?.[`${milestoneId}-review`] ?? "unavailable"}`);
    } else {
      console.log(`Summary artifact: ${finalState.artifacts.summaries?.[milestoneId] ?? "unavailable"}`);
    }
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
