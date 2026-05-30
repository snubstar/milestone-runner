import type { HumanReviewPolicy } from "../config/config-types.js";
import type {
  MilestoneStatus,
  OrchestratorPhase,
} from "../state/state-types.js";

export type HumanReviewTerminalPhase = Extract<
  OrchestratorPhase,
  "needs_human_review" | "failed"
>;
export type HumanReviewMilestoneStatus = Extract<
  MilestoneStatus,
  "needs_human_review" | "failed"
>;
export type HumanReviewPolicyDisposition = "stop" | "fail" | "resolve";

export function humanReviewPolicyDisposition(
  policy: HumanReviewPolicy,
): HumanReviewPolicyDisposition {
  if (policy === "autonomous") return "resolve";
  return policy;
}

export function shouldAttemptAutonomousResolution(
  policy: HumanReviewPolicy,
): boolean {
  return humanReviewPolicyDisposition(policy) === "resolve";
}

export function isFailFastHumanReviewPolicy(policy: HumanReviewPolicy): boolean {
  return humanReviewPolicyDisposition(policy) === "fail";
}

export function isSupervisedHumanReviewPolicy(policy: HumanReviewPolicy): boolean {
  return humanReviewPolicyDisposition(policy) === "stop";
}

export function isAutonomousHumanReviewFailure(
  policy: HumanReviewPolicy,
): boolean {
  return !isSupervisedHumanReviewPolicy(policy);
}

export function terminalPhaseForUnresolvedHumanReview(
  policy: HumanReviewPolicy,
): HumanReviewTerminalPhase {
  return isSupervisedHumanReviewPolicy(policy)
    ? "needs_human_review"
    : "failed";
}

export function terminalPhaseForHumanReview(
  policy: HumanReviewPolicy,
): HumanReviewTerminalPhase {
  return terminalPhaseForUnresolvedHumanReview(policy);
}

export function terminalStatusForUnresolvedHumanReview(
  policy: HumanReviewPolicy,
): HumanReviewTerminalPhase {
  return terminalPhaseForUnresolvedHumanReview(policy);
}

export function terminalStatusForHumanReview(
  policy: HumanReviewPolicy,
): HumanReviewTerminalPhase {
  return terminalStatusForUnresolvedHumanReview(policy);
}

export function milestoneStatusForUnresolvedHumanReview(
  policy: HumanReviewPolicy,
): HumanReviewMilestoneStatus {
  return terminalPhaseForUnresolvedHumanReview(policy);
}

export function milestoneStatusForHumanReview(
  policy: HumanReviewPolicy,
): HumanReviewMilestoneStatus {
  return milestoneStatusForUnresolvedHumanReview(policy);
}

export function lastErrorPhaseForUnresolvedHumanReview(
  policy: HumanReviewPolicy,
  autonomousPhase: OrchestratorPhase = "failed",
): OrchestratorPhase {
  return isSupervisedHumanReviewPolicy(policy)
    ? "needs_human_review"
    : autonomousPhase;
}

export function lastErrorPhaseForHumanReview(
  policy: HumanReviewPolicy,
  autonomousPhase: OrchestratorPhase = "failed",
): OrchestratorPhase {
  return lastErrorPhaseForUnresolvedHumanReview(policy, autonomousPhase);
}
