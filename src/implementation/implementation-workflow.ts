import { readFile } from "node:fs/promises";

import {
  buildCheckFailureArtifactPath,
  buildCheckRepairAttemptArtifactPaths,
  buildMilestoneArtifactPaths,
  buildRecheckAttemptArtifactPaths,
} from "../artifacts/milestone-artifacts.js";
import { resolveRunArtifactPath } from "../artifacts/paths.js";
import {
  buildPlanningArtifactPaths,
  writeJsonArtifact,
  writeTextArtifact,
} from "../artifacts/planning-artifacts.js";
import {
  buildCheckFailureSummaryArtifact,
  formatCheckFailureSummaryForPrompt,
  parseCheckFailureSummaryArtifact,
  type CheckFailureSummaryArtifact,
} from "../checks/check-failure-summary.js";
import type { CheckRunResult } from "../checks/check-types.js";
import { runChecks } from "../checks/check-runner.js";
import { effectiveMaxCheckFixAttempts } from "../config/check-fix-attempts.js";
import { captureGitTree } from "../git/git-diff.js";
import type { Milestone, MilestoneMetadata } from "../milestones/milestone-types.js";
import { parseMilestoneMetadataJson } from "../milestones/milestone-validator.js";
import {
  captureReviewableMilestoneDiff,
  resolveMilestoneBaseline,
} from "../orchestration/milestone-baseline.js";
import { loadPrompt } from "../prompts/prompt-loader.js";
import { renderPrompt, type PromptVariables } from "../prompts/prompt-renderer.js";
import type { AgentRunResult } from "../runners/agent-runner.js";
import { resolveOutputSchemaPathForPhase } from "../runners/output-schema.js";
import { runAgentPhaseWithDiagnostics } from "../runners/runner-diagnostics.js";
import { writeState } from "../state/state-store.js";
import {
  failState,
  recordArtifactByKey,
  recordMilestoneArtifact,
  recordMilestoneBaseline,
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

interface LatestCheckFailureSelection {
  stateKey: string;
  statePath: string;
  source: "failed" | "repair" | "recheck";
  attempt: number;
}

interface LoadedCheckRepairContext {
  milestonePlan: string;
  milestonePlanPath: string;
  implementationReport: string;
  implementationReportPath: string;
  latestDiff: string;
  latestDiffPath: string;
  latestFailedCheckReport: string;
  latestFailedCheckReportPath: string;
  checkFailureSummary: CheckFailureSummaryArtifact;
  checkFailureSummaryPath: string;
  baselineTree: string;
}

interface LoadedManualRecheckContext {
  milestonePlanPath: string;
  implementationReportPath: string;
  originalFailedCheckReportPath: string;
  baselineTree: string;
  baselineSource: "stored" | "reconstructed";
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

  if (options.resumeRecoveryMode === "repair_failed") {
    return repairFailedChecksFromResume();
  }
  if (options.resumeRecoveryMode === "recheck_failed") {
    return recheckFailedMilestoneFromResume();
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
  state = await persist(
    recordMilestoneBaseline(
      state,
      activeMilestoneId,
      diffBaseline.tree,
      clock(),
    ),
  );

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

  const diffResult = await captureReviewableMilestoneDiff({
    cwd: options.cwd,
    commandRunner: options.commandRunner,
    paths: options.paths,
    baselineTree: diffBaseline.tree,
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
    const checkFailureWrite = await writeInitialCheckFailureSummary(
      "checking",
      activeMilestoneId,
      milestonePaths.statePaths.checks,
      checks,
    );
    if (!checkFailureWrite.ok) return checkFailureWrite.result;

    const maxCheckFixAttempts = effectiveMaxCheckFixAttempts(options.config);
    if (maxCheckFixAttempts === 0) {
      return fail("failed", `Checks failed for milestone ${activeMilestoneId}.`, {
        checkFailureSummary: checkFailureWrite.statePath,
        results: checks.results,
      });
    }

    state = await markChecksFailed(
      activeMilestoneId,
      `Checks failed for milestone ${activeMilestoneId}.`,
      {
        checkFailureSummary: checkFailureWrite.statePath,
        checks: milestonePaths.statePaths.checks,
        maxCheckFixAttempts,
        attemptsCompleted: state.checkFixAttempts[String(activeMilestoneId)] ?? 0,
        results: checks.results,
      },
    );

    return runCheckRepairLoop({
      metadata,
      activeMilestone,
      finalMajorPlan: finalMajorPlan.value,
      maxCheckFixAttempts,
    });
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

  async function repairFailedChecksFromResume(): Promise<ImplementationWorkflowResult> {
    const recoveryPreflight = validateCheckRepairResumeState(state);
    if (!recoveryPreflight.ok) {
      return fail("repairing_checks", recoveryPreflight.error);
    }

    activeMilestoneId = recoveryPreflight.milestoneId;
    const recoveryPlanningPaths = buildPlanningArtifactPaths(options.paths);
    const metadataResult = await readMilestoneMetadata(recoveryPlanningPaths.files.milestones);
    if (!metadataResult.ok) return fail("repairing_checks", metadataResult.error);

    const recoveryMetadata = metadataResult.value;
    const recoveryMilestone = recoveryMetadata.milestones.find(
      (milestone) => milestone.id === activeMilestoneId,
    );
    if (!recoveryMilestone) {
      return fail(
        "repairing_checks",
        `Active milestone ${activeMilestoneId} was not found.`,
      );
    }

    const recoveryFinalMajorPlan = await readRequiredArtifact(
      state.artifacts.finalMajorPlanMarkdown,
      recoveryPlanningPaths.files.finalMajorPlanMarkdown,
      "final major plan",
    );
    if (!recoveryFinalMajorPlan.ok) {
      return fail("repairing_checks", recoveryFinalMajorPlan.error);
    }

    const maxCheckFixAttempts = effectiveMaxCheckFixAttempts(options.config);
    if (maxCheckFixAttempts === 0) {
      return fail(
        "failed",
        `Cannot repair failed checks for milestone ${activeMilestoneId} because maxCheckFixAttempts is 0.`,
        { maxCheckFixAttempts },
      );
    }

    const checkFailureSummary = await ensureCheckFailureSummaryForRecovery(
      activeMilestoneId,
    );
    if (!checkFailureSummary.ok) return checkFailureSummary.result;

    state = await markChecksFailed(
      activeMilestoneId,
      `Repair recovery started for failed checks on milestone ${activeMilestoneId}.`,
      {
        recoveryMode: "repair_failed",
        maxCheckFixAttempts,
        attemptsCompleted: state.checkFixAttempts[String(activeMilestoneId)] ?? 0,
        checkFailureSummary: checkFailureSummary.statePath,
        synthesizedCheckFailureSummary: checkFailureSummary.synthesized,
      },
    );

    return runCheckRepairLoop({
      metadata: recoveryMetadata,
      activeMilestone: recoveryMilestone,
      finalMajorPlan: recoveryFinalMajorPlan.value,
      maxCheckFixAttempts,
    });
  }

  async function recheckFailedMilestoneFromResume(): Promise<ImplementationWorkflowResult> {
    const recoveryPreflight = validateCheckRecheckResumeState(state);
    if (!recoveryPreflight.ok) {
      return fail("rechecking", recoveryPreflight.error);
    }

    activeMilestoneId = recoveryPreflight.milestoneId;
    const recoveryPlanningPaths = buildPlanningArtifactPaths(options.paths);
    const metadataResult = await readMilestoneMetadata(recoveryPlanningPaths.files.milestones);
    if (!metadataResult.ok) return fail("rechecking", metadataResult.error);

    const recoveryMetadata = metadataResult.value;
    const recoveryMilestone = recoveryMetadata.milestones.find(
      (milestone) => milestone.id === activeMilestoneId,
    );
    if (!recoveryMilestone) {
      return fail("rechecking", `Active milestone ${activeMilestoneId} was not found.`);
    }

    const recheckContext = await loadManualRecheckContext({
      metadata: recoveryMetadata,
      activeMilestone: recoveryMilestone,
    });
    if (!recheckContext.ok) {
      return fail("rechecking", recheckContext.error, recheckContext.details);
    }

    const attempt = nextRecheckAttempt(state, activeMilestoneId);
    const recheckPaths = buildRecheckAttemptArtifactPaths(
      options.paths,
      activeMilestoneId,
      attempt,
    );

    state = await persist(setStatePhase(state, "rechecking", clock()));
    state = await persist(setMilestoneStatus(state, activeMilestoneId, "rechecking", clock()));

    const diffResult = await captureReviewableMilestoneDiff({
      cwd: options.cwd,
      commandRunner: options.commandRunner,
      paths: options.paths,
      baselineTree: recheckContext.value.baselineTree,
    });
    if (!diffResult.ok) {
      return blockRecheckPromotion(
        activeMilestoneId,
        `Cannot recheck milestone ${activeMilestoneId} because the reconciled diff could not be captured.`,
        {
          recoveryMode: "recheck_failed",
          recheckAttempt: attempt,
          reason: "diff_capture_failed",
          details: diffResult.details ?? diffResult.error,
        },
      );
    }

    if (diffResult.diff.trim().length === 0) {
      return blockRecheckPromotion(
        activeMilestoneId,
        `Cannot recheck milestone ${activeMilestoneId} because the reconciled diff is empty.`,
        {
          recoveryMode: "recheck_failed",
          recheckAttempt: attempt,
          reason: "empty_reconciled_diff",
          baselineSource: recheckContext.value.baselineSource,
        },
      );
    }

    const diffWrite = await writeTextArtifactOrFail(
      "rechecking",
      recheckPaths.files.diff,
      diffResult.diff,
      "manual recheck diff artifact",
    );
    if (!diffWrite.ok) return diffWrite.result;

    state = await persist(
      recordArtifactByKey(
        state,
        "diffs",
        recheckPaths.stateKey,
        recheckPaths.statePaths.diff,
        clock(),
      ),
    );

    const recheckResult = await runChecks({
      checks: options.config.checks,
      cwd: options.cwd,
      commandRunner: options.commandRunner,
    });
    options.checkTimingCollector?.recordCheckRun({
      stateKey: recheckPaths.stateKey,
      milestoneId: activeMilestoneId,
      attempt,
      artifactPath: recheckPaths.statePaths.checks,
      result: recheckResult,
    });

    const checksWrite = await writeTextArtifactOrFail(
      "rechecking",
      recheckPaths.files.checks,
      recheckResult.report,
      "manual recheck checks artifact",
    );
    if (!checksWrite.ok) return checksWrite.result;

    state = await persist(
      recordArtifactByKey(
        state,
        "checks",
        recheckPaths.stateKey,
        recheckPaths.statePaths.checks,
        clock(),
      ),
    );

    const summary = formatMilestoneRecheckSummary({
      milestone: recoveryMilestone,
      milestonePlan: recheckContext.value.milestonePlanPath,
      implementation: recheckContext.value.implementationReportPath,
      diff: recheckPaths.statePaths.diff,
      checks: recheckPaths.statePaths.checks,
      originalFailedChecks: recheckContext.value.originalFailedCheckReportPath,
      recheckAttempt: attempt,
      checkCount: recheckResult.results.length,
      promoted: recheckResult.ok,
      baselineSource: recheckContext.value.baselineSource,
    });
    const summaryWrite = await writeTextArtifactOrFail(
      "rechecking",
      recheckPaths.files.summary,
      summary,
      "manual recheck summary artifact",
    );
    if (!summaryWrite.ok) return summaryWrite.result;

    state = await persist(
      recordArtifactByKey(
        state,
        "summaries",
        recheckPaths.stateKey,
        recheckPaths.statePaths.summary,
        clock(),
      ),
    );

    if (recheckResult.ok) {
      state = await persist(
        recordMilestoneArtifact(
          state,
          "diffs",
          activeMilestoneId,
          recheckPaths.statePaths.diff,
          clock(),
        ),
      );
      state = await persist(
        recordMilestoneArtifact(
          state,
          "checks",
          activeMilestoneId,
          recheckPaths.statePaths.checks,
          clock(),
        ),
      );
      state = await persist(
        recordMilestoneArtifact(
          state,
          "summaries",
          activeMilestoneId,
          recheckPaths.statePaths.summary,
          clock(),
        ),
      );

      const now = clock();
      let nextState = setStatePhase(state, "ready_for_review", now);
      nextState = setMilestoneStatus(nextState, activeMilestoneId, "ready_for_review", now);
      state = await persist({
        ...nextState,
        lastError: null,
      });

      return {
        ok: true,
        state,
        metadata: recoveryMetadata,
        milestoneId: activeMilestoneId,
      };
    }

    const failureWrite = await writeRepairCheckFailureSummary(
      "rechecking",
      activeMilestoneId,
      attempt,
      recheckPaths.stateKey,
      recheckPaths.files.checkFailure,
      recheckPaths.statePaths.checkFailure,
      recheckPaths.statePaths.checks,
      recheckResult,
    );
    if (!failureWrite.ok) return failureWrite.result;

    state = await markChecksFailed(
      activeMilestoneId,
      `Checks failed during manual recheck attempt ${attempt} for milestone ${activeMilestoneId}.`,
      {
        recoveryMode: "recheck_failed",
        recheckAttempt: attempt,
        originalFailedChecks: recheckContext.value.originalFailedCheckReportPath,
        recheckDiff: recheckPaths.statePaths.diff,
        recheckChecks: recheckPaths.statePaths.checks,
        recheckSummary: recheckPaths.statePaths.summary,
        checkFailureSummary: failureWrite.statePath,
        promoted: false,
        results: recheckResult.results,
      },
    );

    return {
      ok: false,
      state,
      error: `Checks failed during manual recheck attempt ${attempt} for milestone ${activeMilestoneId}.`,
    };
  }

  async function runCheckRepairLoop(context: {
    metadata: MilestoneMetadata;
    activeMilestone: Milestone;
    finalMajorPlan: string;
    maxCheckFixAttempts: number;
  }): Promise<ImplementationWorkflowResult> {
    const milestoneId = context.activeMilestone.id;

    for (;;) {
      const completedAttempts = state.checkFixAttempts[String(milestoneId)] ?? 0;
      const latestFailure = selectLatestCheckFailureArtifact(state, milestoneId);

      if (completedAttempts >= context.maxCheckFixAttempts) {
        return fail(
          "failed",
          `Check repair attempts exhausted after ${completedAttempts} attempt(s) for milestone ${milestoneId}.`,
          {
            attempts: completedAttempts,
            maxCheckFixAttempts: context.maxCheckFixAttempts,
            latestCheckFailureSummary: latestFailure?.statePath ?? null,
          },
        );
      }

      const repairContext = await loadCheckRepairContext({
        metadata: context.metadata,
        activeMilestone: context.activeMilestone,
      });
      if (!repairContext.ok) {
        return fail("repairing_checks", repairContext.error, repairContext.details);
      }

      const attempt = completedAttempts + 1;
      const repairPaths = buildCheckRepairAttemptArtifactPaths(
        options.paths,
        milestoneId,
        attempt,
      );

      state = await persist(setStatePhase(state, "repairing_checks", clock()));
      state = await persist(setMilestoneStatus(state, milestoneId, "repairing_checks", clock()));

      const repairPrompt = await renderLoadedPrompt("fix-check-failures", {
        goal: options.goal,
        finalMajorPlan: context.finalMajorPlan,
        activeMilestone: context.activeMilestone,
        milestonePlan: repairContext.value.milestonePlan,
        implementationReport: repairContext.value.implementationReport,
        latestDiff: repairContext.value.latestDiff,
        latestFailedCheckReport: repairContext.value.latestFailedCheckReport,
        checkFailureSummary: formatCheckFailureSummaryForPrompt(
          repairContext.value.checkFailureSummary,
        ),
        checkFixAttempts: completedAttempts,
        maxCheckFixAttempts: context.maxCheckFixAttempts,
        state,
      });
      if (!repairPrompt.ok) return fail("repairing_checks", repairPrompt.error);

      const repair = await runPhase("fix_check_failures", repairPrompt.value, {
        finalMajorPlan:
          state.artifacts.finalMajorPlanMarkdown ??
          buildPlanningArtifactPaths(options.paths).statePaths.finalMajorPlanMarkdown,
        milestonePlan: repairContext.value.milestonePlanPath,
        implementation: repairContext.value.implementationReportPath,
        diff: repairContext.value.latestDiffPath,
        checks: repairContext.value.latestFailedCheckReportPath,
        checkFailureSummary: repairContext.value.checkFailureSummaryPath,
      }, { cwd: options.cwd });
      if (!repair.ok) return fail("repairing_checks", repair.error, repair.details);

      const repairWrite = await writeTextArtifactOrFail(
        "repairing_checks",
        repairPaths.files.fix,
        repair.value,
        "check repair artifact",
      );
      if (!repairWrite.ok) return repairWrite.result;

      state = await persist(
        recordArtifactByKey(
          state,
          "fixes",
          repairPaths.stateKey,
          repairPaths.statePaths.fix,
          clock(),
        ),
      );
      state = await recordCompletedCheckFixAttempt(milestoneId, attempt);

      const diffResult = await captureReviewableMilestoneDiff({
        cwd: options.cwd,
        commandRunner: options.commandRunner,
        paths: options.paths,
        baselineTree: repairContext.value.baselineTree,
      });
      if (!diffResult.ok) {
        return fail("repairing_checks", diffResult.error, diffResult.details);
      }

      if (diffResult.diff.trim().length === 0) {
        return fail(
          "repairing_checks",
          `Check repair attempt ${attempt} for milestone ${milestoneId} produced an empty diff.`,
        );
      }

      const diffWrite = await writeTextArtifactOrFail(
        "repairing_checks",
        repairPaths.files.diff,
        diffResult.diff,
        "post-check-repair diff artifact",
      );
      if (!diffWrite.ok) return diffWrite.result;

      state = await persist(
        recordArtifactByKey(
          state,
          "diffs",
          repairPaths.stateKey,
          repairPaths.statePaths.diff,
          clock(),
        ),
      );
      state = await persist(
        recordMilestoneArtifact(
          state,
          "diffs",
          milestoneId,
          repairPaths.statePaths.diff,
          clock(),
        ),
      );

      state = await persist(setStatePhase(state, "checking", clock()));
      state = await persist(setMilestoneStatus(state, milestoneId, "checking", clock()));

      const repairChecks = await runChecks({
        checks: options.config.checks,
        cwd: options.cwd,
        commandRunner: options.commandRunner,
      });
      options.checkTimingCollector?.recordCheckRun({
        stateKey: repairPaths.stateKey,
        milestoneId,
        attempt,
        artifactPath: repairPaths.statePaths.checks,
        result: repairChecks,
      });

      const checksWrite = await writeTextArtifactOrFail(
        "checking",
        repairPaths.files.checks,
        repairChecks.report,
        "post-check-repair checks artifact",
      );
      if (!checksWrite.ok) return checksWrite.result;

      state = await persist(
        recordArtifactByKey(
          state,
          "checks",
          repairPaths.stateKey,
          repairPaths.statePaths.checks,
          clock(),
        ),
      );

      if (repairChecks.ok) {
        state = await persist(
          recordMilestoneArtifact(
            state,
            "checks",
            milestoneId,
            repairPaths.statePaths.checks,
            clock(),
          ),
        );

        const milestonePaths = buildMilestoneArtifactPaths(options.paths, milestoneId);
        const summary = formatMilestoneSummary({
          milestone: context.activeMilestone,
          milestonePlan: repairContext.value.milestonePlanPath,
          implementation: repairContext.value.implementationReportPath,
          diff: repairPaths.statePaths.diff,
          checks: repairPaths.statePaths.checks,
          checkCount: repairChecks.results.length,
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
            milestoneId,
            milestonePaths.statePaths.summary,
            clock(),
          ),
        );

        const now = clock();
        let nextState = setStatePhase(state, "ready_for_review", now);
        nextState = setMilestoneStatus(nextState, milestoneId, "ready_for_review", now);
        state = await persist({
          ...nextState,
          lastError: null,
        });

        return {
          ok: true,
          state,
          metadata: context.metadata,
          milestoneId,
        };
      }

      const failureWrite = await writeRepairCheckFailureSummary(
        "checking",
        milestoneId,
        attempt,
        repairPaths.stateKey,
        repairPaths.files.checkFailure,
        repairPaths.statePaths.checkFailure,
        repairPaths.statePaths.checks,
        repairChecks,
      );
      if (!failureWrite.ok) return failureWrite.result;

      state = await markChecksFailed(
        milestoneId,
        `Checks failed after check repair attempt ${attempt} for milestone ${milestoneId}.`,
        {
          checkFailureSummary: failureWrite.statePath,
          checks: repairPaths.statePaths.checks,
          maxCheckFixAttempts: context.maxCheckFixAttempts,
          attemptsCompleted: state.checkFixAttempts[String(milestoneId)] ?? attempt,
          repairAttempt: attempt,
          results: repairChecks.results,
        },
      );
    }
  }

  async function renderLoadedPrompt(
    promptName:
      | "milestone-plan"
      | "milestone-plan-review"
      | "final-milestone-plan"
      | "implement-milestone"
      | "fix-check-failures",
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

  async function writeJsonArtifactOrFail(
    phase: OrchestratorPhase,
    filePath: string,
    value: unknown,
    label: string,
  ): Promise<{ ok: true } | { ok: false; result: ImplementationWorkflowResult }> {
    try {
      await writeJsonArtifact(filePath, value);
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
    let filePath = fallbackPath;
    if (statePath !== undefined) {
      const resolvedPath = resolveRunArtifactPath(options.paths.runDir, statePath);
      if (!resolvedPath.ok) {
        return {
          ok: false,
          error: `Invalid ${label} artifact path ${statePath}: ${resolvedPath.error}`,
        };
      }
      filePath = resolvedPath.path;
    }

    try {
      return { ok: true, value: await readFile(filePath, "utf8") };
    } catch (error) {
      return {
        ok: false,
        error: `Failed to read ${label} at ${filePath}: ${formatError(error)}`,
      };
    }
  }

  async function markChecksFailed(
    milestoneId: number,
    message: string,
    details?: string | object | unknown[] | null,
  ): Promise<RunState> {
    const now = clock();
    let nextState = setStatePhase(state, "checks_failed", now);
    nextState = setMilestoneStatus(nextState, milestoneId, "checks_failed", now);
    nextState = {
      ...nextState,
      lastError: {
        message,
        phase: "checks_failed",
        occurredAt: now.toISOString(),
        ...(details === undefined ? {} : { details }),
      },
    };
    return persist(nextState);
  }

  async function loadCheckRepairContext(optionsForRepair: {
    metadata: MilestoneMetadata;
    activeMilestone: Milestone;
  }): Promise<
    | { ok: true; value: LoadedCheckRepairContext }
    | { ok: false; error: string; details?: object }
  > {
    const milestoneId = optionsForRepair.activeMilestone.id;
    const unmetDependencies = optionsForRepair.activeMilestone.dependencies.filter(
      (dependencyId) => state.milestoneStatuses[String(dependencyId)] !== "passed",
    );
    if (unmetDependencies.length > 0) {
      return {
        ok: false,
        error: `Cannot repair checks for milestone ${milestoneId} because dependencies are not passed: ${unmetDependencies.join(", ")}.`,
        details: { unmetDependencies },
      };
    }

    const milestonePaths = buildMilestoneArtifactPaths(options.paths, milestoneId);
    const milestonePlanPath =
      state.artifacts.milestonePlans?.[String(milestoneId)] ??
      milestonePaths.statePaths.milestonePlan;
    const milestonePlan = await readRequiredArtifact(
      state.artifacts.milestonePlans?.[String(milestoneId)],
      milestonePaths.files.milestonePlan,
      "milestone plan",
    );
    if (!milestonePlan.ok) return milestonePlan;

    const implementationReportPath =
      state.artifacts.implementations?.[String(milestoneId)] ??
      milestonePaths.statePaths.implementation;
    const implementationReport = await readRequiredArtifact(
      state.artifacts.implementations?.[String(milestoneId)],
      milestonePaths.files.implementation,
      "implementation report",
    );
    if (!implementationReport.ok) return implementationReport;

    const latestFailure = await readLatestCheckFailureSummary(milestoneId);
    if (!latestFailure.ok) return latestFailure;

    const latestDiffPath = selectLatestDiffArtifactPath(
      state,
      milestoneId,
      latestFailure.selection.stateKey,
    );
    if (latestDiffPath === null) {
      return {
        ok: false,
        error: `Cannot repair checks for milestone ${milestoneId} because no diff artifact exists.`,
      };
    }
    const latestDiff = await readRequiredRunArtifact(latestDiffPath, "latest diff");
    if (!latestDiff.ok) return latestDiff;

    const latestFailedCheckReport = await readRequiredRunArtifact(
      latestFailure.summary.fullCheckReportArtifactPath,
      "latest failed check report",
    );
    if (!latestFailedCheckReport.ok) return latestFailedCheckReport;

    const baseline = await resolveMilestoneBaseline({
      state,
      metadata: optionsForRepair.metadata,
      milestoneId,
      paths: options.paths,
      cwd: options.cwd,
      commandRunner: options.commandRunner,
    });
    if (!baseline.ok) {
      return {
        ok: false,
        error: baseline.error,
        ...(baseline.details === undefined ? {} : { details: baseline.details }),
      };
    }

    return {
      ok: true,
      value: {
        milestonePlan: milestonePlan.value,
        milestonePlanPath,
        implementationReport: implementationReport.value,
        implementationReportPath,
        latestDiff: latestDiff.value,
        latestDiffPath,
        latestFailedCheckReport: latestFailedCheckReport.value,
        latestFailedCheckReportPath: latestFailure.summary.fullCheckReportArtifactPath,
        checkFailureSummary: latestFailure.summary,
        checkFailureSummaryPath: latestFailure.selection.statePath,
        baselineTree: baseline.baselineTree,
      },
    };
  }

  async function loadManualRecheckContext(optionsForRecheck: {
    metadata: MilestoneMetadata;
    activeMilestone: Milestone;
  }): Promise<
    | { ok: true; value: LoadedManualRecheckContext }
    | { ok: false; error: string; details?: object }
  > {
    const milestoneId = optionsForRecheck.activeMilestone.id;
    const unmetDependencies = optionsForRecheck.activeMilestone.dependencies.filter(
      (dependencyId) => state.milestoneStatuses[String(dependencyId)] !== "passed",
    );
    if (unmetDependencies.length > 0) {
      return {
        ok: false,
        error: `Cannot recheck milestone ${milestoneId} because dependencies are not passed: ${unmetDependencies.join(", ")}.`,
        details: { unmetDependencies },
      };
    }

    const milestonePaths = buildMilestoneArtifactPaths(options.paths, milestoneId);
    const milestonePlanPath =
      state.artifacts.milestonePlans?.[String(milestoneId)] ??
      milestonePaths.statePaths.milestonePlan;
    const milestonePlan = await readRequiredArtifact(
      state.artifacts.milestonePlans?.[String(milestoneId)],
      milestonePaths.files.milestonePlan,
      "milestone plan",
    );
    if (!milestonePlan.ok) return milestonePlan;

    const implementationReportPath =
      state.artifacts.implementations?.[String(milestoneId)] ??
      milestonePaths.statePaths.implementation;
    const implementationReport = await readRequiredArtifact(
      state.artifacts.implementations?.[String(milestoneId)],
      milestonePaths.files.implementation,
      "implementation report",
    );
    if (!implementationReport.ok) return implementationReport;

    const originalFailedCheckReportPath = state.artifacts.checks?.[String(milestoneId)];
    if (!originalFailedCheckReportPath) {
      return {
        ok: false,
        error: `Cannot recheck milestone ${milestoneId} because no failed check artifact exists.`,
      };
    }
    const originalFailedCheckReport = await readRequiredRunArtifact(
      originalFailedCheckReportPath,
      "failed check report",
    );
    if (!originalFailedCheckReport.ok) return originalFailedCheckReport;

    const baseline = await resolveMilestoneBaseline({
      state,
      metadata: optionsForRecheck.metadata,
      milestoneId,
      paths: options.paths,
      cwd: options.cwd,
      commandRunner: options.commandRunner,
    });
    if (!baseline.ok) {
      return {
        ok: false,
        error: baseline.error,
        ...(baseline.details === undefined ? {} : { details: baseline.details }),
      };
    }

    return {
      ok: true,
      value: {
        milestonePlanPath,
        implementationReportPath,
        originalFailedCheckReportPath,
        baselineTree: baseline.baselineTree,
        baselineSource: baseline.source,
      },
    };
  }

  async function readLatestCheckFailureSummary(
    milestoneId: number,
  ): Promise<
    | {
        ok: true;
        selection: LatestCheckFailureSelection;
        summary: CheckFailureSummaryArtifact;
      }
    | { ok: false; error: string }
  > {
    const selection = selectLatestCheckFailureArtifact(state, milestoneId);
    if (selection === null) {
      return {
        ok: false,
        error: `Cannot repair checks for milestone ${milestoneId} because no check failure summary artifact exists.`,
      };
    }

    const raw = await readRequiredRunArtifact(
      selection.statePath,
      "check failure summary",
    );
    if (!raw.ok) return raw;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.value);
    } catch (error) {
      return {
        ok: false,
        error: `Failed to parse check failure summary at ${selection.statePath}: ${formatError(error)}`,
      };
    }

    const parsedSummary = parseCheckFailureSummaryArtifact(parsedJson);
    if (!parsedSummary.ok) {
      return {
        ok: false,
        error: `Invalid check failure summary at ${selection.statePath}: ${parsedSummary.error}`,
      };
    }

    return {
      ok: true,
      selection,
      summary: parsedSummary.value,
    };
  }

  async function ensureCheckFailureSummaryForRecovery(
    milestoneId: number,
  ): Promise<
    | {
        ok: true;
        stateKey: string;
        statePath: string;
        synthesized: boolean;
      }
    | { ok: false; result: ImplementationWorkflowResult }
  > {
    const existing = selectLatestCheckFailureArtifact(state, milestoneId);
    if (existing !== null) {
      return {
        ok: true,
        stateKey: existing.stateKey,
        statePath: existing.statePath,
        synthesized: false,
      };
    }

    const fullCheckReportArtifactPath =
      state.artifacts.checks?.[String(milestoneId)];
    if (!fullCheckReportArtifactPath) {
      return {
        ok: false,
        result: await fail(
          "repairing_checks",
          `Cannot repair checks for milestone ${milestoneId} because no check failure summary or failed check artifact exists.`,
        ),
      };
    }

    const fullCheckReport = await readRequiredRunArtifact(
      fullCheckReportArtifactPath,
      "legacy failed check report",
    );
    if (!fullCheckReport.ok) {
      return {
        ok: false,
        result: await fail("repairing_checks", fullCheckReport.error),
      };
    }

    const failureAttempt = nextCheckFailureAttempt(state, milestoneId);
    const checkFailurePath = buildCheckFailureArtifactPath(
      options.paths,
      milestoneId,
      failureAttempt,
    );
    const write = await writeCheckFailureSummary({
      phase: "repairing_checks",
      milestoneId,
      attempt: failureAttempt,
      stateKey: checkFailurePath.stateKey,
      file: checkFailurePath.file,
      statePath: checkFailurePath.statePath,
      fullCheckReportArtifactPath,
      result: {
        ok: false,
        report: fullCheckReport.value,
        results: [
          {
            command: `legacy failed check report artifact: ${fullCheckReportArtifactPath}`,
            exitCode: 1,
            stdout: fullCheckReport.value,
            stderr: "",
            durationMs: 0,
          },
        ],
      },
    });
    if (!write.ok) return write;

    return {
      ok: true,
      stateKey: write.stateKey,
      statePath: write.statePath,
      synthesized: true,
    };
  }

  async function readRequiredRunArtifact(
    statePath: string,
    label: string,
  ): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const resolvedPath = resolveRunArtifactPath(options.paths.runDir, statePath);
    if (!resolvedPath.ok) {
      return {
        ok: false,
        error: `Invalid ${label} artifact path ${statePath}: ${resolvedPath.error}`,
      };
    }

    try {
      return { ok: true, value: await readFile(resolvedPath.path, "utf8") };
    } catch (error) {
      return {
        ok: false,
        error: `Failed to read ${label} at ${resolvedPath.path}: ${formatError(error)}`,
      };
    }
  }

  async function writeInitialCheckFailureSummary(
    phase: OrchestratorPhase,
    milestoneId: number,
    fullCheckReportArtifactPath: string,
    result: CheckRunResult,
  ): Promise<
    | { ok: true; stateKey: string; statePath: string }
    | { ok: false; result: ImplementationWorkflowResult }
  > {
    const failureAttempt = nextCheckFailureAttempt(state, milestoneId);
    const checkFailurePath = buildCheckFailureArtifactPath(
      options.paths,
      milestoneId,
      failureAttempt,
    );
    return writeCheckFailureSummary({
      phase,
      milestoneId,
      attempt: failureAttempt,
      stateKey: checkFailurePath.stateKey,
      file: checkFailurePath.file,
      statePath: checkFailurePath.statePath,
      fullCheckReportArtifactPath,
      result,
    });
  }

  async function writeRepairCheckFailureSummary(
    phase: OrchestratorPhase,
    milestoneId: number,
    attempt: number,
    stateKey: string,
    file: string,
    statePath: string,
    fullCheckReportArtifactPath: string,
    result: CheckRunResult,
  ): Promise<
    | { ok: true; stateKey: string; statePath: string }
    | { ok: false; result: ImplementationWorkflowResult }
  > {
    return writeCheckFailureSummary({
      phase,
      milestoneId,
      attempt,
      stateKey,
      file,
      statePath,
      fullCheckReportArtifactPath,
      result,
    });
  }

  async function writeCheckFailureSummary(optionsForSummary: {
    phase: OrchestratorPhase;
    milestoneId: number;
    attempt: number;
    stateKey: string;
    file: string;
    statePath: string;
    fullCheckReportArtifactPath: string;
    result: CheckRunResult;
  }): Promise<
    | { ok: true; stateKey: string; statePath: string }
    | { ok: false; result: ImplementationWorkflowResult }
  > {
    const checkFailureSummary = buildCheckFailureSummaryArtifact({
      milestoneId: optionsForSummary.milestoneId,
      attempt: optionsForSummary.attempt,
      stateKey: optionsForSummary.stateKey,
      fullCheckReportArtifactPath: optionsForSummary.fullCheckReportArtifactPath,
      result: optionsForSummary.result,
      generatedAt: clock(),
    });
    const checkFailureWrite = await writeJsonArtifactOrFail(
      optionsForSummary.phase,
      optionsForSummary.file,
      checkFailureSummary,
      "check failure summary artifact",
    );
    if (!checkFailureWrite.ok) return checkFailureWrite;

    state = await persist(
      recordArtifactByKey(
        state,
        "checkFailures",
        optionsForSummary.stateKey,
        optionsForSummary.statePath,
        clock(),
      ),
    );

    return {
      ok: true,
      stateKey: optionsForSummary.stateKey,
      statePath: optionsForSummary.statePath,
    };
  }

  async function recordCompletedCheckFixAttempt(
    milestoneId: number,
    attempt: number,
  ): Promise<RunState> {
    state = await persist({
      ...state,
      checkFixAttempts: {
        ...state.checkFixAttempts,
        [String(milestoneId)]: attempt,
      },
      updatedAt: clock().toISOString(),
    });
    return state;
  }

  async function blockRecheckPromotion(
    milestoneId: number,
    message: string,
    details?: string | object | unknown[] | null,
  ): Promise<ImplementationWorkflowResult> {
    state = await markChecksFailed(milestoneId, message, details);
    return {
      ok: false,
      state,
      error: message,
    };
  }
}

function nextCheckFailureAttempt(state: RunState, milestoneId: number): number {
  const pattern = new RegExp(`^${milestoneId}-failed-(\\d+)$`);
  let highestAttempt = 0;

  for (const artifactKey of Object.keys(state.artifacts.checkFailures ?? {})) {
    const match = pattern.exec(artifactKey);
    if (!match) continue;

    highestAttempt = Math.max(highestAttempt, Number(match[1]));
  }

  return highestAttempt + 1;
}

function nextRecheckAttempt(state: RunState, milestoneId: number): number {
  const pattern = new RegExp(`^${milestoneId}-recheck-(\\d+)$`);
  let highestAttempt = 0;

  for (const artifacts of [
    state.artifacts.diffs,
    state.artifacts.checks,
    state.artifacts.checkFailures,
    state.artifacts.summaries,
  ]) {
    for (const artifactKey of Object.keys(artifacts ?? {})) {
      const match = pattern.exec(artifactKey);
      if (!match) continue;

      highestAttempt = Math.max(highestAttempt, Number(match[1]));
    }
  }

  return highestAttempt + 1;
}

function selectLatestCheckFailureArtifact(
  state: RunState,
  milestoneId: number,
): LatestCheckFailureSelection | null {
  const lastErrorSelection = selectLastErrorCheckFailureArtifact(state, milestoneId);
  if (lastErrorSelection) return lastErrorSelection;

  const pattern = new RegExp(`^${milestoneId}-(failed|repair|recheck)-(\\d+)$`);
  let latest: LatestCheckFailureSelection | null = null;

  for (const [stateKey, statePath] of Object.entries(state.artifacts.checkFailures ?? {})) {
    const match = pattern.exec(stateKey);
    if (!match) continue;

    const source = match[1] as LatestCheckFailureSelection["source"];
    const attempt = Number(match[2]);
    if (!Number.isInteger(attempt) || attempt < 1) continue;

    const candidate: LatestCheckFailureSelection = {
      stateKey,
      statePath,
      source,
      attempt,
    };
    if (
      latest === null ||
      checkFailureSelectionRank(candidate) > checkFailureSelectionRank(latest)
    ) {
      latest = candidate;
    }
  }

  return latest;
}

function selectLastErrorCheckFailureArtifact(
  state: RunState,
  milestoneId: number,
): LatestCheckFailureSelection | null {
  const statePath = lastErrorCheckFailurePath(state);
  if (!statePath) return null;

  for (const [stateKey, artifactPath] of Object.entries(state.artifacts.checkFailures ?? {})) {
    if (artifactPath !== statePath) continue;

    const parsed = parseCheckFailureArtifactKey(milestoneId, stateKey);
    if (!parsed) continue;

    return {
      stateKey,
      statePath: artifactPath,
      source: parsed.source,
      attempt: parsed.attempt,
    };
  }

  return null;
}

function lastErrorCheckFailurePath(state: RunState): string | null {
  const details = state.lastError?.details;
  if (!isRecord(details)) return null;

  if (typeof details.checkFailureSummary === "string") {
    return details.checkFailureSummary;
  }

  if (typeof details.latestCheckFailureSummary === "string") {
    return details.latestCheckFailureSummary;
  }

  return null;
}

function parseCheckFailureArtifactKey(
  milestoneId: number,
  stateKey: string,
): { source: LatestCheckFailureSelection["source"]; attempt: number } | null {
  const match = new RegExp(`^${milestoneId}-(failed|repair|recheck)-(\\d+)$`).exec(stateKey);
  if (!match) return null;

  const attempt = Number(match[2]);
  if (!Number.isInteger(attempt) || attempt < 1) return null;

  return {
    source: match[1] as LatestCheckFailureSelection["source"],
    attempt,
  };
}

function selectLatestDiffArtifactPath(
  state: RunState,
  milestoneId: number,
  latestCheckFailureStateKey: string,
): string | null {
  return (
    state.artifacts.diffs?.[latestCheckFailureStateKey] ??
    state.artifacts.diffs?.[String(milestoneId)] ??
    null
  );
}

function checkFailureSelectionRank(selection: LatestCheckFailureSelection): number {
  const sourceRank = {
    failed: 0,
    repair: 1,
    recheck: 2,
  }[selection.source];

  return sourceRank * 1_000_000 + selection.attempt;
}

function validateCheckRepairResumeState(
  state: RunState,
): { ok: true; milestoneId: number } | { ok: false; error: string } {
  if (state.currentMilestoneId === null) {
    return {
      ok: false,
      error: "Check repair recovery requires currentMilestoneId.",
    };
  }

  const milestoneStatus = state.milestoneStatuses[String(state.currentMilestoneId)];
  if (
    state.currentPhase === "checks_failed" &&
    state.status === "checks_failed" &&
    milestoneStatus === "checks_failed"
  ) {
    return { ok: true, milestoneId: state.currentMilestoneId };
  }

  if (
    state.currentPhase === "checking" &&
    state.status === "failed" &&
    (milestoneStatus === "failed" ||
      milestoneStatus === "checking" ||
      milestoneStatus === "checks_failed")
  ) {
    return { ok: true, milestoneId: state.currentMilestoneId };
  }

  if (
    state.currentPhase === "failed" &&
    state.status === "failed" &&
    milestoneStatus === "failed" &&
    hasTerminalCheckFailureEvidence(state, state.currentMilestoneId)
  ) {
    return { ok: true, milestoneId: state.currentMilestoneId };
  }

  return {
    ok: false,
    error: `Check repair recovery requires checks_failed, legacy failed-check, or terminal failed-check state, got phase ${state.currentPhase}, status ${state.status}, milestone status ${milestoneStatus ?? "missing"}.`,
  };
}

function validateCheckRecheckResumeState(
  state: RunState,
): { ok: true; milestoneId: number } | { ok: false; error: string } {
  if (state.currentMilestoneId === null) {
    return {
      ok: false,
      error: "Manual recheck recovery requires currentMilestoneId.",
    };
  }

  const milestoneStatus = state.milestoneStatuses[String(state.currentMilestoneId)];
  if (
    state.currentPhase === "checks_failed" &&
    state.status === "checks_failed" &&
    milestoneStatus === "checks_failed"
  ) {
    return { ok: true, milestoneId: state.currentMilestoneId };
  }

  if (
    state.currentPhase === "checking" &&
    state.status === "failed" &&
    (milestoneStatus === "failed" ||
      milestoneStatus === "checking" ||
      milestoneStatus === "checks_failed")
  ) {
    return { ok: true, milestoneId: state.currentMilestoneId };
  }

  if (
    state.currentPhase === "failed" &&
    state.status === "failed" &&
    milestoneStatus === "failed" &&
    hasTerminalCheckFailureEvidence(state, state.currentMilestoneId)
  ) {
    return { ok: true, milestoneId: state.currentMilestoneId };
  }

  return {
    ok: false,
    error: `Manual recheck recovery requires checks_failed, legacy failed-check, or terminal failed-check state, got phase ${state.currentPhase}, status ${state.status}, milestone status ${milestoneStatus ?? "missing"}.`,
  };
}

function hasTerminalCheckFailureEvidence(
  state: RunState,
  milestoneId: number,
): boolean {
  if (hasCheckFailureArtifactForMilestone(state, milestoneId)) return true;

  const details = state.lastError?.details;
  if (!isRecord(details)) return false;

  return (
    typeof details.checkFailureSummary === "string" ||
    typeof details.latestCheckFailureSummary === "string"
  );
}

function hasCheckFailureArtifactForMilestone(
  state: RunState,
  milestoneId: number,
): boolean {
  const pattern = new RegExp(`^${milestoneId}-(failed|repair|recheck)-\\d+$`);
  return Object.keys(state.artifacts.checkFailures ?? {}).some((artifactKey) =>
    pattern.test(artifactKey),
  );
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
    `Milestone ${options.milestone.id} must review the diff and decide whether fixes are required.`,
  ].join("\n");
}

function formatMilestoneRecheckSummary(options: {
  milestone: Milestone;
  milestonePlan: string;
  implementation: string;
  diff: string;
  checks: string;
  originalFailedChecks: string;
  recheckAttempt: number;
  checkCount: number;
  promoted: boolean;
  baselineSource: "stored" | "reconstructed";
}): string {
  return [
    `# Milestone ${options.milestone.id} Recheck Summary`,
    "",
    `Status: ${options.promoted ? "ready_for_review" : "checks_failed"}`,
    `Title: ${options.milestone.title}`,
    `Recheck attempt: ${options.recheckAttempt}`,
    `Promoted: ${options.promoted ? "yes" : "no"}`,
    `Baseline source: ${options.baselineSource}`,
    "",
    "## Reconciliation",
    "",
    "The implementation runner reconciled the current worktree against the milestone baseline and captured a fresh reviewable diff.",
    "",
    "## Artifacts",
    "",
    `- Plan: ${options.milestonePlan}`,
    `- Implementation: ${options.implementation}`,
    `- Original failed checks: ${options.originalFailedChecks}`,
    `- Recheck diff: ${options.diff}`,
    `- Recheck checks: ${options.checks}`,
    "",
    "## Verification",
    "",
    `Configured checks ${options.promoted ? "passed" : "failed"}: ${options.checkCount}`,
    "",
    "## Remaining",
    "",
    options.promoted
      ? `Milestone ${options.milestone.id} must review the reconciled diff and decide whether fixes are required.`
      : `Milestone ${options.milestone.id} remains blocked until checks pass.`,
  ].join("\n");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withDiagnosticArtifact<T extends object>(
  details: T,
  diagnosticArtifact: string | undefined,
): T & { diagnosticArtifact?: string } {
  return diagnosticArtifact === undefined
    ? details
    : { ...details, diagnosticArtifact };
}
