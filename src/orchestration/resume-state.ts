import type { MilestoneMetadata } from "../milestones/milestone-types.js";
import type {
  ActiveResumeRecoveryMode,
  ResumeRecoveryMode,
} from "./resume-recovery.js";
import type { RunState } from "../state/state-types.js";
import {
  selectNextRunnableMilestone,
  type MilestoneSelectionDecision,
} from "./milestone-selector.js";

export type ResumeDecision =
  | { kind: "continue"; state: RunState }
  | { kind: "advance"; milestoneId: number }
  | { kind: "complete"; summaryRequired: boolean }
  | { kind: "stopped"; state: RunState }
  | {
      kind: "recover";
      mode: ActiveResumeRecoveryMode;
      milestoneId: number;
      legacyFailedCheck: boolean;
    }
  | { kind: "normalize_to_ready_for_review"; milestoneId: number }
  | { kind: "normalize_to_passed"; milestoneId: number }
  | {
      kind: "needs_human_review";
      message: string;
      details?: unknown;
      currentMilestoneId?: number | null;
    };

export function normalizeStateForGoalResume(
  state: RunState,
  metadata: MilestoneMetadata,
  options: { recoveryMode?: ResumeRecoveryMode } = {},
): ResumeDecision {
  const recoveryMode = options.recoveryMode ?? "none";
  if (recoveryMode !== "none") {
    return normalizeRecoveryResume(state, metadata, recoveryMode);
  }

  if (state.status === "failed" || state.status === "needs_human_review") {
    return { kind: "stopped", state };
  }

  if (
    state.currentPhase === "initialized" ||
    state.currentPhase === "planning" ||
    state.currentPhase === "plan_reviewing"
  ) {
    return { kind: "continue", state };
  }

  if (state.currentPhase === "ready_for_milestone") {
    return normalizeReadyForMilestone(state, metadata);
  }

  if (state.currentPhase === "ready_for_review") {
    return normalizeReadyForReview(state, metadata);
  }

  if (state.currentPhase === "passed") {
    return normalizePassedState(state, metadata);
  }

  if (
    state.currentPhase === "implementing" ||
    state.currentPhase === "checking"
  ) {
    return normalizeImplementationTransient(state, metadata);
  }

  if (state.currentPhase === "reviewing" || state.currentPhase === "fixing") {
    return normalizeReviewTransient(state, metadata);
  }

  return {
    kind: "needs_human_review",
    message: `Resume from phase ${state.currentPhase} is not supported.`,
    details: { currentPhase: state.currentPhase, status: state.status },
    currentMilestoneId: state.currentMilestoneId,
  };
}

function normalizeRecoveryResume(
  state: RunState,
  metadata: MilestoneMetadata,
  recoveryMode: ActiveResumeRecoveryMode,
): ResumeDecision {
  const activeMilestone = validateCurrentMilestone(state, metadata);
  if (!activeMilestone.ok) return activeMilestone.decision;

  const recoveryState = classifyRecoverableCheckFailureState(
    state,
    activeMilestone.milestoneId,
  );
  if (!recoveryState.ok) {
    return needsHumanReview(
      `Recovery mode ${recoveryMode} can only resume from checks_failed or legacy failed-check states.`,
      {
        currentPhase: state.currentPhase,
        status: state.status,
        currentMilestoneId: activeMilestone.milestoneId,
        milestoneStatus:
          state.milestoneStatuses[String(activeMilestone.milestoneId)] ?? null,
      },
      activeMilestone.milestoneId,
    );
  }

  return {
    kind: "recover",
    mode: recoveryMode,
    milestoneId: activeMilestone.milestoneId,
    legacyFailedCheck: recoveryState.legacyFailedCheck,
  };
}

