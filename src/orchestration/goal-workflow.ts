import { readFile } from "node:fs/promises";

import { buildPlanningArtifactPaths } from "../artifacts/planning-artifacts.js";
import { runImplementationWorkflow } from "../implementation/implementation-workflow.js";
import type { MilestoneMetadata } from "../milestones/milestone-types.js";
import { parseMilestoneMetadataJson } from "../milestones/milestone-validator.js";
import { runPlanningWorkflow } from "../planning/planning-workflow.js";
import { runReviewWorkflow } from "../review/review-workflow.js";
import { writeState } from "../state/state-store.js";
import {
  advanceToMilestoneState,
  completeGoalState,
  recordArtifactByKey,
  setMilestoneStatus,
  setStatePhase,
  stopGoalForHumanReviewState,
} from "../state/state-transitions.js";
import type { RunState } from "../state/state-types.js";
import { writeGoalSummary, type GoalSummaryDiagnostic } from "./goal-summary.js";
import {
  selectNextRunnableMilestone,
  type MilestoneSelectionDecision,
} from "./milestone-selector.js";
import {
  normalizeStateForGoalResume,
  type ResumeDecision,
} from "./resume-state.js";
import type {
  GoalWorkflowOptions,
  GoalWorkflowResult,
} from "./goal-workflow-types.js";

const emptyMetadata: MilestoneMetadata = { milestones: [] };

