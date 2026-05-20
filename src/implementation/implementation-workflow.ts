import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildMilestoneArtifactPaths } from "../artifacts/milestone-artifacts.js";
import { buildPlanningArtifactPaths, writeTextArtifact } from "../artifacts/planning-artifacts.js";
import { runChecks } from "../checks/check-runner.js";
import { captureGitDiff, captureGitTree } from "../git/git-diff.js";
import type { Milestone, MilestoneMetadata } from "../milestones/milestone-types.js";
import { parseMilestoneMetadataJson } from "../milestones/milestone-validator.js";
import { loadPrompt } from "../prompts/prompt-loader.js";
import { renderPrompt, type PromptVariables } from "../prompts/prompt-renderer.js";
import type { AgentRunResult } from "../runners/agent-runner.js";
import { resolveOutputSchemaPathForPhase } from "../runners/output-schema.js";
import { runAgentPhaseWithDiagnostics } from "../runners/runner-diagnostics.js";
import { writeState } from "../state/state-store.js";
import {
  failState,
  recordMilestoneArtifact,
  setMilestoneStatus,
  setStatePhase,
} from "../state/state-transitions.js";
import type { OrchestratorPhase, RunState } from "../state/state-types.js";
import { appendStateTimelineEvent } from "../timings/state-timeline.js";
import type {
  ImplementationRunnerPhase,
  ImplementationWorkflowOptions,
  ImplementationWorkflowResult,
} from "./implementation-types.js";
import {
  formatFullMilestonePlan,
  formatLightMilestonePlan,
  selectMilestonePlanDecision,
  type MilestonePlanDecision,
} from "./milestone-plan-policy.js";

interface ProducedMilestonePlan {
  content: string;
  decision: MilestonePlanDecision;
}

interface MilestonePlanPromptContext {
  goal: string;
  finalMajorPlan: string;
  metadata: MilestoneMetadata;
  activeMilestone: Milestone;
  state: RunState;
}

interface InitialMilestonePlanProductionContext extends MilestonePlanPromptContext {
  config: ImplementationWorkflowOptions["config"];
}