function classifyRecoverableCheckFailureState(
  state: RunState,
  milestoneId: number,
): { ok: true; legacyFailedCheck: boolean } | { ok: false } {
  const milestoneStatus = state.milestoneStatuses[String(milestoneId)];

  if (
    state.currentPhase === "checks_failed" &&
    state.status === "checks_failed" &&
    milestoneStatus === "checks_failed"
  ) {
    return { ok: true, legacyFailedCheck: false };
  }

  if (
    state.currentPhase === "checking" &&
    state.status === "failed" &&
    (milestoneStatus === "failed" ||
      milestoneStatus === "checking" ||
      milestoneStatus === "checks_failed")
  ) {
    return { ok: true, legacyFailedCheck: true };
  }

  if (
    state.currentPhase === "failed" &&
    state.status === "failed" &&
    milestoneStatus === "failed" &&
    hasTerminalCheckFailureEvidence(state, milestoneId)
  ) {
    return { ok: true, legacyFailedCheck: false };
  }

  return { ok: false };
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

function normalizeReadyForMilestone(
  state: RunState,
  metadata: MilestoneMetadata,
): ResumeDecision {
  const activeMilestone = validateCurrentMilestone(state, metadata);
  if (!activeMilestone.ok) return activeMilestone.decision;

  const decision = selectNextRunnableMilestone(metadata, state);
  if (decision.kind === "runnable") {
    if (decision.milestone.id !== activeMilestone.milestoneId) {
      return needsHumanReview(
        "Resume currentMilestoneId does not match the next runnable milestone.",
        {
          currentMilestoneId: activeMilestone.milestoneId,
          nextRunnableMilestoneId: decision.milestone.id,
        },
        activeMilestone.milestoneId,
      );
    }

    return { kind: "continue", state };
  }

  return selectorStopDecision(decision, state.currentMilestoneId);
}

function normalizeReadyForReview(
  state: RunState,
  metadata: MilestoneMetadata,
): ResumeDecision {
  const activeMilestone = validateCurrentMilestone(state, metadata);
  if (!activeMilestone.ok) return activeMilestone.decision;

  const milestoneStatus = state.milestoneStatuses[String(activeMilestone.milestoneId)];
  if (milestoneStatus !== "ready_for_review") {
    return needsHumanReview(
      "Resume ready_for_review state does not have a ready_for_review active milestone.",
      { milestoneId: activeMilestone.milestoneId, milestoneStatus },
      activeMilestone.milestoneId,
    );
  }

  const missingArtifacts = missingReadyForReviewArtifacts(
    state,
    activeMilestone.milestoneId,
  );
  if (missingArtifacts.length > 0) {
    return needsHumanReview(
      "Resume ready_for_review state is missing required milestone artifacts.",
      {
        milestoneId: activeMilestone.milestoneId,
        missingArtifacts,
      },
      activeMilestone.milestoneId,
    );
  }

  return { kind: "continue", state };
}

function normalizePassedState(
  state: RunState,
  metadata: MilestoneMetadata,
): ResumeDecision {
  const decision = selectNextRunnableMilestone(metadata, state);
  if (decision.kind === "runnable") {
    return { kind: "advance", milestoneId: decision.milestone.id };
  }

  if (decision.kind === "complete") {
    return {
      kind: "complete",
      summaryRequired: !state.artifacts.summaries?.goal,
    };
  }

  return selectorStopDecision(decision, state.currentMilestoneId);
}

function normalizeImplementationTransient(
  state: RunState,
  metadata: MilestoneMetadata,
): ResumeDecision {
  const activeMilestone = validateCurrentMilestone(state, metadata);
  if (!activeMilestone.ok) return activeMilestone.decision;

  const missingArtifacts = missingReadyForReviewArtifacts(
    state,
    activeMilestone.milestoneId,
  );
  if (missingArtifacts.length === 0) {
    return {
      kind: "normalize_to_ready_for_review",
      milestoneId: activeMilestone.milestoneId,
    };
  }

  return needsHumanReview(
    "Resume cannot prove that transient implementation work is safe to continue.",
    {
      currentPhase: state.currentPhase,
      milestoneId: activeMilestone.milestoneId,
      missingArtifacts,
    },
    activeMilestone.milestoneId,
  );
}

function normalizeReviewTransient(
  state: RunState,
  metadata: MilestoneMetadata,
): ResumeDecision {
  const activeMilestone = validateCurrentMilestone(state, metadata);
  if (!activeMilestone.ok) return activeMilestone.decision;

  const milestoneId = activeMilestone.milestoneId;
  const milestoneStatus = state.milestoneStatuses[String(milestoneId)];
  const reviewSummaryPath = state.artifacts.summaries?.[`${milestoneId}-review`];

  if (milestoneStatus === "passed" && reviewSummaryPath) {
    return { kind: "normalize_to_passed", milestoneId };
  }

  if (milestoneStatus === "needs_human_review" && reviewSummaryPath) {
    return needsHumanReview(
      "Resume found a review terminal human-review milestone.",
      { milestoneId, reviewSummary: reviewSummaryPath },
      milestoneId,
    );
  }

  return needsHumanReview(
    "Resume cannot prove that transient review work reached a safe terminal state.",
    {
      currentPhase: state.currentPhase,
      milestoneId,
      milestoneStatus,
      reviewSummary: reviewSummaryPath ?? null,
    },
    milestoneId,
  );
}

function validateCurrentMilestone(
  state: RunState,
  metadata: MilestoneMetadata,
):
  | { ok: true; milestoneId: number }
  | { ok: false; decision: ResumeDecision } {
  if (state.currentMilestoneId === null) {
    return {
      ok: false,
      decision: needsHumanReview(
        "Resume state requires an active currentMilestoneId.",
        { currentPhase: state.currentPhase, status: state.status },
        null,
      ),
    };
  }

  const milestone = metadata.milestones.find(
    (candidate) => candidate.id === state.currentMilestoneId,
  );
  if (!milestone) {
    return {
      ok: false,
      decision: needsHumanReview(
        "Resume currentMilestoneId is missing from milestone metadata.",
        { currentMilestoneId: state.currentMilestoneId },
        state.currentMilestoneId,
      ),
    };
  }

  return { ok: true, milestoneId: state.currentMilestoneId };
}

function missingReadyForReviewArtifacts(
  state: RunState,
  milestoneId: number,
): string[] {
  const key = String(milestoneId);
  const missing: string[] = [];

  if (!state.artifacts.milestonePlans?.[key]) missing.push("milestonePlans");
  if (!state.artifacts.implementations?.[key]) missing.push("implementations");
  if (!state.artifacts.diffs?.[key]) missing.push("diffs");
  if (!state.artifacts.checks?.[key]) missing.push("checks");
  if (!state.artifacts.summaries?.[key]) missing.push("summaries");

  return missing;
}

function selectorStopDecision(
  decision: MilestoneSelectionDecision,
  currentMilestoneId: number | null,
): ResumeDecision {
  if (decision.kind === "blocked" || decision.kind === "invalid_state") {
    return needsHumanReview(
      decision.message,
      decision.details,
      currentMilestoneId,
    );
  }

  return needsHumanReview(
    "Resume selector returned an unexpected decision.",
    { decision },
    currentMilestoneId,
  );
}

function needsHumanReview(
  message: string,
  details?: unknown,
  currentMilestoneId?: number | null,
): ResumeDecision {
  return {
    kind: "needs_human_review",
    message,
    ...(details === undefined ? {} : { details }),
    ...(currentMilestoneId === undefined ? {} : { currentMilestoneId }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