export async function runGoalWorkflow(
  options: GoalWorkflowOptions,
): Promise<GoalWorkflowResult> {
  const clock = options.now ?? (() => new Date());
  let state = options.initialState;
  let metadata: MilestoneMetadata | null = null;

  async function persist(nextState: RunState): Promise<RunState> {
    await writeState(options.paths.files.state, nextState);
    return nextState;
  }

  const resumeResult = await applyResumeNormalization();
  if (resumeResult) return resumeResult;

  for (let iteration = 0; iteration < 1000; iteration += 1) {
    switch (state.currentPhase) {
      case "initialized":
      case "planning":
      case "plan_reviewing": {
        const result = await runPlanningWorkflow({
          goal: options.goal,
          config: options.config,
          paths: options.paths,
          initialState: state,
          runner: options.runner,
          cwd: options.cwd,
          promptDir: options.promptDir,
          milestonesSchema: options.milestonesSchema,
          now: clock,
        });

        state = result.state;
        if (!result.ok) {
          return finishTerminal({
            state,
            metadata: await readMetadataOrEmpty(),
            ok: false,
            originalError: result.error,
          });
        }

        metadata = result.metadata;
        if (options.planningOnly) {
          return { ok: true, state };
        }
        break;
      }

      case "ready_for_milestone": {
        if (options.planningOnly) {
          return { ok: true, state };
        }

        const result = await runImplementationWorkflow({
          goal: options.goal,
          config: options.config,
          paths: options.paths,
          initialState: state,
          runner: options.runner,
          commandRunner: options.commandRunner,
          cwd: options.cwd,
          promptDir: options.promptDir,
          now: clock,
        });

        state = result.state;
        if (!result.ok) {
          return finishTerminal({
            state,
            metadata: await readMetadataOrEmpty(),
            ok: false,
            originalError: result.error,
          });
        }

        metadata = result.metadata;
        break;
      }

      case "ready_for_review": {
        if (options.planningOnly) {
          return { ok: true, state };
        }

        const result = await runReviewWorkflow({
          goal: options.goal,
          config: options.config,
          paths: options.paths,
          initialState: state,
          runner: options.runner,
          commandRunner: options.commandRunner,
          cwd: options.cwd,
          promptDir: options.promptDir,
          now: clock,
        });

        state = result.state;
        if (!result.ok) {
          return finishTerminal({
            state,
            metadata: await readMetadataOrEmpty(),
            ok: false,
            originalError: result.error,
          });
        }

        metadata = result.metadata;
        if (result.verdict === "needs_human_review") {
          return finishTerminal({
            state,
            metadata,
            ok: true,
            originalError: terminalReason(state),
          });
        }

        break;
      }

      case "passed": {
        const metadataResult = await ensureMetadata(metadata);
        if (!metadataResult.ok) {
          return stopForHumanReview(metadataResult.error, undefined, null);
        }
        metadata = metadataResult.metadata;

        const decision = selectNextRunnableMilestone(metadata, state);
        const handledDecision = await handleSelectionDecision(decision, metadata);
        if (handledDecision) return handledDecision;
        break;
      }

      case "failed": {
        return finishTerminal({
          state,
          metadata: await readMetadataOrEmpty(),
          ok: false,
          originalError: terminalReason(state),
        });
      }

      case "needs_human_review": {
        return finishTerminal({
          state,
          metadata: await readMetadataOrEmpty(),
          ok: true,
          originalError: terminalReason(state),
        });
      }

      default:
        return stopForHumanReview(
          `Goal workflow cannot continue from phase ${state.currentPhase}.`,
          { currentPhase: state.currentPhase },
        );
    }
  }

  return stopForHumanReview(
    "Goal workflow exceeded the maximum iteration limit.",
    { maxIterations: 1000 },
  );

  async function handleSelectionDecision(
    decision: MilestoneSelectionDecision,
    selectedMetadata: MilestoneMetadata,
  ): Promise<GoalWorkflowResult | null> {
    if (decision.kind === "runnable") {
      state = await persist(
        advanceToMilestoneState(state, decision.milestone.id, clock()),
      );
      return null;
    }

    if (decision.kind === "complete") {
      const completedState = completeGoalState(state, clock());
      const summaryResult = await writeAndRecordGoalSummary(
        completedState,
        selectedMetadata,
      );
      if (!summaryResult.ok) {
        return {
          ok: false,
          state,
          error: summaryResult.error,
        };
      }

      state = await persist(summaryResult.state);
      return { ok: true, state };
    }

    return stopForHumanReview(decision.message, decision.details, state.currentMilestoneId);
  }

  async function applyResumeNormalization(): Promise<GoalWorkflowResult | null> {
    if (
      state.status !== "failed" &&
      state.status !== "needs_human_review" &&
      isPlanningResumePhase(state.currentPhase)
    ) {
      return null;
    }

    const metadataResult = await readMetadata();
    if (!metadataResult.ok) {
      if (state.status === "failed" || state.status === "needs_human_review") {
        return finishTerminal({
          state,
          metadata: emptyMetadata,
          ok: state.status !== "failed",
          originalError: terminalReason(state),
        });
      }

      return stopForHumanReview(
        metadataResult.error,
        undefined,
        state.currentMilestoneId,
      );
    }

    metadata = metadataResult.metadata;
    return handleResumeDecision(
      normalizeStateForGoalResume(state, metadata),
      metadata,
    );
  }

  async function handleResumeDecision(
    decision: ResumeDecision,
    selectedMetadata: MilestoneMetadata,
  ): Promise<GoalWorkflowResult | null> {
    if (decision.kind === "continue") {
      state = decision.state;
      return null;
    }

    if (decision.kind === "advance") {
      state = await persist(
        advanceToMilestoneState(state, decision.milestoneId, clock()),
      );
      return null;
    }

    if (decision.kind === "complete") {
      if (!decision.summaryRequired) {
        if (state.currentMilestoneId !== null) {
          state = await persist(completeGoalState(state, clock()));
        }
        return { ok: true, state };
      }

      const completedState = completeGoalState(state, clock());
      const summaryResult = await writeAndRecordGoalSummary(
        completedState,
        selectedMetadata,
      );
      if (!summaryResult.ok) {
        return {
          ok: false,
          state,
          error: summaryResult.error,
        };
      }

      state = await persist(summaryResult.state);
      return { ok: true, state };
    }

    if (decision.kind === "stopped") {
      state = decision.state;
      return finishTerminal({
        state,
        metadata: selectedMetadata,
        ok: state.status !== "failed",
        originalError: terminalReason(state),
      });
    }

    if (decision.kind === "normalize_to_ready_for_review") {
      const now = clock();
      let nextState = setStatePhase(state, "ready_for_review", now);
      nextState = setMilestoneStatus(
        nextState,
        decision.milestoneId,
        "ready_for_review",
        now,
      );
      state = await persist({
        ...nextState,
        lastError: null,
      });
      return null;
    }

    if (decision.kind === "normalize_to_passed") {
      const now = clock();
      let nextState = setStatePhase(state, "passed", now);
      nextState = setMilestoneStatus(
        nextState,
        decision.milestoneId,
        "passed",
        now,
      );
      state = await persist({
        ...nextState,
        lastError: null,
      });
      return null;
    }

    return stopForHumanReview(
      decision.message,
      decision.details,
      decision.currentMilestoneId,
    );
  }

  async function stopForHumanReview(
    message: string,
    details?: unknown,
    currentMilestoneId?: number | null,
  ): Promise<GoalWorkflowResult> {
    state = await persist(
      stopGoalForHumanReviewState(
        state,
        {
          message,
          details: normalizeDetails(details),
          ...(currentMilestoneId === undefined ? {} : { currentMilestoneId }),
        },
        clock(),
      ),
    );

    const selectedMetadata = await readMetadataOrEmpty();
    return finishTerminal({
      state,
      metadata: selectedMetadata,
      ok: true,
      originalError: message,
      diagnostics: [
        {
          message,
          details: normalizeDetails(details),
        },
      ],
    });
  }

  async function finishTerminal(options: {
    state: RunState;
    metadata: MilestoneMetadata;
    ok: boolean;
    originalError?: string;
    diagnostics?: GoalSummaryDiagnostic[];
  }): Promise<GoalWorkflowResult> {
    const summaryResult = await writeAndRecordGoalSummary(
      options.state,
      options.metadata,
      options.diagnostics,
    );
    if (!summaryResult.ok) {
      return {
        ok: false,
        state: options.state,
        error: combineTerminalErrors(options.originalError, summaryResult.error),
      };
    }

    state = await persist(summaryResult.state);
    return {
      ok: options.ok,
      state,
      ...(options.ok ? {} : { error: options.originalError ?? terminalReason(state) }),
    };
  }

  async function writeAndRecordGoalSummary(
    summaryState: RunState,
    selectedMetadata: MilestoneMetadata,
    diagnostics: GoalSummaryDiagnostic[] = [],
  ): Promise<{ ok: true; state: RunState } | { ok: false; error: string }> {
    const summaryResult = await writeGoalSummary({
      paths: options.paths,
      state: summaryState,
      metadata: selectedMetadata,
      cwd: options.cwd,
      commandRunner: options.commandRunner,
      diagnostics,
    });
    if (!summaryResult.ok) {
      return { ok: false, error: summaryResult.error };
    }

    return {
      ok: true,
      state: recordArtifactByKey(
        summaryState,
        "summaries",
        "goal",
        summaryResult.statePath,
        clock(),
      ),
    };
  }

  async function ensureMetadata(
    currentMetadata: MilestoneMetadata | null,
  ): Promise<{ ok: true; metadata: MilestoneMetadata } | { ok: false; error: string }> {
    if (currentMetadata) return { ok: true, metadata: currentMetadata };
    return readMetadata();
  }

  async function readMetadataOrEmpty(): Promise<MilestoneMetadata> {
    const result = await readMetadata();
    return result.ok ? result.metadata : emptyMetadata;
  }

  async function readMetadata(): Promise<
    { ok: true; metadata: MilestoneMetadata } | { ok: false; error: string }
  > {
    const planningPaths = buildPlanningArtifactPaths(options.paths);

    try {
      const raw = await readFile(planningPaths.files.milestones, "utf8");
      const parsed = parseMilestoneMetadataJson(raw);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, metadata: parsed.value };
    } catch (error) {
      return {
        ok: false,
        error: `Failed to read milestone metadata: ${formatError(error)}`,
      };
    }
  }
}

function terminalReason(state: RunState): string {
  return state.lastError?.message ?? `Goal stopped with status ${state.status}.`;
}

function isPlanningResumePhase(phase: RunState["currentPhase"]): boolean {
  return (
    phase === "initialized" ||
    phase === "planning" ||
    phase === "plan_reviewing"
  );
}

function combineTerminalErrors(
  originalError: string | undefined,
  summaryError: string,
): string {
  return originalError
    ? `${originalError} Additionally, ${summaryError}`
    : summaryError;
}

function normalizeDetails(
  details: unknown,
): string | object | unknown[] | null | undefined {
  if (
    details === undefined ||
    details === null ||
    typeof details === "string" ||
    Array.isArray(details) ||
    typeof details === "object"
  ) {
    return details;
  }

  return String(details);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
