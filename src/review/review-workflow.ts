import { readFile } from "node:fs/promises";

import { buildMilestoneArtifactPaths } from "../artifacts/milestone-artifacts.js";
import { resolveRunArtifactPath } from "../artifacts/paths.js";
import { buildPlanningArtifactPaths, writeJsonArtifact, writeTextArtifact } from "../artifacts/planning-artifacts.js";
import {
  buildBaseMalformedReviewArtifactPath,
  buildBaseReviewArtifactPaths,
  buildBaseReviewRepairArtifactPath,
  buildBaseReviewResolutionArtifactPath,
  buildFixAttemptArtifactPaths,
  buildFixAttemptMalformedReviewArtifactPath,
  buildFixAttemptReviewRepairArtifactPath,
  buildFixAttemptReviewResolutionArtifactPath,
  type ReviewDiagnosticArtifactPath,
} from "../artifacts/review-artifacts.js";
import { runChecks } from "../checks/check-runner.js";
import { captureGitDiff } from "../git/git-diff.js";
import type { Milestone, MilestoneMetadata } from "../milestones/milestone-types.js";
import { parseMilestoneMetadataJson } from "../milestones/milestone-validator.js";
import {
  isFailFastHumanReviewPolicy,
  shouldAttemptAutonomousResolution,
  terminalPhaseForUnresolvedHumanReview,
} from "../orchestration/human-review-policy.js";
import { loadPrompt } from "../prompts/prompt-loader.js";
import { renderPrompt, type PromptVariables } from "../prompts/prompt-renderer.js";
import type { AgentRunResult } from "../runners/agent-runner.js";
import { resolveOutputSchemaPathForPhase } from "../runners/output-schema.js";
import { runAgentPhaseWithDiagnostics } from "../runners/runner-diagnostics.js";
import { writeState } from "../state/state-store.js";
import {
  failState,
  recordArtifactByKey,
  setMilestoneStatus,
  setStatePhase,
} from "../state/state-transitions.js";
import type { OrchestratorPhase, RunState } from "../state/state-types.js";
import { appendStateTimelineEvent } from "../timings/state-timeline.js";
import {
  parseReviewVerdictJson,
} from "./review-verdict-validator.js";
import { parseReviewResolutionJson } from "./review-resolution-validator.js";
import { buildReviewEvidence } from "./review-evidence.js";
import type {
  ReviewRunnerPhase,
  ReviewFinding,
  ReviewResolutionDocument,
  ReviewVerdict,
  ReviewVerdictDocument,
  ReviewWorkflowOptions,
  ReviewWorkflowResult,
} from "./review-types.js";

const reviewRepairAttemptLimit = 2;
const reviewResolutionAttemptLimit = 2;
const reviewVerdictSchemaContract = [
  "Return a JSON object with exactly these root fields:",
  '- verdict: one of "pass", "fail", or "needs_human_review"',
  "- summary: non-empty string",
  "- findings: array of finding objects",
  "- reviewedArtifacts: non-empty array of unique artifact path strings",
  "",
  "Each finding object must have exactly:",
  '- severity: one of "high", "medium", or "low"',
  "- file: string or null",
  "- issue: non-empty string",
  "- suggestedFix: non-empty string",
  "- blocking: boolean",
  "",
  "A pass verdict cannot include blocking findings.",
].join("\n");
const reviewResolutionSchemaContract = [
  "Return a JSON object with exactly these root fields:",
  "- resolution: object",
  "- verdict: strict review verdict object",
  "",
  "resolution must have exactly:",
  "- summary: non-empty string",
  "- rationale: non-empty string",
  "- assumptions: array of non-empty strings",
  "- sourceCondition: non-empty string",
  "",
  "verdict must match schemas/review-verdict.schema.json.",
].join("\n");

interface ReviewOutputHandlingOptions {
  rawOutput: string;
  malformedSummary: string;
  malformedMessage: string;
  reviewedArtifacts: string[];
  finalReviewFile: string;
  finalReviewStatePath: string;
  finalReviewStateKey: string;
  malformedArtifactPath: ReviewDiagnosticArtifactPath;
  repairArtifactPathForAttempt: (repairAttempt: number) => ReviewDiagnosticArtifactPath;
  reviewRound: string;
  latestDiff: string;
  latestDiffPath: string;
  latestChecks: string;
  latestChecksPath: string;
  latestChecksPassed: boolean;
  reviewEvidence: string;
  reviewEvidencePath: string;
  fixPath?: string;
}

type ReviewOutputHandlingResult =
  | { ok: true; value: ReviewVerdictDocument }
  | { ok: false; result: ReviewWorkflowResult };

interface ReviewDecision {
  verdict: ReviewVerdictDocument;
  reviewPath: string;
  resolution?: ReviewResolutionDocument;
}

interface ReviewDecisionContext {
  decision: ReviewDecision;
  reviewedArtifacts: string[];
  latestDiff: string;
  latestDiffPath: string;
  latestChecks: string;
  latestChecksPath: string;
  latestChecksPassed: boolean;
  reviewEvidence: string;
  reviewEvidencePath: string;
  reviewRound: string;
  resolutionArtifactPathForAttempt: (resolutionAttempt: number) => ReviewDiagnosticArtifactPath;
  fixPath?: string;
  passWithFailedChecksMode: "terminal" | "defer";
}

interface ReviewEquivalentContext extends ReviewDecisionContext {
  sourceVerdict: ReviewVerdictDocument;
  sourceCondition: string;
  reason: string;
  allowedResolvedVerdicts?: Exclude<ReviewVerdict, "needs_human_review">[];
}

type ReviewDecisionHandlingResult =
  | { ok: true; value: ReviewDecision }
  | { ok: false; result: ReviewWorkflowResult };

