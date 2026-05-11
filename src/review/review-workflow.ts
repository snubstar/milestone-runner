import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildMilestoneArtifactPaths } from "../artifacts/milestone-artifacts.js";
import { buildPlanningArtifactPaths, writeJsonArtifact, writeTextArtifact } from "../artifacts/planning-artifacts.js";
import {
  buildBaseReviewArtifactPaths,
  buildFixAttemptArtifactPaths,
} from "../artifacts/review-artifacts.js";
import { runChecks } from "../checks/check-runner.js";
import { captureGitDiff } from "../git/git-diff.js";
import type { Milestone, MilestoneMetadata } from "../milestones/milestone-types.js";
import { parseMilestoneMetadataJson } from "../milestones/milestone-validator.js";
import { loadPrompt } from "../prompts/prompt-loader.js";
import { renderPrompt, type PromptVariables } from "../prompts/prompt-renderer.js";
import type { AgentRunResult } from "../runners/agent-runner.js";
import { writeState } from "../state/state-store.js";
import {
  failState,
  recordArtifactByKey,
  setMilestoneStatus,
  setStatePhase,
} from "../state/state-transitions.js";
import type { OrchestratorPhase, RunState } from "../state/state-types.js";
import {
  parseReviewVerdictJson,
} from "./review-verdict-validator.js";
import type {
  ReviewRunnerPhase,
  ReviewFinding,
  ReviewVerdict,
  ReviewVerdictDocument,
  ReviewWorkflowOptions,
  ReviewWorkflowResult,
} from "./review-types.js";

