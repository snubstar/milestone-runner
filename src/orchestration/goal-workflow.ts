import { access, copyFile, readFile } from "node:fs/promises";
import path from "node:path";

import { resolveRunArtifactPath, type RunPaths } from "../artifacts/paths.js";
import {
  buildPlanningArtifactPaths,
  writeJsonArtifact,
} from "../artifacts/planning-artifacts.js";
import { runImplementationWorkflow } from "../implementation/implementation-workflow.js";
import { captureGitTree } from "../git/git-diff.js";
import type { MilestoneMetadata } from "../milestones/milestone-types.js";
import { parseMilestoneMetadataJson } from "../milestones/milestone-validator.js";
import { runPlanningWorkflow } from "../planning/planning-workflow.js";
import { loadPrompt } from "../prompts/prompt-loader.js";
import { renderPrompt, type PromptVariables } from "../prompts/prompt-renderer.js";
import { runReviewWorkflow } from "../review/review-workflow.js";
import type { AgentRunResult } from "../runners/agent-runner.js";
import { resolveOutputSchemaPathForPhase } from "../runners/output-schema.js";
import { runAgentPhaseWithDiagnostics } from "../runners/runner-diagnostics.js";
import { writeState } from "../state/state-store.js";
import {
  advanceToMilestoneState,
  completeGoalState,
  failState,
  recordArtifactByKey,
  setMilestoneStatus,
  setStatePhase,
  stopGoalForHumanReviewState,
} from "../state/state-transitions.js";
import type { RunState } from "../state/state-types.js";
import { createCheckTimingCollector } from "../timings/check-timing-collector.js";
import { writeRunTimings } from "../timings/run-timings.js";
import {
  appendInvocationTimelineEvent,
  appendStateTimelineEvent,
  nextTimelineInvocationId,
} from "../timings/state-timeline.js";
import {
  createTimingWarningCollector,
  type TimingWarning,
} from "../timings/timing-types.js";
import { writeGoalSummary, type GoalSummaryDiagnostic } from "./goal-summary.js";
import { resolveMilestoneBaseline } from "./milestone-baseline.js";
import {
  selectNextRunnableMilestone,
  type MilestoneSelectionDecision,
} from "./milestone-selector.js";
import {
  normalizeStateForGoalResume,
  type ResumeDecision,
} from "./resume-state.js";
import { actionForResumeRecoveryMode } from "./resume-recovery.js";
import {
  isSupervisedHumanReviewPolicy,
  shouldAttemptAutonomousResolution,
  terminalPhaseForUnresolvedHumanReview,
} from "./human-review-policy.js";
import {
  parseResumeResolutionJson,
  validateResumeResolutionAction,
  type ResumeResolutionDocument,
} from "./resume-resolution-validator.js";
import type {
  GoalWorkflowOptions,
  GoalWorkflowResult,
} from "./goal-workflow-types.js";

const emptyMetadata: MilestoneMetadata = { milestones: [] };
const resumeWithoutMilestoneNextAction =
  "resume without --milestone to continue remaining milestones";
const resumeResolutionAttemptLimit = 2;
const retryResetArtifactMapKeys = [
  "diffs",
  "checks",
  "summaries",
  "checkFailures",
] as const;
const resumeResolutionSchemaContract = [
  "Return a JSON object with exactly these root fields:",
  '- action: one of "continue", "normalize_to_ready_for_review", "normalize_to_passed", or "fail"',
  "- summary: non-empty string",
  "- rationale: non-empty string",
  "- assumptions: array of non-empty strings",
  "- currentMilestoneId: optional positive integer or null",
  "",
  "Do not include artifact paths or extra fields in the response.",
].join("\n");