export async function runReviewWorkflow(
  options: ReviewWorkflowOptions,
): Promise<ReviewWorkflowResult> {
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
  ): Promise<ReviewWorkflowResult> {
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

  async function needsHumanReview(
    message: string,
    details?: string | object | unknown[] | null,
  ): Promise<RunState> {
    const now = clock();
    let nextState = setStatePhase(state, "needs_human_review", now);
    if (activeMilestoneId !== null) {
      nextState = setMilestoneStatus(nextState, activeMilestoneId, "needs_human_review", now);
    }
    nextState = {
      ...nextState,
      lastError: {
        message,
        phase: "needs_human_review",
        occurredAt: now.toISOString(),
        ...(details === undefined ? {} : { details }),
      },
    };
    state = await persist(nextState);
    return state;
  }

  async function passMilestone(): Promise<RunState> {
    const now = clock();
    let nextState = setStatePhase(state, "passed", now);
    if (activeMilestoneId !== null) {
      nextState = setMilestoneStatus(nextState, activeMilestoneId, "passed", now);
    }
    nextState = {
      ...nextState,
      lastError: null,
    };
    state = await persist(nextState);
    return state;
  }

  const preflight = validateReadyState(state);
  if (!preflight.ok) return fail("reviewing", preflight.error);

  activeMilestoneId = preflight.milestoneId;
  const milestonePaths = buildMilestoneArtifactPaths(options.paths, activeMilestoneId);
  const planningPaths = buildPlanningArtifactPaths(options.paths);
  const reviewPaths = buildBaseReviewArtifactPaths(options.paths, activeMilestoneId);

  const metadataResult = await readMilestoneMetadata(planningPaths.files.milestones);
  if (!metadataResult.ok) return fail("reviewing", metadataResult.error);
  const metadata = metadataResult.value;

  const activeMilestone = metadata.milestones.find(
    (milestone) => milestone.id === activeMilestoneId,
  );
  if (!activeMilestone) {
    return fail("reviewing", `Active milestone ${activeMilestoneId} was not found.`);
  }
  const reviewedMilestone = activeMilestone;

  const finalMajorPlan = await readRequiredArtifact(
    state.artifacts.finalMajorPlanMarkdown,
    planningPaths.files.finalMajorPlanMarkdown,
    "final major plan",
  );
  if (!finalMajorPlan.ok) return fail("reviewing", finalMajorPlan.error);
  const finalMajorPlanText = finalMajorPlan.value;

  const milestonePlan = await readRequiredArtifact(
    state.artifacts.milestonePlans?.[String(activeMilestoneId)],
    milestonePaths.files.milestonePlan,
    "milestone plan",
  );
  if (!milestonePlan.ok) return fail("reviewing", milestonePlan.error);
  const milestonePlanText = milestonePlan.value;

  const implementationReport = await readRequiredArtifact(
    state.artifacts.implementations?.[String(activeMilestoneId)],
    milestonePaths.files.implementation,
    "implementation report",
  );
  if (!implementationReport.ok) return fail("reviewing", implementationReport.error);
  const implementationReportText = implementationReport.value;

  const diff = await readRequiredArtifact(
    state.artifacts.diffs?.[String(activeMilestoneId)],
    milestonePaths.files.diff,
    "milestone diff",
  );
  if (!diff.ok) return fail("reviewing", diff.error);

  const checks = await readRequiredArtifact(
    state.artifacts.checks?.[String(activeMilestoneId)],
    milestonePaths.files.checks,
    "check output",
  );
  if (!checks.ok) return fail("reviewing", checks.error);

  let latestDiff = diff.value;
  let latestDiffPath =
    state.artifacts.diffs?.[String(activeMilestoneId)] ?? milestonePaths.statePaths.diff;
  let latestChecks = checks.value;
  let latestChecksPath =
    state.artifacts.checks?.[String(activeMilestoneId)] ?? milestonePaths.statePaths.checks;
  let latestChecksPassed = checkReportPassed(latestChecks);

  state = await persist(setStatePhase(state, "reviewing", clock()));
  state = await persist(setMilestoneStatus(state, activeMilestoneId, "reviewing", clock()));

  const evidence = await writeReviewEvidenceArtifactOrFail({
    filePath: reviewPaths.files.evidence,
    statePath: reviewPaths.statePaths.evidence,
    stateKey: reviewPaths.stateKeys.evidence,
    diff: latestDiff,
    reviewRound: { kind: "base" },
  });
  if (!evidence.ok) return evidence.result;

  const reviewedArtifacts = [
    state.artifacts.finalMajorPlanMarkdown ?? planningPaths.statePaths.finalMajorPlanMarkdown,
    state.artifacts.milestonePlans?.[String(activeMilestoneId)] ?? milestonePaths.statePaths.milestonePlan,
    state.artifacts.implementations?.[String(activeMilestoneId)] ?? milestonePaths.statePaths.implementation,
    latestDiffPath,
    latestChecksPath,
    reviewPaths.statePaths.evidence,
  ];

  const prompt = await renderLoadedPrompt("review-milestone", {
    goal: options.goal,
    finalMajorPlan: finalMajorPlanText,
    activeMilestone,
    milestonePlan: milestonePlanText,
    implementationReport: implementationReportText,
    diff: latestDiff,
    checks: latestChecks,
    latestChecksPassed,
    reviewEvidence: evidence.value,
    reviewedArtifacts,
    state,
  });
  if (!prompt.ok) return fail("reviewing", prompt.error);

  const review = await runPhase("review_milestone", prompt.value, {
    finalMajorPlan: reviewedArtifacts[0] ?? planningPaths.statePaths.finalMajorPlanMarkdown,
    milestonePlan: reviewedArtifacts[1] ?? milestonePaths.statePaths.milestonePlan,
    implementation: reviewedArtifacts[2] ?? milestonePaths.statePaths.implementation,
    diff: latestDiffPath,
    checks: latestChecksPath,
    reviewEvidence: reviewPaths.statePaths.evidence,
  });
  if (!review.ok) return fail("reviewing", review.error, review.details);

  const verdictResult = await parseReviewOutputOrHandleMalformed({
    rawOutput: review.value,
    malformedSummary: "Review output could not be parsed or validated.",
    malformedMessage: "Review verdict was malformed.",
    reviewedArtifacts,
    finalReviewFile: reviewPaths.files.review,
    finalReviewStatePath: reviewPaths.statePaths.review,
    finalReviewStateKey: reviewPaths.stateKeys.review,
    malformedArtifactPath: buildBaseMalformedReviewArtifactPath(
      options.paths,
      activeMilestoneId,
    ),
    repairArtifactPathForAttempt: (repairAttempt) =>
      buildBaseReviewRepairArtifactPath(options.paths, activeMilestoneId, repairAttempt),
    reviewRound: "base",
    latestDiff,
    latestDiffPath,
    latestChecks,
    latestChecksPath,
    latestChecksPassed,
    reviewEvidence: evidence.value,
    reviewEvidencePath: reviewPaths.statePaths.evidence,
  });
  if (!verdictResult.ok) return verdictResult.result;
  const verdict = verdictResult.value;

  const reviewWrite = await writeJsonArtifactOrFail(
    "reviewing",
    reviewPaths.files.review,
    verdict,
    "review artifact",
  );
  if (!reviewWrite.ok) return reviewWrite.result;

  state = await persist(
    recordArtifactByKey(
      state,
      "reviews",
      reviewPaths.stateKeys.review,
      reviewPaths.statePaths.review,
      clock(),
    ),
  );

  const baseDecisionResult = await normalizeReviewDecision({
    decision: {
      verdict,
      reviewPath: reviewPaths.statePaths.review,
    },
    reviewedArtifacts,
    latestDiff,
    latestDiffPath,
    latestChecks,
    latestChecksPath,
    latestChecksPassed,
    reviewEvidence: evidence.value,
    reviewEvidencePath: reviewPaths.statePaths.evidence,
    reviewRound: "base",
    resolutionArtifactPathForAttempt: (resolutionAttempt) =>
      buildBaseReviewResolutionArtifactPath(options.paths, activeMilestoneId, resolutionAttempt),
    passWithFailedChecksMode: "terminal",
  });
  if (!baseDecisionResult.ok) return baseDecisionResult.result;
  const baseDecision = baseDecisionResult.value;
  const acceptedVerdict = baseDecision.verdict;

  if (acceptedVerdict.verdict === "pass") {
    if (!latestChecksPassed) {
      return finishUnresolvedReviewEquivalent({
        summary: acceptedVerdict.summary,
        reviewPath: baseDecision.reviewPath,
        checksPassed: latestChecksPassed,
        message: "Review passed but latest deterministic checks failed.",
        details: {
          review: baseDecision.reviewPath,
          checks: latestChecksPath,
        },
        resolution: baseDecision.resolution,
      });
    }

    const summaryResult = await writeFinalSummary(
      "pass",
      acceptedVerdict.summary,
      baseDecision.reviewPath,
      latestChecksPassed,
      undefined,
      baseDecision.resolution,
    );
    if (!summaryResult.ok) return summaryResult.result;
    state = await passMilestone();
    return {
      ok: true,
      state,
      metadata,
      milestoneId: activeMilestoneId,
      verdict: "pass",
    };
  }

  if (acceptedVerdict.verdict === "needs_human_review") {
    return finishUnresolvedReviewEquivalent({
      summary: acceptedVerdict.summary,
      reviewPath: baseDecision.reviewPath,
      checksPassed: latestChecksPassed,
      message: acceptedVerdict.summary,
      details: {
        review: baseDecision.reviewPath,
        findings: acceptedVerdict.findings,
      },
      resolution: baseDecision.resolution,
    });
  }

  const blockingFindings = acceptedVerdict.findings.filter((finding) => finding.blocking);
  if (blockingFindings.length === 0) {
    return finishUnresolvedReviewEquivalent({
      summary: acceptedVerdict.summary,
      reviewPath: baseDecision.reviewPath,
      checksPassed: latestChecksPassed,
      message: "Review failed without blocking findings that can be fixed automatically.",
      details: {
        review: baseDecision.reviewPath,
        findings: acceptedVerdict.findings,
      },
      resolution: baseDecision.resolution,
    });
  }

  if (options.config.maxFixAttempts === 0) {
    return finishUnresolvedReviewEquivalent({
      summary: acceptedVerdict.summary,
      reviewPath: baseDecision.reviewPath,
      checksPassed: latestChecksPassed,
      message: "Review failed with blocking findings, but maxFixAttempts is 0.",
      details: {
        review: baseDecision.reviewPath,
        findings: blockingFindings,
      },
      resolution: baseDecision.resolution,
    });
  }

  let latestReviewVerdict = acceptedVerdict;
  let latestReviewPath = baseDecision.reviewPath;
  let latestReviewResolution = baseDecision.resolution;
  let latestReviewEvidence = evidence.value;
  let latestReviewEvidencePath = reviewPaths.statePaths.evidence;
  let latestBlockingFindings = blockingFindings;

  while (latestBlockingFindings.length > 0) {
    const completedAttempts = state.fixAttempts[String(activeMilestoneId)] ?? 0;
    if (completedAttempts >= options.config.maxFixAttempts) {
      const exhaustedMessage = `Max fix attempts exhausted after ${completedAttempts} attempt(s).`;
      if (
        latestChecksPassed &&
        shouldAttemptAutonomousResolution(options.config.humanReviewPolicy)
      ) {
        const resolutionResult = await resolveReviewAmbiguity({
          decision: {
            verdict: latestReviewVerdict,
            reviewPath: latestReviewPath,
            ...(latestReviewResolution === undefined
              ? {}
              : { resolution: latestReviewResolution }),
          },
          sourceVerdict: latestReviewVerdict,
          sourceCondition: "max_fix_attempts_exhausted",
          reason: exhaustedMessage,
          reviewedArtifacts: mergeUniqueStrings([
            ...latestReviewVerdict.reviewedArtifacts,
            latestReviewPath,
            latestChecksPath,
          ]),
          latestDiff,
          latestDiffPath,
          latestChecks,
          latestChecksPath,
          latestChecksPassed,
          reviewEvidence: latestReviewEvidence,
          reviewEvidencePath: latestReviewEvidencePath,
          reviewRound: `fix ${completedAttempts}`,
          resolutionArtifactPathForAttempt: (resolutionAttempt) =>
            buildFixAttemptReviewResolutionArtifactPath(
              options.paths,
              activeMilestoneId,
              completedAttempts,
              resolutionAttempt,
            ),
          passWithFailedChecksMode: "terminal",
          allowedResolvedVerdicts: ["pass"],
        });
        if (!resolutionResult.ok) return resolutionResult.result;

        const resolvedDecision = resolutionResult.value;
        const summaryResult = await writeFinalSummary(
          "pass",
          resolvedDecision.verdict.summary,
          resolvedDecision.reviewPath,
          latestChecksPassed,
          undefined,
          resolvedDecision.resolution,
        );
        if (!summaryResult.ok) return summaryResult.result;
        state = await passMilestone();
        return {
          ok: true,
          state,
          metadata,
          milestoneId: activeMilestoneId,
          verdict: "pass",
        };
      }

      return finishUnresolvedReviewEquivalent({
        summary: latestReviewVerdict.summary,
        reviewPath: latestReviewPath,
        checksPassed: latestChecksPassed,
        message: exhaustedMessage,
        details: {
          review: latestReviewPath,
          findings: latestBlockingFindings,
          attempts: completedAttempts,
        },
        resolution: latestReviewResolution,
      });
    }

    const attempt = completedAttempts + 1;
    const fixPaths = buildFixAttemptArtifactPaths(options.paths, activeMilestoneId, attempt);

    state = await persist(setStatePhase(state, "fixing", clock()));
    state = await persist(setMilestoneStatus(state, activeMilestoneId, "fixing", clock()));

    const fixPrompt = await renderLoadedPrompt("fix-review-findings", {
      goal: options.goal,
      activeMilestone,
      blockingFindings: latestBlockingFindings,
      reviewVerdict: latestReviewVerdict,
      latestDiff,
      latestChecks,
      state,
    });
    if (!fixPrompt.ok) return fail("fixing", fixPrompt.error);

    const fix = await runPhase("fix_review_findings", fixPrompt.value, {
      review: latestReviewPath,
      diff: latestDiffPath,
      checks: latestChecksPath,
    });
    if (!fix.ok) return fail("fixing", fix.error, fix.details);

    const fixWrite = await writeTextArtifactOrFail(
      "fixing",
      fixPaths.files.fix,
      fix.value,
      "fix attempt artifact",
    );
    if (!fixWrite.ok) return fixWrite.result;
    state = await persist(
      recordArtifactByKey(
        state,
        "fixes",
        fixPaths.stateKey,
        fixPaths.statePaths.fix,
        clock(),
      ),
    );
    state = await recordCompletedFixAttempt(attempt);

    const diffResult = await captureGitDiff({
      cwd: options.cwd,
      commandRunner: options.commandRunner,
      excludedPaths: [options.paths.runDir],
    });
    if (!diffResult.ok) return fail("fixing", diffResult.error, diffResult.details);
    latestDiff = diffResult.diff;
    latestDiffPath = fixPaths.statePaths.diff;

    const diffWrite = await writeTextArtifactOrFail(
      "fixing",
      fixPaths.files.diff,
      latestDiff,
      "post-fix diff artifact",
    );
    if (!diffWrite.ok) return diffWrite.result;
    state = await persist(
      recordArtifactByKey(
        state,
        "diffs",
        fixPaths.stateKey,
        latestDiffPath,
        clock(),
      ),
    );

    state = await persist(setStatePhase(state, "checking", clock()));
    state = await persist(setMilestoneStatus(state, activeMilestoneId, "checking", clock()));

    const checkResult = await runChecks({
      checks: options.config.checks,
      cwd: options.cwd,
      commandRunner: options.commandRunner,
    });
    latestChecks = checkResult.report;
    latestChecksPath = fixPaths.statePaths.checks;
    latestChecksPassed = checkResult.ok;
    options.checkTimingCollector?.recordCheckRun({
      stateKey: fixPaths.stateKey,
      milestoneId: activeMilestoneId,
      attempt,
      artifactPath: latestChecksPath,
      result: checkResult,
    });

    const checksWrite = await writeTextArtifactOrFail(
      "checking",
      fixPaths.files.checks,
      latestChecks,
      "post-fix checks artifact",
    );
    if (!checksWrite.ok) return checksWrite.result;
    state = await persist(
      recordArtifactByKey(
        state,
        "checks",
        fixPaths.stateKey,
        latestChecksPath,
        clock(),
      ),
    );

    state = await persist(setStatePhase(state, "reviewing", clock()));
    state = await persist(setMilestoneStatus(state, activeMilestoneId, "reviewing", clock()));

    const postFixEvidence = await writeReviewEvidenceArtifactOrFail({
      filePath: fixPaths.files.evidence,
      statePath: fixPaths.statePaths.evidence,
      stateKey: fixPaths.stateKeys.evidence,
      diff: latestDiff,
      reviewRound: { kind: "fix", attempt },
    });
    if (!postFixEvidence.ok) return postFixEvidence.result;
    latestReviewEvidence = postFixEvidence.value;
    latestReviewEvidencePath = fixPaths.statePaths.evidence;

    const postFixReviewedArtifacts = [
      state.artifacts.finalMajorPlanMarkdown ?? planningPaths.statePaths.finalMajorPlanMarkdown,
      state.artifacts.milestonePlans?.[String(activeMilestoneId)] ?? milestonePaths.statePaths.milestonePlan,
      state.artifacts.implementations?.[String(activeMilestoneId)] ?? milestonePaths.statePaths.implementation,
      latestDiffPath,
      latestChecksPath,
      fixPaths.statePaths.fix,
      fixPaths.statePaths.evidence,
    ];
    const postFixPrompt = await renderLoadedPrompt("review-milestone", {
      goal: options.goal,
      finalMajorPlan: finalMajorPlanText,
      activeMilestone,
      milestonePlan: milestonePlanText,
      implementationReport: implementationReportText,
      diff: latestDiff,
      checks: latestChecks,
      latestChecksPassed,
      reviewEvidence: postFixEvidence.value,
      reviewedArtifacts: postFixReviewedArtifacts,
      state,
    });
    if (!postFixPrompt.ok) return fail("reviewing", postFixPrompt.error);

    const postFixReview = await runPhase("review_milestone", postFixPrompt.value, {
      finalMajorPlan: postFixReviewedArtifacts[0] ?? planningPaths.statePaths.finalMajorPlanMarkdown,
      milestonePlan: postFixReviewedArtifacts[1] ?? milestonePaths.statePaths.milestonePlan,
      implementation: postFixReviewedArtifacts[2] ?? milestonePaths.statePaths.implementation,
      diff: latestDiffPath,
      checks: latestChecksPath,
      fix: fixPaths.statePaths.fix,
      reviewEvidence: fixPaths.statePaths.evidence,
    });
    if (!postFixReview.ok) return fail("reviewing", postFixReview.error, postFixReview.details);

    latestReviewPath = fixPaths.statePaths.review;
    const postFixVerdictResult = await parseReviewOutputOrHandleMalformed({
      rawOutput: postFixReview.value,
      malformedSummary: "Post-fix review output could not be parsed or validated.",
      malformedMessage: "Post-fix review verdict was malformed.",
      reviewedArtifacts: postFixReviewedArtifacts,
      finalReviewFile: fixPaths.files.review,
      finalReviewStatePath: latestReviewPath,
      finalReviewStateKey: fixPaths.stateKey,
      malformedArtifactPath: buildFixAttemptMalformedReviewArtifactPath(
        options.paths,
        activeMilestoneId,
        attempt,
      ),
      repairArtifactPathForAttempt: (repairAttempt) =>
        buildFixAttemptReviewRepairArtifactPath(
          options.paths,
          activeMilestoneId,
          attempt,
          repairAttempt,
        ),
      reviewRound: `fix ${attempt}`,
      latestDiff,
      latestDiffPath,
      latestChecks,
      latestChecksPath,
      latestChecksPassed,
      reviewEvidence: postFixEvidence.value,
      reviewEvidencePath: fixPaths.statePaths.evidence,
      fixPath: fixPaths.statePaths.fix,
    });
    if (!postFixVerdictResult.ok) return postFixVerdictResult.result;

    latestReviewVerdict = postFixVerdictResult.value;
    const postFixReviewWrite = await writeJsonArtifactOrFail(
      "reviewing",
      fixPaths.files.review,
      latestReviewVerdict,
      "post-fix review artifact",
    );
    if (!postFixReviewWrite.ok) return postFixReviewWrite.result;
    state = await persist(
      recordArtifactByKey(
        state,
        "reviews",
        fixPaths.stateKey,
        latestReviewPath,
        clock(),
      ),
    );

    const postFixDecisionResult = await normalizeReviewDecision({
      decision: {
        verdict: latestReviewVerdict,
        reviewPath: latestReviewPath,
      },
      reviewedArtifacts: postFixReviewedArtifacts,
      latestDiff,
      latestDiffPath,
      latestChecks,
      latestChecksPath,
      latestChecksPassed,
      reviewEvidence: postFixEvidence.value,
      reviewEvidencePath: fixPaths.statePaths.evidence,
      reviewRound: `fix ${attempt}`,
      resolutionArtifactPathForAttempt: (resolutionAttempt) =>
        buildFixAttemptReviewResolutionArtifactPath(
          options.paths,
          activeMilestoneId,
          attempt,
          resolutionAttempt,
        ),
      fixPath: fixPaths.statePaths.fix,
      passWithFailedChecksMode: "defer",
    });
    if (!postFixDecisionResult.ok) return postFixDecisionResult.result;
    latestReviewVerdict = postFixDecisionResult.value.verdict;
    latestReviewPath = postFixDecisionResult.value.reviewPath;
    latestReviewResolution = postFixDecisionResult.value.resolution;

    if (latestReviewVerdict.verdict === "pass") {
      if (!latestChecksPassed) {
        latestBlockingFindings = [
          failedChecksFinding(latestChecksPath),
        ];
        continue;
      }

      const summaryResult = await writeFinalSummary(
        "pass",
        latestReviewVerdict.summary,
        latestReviewPath,
        latestChecksPassed,
        undefined,
        latestReviewResolution,
      );
      if (!summaryResult.ok) return summaryResult.result;
      state = await passMilestone();
      return {
        ok: true,
        state,
        metadata,
        milestoneId: activeMilestoneId,
        verdict: "pass",
      };
    }

    if (latestReviewVerdict.verdict === "needs_human_review") {
      return finishUnresolvedReviewEquivalent({
        summary: latestReviewVerdict.summary,
        reviewPath: latestReviewPath,
        checksPassed: latestChecksPassed,
        message: latestReviewVerdict.summary,
        details: {
          review: latestReviewPath,
          findings: latestReviewVerdict.findings,
        },
        resolution: latestReviewResolution,
      });
    }

    latestBlockingFindings = latestReviewVerdict.findings.filter((finding) => finding.blocking);
    if (latestBlockingFindings.length === 0) {
      return finishUnresolvedReviewEquivalent({
        summary: latestReviewVerdict.summary,
        reviewPath: latestReviewPath,
        checksPassed: latestChecksPassed,
        message: "Review failed without blocking findings that can be fixed automatically.",
        details: {
          review: latestReviewPath,
          findings: latestReviewVerdict.findings,
        },
        resolution: latestReviewResolution,
      });
    }
  }

  return fail("reviewing", "Review fix loop ended unexpectedly.");

  async function normalizeReviewDecision(
    context: ReviewDecisionContext,
  ): Promise<ReviewDecisionHandlingResult> {
    const sourceVerdict = context.decision.verdict;

    if (sourceVerdict.verdict === "pass" && !context.latestChecksPassed) {
      if (
        context.passWithFailedChecksMode === "defer" &&
        !shouldAttemptAutonomousResolution(options.config.humanReviewPolicy) &&
        !isFailFastHumanReviewPolicy(options.config.humanReviewPolicy)
      ) {
        return { ok: true, value: context.decision };
      }

      return handleReviewEquivalent({
        ...context,
        sourceVerdict: failedChecksVerdict(sourceVerdict, context.latestChecksPath),
        sourceCondition: "review_passed_checks_failed",
        reason: "Review passed but latest deterministic checks failed.",
      });
    }

    if (sourceVerdict.verdict === "needs_human_review") {
      return handleReviewEquivalent({
        ...context,
        sourceVerdict,
        sourceCondition: "explicit_needs_human_review",
        reason: sourceVerdict.summary,
      });
    }

    if (
      sourceVerdict.verdict === "fail" &&
      sourceVerdict.findings.filter((finding) => finding.blocking).length === 0
    ) {
      return handleReviewEquivalent({
        ...context,
        sourceVerdict,
        sourceCondition: "fail_without_blocking_findings",
        reason: "Review failed without blocking findings that can be fixed automatically.",
      });
    }

    return { ok: true, value: context.decision };
  }

  async function handleReviewEquivalent(
    context: ReviewEquivalentContext,
  ): Promise<ReviewDecisionHandlingResult> {
    if (shouldAttemptAutonomousResolution(options.config.humanReviewPolicy)) {
      return resolveReviewAmbiguity(context);
    }

    return {
      ok: false,
      result: await finishUnresolvedReviewEquivalent({
        summary: context.sourceVerdict.summary,
        reviewPath: context.decision.reviewPath,
        checksPassed: context.latestChecksPassed,
        message: context.reason,
        details: {
          review: context.decision.reviewPath,
          findings: context.sourceVerdict.findings,
          sourceCondition: context.sourceCondition,
        },
        resolution: context.decision.resolution,
      }),
    };
  }

  async function resolveReviewAmbiguity(
    context: ReviewEquivalentContext,
  ): Promise<ReviewDecisionHandlingResult> {
    let previousResolutionOutput: string | null = null;
    let previousResolutionError: string | null = null;
    let latestResolutionError = context.reason;

    for (
      let resolutionAttempt = 1;
      resolutionAttempt <= reviewResolutionAttemptLimit;
      resolutionAttempt += 1
    ) {
      const resolutionPrompt = await renderLoadedPrompt("resolve-review-ambiguity", {
        goal: options.goal,
        activeMilestone: reviewedMilestone,
        milestonePlan: milestonePlanText,
        implementationReport: implementationReportText,
        diff: context.latestDiff,
        checks: context.latestChecks,
        latestChecksPassed: context.latestChecksPassed,
        reviewEvidence: context.reviewEvidence,
        reviewedArtifacts: context.reviewedArtifacts,
        state,
        resolutionAttempt,
        sourceCondition: context.sourceCondition,
        reason: context.reason,
        previousResolutionOutput: previousResolutionOutput ?? "None.",
        previousResolutionError: previousResolutionError ?? "None.",
        expectedSchemaContract: reviewResolutionSchemaContract,
        sourceReviewPath: context.decision.reviewPath,
        sourceVerdict: context.sourceVerdict,
      });
      if (!resolutionPrompt.ok) {
        return {
          ok: false,
          result: await fail("reviewing", resolutionPrompt.error),
        };
      }

      const resolution = await runPhase("resolve_review_ambiguity", resolutionPrompt.value, {
        review: context.decision.reviewPath,
        diff: context.latestDiffPath,
        checks: context.latestChecksPath,
        reviewEvidence: context.reviewEvidencePath,
        ...(context.fixPath === undefined ? {} : { fix: context.fixPath }),
      });
      if (!resolution.ok) {
        return {
          ok: false,
          result: await fail("reviewing", resolution.error, resolution.details),
        };
      }

      const parsedResolution = parseReviewResolutionJson(resolution.value);
      const resolutionError = parsedResolution.ok
        ? validateResolvedResolution(
          parsedResolution.value,
          context.sourceCondition,
          context.latestChecksPassed,
          context.allowedResolvedVerdicts,
        )
        : parsedResolution.error;
      const resolved = parsedResolution.ok && resolutionError === null;
      const resolutionArtifactPath = context.resolutionArtifactPathForAttempt(resolutionAttempt);
      const resolutionDiagnostic = {
        phase: "resolve_review_ambiguity",
        reviewRound: context.reviewRound,
        attempt: resolutionAttempt,
        status: resolved ? "resolved" : "unresolved",
        sourceCondition: context.sourceCondition,
        reason: context.reason,
        sourceReview: context.decision.reviewPath,
        sourceVerdict: context.sourceVerdict,
        resolutionError,
        rawOutput: resolution.value,
        reviewedArtifacts: context.reviewedArtifacts,
        ...(parsedResolution.ok ? { resolution: parsedResolution.value } : {}),
      };
      const resolutionWrite = await writeJsonArtifactOrFail(
        "reviewing",
        resolutionArtifactPath.file,
        resolutionDiagnostic,
        "review resolution diagnostic artifact",
      );
      if (!resolutionWrite.ok) return resolutionWrite;
      state = await persist(
        recordArtifactByKey(
          state,
          "reviews",
          resolutionArtifactPath.stateKey,
          resolutionArtifactPath.statePath,
          clock(),
        ),
      );

      if (parsedResolution.ok && resolved) {
        return {
          ok: true,
          value: {
            verdict: parsedResolution.value.verdict,
            reviewPath: resolutionArtifactPath.statePath,
            resolution: parsedResolution.value,
          },
        };
      }

      previousResolutionOutput = resolution.value;
      latestResolutionError = resolutionError ?? "Review resolution did not produce a decision.";
      previousResolutionError = latestResolutionError;
    }

    return {
      ok: false,
      result: await finishUnresolvedReviewEquivalent({
        summary: "Autonomous review resolution could not produce a valid decision.",
        reviewPath: context.decision.reviewPath,
        checksPassed: context.latestChecksPassed,
        message: `Review ambiguity resolution failed after ${reviewResolutionAttemptLimit} attempt(s).`,
        reason: latestResolutionError,
        details: {
          sourceCondition: context.sourceCondition,
          latestResolutionError,
          review: context.decision.reviewPath,
        },
        resolution: context.decision.resolution,
      }),
    };
  }

  async function finishUnresolvedReviewEquivalent(optionsForFinish: {
    summary: string;
    reviewPath: string;
    checksPassed: boolean;
    message: string;
    details?: string | object | unknown[] | null;
    reason?: string;
    resolution?: ReviewResolutionDocument;
  }): Promise<ReviewWorkflowResult> {
    const terminalPhase = terminalPhaseForUnresolvedHumanReview(
      options.config.humanReviewPolicy,
    );
    const summaryResult = await writeFinalSummary(
      terminalPhase,
      optionsForFinish.summary,
      optionsForFinish.reviewPath,
      optionsForFinish.checksPassed,
      optionsForFinish.reason ?? optionsForFinish.message,
      optionsForFinish.resolution,
    );
    if (!summaryResult.ok) return summaryResult.result;

    if (terminalPhase === "failed") {
      return fail(terminalPhase, optionsForFinish.message, optionsForFinish.details);
    }

    const milestoneId = activeMilestoneId;
    if (milestoneId === null) {
      return fail("reviewing", "Review workflow lost the active milestone id.");
    }

    state = await needsHumanReview(optionsForFinish.message, optionsForFinish.details);
    return {
      ok: true,
      state,
      metadata,
      milestoneId,
      verdict: "needs_human_review",
    };
  }

  async function parseReviewOutputOrHandleMalformed(
    reviewOutput: ReviewOutputHandlingOptions,
  ): Promise<ReviewOutputHandlingResult> {
    const parsed = parseReviewVerdictJson(reviewOutput.rawOutput);
    if (parsed.ok) return { ok: true, value: parsed.value };

    const diagnostic = {
      verdict: "needs_human_review",
      summary: reviewOutput.malformedSummary,
      error: parsed.error,
      rawOutput: reviewOutput.rawOutput,
      reviewedArtifacts: reviewOutput.reviewedArtifacts,
      humanReviewPolicy: options.config.humanReviewPolicy,
    };

    if (shouldAttemptAutonomousResolution(options.config.humanReviewPolicy)) {
      const malformedWrite = await writeJsonArtifactOrFail(
        "reviewing",
        reviewOutput.malformedArtifactPath.file,
        diagnostic,
        "malformed review diagnostic artifact",
      );
      if (!malformedWrite.ok) return malformedWrite;
      state = await persist(
        recordArtifactByKey(
          state,
          "reviews",
          reviewOutput.malformedArtifactPath.stateKey,
          reviewOutput.malformedArtifactPath.statePath,
          clock(),
        ),
      );

      return repairMalformedReviewOutput(reviewOutput, parsed.error);
    }

    const diagnosticWrite = await writeJsonArtifactOrFail(
      "reviewing",
      reviewOutput.finalReviewFile,
      diagnostic,
      "review diagnostic artifact",
    );
    if (!diagnosticWrite.ok) return diagnosticWrite;
    state = await persist(
      recordArtifactByKey(
        state,
        "reviews",
        reviewOutput.finalReviewStateKey,
        reviewOutput.finalReviewStatePath,
        clock(),
      ),
    );
    return {
      ok: false,
      result: await finishUnresolvedReviewEquivalent({
        summary: diagnostic.summary,
        reviewPath: reviewOutput.finalReviewStatePath,
        checksPassed: reviewOutput.latestChecksPassed,
        message: reviewOutput.malformedMessage,
        reason: parsed.error,
        details: {
          error: parsed.error,
          review: reviewOutput.finalReviewStatePath,
        },
      }),
    };
  }

  async function repairMalformedReviewOutput(
    reviewOutput: ReviewOutputHandlingOptions,
    validationError: string,
  ): Promise<ReviewOutputHandlingResult> {
    let previousRepairOutput: string | null = null;
    let previousRepairError: string | null = null;
    let latestRepairError = validationError;

    for (let repairAttempt = 1; repairAttempt <= reviewRepairAttemptLimit; repairAttempt += 1) {
      const repairPrompt = await renderLoadedPrompt("repair-review-verdict", {
        goal: options.goal,
        activeMilestone: reviewedMilestone,
        milestonePlan: milestonePlanText,
        implementationReport: implementationReportText,
        diff: reviewOutput.latestDiff,
        checks: reviewOutput.latestChecks,
        latestChecksPassed: reviewOutput.latestChecksPassed,
        reviewEvidence: reviewOutput.reviewEvidence,
        reviewedArtifacts: reviewOutput.reviewedArtifacts,
        state,
        repairAttempt,
        validationError,
        previousRepairOutput: previousRepairOutput ?? "None.",
        previousRepairError: previousRepairError ?? "None.",
        rawOutput: reviewOutput.rawOutput,
        expectedSchemaContract: reviewVerdictSchemaContract,
      });
      if (!repairPrompt.ok) {
        return {
          ok: false,
          result: await fail("reviewing", repairPrompt.error),
        };
      }

      const repair = await runPhase("repair_review_verdict", repairPrompt.value, {
        malformedReview: reviewOutput.malformedArtifactPath.statePath,
        diff: reviewOutput.latestDiffPath,
        checks: reviewOutput.latestChecksPath,
        reviewEvidence: reviewOutput.reviewEvidencePath,
        ...(reviewOutput.fixPath === undefined ? {} : { fix: reviewOutput.fixPath }),
      });
      if (!repair.ok) {
        return {
          ok: false,
          result: await fail("reviewing", repair.error, repair.details),
        };
      }

      const repairedVerdict = parseReviewVerdictJson(repair.value);
      const repairArtifactPath = reviewOutput.repairArtifactPathForAttempt(repairAttempt);
      const repairDiagnostic = {
        phase: "repair_review_verdict",
        reviewRound: reviewOutput.reviewRound,
        attempt: repairAttempt,
        status: repairedVerdict.ok ? "repaired" : "unresolved",
        sourceError: validationError,
        repairError: repairedVerdict.ok ? null : repairedVerdict.error,
        rawOutput: reviewOutput.rawOutput,
        repairedOutput: repair.value,
        reviewedArtifacts: reviewOutput.reviewedArtifacts,
        ...(repairedVerdict.ok ? { repairedVerdict: repairedVerdict.value } : {}),
      };
      const repairWrite = await writeJsonArtifactOrFail(
        "reviewing",
        repairArtifactPath.file,
        repairDiagnostic,
        "review repair diagnostic artifact",
      );
      if (!repairWrite.ok) return repairWrite;
      state = await persist(
        recordArtifactByKey(
          state,
          "reviews",
          repairArtifactPath.stateKey,
          repairArtifactPath.statePath,
          clock(),
        ),
      );

      if (repairedVerdict.ok) {
        return { ok: true, value: repairedVerdict.value };
      }

      previousRepairOutput = repair.value;
      latestRepairError = repairedVerdict.error;
      previousRepairError = latestRepairError;
    }

    const summaryResult = await writeFinalSummary(
      "failed",
      "Review output repair could not produce a valid autonomous verdict.",
      reviewOutput.malformedArtifactPath.statePath,
      reviewOutput.latestChecksPassed,
      latestRepairError,
    );
    if (!summaryResult.ok) return summaryResult;

    return {
      ok: false,
      result: await fail(
        terminalPhaseForUnresolvedHumanReview(options.config.humanReviewPolicy),
        `Review verdict repair failed after ${reviewRepairAttemptLimit} attempt(s).`,
        {
          sourceError: validationError,
          latestRepairError,
          malformedReview: reviewOutput.malformedArtifactPath.statePath,
        },
      ),
    };
  }

  async function renderLoadedPrompt(
    promptName:
      | "review-milestone"
      | "repair-review-verdict"
      | "resolve-review-ambiguity"
      | "fix-review-findings",
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
    phase: ReviewRunnerPhase,
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
          milestoneId: activeMilestoneId ?? undefined,
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
    phase: ReviewRunnerPhase,
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
  ): Promise<{ ok: true } | { ok: false; result: ReviewWorkflowResult }> {
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
  ): Promise<{ ok: true } | { ok: false; result: ReviewWorkflowResult }> {
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

  async function writeReviewEvidenceArtifactOrFail(optionsForEvidence: {
    filePath: string;
    statePath: string;
    stateKey: string;
    diff: string;
    reviewRound:
      | { kind: "base" }
      | { kind: "fix"; attempt: number };
  }): Promise<
    | { ok: true; value: string }
    | { ok: false; result: ReviewWorkflowResult }
  > {
    try {
      const evidenceResult = await buildReviewEvidence({
        cwd: options.cwd,
        gitRoot: state.git.root,
        runDir: options.paths.runDir,
        runId: state.runId,
        milestoneId: activeMilestoneId ?? 0,
        reviewRound: optionsForEvidence.reviewRound,
        diff: optionsForEvidence.diff,
      });
      await writeTextArtifact(optionsForEvidence.filePath, evidenceResult.markdown);
      state = await persist(
        recordArtifactByKey(
          state,
          "reviews",
          optionsForEvidence.stateKey,
          optionsForEvidence.statePath,
          clock(),
        ),
      );
      return { ok: true, value: evidenceResult.markdown };
    } catch (error) {
      return {
        ok: false,
        result: await fail(
          "reviewing",
          `Failed to write review evidence artifact at ${optionsForEvidence.filePath}: ${formatError(error)}`,
        ),
      };
    }
  }

  async function writeFinalSummary(
    verdict: ReviewSummaryStatus,
    summary: string,
    review: string,
    checksPassed: boolean,
    reason?: string,
    resolution?: ReviewResolutionDocument,
  ): Promise<{ ok: true } | { ok: false; result: ReviewWorkflowResult }> {
    const summaryWrite = await writeTextArtifactOrFail(
      "reviewing",
      reviewPaths.files.summary,
      formatReviewSummary({
        milestone: reviewedMilestone,
        verdict,
        summary,
        review,
        latestChecksPassed: checksPassed,
        reason,
        resolution,
      }),
      "review summary artifact",
    );
    if (!summaryWrite.ok) return summaryWrite;

    state = await persist(
      recordArtifactByKey(
        state,
        "summaries",
        reviewPaths.stateKeys.summary,
        reviewPaths.statePaths.summary,
        clock(),
      ),
    );
    return { ok: true };
  }

  async function recordCompletedFixAttempt(attempt: number): Promise<RunState> {
    state = await persist({
      ...state,
      fixAttempts: {
        ...state.fixAttempts,
        [String(activeMilestoneId)]: attempt,
      },
      updatedAt: clock().toISOString(),
    });
    return state;
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
}

function failedChecksFinding(checksPath: string): ReviewFinding {
  return {
    severity: "high",
    file: null,
    issue: `Latest deterministic checks failed: ${checksPath}.`,
    suggestedFix: "Fix the failing deterministic checks before accepting the milestone.",
    blocking: true,
  };
}

function failedChecksVerdict(
  sourceVerdict: ReviewVerdictDocument,
  checksPath: string,
): ReviewVerdictDocument {
  return {
    verdict: "fail",
    summary: "Review passed but latest deterministic checks failed.",
    findings: [failedChecksFinding(checksPath)],
    reviewedArtifacts: mergeUniqueStrings([
      ...sourceVerdict.reviewedArtifacts,
      checksPath,
    ]),
  };
}

function validateResolvedResolution(
  resolution: ReviewResolutionDocument,
  expectedSourceCondition: string,
  latestChecksPassed: boolean,
  allowedVerdicts?: Exclude<ReviewVerdict, "needs_human_review">[],
): string | null {
  if (resolution.resolution.sourceCondition !== expectedSourceCondition) {
    return `Resolution sourceCondition must be ${expectedSourceCondition}, got ${resolution.resolution.sourceCondition}.`;
  }

  const verdict = resolution.verdict;
  if (verdict.verdict === "needs_human_review") {
    return "Resolution returned needs_human_review instead of a safe pass or actionable fail.";
  }

  if (allowedVerdicts !== undefined && !allowedVerdicts.includes(verdict.verdict)) {
    return `Resolution returned ${verdict.verdict}, but only ${allowedVerdicts.join(", ")} is allowed for this condition.`;
  }

  if (verdict.verdict === "pass" && !latestChecksPassed) {
    return "Resolution returned pass while latest deterministic checks failed.";
  }

  if (
    verdict.verdict === "fail" &&
    verdict.findings.filter((finding) => finding.blocking).length === 0
  ) {
    return "Resolution returned fail without blocking findings.";
  }

  return null;
}

function mergeUniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function validateReadyState(
  state: RunState,
): { ok: true; milestoneId: number } | { ok: false; error: string } {
  if (state.currentPhase !== "ready_for_review") {
    return {
      ok: false,
      error: `Review requires state phase ready_for_review, got ${state.currentPhase}.`,
    };
  }

  if (state.currentMilestoneId === null) {
    return { ok: false, error: "Review requires currentMilestoneId." };
  }

  if (state.milestoneStatuses[String(state.currentMilestoneId)] !== "ready_for_review") {
    return {
      ok: false,
      error: `Active milestone ${state.currentMilestoneId} must be ready_for_review before review.`,
    };
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

function checkReportPassed(report: string): boolean {
  const lines = report
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 1 && lines[0] === "No configured checks.") {
    return true;
  }

  if (lines[0] !== "Check results") {
    return false;
  }

  return lines[1] === "Overall: passed";
}

function formatReviewSummary(options: {
  milestone: Milestone;
  verdict: ReviewSummaryStatus;
  summary: string;
  review: string;
  latestChecksPassed: boolean;
  reason?: string;
  resolution?: ReviewResolutionDocument;
}): string {
  return [
    `# Milestone ${options.milestone.id} Review Summary`,
    "",
    `Status: ${options.verdict}`,
    `Title: ${options.milestone.title}`,
    `Latest checks passed: ${options.latestChecksPassed}`,
    "",
    "## Review",
    "",
    options.summary,
    "",
    "## Artifacts",
    "",
    `- Review: ${options.review}`,
    ...(options.resolution
      ? [
          "",
          "## Autonomous Resolution",
          "",
          options.resolution.resolution.summary,
          "",
          `Source condition: ${options.resolution.resolution.sourceCondition}`,
          "",
          "### Rationale",
          "",
          options.resolution.resolution.rationale,
          "",
          "### Assumptions",
          "",
          ...(options.resolution.resolution.assumptions.length === 0
            ? ["- None."]
            : options.resolution.resolution.assumptions.map((assumption) => `- ${assumption}`)),
        ]
      : []),
    ...(options.reason ? ["", "## Reason", "", options.reason] : []),
  ].join("\n");
}

type ReviewSummaryStatus = ReviewVerdictDocument["verdict"] | "failed";

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