export async function runImplementationWorkflow(
  options: ImplementationWorkflowOptions,
): Promise<ImplementationWorkflowResult> {
  const clock = options.now ?? (() => new Date());
  let state = options.initialState;
  let activeMilestoneId: number | null = state.currentMilestoneId;

  async function persist(nextState: RunState): Promise<RunState> {
    const previousState = state;
    await writeState(options.paths.files.state, nextState);
    await appendStateTimelineEvent({
      paths: options.paths,
      previousState,
      nextState,
      warnings: options.timingWarnings,
    });
    return nextState;
  }

  async function fail(
    phase: OrchestratorPhase,
    message: string,
    details?: string | object | unknown[] | null,
  ): Promise<ImplementationWorkflowResult> {
    const now = clock();
    let nextState = failState(state, {
      phase,
      message,
      details,
      now,
    });

    if (activeMilestoneId !== null) {
      nextState = setMilestoneStatus(nextState, activeMilestoneId, "failed", now);
    }

    state = await persist(nextState);
    return { ok: false, state, error: message };
  }

  const preflight = validateReadyState(state);
  if (!preflight.ok) return fail("implementing", preflight.error);

  activeMilestoneId = preflight.milestoneId;
  const milestonePaths = buildMilestoneArtifactPaths(options.paths, activeMilestoneId);
  const planningPaths = buildPlanningArtifactPaths(options.paths);

  const metadataResult = await readMilestoneMetadata(planningPaths.files.milestones);
  if (!metadataResult.ok) return fail("implementing", metadataResult.error);
  const metadata = metadataResult.value;

  const activeMilestone = metadata.milestones.find(
    (milestone) => milestone.id === activeMilestoneId,
  );
  if (!activeMilestone) {
    return fail("implementing", `Active milestone ${activeMilestoneId} was not found.`);
  }

  if (state.milestoneStatuses[String(activeMilestoneId)] !== "pending") {
    return fail(
      "implementing",
      `Active milestone ${activeMilestoneId} must be pending before implementation.`,
    );
  }

  const finalMajorPlan = await readRequiredArtifact(
    state.artifacts.finalMajorPlanMarkdown,
    planningPaths.files.finalMajorPlanMarkdown,
    "final major plan",
  );
  if (!finalMajorPlan.ok) return fail("implementing", finalMajorPlan.error);

  state = await persist(setStatePhase(state, "implementing", clock()));

  const milestonePlan = await produceInitialMilestonePlan({
    goal: options.goal,
    config: options.config,
    finalMajorPlan: finalMajorPlan.value,
    metadata,
    activeMilestone,
    state,
  });
  if (!milestonePlan.ok) {
    return fail("implementing", milestonePlan.error, milestonePlan.details);
  }

  let finalMilestonePlan = milestonePlan.value.content;

  if (options.config.milestonePlanReviewPolicy === "scrupulous") {
    const milestonePlanDraftWrite = await writeTextArtifactOrFail(
      "implementing",
      milestonePaths.files.milestonePlanDraft,
      milestonePlan.value.content,
      "milestone plan draft artifact",
    );
    if (!milestonePlanDraftWrite.ok) return milestonePlanDraftWrite.result;

    state = await persist(
      recordMilestoneArtifact(
        state,
        "milestonePlanDrafts",
        activeMilestoneId,
        milestonePaths.statePaths.milestonePlanDraft,
        clock(),
      ),
    );

    const milestonePlanReview = await reviewMilestonePlanDraft({
      goal: options.goal,
      finalMajorPlan: finalMajorPlan.value,
      metadata,
      activeMilestone,
      state,
      milestonePlanDraft: milestonePlan.value.content,
    });
    if (!milestonePlanReview.ok) {
      return fail("implementing", milestonePlanReview.error, milestonePlanReview.details);
    }

    const milestonePlanReviewWrite = await writeTextArtifactOrFail(
      "implementing",
      milestonePaths.files.milestonePlanReview,
      milestonePlanReview.value,
      "milestone plan review artifact",
    );
    if (!milestonePlanReviewWrite.ok) return milestonePlanReviewWrite.result;

    state = await persist(
      recordMilestoneArtifact(
        state,
        "milestonePlanReviews",
        activeMilestoneId,
        milestonePaths.statePaths.milestonePlanReview,
        clock(),
      ),
    );

    const correctedMilestonePlan = await produceFinalMilestonePlan({
      goal: options.goal,
      finalMajorPlan: finalMajorPlan.value,
      metadata,
      activeMilestone,
      state,
      milestonePlanDraft: milestonePlan.value.content,
      milestonePlanReview: milestonePlanReview.value,
    });
    if (!correctedMilestonePlan.ok) {
      return fail(
        "implementing",
        correctedMilestonePlan.error,
        correctedMilestonePlan.details,
      );
    }

    finalMilestonePlan = correctedMilestonePlan.value;
  }

  const milestonePlanWrite = await writeTextArtifactOrFail(
    "implementing",
    milestonePaths.files.milestonePlan,
    finalMilestonePlan,
    "milestone plan artifact",
  );
  if (!milestonePlanWrite.ok) return milestonePlanWrite.result;

  state = await persist(
    recordMilestoneArtifact(
      state,
      "milestonePlans",
      activeMilestoneId,
      milestonePaths.statePaths.milestonePlan,
      clock(),
    ),
  );
  state = await persist(setMilestoneStatus(state, activeMilestoneId, "planned", clock()));

  const implementationPrompt = await renderLoadedPrompt("implement-milestone", {
    goal: options.goal,
    finalMajorPlan: finalMajorPlan.value,
    activeMilestone,
    milestonePlan: finalMilestonePlan,
    state,
  });
  if (!implementationPrompt.ok) return fail("implementing", implementationPrompt.error);

  state = await persist(setMilestoneStatus(state, activeMilestoneId, "implementing", clock()));

  const diffBaseline = await captureGitTree({
    cwd: options.cwd,
    commandRunner: options.commandRunner,
    excludedPaths: [options.paths.runDir],
  });
  if (!diffBaseline.ok) {
    return fail("implementing", diffBaseline.error, diffBaseline.details);
  }

  const implementation = await runPhase(
    "implement_milestone",
    implementationPrompt.value,
    {
      goal: state.artifacts.goal ?? "00-goal.txt",
      finalMajorPlan: state.artifacts.finalMajorPlanMarkdown ?? planningPaths.statePaths.finalMajorPlanMarkdown,
      milestones: state.artifacts.milestones ?? planningPaths.statePaths.milestones,
      milestonePlan: milestonePaths.statePaths.milestonePlan,
    },
    { cwd: options.cwd },
  );
  if (!implementation.ok) {
    return fail("implementing", implementation.error, implementation.details);
  }

  const implementationWrite = await writeTextArtifactOrFail(
    "implementing",
    milestonePaths.files.implementation,
    implementation.value,
    "implementation artifact",
  );
  if (!implementationWrite.ok) return implementationWrite.result;

  state = await persist(
    recordMilestoneArtifact(
      state,
      "implementations",
      activeMilestoneId,
      milestonePaths.statePaths.implementation,
      clock(),
    ),
  );

  const diffResult = await captureGitDiff({
    cwd: options.cwd,
    commandRunner: options.commandRunner,
    excludedPaths: [options.paths.runDir],
    baseTree: diffBaseline.tree,
  });
  if (!diffResult.ok) return fail("implementing", diffResult.error, diffResult.details);

  if (diffResult.diff.trim().length === 0) {
    return fail("implementing", `Active milestone ${activeMilestoneId} produced an empty diff.`);
  }

  const diffWrite = await writeTextArtifactOrFail(
    "implementing",
    milestonePaths.files.diff,
    diffResult.diff,
    "diff artifact",
  );
  if (!diffWrite.ok) return diffWrite.result;

  state = await persist(
    recordMilestoneArtifact(
      state,
      "diffs",
      activeMilestoneId,
      milestonePaths.statePaths.diff,
      clock(),
    ),
  );

  state = await persist(setStatePhase(state, "checking", clock()));
  state = await persist(setMilestoneStatus(state, activeMilestoneId, "checking", clock()));

  const checks = await runChecks({
    checks: options.config.checks,
    cwd: options.cwd,
    commandRunner: options.commandRunner,
  });
  options.checkTimingCollector?.recordCheckRun({
    stateKey: String(activeMilestoneId),
    milestoneId: activeMilestoneId,
    attempt: null,
    artifactPath: milestonePaths.statePaths.checks,
    result: checks,
  });
  const checksWrite = await writeTextArtifactOrFail(
    "checking",
    milestonePaths.files.checks,
    checks.report,
    "checks artifact",
  );
  if (!checksWrite.ok) return checksWrite.result;

  state = await persist(
    recordMilestoneArtifact(
      state,
      "checks",
      activeMilestoneId,
      milestonePaths.statePaths.checks,
      clock(),
    ),
  );

  if (!checks.ok) {
    return fail("checking", `Checks failed for milestone ${activeMilestoneId}.`, checks.results);
  }

  const summary = formatMilestoneSummary({
    milestone: activeMilestone,
    milestonePlan: milestonePaths.statePaths.milestonePlan,
    implementation: milestonePaths.statePaths.implementation,
    diff: milestonePaths.statePaths.diff,
    checks: milestonePaths.statePaths.checks,
    checkCount: checks.results.length,
  });
  const summaryWrite = await writeTextArtifactOrFail(
    "checking",
    milestonePaths.files.summary,
    summary,
    "summary artifact",
  );
  if (!summaryWrite.ok) return summaryWrite.result;

  state = await persist(
    recordMilestoneArtifact(
      state,
      "summaries",
      activeMilestoneId,
      milestonePaths.statePaths.summary,
      clock(),
    ),
  );

  state = await persist(setStatePhase(state, "ready_for_review", clock()));
  state = await persist(
    setMilestoneStatus(state, activeMilestoneId, "ready_for_review", clock()),
  );

  return {
    ok: true,
    state,
    metadata,
    milestoneId: activeMilestoneId,
  };

  async function renderLoadedPrompt(
    promptName:
      | "milestone-plan"
      | "milestone-plan-review"
      | "final-milestone-plan"
      | "implement-milestone",
    variables: PromptVariables,
  ): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const loaded = await loadPrompt(promptName, {
      cwd: options.cwd,
      promptDir: options.promptDir,
    });
    if (!loaded.ok) return loaded;
    return renderPrompt(loaded.value.text, variables);
  }

  async function produceInitialMilestonePlan(
    production: InitialMilestonePlanProductionContext,
  ): Promise<
    | { ok: true; value: ProducedMilestonePlan }
    | { ok: false; error: string; details?: AgentRunResult | { message: string } }
  > {
    const decision = selectMilestonePlanDecision({
      policy: production.config.milestonePlanPolicy,
      activeMilestone: production.activeMilestone,
      metadata: production.metadata,
      state: production.state,
    });

    if (decision.mode === "light") {
      return {
        ok: true,
        value: {
          content: formatLightMilestonePlan({
            activeMilestone: production.activeMilestone,
            metadata: production.metadata,
            decision,
          }),
          decision,
        },
      };
    }

    const planPrompt = await renderLoadedPrompt("milestone-plan", {
      goal: production.goal,
      finalMajorPlan: production.finalMajorPlan,
      milestones: production.metadata,
      activeMilestone: production.activeMilestone,
      state: production.state,
    });
    if (!planPrompt.ok) return planPrompt;

    const generatedPlan = await runPhase("milestone_plan", planPrompt.value, {
      goal: production.state.artifacts.goal ?? "00-goal.txt",
      finalMajorPlan:
        production.state.artifacts.finalMajorPlanMarkdown ??
        planningPaths.statePaths.finalMajorPlanMarkdown,
      milestones:
        production.state.artifacts.milestones ?? planningPaths.statePaths.milestones,
    });
    if (!generatedPlan.ok) return generatedPlan;

    return {
      ok: true,
      value: {
        content:
          decision.policy === "always"
            ? generatedPlan.value
            : formatFullMilestonePlan({
                generatedPlan: generatedPlan.value,
                decision,
              }),
        decision,
      },
    };
  }

  async function reviewMilestonePlanDraft(
    production: MilestonePlanPromptContext & { milestonePlanDraft: string },
  ): Promise<
    | { ok: true; value: string }
    | { ok: false; error: string; details?: AgentRunResult | { message: string } }
  > {
    const reviewPrompt = await renderLoadedPrompt("milestone-plan-review", {
      goal: production.goal,
      finalMajorPlan: production.finalMajorPlan,
      milestones: production.metadata,
      activeMilestone: production.activeMilestone,
      state: production.state,
      milestonePlanDraft: production.milestonePlanDraft,
    });
    if (!reviewPrompt.ok) return reviewPrompt;

    return runPhase("milestone_plan_review", reviewPrompt.value, {
      goal: production.state.artifacts.goal ?? "00-goal.txt",
      finalMajorPlan:
        production.state.artifacts.finalMajorPlanMarkdown ??
        planningPaths.statePaths.finalMajorPlanMarkdown,
      milestones:
        production.state.artifacts.milestones ?? planningPaths.statePaths.milestones,
      milestonePlanDraft: milestonePaths.statePaths.milestonePlanDraft,
    });
  }

  async function produceFinalMilestonePlan(
    production: MilestonePlanPromptContext & {
      milestonePlanDraft: string;
      milestonePlanReview: string;
    },
  ): Promise<
    | { ok: true; value: string }
    | { ok: false; error: string; details?: AgentRunResult | { message: string } }
  > {
    const finalPlanPrompt = await renderLoadedPrompt("final-milestone-plan", {
      goal: production.goal,
      finalMajorPlan: production.finalMajorPlan,
      milestones: production.metadata,
      activeMilestone: production.activeMilestone,
      state: production.state,
      milestonePlanDraft: production.milestonePlanDraft,
      milestonePlanReview: production.milestonePlanReview,
    });
    if (!finalPlanPrompt.ok) return finalPlanPrompt;

    return runPhase("final_milestone_plan", finalPlanPrompt.value, {
      goal: production.state.artifacts.goal ?? "00-goal.txt",
      finalMajorPlan:
        production.state.artifacts.finalMajorPlanMarkdown ??
        planningPaths.statePaths.finalMajorPlanMarkdown,
      milestones:
        production.state.artifacts.milestones ?? planningPaths.statePaths.milestones,
      milestonePlanDraft: milestonePaths.statePaths.milestonePlanDraft,
      milestonePlanReview: milestonePaths.statePaths.milestonePlanReview,
    });
  }

  async function runPhase(
    phase: ImplementationRunnerPhase,
    prompt: string,
    artifacts: Record<string, string>,
    runnerContext: { cwd?: string } = {},
  ): Promise<
    | { ok: true; value: string }
    | { ok: false; error: string; details?: AgentRunResult | { message: string } }
  > {
    let result: AgentRunResult;
    let diagnosticArtifact: string | undefined;
    try {
      const outputSchema = await outputSchemaPathForRunnerPhase(phase);
      if (!outputSchema.ok) return outputSchema;

      const execution = await runAgentPhaseWithDiagnostics({
        runner: options.runner,
        paths: options.paths,
        now: clock,
        request: {
          phase,
          prompt,
          artifacts,
          milestoneId: activeMilestoneId ?? undefined,
          cwd: runnerContext.cwd ?? options.cwd,
          ...(outputSchema.path === undefined
            ? {}
            : { outputSchemaPath: outputSchema.path }),
        },
      });

      if (!execution.ok) {
        return {
          ok: false,
          error: `Runner phase ${phase} threw an error: ${execution.error}`,
          details: withDiagnosticArtifact(
            { message: execution.error },
            execution.diagnosticArtifact,
          ),
        };
      }

      result = execution.result;
      diagnosticArtifact = execution.diagnosticArtifact;
    } catch (error) {
      return {
        ok: false,
        error: `Runner phase ${phase} threw an error: ${formatError(error)}`,
        details: { message: formatError(error) },
      };
    }

    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `Runner phase ${phase} failed with exit code ${result.exitCode}.`,
        details: withDiagnosticArtifact(result, diagnosticArtifact),
      };
    }

    if (result.text.trim().length === 0) {
      return {
        ok: false,
        error: `Runner phase ${phase} returned empty output.`,
        details: withDiagnosticArtifact(result, diagnosticArtifact),
      };
    }

    return { ok: true, value: result.text };
  }

  async function outputSchemaPathForRunnerPhase(
    phase: ImplementationRunnerPhase,
  ): Promise<{ ok: true; path?: string } | { ok: false; error: string }> {
    if (options.runner.type !== "codex-exec") return { ok: true };

    return resolveOutputSchemaPathForPhase({
      phase,
      cwd: options.cwd,
      schemaRoot: options.schemaRoot,
    });
  }

  async function writeTextArtifactOrFail(
    phase: OrchestratorPhase,
    filePath: string,
    content: string,
    label: string,
  ): Promise<{ ok: true } | { ok: false; result: ImplementationWorkflowResult }> {
    try {
      await writeTextArtifact(filePath, content);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        result: await fail(
          phase,
          `Failed to write ${label} at ${filePath}: ${formatError(error)}`,
        ),
      };
    }
  }

  async function readRequiredArtifact(
    statePath: string | undefined,
    fallbackPath: string,
    label: string,
  ): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const filePath = statePath
      ? resolveRunArtifactPath(options.paths.runDir, statePath)
      : fallbackPath;

    try {
      return { ok: true, value: await readFile(filePath, "utf8") };
    } catch (error) {
      return {
        ok: false,
        error: `Failed to read ${label} at ${filePath}: ${formatError(error)}`,
      };
    }
  }
}

