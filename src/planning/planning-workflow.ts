import { readFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

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
import {
  resolveSeedMajorPlan,
  type ResolvedSeedMajorPlan,
} from "../inputs/initial-inputs.js";
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
import { appendStateTimelineEvent } from "../timings/state-timeline.js";
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

  const majorPlan = await prepareMajorPlan();
  if (!majorPlan.ok) return fail("major_plan", majorPlan.error, majorPlan.details);

  const majorPlanText = majorPlan.value;

  state = await persist(setStatePhase(state, "plan_reviewing", clock()));

  const reviewPrompt = await renderLoadedPrompt("major-plan-review", {
    goal: options.goal,
    majorPlan: majorPlanText,
    initialContext: renderReviewInitialContext(state),
  });
  if (!reviewPrompt.ok) return fail("major_plan_review", reviewPrompt.error);

  const majorPlanReview = await runPhase(
    "major_plan_review",
    reviewPrompt.value,
    majorPlanReviewArtifacts(state, planningPaths.statePaths.majorPlan),
  );
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
    majorPlan: majorPlanText,
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

  async function prepareMajorPlan(): Promise<
    | { ok: true; value: string }
    | { ok: false; error: string; details?: AgentRunResult | { message: string } }
  > {
    if (state.inputs?.majorPlanSource?.type === "seed") {
      const seededPlan = await loadSeededMajorPlanText({
        state,
        paths: options.paths,
        targetCwd: options.cwd ?? process.cwd(),
        resolvedSeedMajorPlan: options.resolvedSeedMajorPlan,
      });
      if (!seededPlan.ok) return seededPlan;

      await writeTextArtifact(planningPaths.files.majorPlan, seededPlan.value);
      state = await persist(
        recordPlanningArtifact(
          state,
          "majorPlan",
          planningPaths.statePaths.majorPlan,
          clock(),
        ),
      );
      return seededPlan;
    }

    if (options.resolvedSeedMajorPlan !== undefined) {
      return {
        ok: false,
        error:
          "Resolved seed major plan was provided, but run state does not mark the major plan source as seed.",
      };
    }

    const majorPlanPrompt = await renderLoadedPrompt("major-plan", {
      goal: options.goal,
      config: options.config,
      initialContext: renderInitialContext(state),
    });
    if (!majorPlanPrompt.ok) return { ok: false, error: majorPlanPrompt.error };

    const majorPlan = await runPhase(
      "major_plan",
      majorPlanPrompt.value,
      majorPlanArtifacts(state),
    );
    if (!majorPlan.ok) return majorPlan;

    await writeTextArtifact(planningPaths.files.majorPlan, majorPlan.value);
    state = await persist(
      recordPlanningArtifact(
        state,
        "majorPlan",
        planningPaths.statePaths.majorPlan,
        clock(),
      ),
    );
    return majorPlan;
  }

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
        now: clock,
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
      schemaRoot: options.schemaRoot,
    });
  }
}