export async function runGoalWorkflow(
  options: GoalWorkflowOptions,
): Promise<GoalWorkflowResult> {
  const clock = options.now ?? (() => new Date());
  let state = options.initialState;
  let metadata: MilestoneMetadata | null = null;
  const checkTimingCollector = createCheckTimingCollector();
  const timingWarnings = createTimingWarningCollector(options.timingWarnings);
  const invocationId = options.invocationId ?? (await startWorkflowInvocation());

  async function persist(nextState: RunState): Promise<RunState> {
    const previousState = state;
    await writeState(options.paths.files.state, nextState);
    await appendStateTimelineEvent({
      paths: options.paths,
      previousState,
      nextState,
      warnings: timingWarnings,
    });
    return nextState;
  }

  const resumeResult = await applyResumeNormalization();
  if (resumeResult) return finalizeWorkflowResult(resumeResult);

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
          schemaRoot: options.schemaRoot,
          milestonesSchema: options.milestonesSchema,
          resolvedSeedMajorPlan: options.resolvedSeedMajorPlan,
          timingWarnings,
          now: clock,
        });

        state = result.state;
        if (!result.ok) {
          return finalizeWorkflowResult(await finishTerminal({
            state,
            metadata: await readMetadataOrEmpty(),
            ok: false,
            originalError: result.error,
          }));
        }

        metadata = result.metadata;
        if (options.planningOnly) {
          return finalizeWorkflowResult({ ok: true, state });
        }
        break;
      }

      case "ready_for_milestone": {
        if (options.planningOnly) {
          return finalizeWorkflowResult({ ok: true, state });
        }

        const metadataResult = await ensureMetadata(metadata);
        if (!metadataResult.ok) {
          return finalizeWorkflowResult(await stopForHumanReview(
            metadataResult.error,
            undefined,
            state.currentMilestoneId,
          ));
        }
        metadata = metadataResult.metadata;

        const executionLimitResult = validateExecutionLimitBeforeWork(metadata);
        if (executionLimitResult) return finalizeWorkflowResult(executionLimitResult);

        const result = await runImplementationWorkflow({
          goal: options.goal,
          config: options.config,
          paths: options.paths,
          initialState: state,
          runner: options.runner,
          commandRunner: options.commandRunner,
          cwd: options.cwd,
          promptDir: options.promptDir,
          schemaRoot: options.schemaRoot,
          checkTimingCollector,
          timingWarnings,
          now: clock,
        });

        state = result.state;
        if (!result.ok) {
          return finalizeWorkflowResult(await finishTerminal({
            state,
            metadata: await readMetadataOrEmpty(),
            ok: false,
            originalError: result.error,
          }));
        }

        metadata = result.metadata;
        break;
      }

      case "ready_for_review": {
        if (options.planningOnly) {
          return finalizeWorkflowResult({ ok: true, state });
        }

        const metadataResult = await ensureMetadata(metadata);
        if (!metadataResult.ok) {
          return finalizeWorkflowResult(await stopForHumanReview(
            metadataResult.error,
            undefined,
            state.currentMilestoneId,
          ));
        }
        metadata = metadataResult.metadata;

        const executionLimitResult = validateExecutionLimitBeforeWork(metadata);
        if (executionLimitResult) return finalizeWorkflowResult(executionLimitResult);

        const result = await runReviewWorkflow({
          goal: options.goal,
          config: options.config,
          paths: options.paths,
          initialState: state,
          runner: options.runner,
          commandRunner: options.commandRunner,
          cwd: options.cwd,
          promptDir: options.promptDir,
          schemaRoot: options.schemaRoot,
          checkTimingCollector,
          timingWarnings,
          now: clock,
        });

        state = result.state;
        if (!result.ok) {
          return finalizeWorkflowResult(await finishTerminal({
            state,
            metadata: await readMetadataOrEmpty(),
            ok: false,
            originalError: result.error,
          }));
        }

        metadata = result.metadata;
        if (result.verdict === "needs_human_review") {
          if (!isSupervisedHumanReviewPolicy(options.config.humanReviewPolicy)) {
            return finalizeWorkflowResult(await failUnexpectedHumanReviewResult(metadata));
          }

          return finalizeWorkflowResult(await finishTerminal({
            state,
            metadata,
            ok: true,
            originalError: terminalReason(state),
          }));
        }

        break;
      }

      case "passed": {
        const metadataResult = await ensureMetadata(metadata);
        if (!metadataResult.ok) {
          return finalizeWorkflowResult(await stopForHumanReview(
            metadataResult.error,
            undefined,
            null,
          ));
        }
        metadata = metadataResult.metadata;

        const constrainedStop = handlePassedExecutionLimit(metadata);
        if (constrainedStop) return finalizeWorkflowResult(constrainedStop);

        const decision = selectNextRunnableMilestone(metadata, state);
        const handledDecision = await handleSelectionDecision(decision, metadata);
        if (handledDecision) return finalizeWorkflowResult(handledDecision);
        break;
      }

      case "failed": {
        return finalizeWorkflowResult(await finishTerminal({
          state,
          metadata: await readMetadataOrEmpty(),
          ok: false,
          originalError: terminalReason(state),
        }));
      }

      case "needs_human_review": {
        return finalizeWorkflowResult(await finishTerminal({
          state,
          metadata: await readMetadataOrEmpty(),
          ok: true,
          originalError: terminalReason(state),
        }));
      }

      default:
        return finalizeWorkflowResult(await stopForHumanReview(
          `Goal workflow cannot continue from phase ${state.currentPhase}.`,
          { currentPhase: state.currentPhase },
        ));
    }
  }

  return finalizeWorkflowResult(await stopForHumanReview(
    "Goal workflow exceeded the maximum iteration limit.",
    { maxIterations: 1000 },
  ));

  async function startWorkflowInvocation(): Promise<string> {
    const nextInvocationId = await nextTimelineInvocationId(
      options.paths,
      timingWarnings,
    );
    await appendInvocationTimelineEvent({
      paths: options.paths,
      invocationId: nextInvocationId,
      event: "invocation_started",
      timestamp: clock().toISOString(),
      state,
      warnings: timingWarnings,
    });
    return nextInvocationId;
  }

  async function finalizeWorkflowResult(
    primaryResult: GoalWorkflowResult,
  ): Promise<GoalWorkflowResult> {
    if (primaryResult.nextAction === "blocked_dirty_retry_worktree") {
      return primaryResult;
    }

    const runEndedAt = clock().toISOString();
    await appendInvocationTimelineEvent({
      paths: options.paths,
      invocationId,
      event: "invocation_ended",
      timestamp: runEndedAt,
      state: primaryResult.state,
      warnings: timingWarnings,
    });

    try {
      const generatedAt = clock().toISOString();
      const timingResult = await writeRunTimings({
        paths: options.paths,
        state: primaryResult.state,
        runEndedAt,
        generatedAt,
        finalizedAt: generatedAt,
        checkTimingCollector,
        warnings: timingWarnings.list(),
      });
      state = primaryResult.state;
      let finalizedState = recordArtifactByKey(
        primaryResult.state,
        "logs",
        "timingsJson",
        timingResult.statePaths.timingsJson,
        clock(),
      );
      finalizedState = recordArtifactByKey(
        finalizedState,
        "logs",
        "timingsMarkdown",
        timingResult.statePaths.timingsMarkdown,
        clock(),
      );
      state = await persist(finalizedState);

      return {
        ...primaryResult,
        state,
        timingWarnings: timingResult.warnings,
      };
    } catch (error) {
      timingWarnings.add(finalizationWarning(error));
      return {
        ...primaryResult,
        timingWarnings: timingWarnings.list(),
      };
    }
  }

  async function handleSelectionDecision(
    decision: MilestoneSelectionDecision,
    selectedMetadata: MilestoneMetadata,
  ): Promise<GoalWorkflowResult | null> {
    if (decision.kind === "runnable") {
      const executionLimitResult = validateExecutionLimitBeforeAdvance(
        selectedMetadata,
        decision.milestone.id,
      );
      if (executionLimitResult) return executionLimitResult;

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
    const recoveryMode = options.resumeRecoveryMode ?? "none";
    if (
      recoveryMode === "none" &&
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
    const targetExistsResult = validateTargetMilestoneExists(metadata);
    if (targetExistsResult) return targetExistsResult;

    return handleResumeDecision(
      normalizeStateForGoalResume(state, metadata, { recoveryMode }),
      metadata,
    );
  }

  async function handleResumeDecision(
    decision: ResumeDecision,
    selectedMetadata: MilestoneMetadata,
  ): Promise<GoalWorkflowResult | null> {
    if (options.resumeRecoveryMode !== undefined && options.resumeRecoveryMode !== "none") {
      if (decision.kind !== "recover") {
        return {
          ok: false,
          state,
          error: `Recovery mode ${options.resumeRecoveryMode} cannot continue from this resume state.`,
          nextAction: "blocked_unsafe_resume",
        };
      }
    }

    if (decision.kind === "continue") {
      state = decision.state;
      return null;
    }

    if (decision.kind === "advance") {
      const executionLimitResult = validateExecutionLimitBeforeAdvance(
        selectedMetadata,
        decision.milestoneId,
      );
      if (executionLimitResult) return executionLimitResult;

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

    if (decision.kind === "recover") {
      return handleRecoveryResumeDecision(decision, selectedMetadata);
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

    return handleResumeNeedsHumanReview(decision, selectedMetadata);
  }

  async function handleRecoveryResumeDecision(
    decision: Extract<ResumeDecision, { kind: "recover" }>,
    selectedMetadata: MilestoneMetadata,
  ): Promise<GoalWorkflowResult | null> {
    const targetMilestoneId = options.executionLimits?.targetMilestoneId;
    if (
      targetMilestoneId !== undefined &&
      targetMilestoneId !== decision.milestoneId
    ) {
      return {
        ok: false,
        state,
        error: `Recovery mode ${decision.mode} targets active failed milestone ${decision.milestoneId}; requested milestone ${targetMilestoneId} is not recoverable.`,
        nextAction: "blocked_unsafe_resume",
      };
    }

    const nextAction = actionForResumeRecoveryMode(decision.mode);
    if (decision.mode === "retry_failed") {
      return retryFailedMilestoneFromResume(decision, selectedMetadata);
    }

    if (decision.mode === "repair_failed" || decision.mode === "recheck_failed") {
      const result = await runImplementationWorkflow({
        goal: options.goal,
        config: options.config,
        paths: options.paths,
        initialState: state,
        runner: options.runner,
        commandRunner: options.commandRunner,
        cwd: options.cwd,
        promptDir: options.promptDir,
        schemaRoot: options.schemaRoot,
        checkTimingCollector,
        timingWarnings,
        resumeRecoveryMode: decision.mode,
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
      return null;
    }

    return {
      ok: false,
      state,
      error: `Unsupported recovery action ${nextAction}.`,
      nextAction,
    };
  }

  async function retryFailedMilestoneFromResume(
    decision: Extract<ResumeDecision, { kind: "recover" }>,
    selectedMetadata: MilestoneMetadata,
  ): Promise<GoalWorkflowResult | null> {
    const milestoneId = decision.milestoneId;
    const dependencyBlock = failedRecoveryDependencyBlock(
      state,
      selectedMetadata,
      milestoneId,
    );
    if (dependencyBlock) {
      return {
        ok: false,
        state,
        error: dependencyBlock,
        nextAction: "blocked_unsafe_resume",
      };
    }

    const missingArtifacts = missingRetryRecoveryArtifacts(state, milestoneId);
    if (missingArtifacts.length > 0) {
      return {
        ok: false,
        state,
        error: `Recovery mode retry_failed is missing required milestone artifacts: ${missingArtifacts.join(", ")}.`,
        nextAction: "blocked_unsafe_resume",
      };
    }

    const baseline = await resolveMilestoneBaseline({
      state,
      metadata: selectedMetadata,
      milestoneId,
      paths: options.paths,
      cwd: options.cwd,
      commandRunner: options.commandRunner,
    });
    if (!baseline.ok) {
      return {
        ok: false,
        state,
        error: baseline.error,
        nextAction: "blocked_missing_milestone_baseline",
      };
    }

    const treeResult = await captureGitTree({
      cwd: options.cwd,
      commandRunner: options.commandRunner,
      excludedPaths: [options.paths.runDir],
    });
    if (!treeResult.ok) {
      return {
        ok: false,
        state,
        error: treeResult.error,
        nextAction: "blocked_unsafe_resume",
      };
    }

    if (treeResult.tree !== baseline.baselineTree) {
      return {
        ok: false,
        state,
        error: `Retry requires the worktree to match the milestone ${milestoneId} baseline. Use --repair-failed or --recheck, or restore the worktree manually before retrying.`,
        nextAction: "blocked_dirty_retry_worktree",
      };
    }

    const preserved = await preserveRetryBaseArtifacts(state, milestoneId);
    if (!preserved.ok) {
      return {
        ok: false,
        state,
        error: preserved.error,
        nextAction: "blocked_unsafe_resume",
      };
    }

    const now = clock();
    let nextState = setStatePhase(preserved.state, "ready_for_milestone", now);
    nextState = setMilestoneStatus(nextState, milestoneId, "pending", now);
    nextState = clearRetryBaseArtifacts(nextState, milestoneId, now);
    state = await persist({
      ...nextState,
      lastError: null,
      updatedAt: now.toISOString(),
    });

    return null;
  }

  async function preserveRetryBaseArtifacts(
    currentState: RunState,
    milestoneId: number,
  ): Promise<{ ok: true; state: RunState } | { ok: false; error: string }> {
    const artifactKey = selectRetryPreservationArtifactKey(currentState, milestoneId);
    let nextState = currentState;

    for (const artifactMapKey of retryResetArtifactMapKeys) {
      const baseArtifactPath = nextState.artifacts[artifactMapKey]?.[String(milestoneId)];
      if (!baseArtifactPath) continue;
      if (nextState.artifacts[artifactMapKey]?.[artifactKey]) continue;

      const source = resolveRunArtifactPath(options.paths.runDir, baseArtifactPath);
      if (!source.ok) {
        return {
          ok: false,
          error: `Cannot preserve ${artifactMapKey}.${milestoneId} before retry: ${source.error}`,
        };
      }

      const target = retryPreservedArtifactPath(
        options.paths,
        milestoneId,
        artifactKey,
        artifactMapKey,
      );
      try {
        await copyFile(source.path, target.file);
      } catch (error) {
        return {
          ok: false,
          error: `Cannot preserve ${artifactMapKey}.${milestoneId} before retry: ${formatError(error)}`,
        };
      }

      nextState = recordArtifactByKey(
        nextState,
        artifactMapKey,
        artifactKey,
        target.statePath,
        clock(),
      );
    }

    return { ok: true, state: nextState };
  }

  async function handleResumeNeedsHumanReview(
    decision: Extract<ResumeDecision, { kind: "needs_human_review" }>,
    selectedMetadata: MilestoneMetadata,
  ): Promise<GoalWorkflowResult | null> {
    if (shouldAttemptAutonomousResolution(options.config.humanReviewPolicy)) {
      return resolveResumeNeedsHumanReview(decision, selectedMetadata);
    }

    if (
      terminalPhaseForUnresolvedHumanReview(options.config.humanReviewPolicy) ===
      "failed"
    ) {
      return failResumeDecision(
        decision.message,
        decision.details,
        decision.currentMilestoneId,
        selectedMetadata,
      );
    }

    return stopForHumanReview(
      decision.message,
      decision.details,
      decision.currentMilestoneId,
    );
  }

  async function resolveResumeNeedsHumanReview(
    decision: Extract<ResumeDecision, { kind: "needs_human_review" }>,
    selectedMetadata: MilestoneMetadata,
  ): Promise<GoalWorkflowResult | null> {
    let previousResolutionOutput: string | null = null;
    let previousResolutionError: string | null = null;
    let latestResolutionError = decision.message;

    for (
      let resolutionAttempt = 1;
      resolutionAttempt <= resumeResolutionAttemptLimit;
      resolutionAttempt += 1
    ) {
      const artifactInventory = await buildResumeArtifactInventory();
      const resolutionPrompt = await renderLoadedPrompt("resolve-resume-state", {
        goal: options.goal,
        state,
        milestoneMetadata: selectedMetadata,
        resolutionAttempt,
        originalDecisionMessage: decision.message,
        originalDecisionDetails: decision.details ?? "None.",
        previousResolutionOutput: previousResolutionOutput ?? "None.",
        previousResolutionError: previousResolutionError ?? "None.",
        expectedSchemaContract: resumeResolutionSchemaContract,
        allowedActions: [
          "continue",
          "normalize_to_ready_for_review",
          "normalize_to_passed",
          "fail",
        ],
        artifactSummary: artifactInventory.summary,
      });
      if (!resolutionPrompt.ok) {
        return failResumeDecision(
          resolutionPrompt.error,
          undefined,
          decision.currentMilestoneId,
          selectedMetadata,
        );
      }

      const resolution = await runPhase("resolve_resume_state", resolutionPrompt.value, {
        state: "state.json",
        ...(state.artifacts.milestones === undefined
          ? {}
          : { milestones: state.artifacts.milestones }),
      }, decision.currentMilestoneId ?? state.currentMilestoneId ?? undefined);
      if (!resolution.ok) {
        return failResumeDecision(
          resolution.error,
          resolution.details,
          decision.currentMilestoneId,
          selectedMetadata,
        );
      }

      const parsedResolution = parseResumeResolutionJson(resolution.value);
      const resolutionError = parsedResolution.ok
        ? validateResumeResolutionAction(parsedResolution.value, {
          state,
          metadata: selectedMetadata,
          originalDecision: decision,
          existingArtifacts: artifactInventory.existingArtifacts,
        })
        : parsedResolution.error;
      const resolved = parsedResolution.ok && resolutionError === null;
      const resolutionArtifactPath = buildResumeResolutionArtifactPath(
        resolutionAttempt,
      );
      const resolutionDiagnostic = {
        phase: "resolve_resume_state",
        attempt: resolutionAttempt,
        status: resolved ? "resolved" : "unresolved",
        originalDecision: {
          message: decision.message,
          details: decision.details ?? null,
          currentMilestoneId: decision.currentMilestoneId ?? null,
        },
        resolutionError,
        rawOutput: resolution.value,
        artifactSummary: artifactInventory.summary,
        ...(parsedResolution.ok ? { resolution: parsedResolution.value } : {}),
      };
      try {
        await writeJsonArtifact(resolutionArtifactPath.file, resolutionDiagnostic);
      } catch (error) {
        return failResumeDecision(
          `Failed to write resume resolution diagnostic artifact at ${resolutionArtifactPath.file}: ${formatError(error)}`,
          undefined,
          decision.currentMilestoneId,
          selectedMetadata,
        );
      }

      state = await persist(
        recordArtifactByKey(
          state,
          "logs",
          resolutionArtifactPath.stateKey,
          resolutionArtifactPath.statePath,
          clock(),
        ),
      );

      if (parsedResolution.ok && resolved) {
        return applyResumeResolutionAction(
          parsedResolution.value,
          decision,
          selectedMetadata,
        );
      }

      previousResolutionOutput = resolution.value;
      latestResolutionError =
        resolutionError ?? "Resume resolution did not produce a valid action.";
      previousResolutionError = latestResolutionError;
    }

    return failResumeDecision(
      `Resume state resolution failed after ${resumeResolutionAttemptLimit} attempt(s).`,
      {
        originalDecision: decision.message,
        originalDetails: decision.details ?? null,
        latestResolutionError,
      },
      decision.currentMilestoneId,
      selectedMetadata,
    );
  }

  async function applyResumeResolutionAction(
    resolution: ResumeResolutionDocument,
    originalDecision: Extract<ResumeDecision, { kind: "needs_human_review" }>,
    selectedMetadata: MilestoneMetadata,
  ): Promise<GoalWorkflowResult | null> {
    if (resolution.action === "fail") {
      return failResumeDecision(
        resolution.summary,
        {
          rationale: resolution.rationale,
          assumptions: resolution.assumptions,
          originalDecision: originalDecision.message,
          originalDetails: originalDecision.details ?? null,
        },
        resolution.currentMilestoneId ?? originalDecision.currentMilestoneId,
        selectedMetadata,
      );
    }

    if (resolution.action === "continue") {
      return null;
    }

    const milestoneId = resolution.currentMilestoneId;
    if (milestoneId === undefined || milestoneId === null) {
      return failResumeDecision(
        `Resume resolution action ${resolution.action} did not include currentMilestoneId.`,
        {
          resolution,
          originalDecision: originalDecision.message,
        },
        originalDecision.currentMilestoneId,
        selectedMetadata,
      );
    }

    if (resolution.action === "normalize_to_ready_for_review") {
      const now = clock();
      let nextState = setStatePhase(state, "ready_for_review", now);
      nextState = setMilestoneStatus(nextState, milestoneId, "ready_for_review", now);
      state = await persist({
        ...nextState,
        lastError: null,
      });
      return null;
    }

    if (resolution.action === "normalize_to_passed") {
      const now = clock();
      let nextState = setStatePhase(state, "passed", now);
      nextState = setMilestoneStatus(nextState, milestoneId, "passed", now);
      state = await persist({
        ...nextState,
        lastError: null,
      });
      return null;
    }

    return failResumeDecision(
      `Unsupported resume resolution action: ${resolution.action}.`,
      { resolution },
      originalDecision.currentMilestoneId,
      selectedMetadata,
    );
  }

  async function failResumeDecision(
    message: string,
    details: unknown,
    currentMilestoneId: number | null | undefined,
    selectedMetadata: MilestoneMetadata,
  ): Promise<GoalWorkflowResult> {
    const normalizedDetails = normalizeDetails(details);
    const now = clock();
    let nextState = failState(state, {
      phase: "failed",
      message,
      details: normalizedDetails,
      now,
    });
    if (currentMilestoneId !== undefined) {
      nextState = {
        ...nextState,
        currentMilestoneId,
      };
    }
    if (currentMilestoneId !== undefined && currentMilestoneId !== null) {
      nextState = setMilestoneStatus(nextState, currentMilestoneId, "failed", now);
    }

    state = await persist(nextState);
    return finishTerminal({
      state,
      metadata: selectedMetadata,
      ok: false,
      originalError: message,
      diagnostics: [
        {
          message,
          details: normalizedDetails,
        },
      ],
    });
  }

  async function failUnexpectedHumanReviewResult(
    selectedMetadata: MilestoneMetadata,
  ): Promise<GoalWorkflowResult> {
    const message = `Review workflow returned needs_human_review while humanReviewPolicy is ${options.config.humanReviewPolicy}.`;
    const now = clock();
    let nextState = failState(state, {
      phase: "failed",
      message,
      details: { humanReviewPolicy: options.config.humanReviewPolicy },
      now,
    });
    if (nextState.currentMilestoneId !== null) {
      nextState = setMilestoneStatus(nextState, nextState.currentMilestoneId, "failed", now);
    }
    state = await persist(nextState);
    return finishTerminal({
      state,
      metadata: selectedMetadata,
      ok: false,
      originalError: message,
    });
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

  async function renderLoadedPrompt(
    promptName: "resolve-resume-state",
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
    phase: "resolve_resume_state",
    prompt: string,
    artifacts: Record<string, string>,
    milestoneId?: number,
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
          ...(milestoneId === undefined ? {} : { milestoneId }),
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
    phase: "resolve_resume_state",
  ): Promise<{ ok: true; path?: string } | { ok: false; error: string }> {
    if (options.runner.type !== "codex-exec") return { ok: true };

    return resolveOutputSchemaPathForPhase({
      phase,
      cwd: options.cwd,
      schemaRoot: options.schemaRoot,
    });
  }

  async function buildResumeArtifactInventory(): Promise<{
    summary: string;
    existingArtifacts: ReadonlySet<string>;
  }> {
    const entries = collectArtifactEntries(state.artifacts);
    if (entries.length === 0) {
      return {
        summary: "No artifacts recorded.",
        existingArtifacts: new Set(),
      };
    }

    const existingArtifacts = new Set<string>();
    const lines: string[] = [];
    for (const entry of entries) {
      const resolved = resolveRunArtifactPath(options.paths.runDir, entry.path);
      if (!resolved.ok) {
        lines.push(`- ${entry.key}: ${entry.path} (invalid: ${resolved.error})`);
        continue;
      }

      try {
        await access(resolved.path);
        existingArtifacts.add(entry.path);
        existingArtifacts.add(resolved.relativePath);
        lines.push(`- ${entry.key}: ${entry.path} (exists)`);
      } catch {
        lines.push(`- ${entry.key}: ${entry.path} (missing)`);
      }
    }

    return {
      summary: lines.join("\n"),
      existingArtifacts,
    };
  }

  function buildResumeResolutionArtifactPath(attempt: number): {
    file: string;
    statePath: string;
    stateKey: string;
  } {
    const fileName = `resolve-resume-state-${attempt}.json`;
    return {
      file: path.join(options.paths.dirs.logs, fileName),
      statePath: path.join("logs", fileName),
      stateKey: `resume-resolution-${attempt}`,
    };
  }

  function handlePassedExecutionLimit(
    selectedMetadata: MilestoneMetadata,
  ): GoalWorkflowResult | null {
    const targetMilestoneId = options.executionLimits?.targetMilestoneId;
    if (
      targetMilestoneId === undefined ||
      !options.executionLimits?.stopAfterTargetMilestone ||
      state.currentMilestoneId !== targetMilestoneId ||
      state.milestoneStatuses[String(targetMilestoneId)] !== "passed"
    ) {
      return null;
    }

    const decision = selectNextRunnableMilestone(selectedMetadata, state);
    if (decision.kind === "complete") {
      return null;
    }

    if (
      decision.kind === "runnable" &&
      hasPendingMilestones(selectedMetadata, state)
    ) {
      return {
        ok: true,
        state,
        nextAction: resumeWithoutMilestoneNextAction,
      };
    }

    return null;
  }

  function validateExecutionLimitBeforeWork(
    selectedMetadata: MilestoneMetadata,
  ): GoalWorkflowResult | null {
    const targetMilestoneId = options.executionLimits?.targetMilestoneId;
    if (targetMilestoneId === undefined) return null;

    const targetExists = validateTargetMilestoneExists(selectedMetadata);
    if (targetExists) return targetExists;

    const target = selectedMetadata.milestones.find(
      (milestone) => milestone.id === targetMilestoneId,
    );
    if (!target) {
      return executionLimitBlocked(
        `Target milestone ${targetMilestoneId} was not found in milestone metadata.`,
      );
    }

    const targetStatus = state.milestoneStatuses[String(targetMilestoneId)];
    const unmetDependencies = target.dependencies.filter(
      (dependencyId) => state.milestoneStatuses[String(dependencyId)] !== "passed",
    );
    if (unmetDependencies.length > 0) {
      return executionLimitBlocked(
        `Target milestone ${targetMilestoneId} cannot run because dependencies are not passed: ${unmetDependencies.join(", ")}.`,
        { targetMilestoneId, unmetDependencies },
      );
    }

    if (state.currentMilestoneId === targetMilestoneId) {
      const expectedStatus =
        state.currentPhase === "ready_for_review" ? "ready_for_review" : "pending";
      if (targetStatus !== expectedStatus) {
        return executionLimitBlocked(
          `Target milestone ${targetMilestoneId} cannot run because its current status is ${targetStatus ?? "missing"}. Choose a pending or currently active milestone, or resume without --milestone.`,
        );
      }
      return null;
    }

    if (targetStatus !== "pending") {
      return executionLimitBlocked(
        `Target milestone ${targetMilestoneId} cannot run because its current status is ${targetStatus ?? "missing"}. Choose a pending or currently active milestone, or resume without --milestone.`,
      );
    }

    const decision = selectNextRunnableMilestone(selectedMetadata, state);
    if (decision.kind !== "runnable") {
      if (decision.kind === "complete") {
        return executionLimitBlocked(
          `Target milestone ${targetMilestoneId} cannot run because the goal is already complete.`,
          { targetMilestoneId },
        );
      }

      return executionLimitBlocked(
        `Target milestone ${targetMilestoneId} cannot run because no matching milestone is currently runnable. ${decision.message}`,
        decision.details,
      );
    }

    if (decision.milestone.id !== targetMilestoneId) {
      return executionLimitBlocked(
        `Target milestone ${targetMilestoneId} cannot run because next runnable milestone is ${decision.milestone.id}. Run without --milestone to continue in dependency order or choose --milestone ${decision.milestone.id}.`,
        {
          targetMilestoneId,
          nextRunnableMilestoneId: decision.milestone.id,
        },
      );
    }

    return null;
  }

  function validateExecutionLimitBeforeAdvance(
    selectedMetadata: MilestoneMetadata,
    nextMilestoneId: number,
  ): GoalWorkflowResult | null {
    const targetMilestoneId = options.executionLimits?.targetMilestoneId;
    if (targetMilestoneId === undefined) return null;

    const targetExists = validateTargetMilestoneExists(selectedMetadata);
    if (targetExists) return targetExists;

    if (nextMilestoneId !== targetMilestoneId) {
      return executionLimitBlocked(
        `Target milestone ${targetMilestoneId} cannot run because next runnable milestone is ${nextMilestoneId}. Run without --milestone to continue in dependency order or choose --milestone ${nextMilestoneId}.`,
        {
          targetMilestoneId,
          nextRunnableMilestoneId: nextMilestoneId,
        },
      );
    }

    return null;
  }

  function validateTargetMilestoneExists(
    selectedMetadata: MilestoneMetadata,
  ): GoalWorkflowResult | null {
    const targetMilestoneId = options.executionLimits?.targetMilestoneId;
    if (targetMilestoneId === undefined) return null;

    if (
      selectedMetadata.milestones.some(
        (milestone) => milestone.id === targetMilestoneId,
      )
    ) {
      return null;
    }

    return executionLimitBlocked(
      `Target milestone ${targetMilestoneId} was not found in milestone metadata.`,
      { targetMilestoneId },
    );
  }

  function executionLimitBlocked(
    message: string,
    details?: unknown,
  ): GoalWorkflowResult {
    return {
      ok: false,
      state,
      error:
        details === undefined
          ? message
          : `${message} Details: ${JSON.stringify(normalizeDetails(details))}`,
    };
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

function hasPendingMilestones(
  metadata: MilestoneMetadata,
  state: RunState,
): boolean {
  return metadata.milestones.some(
    (milestone) => state.milestoneStatuses[String(milestone.id)] === "pending",
  );
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

function missingRetryRecoveryArtifacts(
  state: RunState,
  milestoneId: number,
): string[] {
  const key = String(milestoneId);
  const missing: string[] = [];

  if (!state.artifacts.milestones) missing.push("milestones");
  if (!state.artifacts.finalMajorPlanMarkdown) missing.push("finalMajorPlanMarkdown");
  if (!state.artifacts.milestonePlans?.[key]) missing.push("milestonePlans");
  if (!state.artifacts.implementations?.[key]) missing.push("implementations");
  if (!state.artifacts.diffs?.[key]) missing.push("diffs");
  if (!state.artifacts.checks?.[key]) missing.push("checks");

  return missing;
}

function selectRetryPreservationArtifactKey(
  state: RunState,
  milestoneId: number,
): string {
  const pattern = new RegExp(`^${milestoneId}-(failed|repair|recheck)-(\\d+)$`);
  let latest: { key: string; rank: number } | null = null;

  for (const artifactMapKey of retryResetArtifactMapKeys) {
    for (const artifactKey of Object.keys(state.artifacts[artifactMapKey] ?? {})) {
      const match = pattern.exec(artifactKey);
      if (!match) continue;

      const source = match[1] as "failed" | "repair" | "recheck";
      const attempt = Number(match[2]);
      if (!Number.isInteger(attempt) || attempt < 1) continue;

      const rank = retryPreservationArtifactRank(source, attempt);
      if (latest === null || rank > latest.rank) {
        latest = { key: artifactKey, rank };
      }
    }
  }

  return latest?.key ?? `${milestoneId}-failed-1`;
}

function retryPreservationArtifactRank(
  source: "failed" | "repair" | "recheck",
  attempt: number,
): number {
  const sourceRank = {
    failed: 0,
    repair: 1,
    recheck: 2,
  }[source];

  return sourceRank * 1_000_000 + attempt;
}

function retryPreservedArtifactPath(
  paths: RunPaths,
  milestoneId: number,
  artifactKey: string,
  artifactMapKey: (typeof retryResetArtifactMapKeys)[number],
): { file: string; statePath: string } {
  const label = artifactKey.replace(`${milestoneId}-`, "");

  switch (artifactMapKey) {
    case "diffs": {
      const statePath = path.join("diffs", `12-milestone-${milestoneId}-${label}.diff`);
      return {
        file: path.join(paths.runDir, statePath),
        statePath,
      };
    }
    case "checks": {
      const statePath = path.join("checks", `13-milestone-${milestoneId}-checks-${label}.txt`);
      return {
        file: path.join(paths.runDir, statePath),
        statePath,
      };
    }
    case "summaries": {
      const statePath = path.join("milestones", `14-milestone-${milestoneId}-summary-${label}.md`);
      return {
        file: path.join(paths.runDir, statePath),
        statePath,
      };
    }
    case "checkFailures": {
      const statePath = path.join("checks", `13-milestone-${milestoneId}-check-failure-${label}.json`);
      return {
        file: path.join(paths.runDir, statePath),
        statePath,
      };
    }
  }
}

function clearRetryBaseArtifacts(
  state: RunState,
  milestoneId: number,
  now: Date,
): RunState {
  const artifactKey = String(milestoneId);
  const artifacts = { ...state.artifacts };

  for (const artifactMapKey of retryResetArtifactMapKeys) {
    const existingArtifacts = artifacts[artifactMapKey];
    if (!existingArtifacts || !(artifactKey in existingArtifacts)) continue;

    const nextArtifacts = { ...existingArtifacts };
    delete nextArtifacts[artifactKey];

    if (Object.keys(nextArtifacts).length === 0) {
      delete artifacts[artifactMapKey];
    } else {
      artifacts[artifactMapKey] = nextArtifacts;
    }
  }

  return {
    ...state,
    artifacts,
    updatedAt: now.toISOString(),
  };
}

function collectArtifactEntries(
  artifacts: RunState["artifacts"],
): Array<{ key: string; path: string }> {
  const entries: Array<{ key: string; path: string }> = [];

  for (const [key, value] of Object.entries(artifacts)) {
    if (typeof value === "string") {
      entries.push({ key, path: value });
      continue;
    }

    if (!isRecord(value)) continue;
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      if (typeof nestedValue === "string") {
        entries.push({ key: `${key}.${nestedKey}`, path: nestedValue });
      }
    }
  }

  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

function combineTerminalErrors(
  originalError: string | undefined,
  summaryError: string,
): string {
  return originalError
    ? `${originalError} Additionally, ${summaryError}`
    : summaryError;
}

function finalizationWarning(error: unknown): TimingWarning {
  return {
    code: "timing_finalization_failed",
    message: `Failed to finalize timing artifacts: ${formatError(error)}`,
    source: "finalization",
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