function validateReadyState(
  state: RunState,
): { ok: true; milestoneId: number } | { ok: false; error: string } {
  if (state.currentPhase !== "ready_for_milestone") {
    return {
      ok: false,
      error: `Implementation requires state phase ready_for_milestone, got ${state.currentPhase}.`,
    };
  }

  if (state.currentMilestoneId === null) {
    return { ok: false, error: "Implementation requires currentMilestoneId." };
  }

  if (state.git.startSha === null) {
    return { ok: false, error: "Implementation requires a committed Git baseline." };
  }

  if (state.git.dirtyAtStart && !state.git.dirtyOverride) {
    return { ok: false, error: "Implementation requires a clean Git baseline." };
  }

  return { ok: true, milestoneId: state.currentMilestoneId };
}

async function readMilestoneMetadata(
  filePath: string,
): Promise<{ ok: true; value: MilestoneMetadata } | { ok: false; error: string }> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read milestone metadata at ${filePath}: ${formatError(error)}`,
    };
  }

  return parseMilestoneMetadataJson(raw);
}

function formatMilestoneSummary(options: {
  milestone: Milestone;
  milestonePlan: string;
  implementation: string;
  diff: string;
  checks: string;
  checkCount: number;
}): string {
  return [
    `# Milestone ${options.milestone.id} Summary`,
    "",
    `Status: ready_for_review`,
    `Title: ${options.milestone.title}`,
    "",
    "## What Changed",
    "",
    "The implementation runner completed the active milestone and the orchestrator captured a non-empty Git diff.",
    "",
    "## Artifacts",
    "",
    `- Plan: ${options.milestonePlan}`,
    `- Implementation: ${options.implementation}`,
    `- Diff: ${options.diff}`,
    `- Checks: ${options.checks}`,
    "",
    "## Verification",
    "",
    `Configured checks passed: ${options.checkCount}`,
    "",
    "## Remaining",
    "",
    "Milestone 5 must review the diff and decide whether fixes are required.",
  ].join("\n");
}

function resolveRunArtifactPath(runDir: string, artifactPath: string): string {
  return path.isAbsolute(artifactPath) ? artifactPath : path.join(runDir, artifactPath);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withDiagnosticArtifact<T extends object>(
  details: T,
  diagnosticArtifact: string | undefined,
): T & { diagnosticArtifact?: string } {
  return diagnosticArtifact === undefined
    ? details
    : { ...details, diagnosticArtifact };
}