function readMilestonesSchema(
  options: PlanningWorkflowOptions,
): Promise<{ ok: true; value: string | object } | { ok: false; error: string }> {
  if (options.milestonesSchema !== undefined) {
    return Promise.resolve({ ok: true, value: options.milestonesSchema });
  }

  const schemaPath = path.resolve(
    options.schemaRoot ?? path.resolve(options.cwd ?? process.cwd(), "schemas"),
    "milestones.schema.json",
  );
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

function renderInitialContext(state: RunState): string {
  const context = state.inputs?.context ?? [];
  if (context.length === 0) {
    return "Initial context files: none provided.";
  }

  return [
    "Initial context files:",
    ...context.map((entry) => `- ${entry.path} (snapshot artifact: ${entry.artifactPath})`),
    "",
    "These files were explicitly provided by the operator. Read them from the " +
      "target repository before drafting the major plan when they are relevant to the goal.",
  ].join("\n");
}

function renderReviewInitialContext(state: RunState): string {
  const context = state.inputs?.context ?? [];
  if (context.length === 0) {
    return "Initial context files: none provided.";
  }

  return [
    "Initial context files:",
    ...context.map((entry) => `- ${entry.path} (snapshot artifact: ${entry.artifactPath})`),
    "",
    "These files were explicitly provided by the operator. Consider them while " +
      "reviewing or finalizing the major plan when they are relevant to the goal.",
  ].join("\n");
}

function majorPlanArtifacts(state: RunState): Record<string, string> {
  return {
    goal: state.artifacts.goal ?? "00-goal.txt",
    ...initialInputArtifacts(state),
  };
}

function majorPlanReviewArtifacts(
  state: RunState,
  majorPlanArtifact: string,
): Record<string, string> {
  return {
    goal: state.artifacts.goal ?? "00-goal.txt",
    majorPlan: majorPlanArtifact,
    ...initialInputArtifacts(state),
  };
}

function initialInputArtifacts(state: RunState): Record<string, string> {
  const artifacts: Record<string, string> = {};
  if (state.artifacts.inputs?.manifest) {
    artifacts.initialInputsManifest = state.artifacts.inputs.manifest;
  }

  for (const [index, input] of (state.inputs?.context ?? []).entries()) {
    artifacts[`initialContext${index + 1}`] = input.artifactPath;
  }

  return artifacts;
}

async function loadSeededMajorPlanText(options: {
  state: RunState;
  paths: PlanningWorkflowOptions["paths"];
  targetCwd: string;
  resolvedSeedMajorPlan?: ResolvedSeedMajorPlan;
}): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const source = options.state.inputs?.majorPlanSource;
  if (source?.type !== "seed") {
    return {
      ok: false,
      error: "Run state does not record a seeded major plan source.",
    };
  }

  const sourcePath = source.path;
  const sourceSizeBytes = source.sizeBytes;
  const sourceSha256 = source.sha256;
  if (
    typeof sourcePath !== "string" ||
    sourcePath.length === 0 ||
    typeof sourceSizeBytes !== "number" ||
    typeof sourceSha256 !== "string" ||
    sourceSha256.length === 0
  ) {
    return {
      ok: false,
      error: "Run state has incomplete seeded major plan metadata.",
    };
  }
  const sourceMetadata = {
    path: sourcePath,
    sizeBytes: sourceSizeBytes,
    sha256: sourceSha256,
  };

  if (options.resolvedSeedMajorPlan !== undefined) {
    const mismatch = seedCacheMismatch(sourceMetadata, options.resolvedSeedMajorPlan);
    if (mismatch) return { ok: false, error: mismatch };
    return nonBlankSeededPlan(options.resolvedSeedMajorPlan.text, "Resolved seed major plan");
  }

  if (options.state.artifacts.majorPlan !== undefined) {
    const artifact = await readRunRelativeTextArtifact({
      runDir: options.paths.runDir,
      artifactPath: options.state.artifacts.majorPlan,
      label: "Seeded major plan artifact",
    });
    if (!artifact.ok) return artifact;
    return nonBlankSeededPlan(artifact.value, "Seeded major plan artifact");
  }

  const resolved = await resolveSeedMajorPlan({
    targetCwd: options.targetCwd,
    seedMajorPlanFile: sourceMetadata.path,
  });
  if (!resolved.ok) return resolved;
  if (resolved.value === undefined) {
    return {
      ok: false,
      error: "Seeded major plan source is missing from run state.",
    };
  }

  const mismatch = seedCacheMismatch(sourceMetadata, resolved.value);
  if (mismatch) {
    return {
      ok: false,
      error: "Seed major plan file changed since the run was initialized.",
    };
  }

  return nonBlankSeededPlan(resolved.value.text, "Seed major plan file");
}

function seedCacheMismatch(
  source: { path: string; sizeBytes?: number; sha256?: string },
  seed: ResolvedSeedMajorPlan,
): string | null {
  if (
    source.path !== seed.path ||
    source.sizeBytes !== seed.sizeBytes ||
    source.sha256 !== seed.sha256
  ) {
    return "Resolved seed major plan does not match saved seeded major plan source.";
  }

  return null;
}

async function readRunRelativeTextArtifact(options: {
  runDir: string;
  artifactPath: string;
  label: string;
}): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  if (!isSafeRunRelativePath(options.artifactPath)) {
    return {
      ok: false,
      error: `${options.label} path is not a safe run-relative path: ${options.artifactPath}`,
    };
  }

  const runDir = path.resolve(options.runDir);
  const filePath = path.resolve(runDir, ...options.artifactPath.split("/"));
  if (!isInsideDirectory(runDir, filePath)) {
    return {
      ok: false,
      error: `${options.label} path escapes the run directory: ${options.artifactPath}`,
    };
  }

  try {
    const content = await readFile(filePath);
    return decodeUtf8(content, options.label);
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read ${options.label} at ${options.artifactPath}: ${formatError(error)}`,
    };
  }
}

function decodeUtf8(
  content: Buffer,
  label: string,
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    return {
      ok: true,
      value: new TextDecoder("utf-8", { fatal: true }).decode(content),
    };
  } catch {
    return { ok: false, error: `${label} must be valid UTF-8 text.` };
  }
}

function nonBlankSeededPlan(
  text: string,
  label: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (text.trim().length === 0) {
    return {
      ok: false,
      error: `${label} must not be empty or whitespace-only.`,
    };
  }

  return { ok: true, value: text };
}

function isSafeRunRelativePath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    !path.isAbsolute(filePath) &&
    !filePath.split(/[\\/]+/).includes("..")
  );
}

function isInsideDirectory(root: string, targetPath: string): boolean {
  return targetPath === root || targetPath.startsWith(`${root}${path.sep}`);
}

function withDiagnosticArtifact<T extends object>(
  details: T,
  diagnosticArtifact: string | undefined,
): T & { diagnosticArtifact?: string } {
  return diagnosticArtifact === undefined
    ? details
    : { ...details, diagnosticArtifact };
}