export async function runReviewWorkflow(
  options: ReviewWorkflowOptions,
): Promise<ReviewWorkflowResult> {
  const clock = options.now ?? (() => new Date());
  let state = options.initialState;
  let activeMilestoneId: number | null = state.currentMilestoneId;

  async function persist(nextState: RunState): Promise<RunState> {
    await writeState(options.paths.files.state, nextState);
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

  const milestonePlan = await readRequiredArtifact(
    state.artifacts.milestonePlans?.[String(activeMilestoneId)],
    milestonePaths.files.milestonePlan,
    "milestone plan",
  );
  if (!milestonePlan.ok) return fail("reviewing", milestonePlan.error);

  const implementationReport = await readRequiredArtifact(
    state.artifacts.implementations?.[String(activeMilestoneId)],
    milestonePaths.files.implementation,
    "implementation report",
  );
  if (!implementationReport.ok) return fail("reviewing", implementationReport.error);

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

  const reviewedArtifacts = [
    state.artifacts.finalMajorPlanMarkdown ?? planningPaths.statePaths.finalMajorPlanMarkdown,
    state.artifacts.milestonePlans?.[String(activeMilestoneId)] ?? milestonePaths.statePaths.milestonePlan,
    state.artifacts.implementations?.[String(activeMilestoneId)] ?? milestonePaths.statePaths.implementation,
    latestDiffPath,
    latestChecksPath,
  ];

  const prompt = await renderLoadedPrompt("review-milestone", {
    goal: options.goal,
    finalMajorPlan: finalMajorPlan.value,
    activeMilestone,
    milestonePlan: milestonePlan.value,
    implementationReport: implementationReport.value,
    diff: latestDiff,
    checks: latestChecks,
    latestChecksPassed,
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
  });
  if (!review.ok) return fail("reviewing", review.error, review.details);

  const verdict = parseReviewVerdictJson(review.value);
  if (!verdict.ok) {
    const diagnostic = {
      verdict: "needs_human_review",
      summary: "Review output could not be parsed or validated.",
      error: verdict.error,
      rawOutput: review.value,
      reviewedArtifacts,
    };
    const writeResult = await writeJsonArtifactOrFail(
      "reviewing",
      reviewPaths.files.review,
      diagnostic,
      "review diagnostic artifact",
    );
    if (!writeResult.ok) return writeResult.result;
    state = await persist(
      recordArtifactByKey(
        state,
        "reviews",
        reviewPaths.stateKeys.review,
        reviewPaths.statePaths.review,
        clock(),
      ),
    );
    const summaryResult = await writeFinalSummary(
      "needs_human_review",
      diagnostic.summary,
      reviewPaths.statePaths.review,
      latestChecksPassed,
      verdict.error,
    );
    if (!summaryResult.ok) return summaryResult.result;
    state = await needsHumanReview("Review verdict was malformed.", {
      error: verdict.error,
      review: reviewPaths.statePaths.review,
    });
    return {
      ok: true,
      state,
      metadata,
      milestoneId: activeMilestoneId,
      verdict: "needs_human_review",
    };
  }

  const reviewWrite = await writeJsonArtifactOrFail(
    "reviewing",
    reviewPaths.files.review,
    verdict.value,
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

  if (verdict.value.verdict === "pass") {
    if (!latestChecksPassed) {
      const summaryResult = await writeFinalSummary(
        "needs_human_review",
        verdict.value.summary,
        reviewPaths.statePaths.review,
        latestChecksPassed,
        "Review passed but latest deterministic checks failed.",
      );
      if (!summaryResult.ok) return summaryResult.result;
      state = await needsHumanReview(
        "Review passed but latest deterministic checks failed.",
        {
          review: reviewPaths.statePaths.review,
          checks: latestChecksPath,
        },
      );
      return {
        ok: true,
        state,
        metadata,
        milestoneId: activeMilestoneId,
        verdict: "needs_human_review",
      };
    }

    const summaryResult = await writeFinalSummary(
      "pass",
      verdict.value.summary,
      reviewPaths.statePaths.review,
      latestChecksPassed,
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

  if (verdict.value.verdict === "needs_human_review") {
    const summaryResult = await writeFinalSummary(
      "needs_human_review",
      verdict.value.summary,
      reviewPaths.statePaths.review,
      latestChecksPassed,
    );
    if (!summaryResult.ok) return summaryResult.result;
    state = await needsHumanReview(verdict.value.summary, {
      review: reviewPaths.statePaths.review,
      findings: verdict.value.findings,
    });
    return {
      ok: true,
      state,
      metadata,
      milestoneId: activeMilestoneId,
      verdict: "needs_human_review",
    };
  }

  const blockingFindings = verdict.value.findings.filter((finding) => finding.blocking);
  if (blockingFindings.length === 0) {
    const summaryResult = await writeFinalSummary(
      "needs_human_review",
      verdict.value.summary,
      reviewPaths.statePaths.review,
      latestChecksPassed,
      "Review failed without blocking findings that can be fixed automatically.",
    );
    if (!summaryResult.ok) return summaryResult.result;
    state = await needsHumanReview(
      "Review failed without blocking findings that can be fixed automatically.",
      {
        review: reviewPaths.statePaths.review,
        findings: verdict.value.findings,
      },
    );
    return {
      ok: true,
      state,
      metadata,
      milestoneId: activeMilestoneId,
      verdict: "needs_human_review",
    };
  }

  if (options.config.maxFixAttempts === 0) {
    const summaryResult = await writeFinalSummary(
      "needs_human_review",
      verdict.value.summary,
      reviewPaths.statePaths.review,
      latestChecksPassed,
      "Review failed with blocking findings, but maxFixAttempts is 0.",
    );
    if (!summaryResult.ok) return summaryResult.result;
    state = await needsHumanReview(
      "Review failed with blocking findings, but maxFixAttempts is 0.",
      {
        review: reviewPaths.statePaths.review,
        findings: blockingFindings,
      },
    );
    return {
      ok: true,
      state,
      metadata,
      milestoneId: activeMilestoneId,
      verdict: "needs_human_review",
    };
  }

  let latestReviewVerdict = verdict.value;
  let latestReviewPath = reviewPaths.statePaths.review;
  let latestBlockingFindings = blockingFindings;

  while (latestBlockingFindings.length > 0) {
    const completedAttempts = state.fixAttempts[String(activeMilestoneId)] ?? 0;
    if (completedAttempts >= options.config.maxFixAttempts) {
      const summaryResult = await writeFinalSummary(
        "needs_human_review",
        latestReviewVerdict.summary,
        latestReviewPath,
        latestChecksPassed,
        `Max fix attempts exhausted after ${completedAttempts} attempt(s).`,
      );
      if (!summaryResult.ok) return summaryResult.result;
      state = await needsHumanReview(
        `Max fix attempts exhausted after ${completedAttempts} attempt(s).`,
        {
          review: latestReviewPath,
          findings: latestBlockingFindings,
          attempts: completedAttempts,
        },
      );
      return {
        ok: true,
        state,
        metadata,
        milestoneId: activeMilestoneId,
        verdict: "needs_human_review",
      };
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

    const postFixReviewedArtifacts = [
      state.artifacts.finalMajorPlanMarkdown ?? planningPaths.statePaths.finalMajorPlanMarkdown,
      state.artifacts.milestonePlans?.[String(activeMilestoneId)] ?? milestonePaths.statePaths.milestonePlan,
      state.artifacts.implementations?.[String(activeMilestoneId)] ?? milestonePaths.statePaths.implementation,
      latestDiffPath,
      latestChecksPath,
      fixPaths.statePaths.fix,
    ];
    const postFixPrompt = await renderLoadedPrompt("review-milestone", {
      goal: options.goal,
      finalMajorPlan: finalMajorPlan.value,
      activeMilestone,
      milestonePlan: milestonePlan.value,
      implementationReport: implementationReport.value,
      diff: latestDiff,
      checks: latestChecks,
      latestChecksPassed,
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
    });
    if (!postFixReview.ok) return fail("reviewing", postFixReview.error, postFixReview.details);

    const postFixVerdict = parseReviewVerdictJson(postFixReview.value);
    latestReviewPath = fixPaths.statePaths.review;
    if (!postFixVerdict.ok) {
      const diagnostic = {
        verdict: "needs_human_review",
        summary: "Post-fix review output could not be parsed or validated.",
        error: postFixVerdict.error,
        rawOutput: postFixReview.value,
        reviewedArtifacts: postFixReviewedArtifacts,
      };
      const diagnosticWrite = await writeJsonArtifactOrFail(
        "reviewing",
        fixPaths.files.review,
        diagnostic,
        "post-fix review diagnostic artifact",
      );
      if (!diagnosticWrite.ok) return diagnosticWrite.result;
      state = await persist(
        recordArtifactByKey(
          state,
          "reviews",
          fixPaths.stateKey,
          latestReviewPath,
          clock(),
        ),
      );
      const summaryResult = await writeFinalSummary(
        "needs_human_review",
        diagnostic.summary,
        latestReviewPath,
        latestChecksPassed,
        postFixVerdict.error,
      );
      if (!summaryResult.ok) return summaryResult.result;
      state = await needsHumanReview("Post-fix review verdict was malformed.", {
        error: postFixVerdict.error,
        review: latestReviewPath,
      });
      return {
        ok: true,
        state,
        metadata,
        milestoneId: activeMilestoneId,
        verdict: "needs_human_review",
      };
    }

    latestReviewVerdict = postFixVerdict.value;
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
      const summaryResult = await writeFinalSummary(
        "needs_human_review",
        latestReviewVerdict.summary,
        latestReviewPath,
        latestChecksPassed,
      );
      if (!summaryResult.ok) return summaryResult.result;
      state = await needsHumanReview(latestReviewVerdict.summary, {
        review: latestReviewPath,
        findings: latestReviewVerdict.findings,
      });
      return {
        ok: true,
        state,
        metadata,
        milestoneId: activeMilestoneId,
        verdict: "needs_human_review",
      };
    }

    latestBlockingFindings = latestReviewVerdict.findings.filter((finding) => finding.blocking);
    if (latestBlockingFindings.length === 0) {
      const summaryResult = await writeFinalSummary(
        "needs_human_review",
        latestReviewVerdict.summary,
        latestReviewPath,
        latestChecksPassed,
        "Review failed without blocking findings that can be fixed automatically.",
      );
      if (!summaryResult.ok) return summaryResult.result;
      state = await needsHumanReview(
        "Review failed without blocking findings that can be fixed automatically.",
        {
          review: latestReviewPath,
          findings: latestReviewVerdict.findings,
        },
      );
      return {
        ok: true,
        state,
        metadata,
        milestoneId: activeMilestoneId,
        verdict: "needs_human_review",
      };
    }
  }

  return fail("reviewing", "Review fix loop ended unexpectedly.");

  async function renderLoadedPrompt(
    promptName: "review-milestone" | "fix-review-findings",
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
    try {
      result = await options.runner.run({
        phase,
        prompt,
        artifacts,
        milestoneId: activeMilestoneId ?? undefined,
        cwd: options.cwd,
      });
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
        details: result,
      };
    }

    if (result.text.trim().length === 0) {
      return {
        ok: false,
        error: `Runner phase ${phase} returned empty output.`,
        details: result,
      };
    }

    return { ok: true, value: result.text };
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

  async function writeFinalSummary(
    verdict: ReviewVerdict,
    summary: string,
    review: string,
    checksPassed: boolean,
    reason?: string,
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

function failedChecksFinding(checksPath: string): ReviewFinding {
  return {
    severity: "high",
    file: null,
    issue: `Latest deterministic checks failed: ${checksPath}.`,
    suggestedFix: "Fix the failing deterministic checks before accepting the milestone.",
    blocking: true,
  };
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
  verdict: ReviewVerdictDocument["verdict"];
  summary: string;
  review: string;
  latestChecksPassed: boolean;
  reason?: string;
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
    ...(options.reason ? ["", "## Reason", "", options.reason] : []),
  ].join("\n");
}

function resolveRunArtifactPath(runDir: string, artifactPath: string): string {
  return path.isAbsolute(artifactPath) ? artifactPath : path.join(runDir, artifactPath);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
