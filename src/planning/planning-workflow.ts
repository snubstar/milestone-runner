import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildPlanningArtifactPaths,
  writeJsonArtifact,
  writeTextArtifact,
} from "../artifacts/planning-artifacts.js";
import {
  firstPendingMilestoneId,
  parseMilestoneMetadataJson,
  toMilestoneStatusMap,
} from "../milestones/milestone-validator.js";
import { loadPrompt } from "../prompts/prompt-loader.js";
import { renderPrompt, type PromptVariables } from "../prompts/prompt-renderer.js";
import type { AgentRunResult } from "../runners/agent-runner.js";
import { resolveOutputSchemaPathForPhase } from "../runners/output-schema.js";
import { runAgentPhaseWithDiagnostics } from "../runners/runner-diagnostics.js";
import { writeState } from "../state/state-store.js";
import {
  completePlanningState,
  failState,
  recordPlanningArtifact,
  setStatePhase,
} from "../state/state-transitions.js";
import type { RunState } from "../state/state-types.js";
import {
  statePhaseForPlanningRunnerPhase,
  type PlanningRunnerPhase,
  type PlanningWorkflowOptions,
  type PlanningWorkflowResult,
} from "./planning-types.js";

export async function runPlanningWorkflow(
  options: PlanningWorkflowOptions,
): Promise<PlanningWorkflowResult> {
  const clock = options.now ?? (() => new Date());
  let state = options.initialState;
  const planningPaths = buildPlanningArtifactPaths(options.paths);

  async function persist(nextState: RunState): Promise<RunState> {
    await writeState(options.paths.files.state, nextState);
    return nextState;
  }

  async function fail(
    phase: PlanningRunnerPhase,
    message: string,
    details?: string | object | unknown[] | null,
  ): Promise<PlanningWorkflowResult> {
    state = await persist(
      failState(state, {
        phase: statePhaseForPlanningRunnerPhase(phase),
        message,
        details,
        now: clock(),
      }),
    );
    return { ok: false, state, error: message };
  }

  state = await persist(setStatePhase(state, "planning", clock()));

  const majorPlanPrompt = await renderLoadedPrompt("major-plan", {
    goal: options.goal,
    config: options.config,
  });
  if (!majorPlanPrompt.ok) return fail("major_plan", majorPlanPrompt.error);

  const majorPlan = await runPhase("major_plan", majorPlanPrompt.value, {
    goal: state.artifacts.goal ?? "00-goal.txt",
  });
  if (!majorPlan.ok) return fail("major_plan", majorPlan.error, majorPlan.details);

  await writeTextArtifact(planningPaths.files.majorPlan, majorPlan.value);
  state = await persist(
    recordPlanningArtifact(
      state,
      "majorPlan",
      planningPaths.statePaths.majorPlan,
      clock(),
    ),
  );

  state = await persist(setStatePhase(state, "plan_reviewing", clock()));

  const reviewPrompt = await renderLoadedPrompt("major-plan-review", {
    goal: options.goal,
    majorPlan: majorPlan.value,
  });
  if (!reviewPrompt.ok) return fail("major_plan_review", reviewPrompt.error);

  const majorPlanReview = await runPhase("major_plan_review", reviewPrompt.value, {
    goal: state.artifacts.goal ?? "00-goal.txt",
    majorPlan: planningPaths.statePaths.majorPlan,
  });
  if (!majorPlanReview.ok) {
    return fail("major_plan_review", majorPlanReview.error, majorPlanReview.details);
  }

  await writeTextArtifact(planningPaths.files.majorPlanReview, majorPlanReview.value);
  state = await persist(
    recordPlanningArtifact(
      state,
      "majorPlanReview",
      planningPaths.statePaths.majorPlanReview,
      clock(),
    ),
  );

  state = await persist(setStatePhase(state, "planning", clock()));

  const finalPlanPrompt = await renderLoadedPrompt("final-major-plan", {
    goal: options.goal,
    majorPlan: majorPlan.value,
    majorPlanReview: majorPlanReview.value,
  });
  if (!finalPlanPrompt.ok) return fail("final_major_plan", finalPlanPrompt.error);

  const finalMajorPlan = await runPhase("final_major_plan", finalPlanPrompt.value, {
    goal: state.artifacts.goal ?? "00-goal.txt",
    majorPlan: planningPaths.statePaths.majorPlan,
    majorPlanReview: planningPaths.statePaths.majorPlanReview,
  });
  if (!finalMajorPlan.ok) {
    return fail("final_major_plan", finalMajorPlan.error, finalMajorPlan.details);
  }

  await writeTextArtifact(planningPaths.files.finalMajorPlanMarkdown, finalMajorPlan.value);
  state = await persist(
    recordPlanningArtifact(
      state,
      "finalMajorPlanMarkdown",
      planningPaths.statePaths.finalMajorPlanMarkdown,
      clock(),
    ),
  );

  const schemaResult = await readMilestonesSchema(options);
  if (!schemaResult.ok) return fail("final_plan_json", schemaResult.error);

  const finalPlanJsonPrompt = await renderLoadedPrompt("final-plan-json", {
    goal: options.goal,
    finalMajorPlan: finalMajorPlan.value,
    majorPlanReview: majorPlanReview.value,
    milestonesSchema: schemaResult.value,
  });
  if (!finalPlanJsonPrompt.ok) return fail("final_plan_json", finalPlanJsonPrompt.error);

  const finalPlanJson = await runPhase("final_plan_json", finalPlanJsonPrompt.value, {
    goal: state.artifacts.goal ?? "00-goal.txt",
    finalMajorPlanMarkdown: planningPaths.statePaths.finalMajorPlanMarkdown,
    majorPlanReview: planningPaths.statePaths.majorPlanReview,
  });
  if (!finalPlanJson.ok) {
    return fail("final_plan_json", finalPlanJson.error, finalPlanJson.details);
  }

  const metadataResult = parseMilestoneMetadataJson(finalPlanJson.value);
  if (!metadataResult.ok) return fail("final_plan_json", metadataResult.error);

  await writeJsonArtifact(planningPaths.files.milestones, metadataResult.value);
  state = await persist(
    recordPlanningArtifact(
      state,
      "milestones",
      planningPaths.statePaths.milestones,
      clock(),
    ),
  );

  const currentMilestoneId = firstPendingMilestoneId(metadataResult.value);
  if (currentMilestoneId === null) {
    return fail("final_plan_json", "No pending milestone found in validated metadata.");
  }

  state = await persist(
    completePlanningState(state, {
      currentMilestoneId,
      milestoneStatuses: toMilestoneStatusMap(metadataResult.value),
      now: clock(),
    }),
  );

  return {
    ok: true,
    state,
    metadata: metadataResult.value,
  };

  async function renderLoadedPrompt(
    promptName:
      | "major-plan"
      | "major-plan-review"
      | "final-major-plan"
      | "final-plan-json",
    variables: PromptVariables,
  ): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const loaded = await loadPrompt(promptName, {
      cwd: options.cwd,
      promptDir: options.promptDir,
    });
    if (!loaded.ok) return loaded;
    return renderPrompt(loaded.value.text, variables);
  }

  async function runPhase(
    phase: PlanningRunnerPhase,
    prompt: string,
    artifacts: Record<string, string>,
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
        request: {
          phase,
          prompt,
          artifacts,
          cwd: options.cwd,
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
    phase: PlanningRunnerPhase,
  ): Promise<{ ok: true; path?: string } | { ok: false; error: string }> {
    if (options.runner.type !== "codex-exec") return { ok: true };

    return resolveOutputSchemaPathForPhase({
      phase,
      cwd: options.cwd ?? process.cwd(),
    });
  }
}

function readMilestonesSchema(
  options: PlanningWorkflowOptions,
): Promise<{ ok: true; value: string | object } | { ok: false; error: string }> {
  if (options.milestonesSchema !== undefined) {
    return Promise.resolve({ ok: true, value: options.milestonesSchema });
  }

  const schemaPath = path.resolve(options.cwd ?? process.cwd(), "schemas", "milestones.schema.json");
  return readFile(schemaPath, "utf8")
    .then((value) => ({ ok: true as const, value }))
    .catch((error) => ({
      ok: false as const,
      error: `Failed to read milestone schema at ${schemaPath}: ${formatError(error)}`,
    }));
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
