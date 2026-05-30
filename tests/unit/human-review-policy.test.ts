import assert from "node:assert/strict";
import test from "node:test";

import type { HumanReviewPolicy } from "../../src/config/config-types.js";
import {
  humanReviewPolicyDisposition,
  isAutonomousHumanReviewFailure,
  isFailFastHumanReviewPolicy,
  isSupervisedHumanReviewPolicy,
  lastErrorPhaseForHumanReview,
  milestoneStatusForHumanReview,
  shouldAttemptAutonomousResolution,
  terminalPhaseForHumanReview,
  terminalStatusForHumanReview,
} from "../../src/orchestration/human-review-policy.js";

test("human review policy helper maps supervised stop mode", () => {
  assert.equal(humanReviewPolicyDisposition("stop"), "stop");
  assert.equal(isSupervisedHumanReviewPolicy("stop"), true);
  assert.equal(isFailFastHumanReviewPolicy("stop"), false);
  assert.equal(shouldAttemptAutonomousResolution("stop"), false);
  assert.equal(isAutonomousHumanReviewFailure("stop"), false);
  assert.equal(terminalPhaseForHumanReview("stop"), "needs_human_review");
  assert.equal(terminalStatusForHumanReview("stop"), "needs_human_review");
  assert.equal(milestoneStatusForHumanReview("stop"), "needs_human_review");
  assert.equal(
    lastErrorPhaseForHumanReview("stop", "reviewing"),
    "needs_human_review",
  );
});

test("human review policy helper maps fail-fast mode", () => {
  assert.equal(humanReviewPolicyDisposition("fail"), "fail");
  assert.equal(isSupervisedHumanReviewPolicy("fail"), false);
  assert.equal(isFailFastHumanReviewPolicy("fail"), true);
  assert.equal(shouldAttemptAutonomousResolution("fail"), false);
  assert.equal(isAutonomousHumanReviewFailure("fail"), true);
  assert.equal(terminalPhaseForHumanReview("fail"), "failed");
  assert.equal(terminalStatusForHumanReview("fail"), "failed");
  assert.equal(milestoneStatusForHumanReview("fail"), "failed");
  assert.equal(lastErrorPhaseForHumanReview("fail"), "failed");
  assert.equal(lastErrorPhaseForHumanReview("fail", "reviewing"), "reviewing");
});

test("human review policy helper maps autonomous resolve mode", () => {
  assert.equal(humanReviewPolicyDisposition("autonomous"), "resolve");
  assert.equal(isSupervisedHumanReviewPolicy("autonomous"), false);
  assert.equal(isFailFastHumanReviewPolicy("autonomous"), false);
  assert.equal(shouldAttemptAutonomousResolution("autonomous"), true);
  assert.equal(isAutonomousHumanReviewFailure("autonomous"), true);
  assert.equal(terminalPhaseForHumanReview("autonomous"), "failed");
  assert.equal(terminalStatusForHumanReview("autonomous"), "failed");
  assert.equal(milestoneStatusForHumanReview("autonomous"), "failed");
  assert.equal(lastErrorPhaseForHumanReview("autonomous"), "failed");
  assert.equal(
    lastErrorPhaseForHumanReview("autonomous", "reviewing"),
    "reviewing",
  );
});

test("human review policy helper covers all policy values deterministically", () => {
  const expectations: Record<
    HumanReviewPolicy,
    {
      disposition: ReturnType<typeof humanReviewPolicyDisposition>;
      supervised: boolean;
      failFast: boolean;
      resolve: boolean;
      autonomousFailure: boolean;
      terminalPhase: ReturnType<typeof terminalPhaseForHumanReview>;
      terminalStatus: ReturnType<typeof terminalStatusForHumanReview>;
      milestoneStatus: ReturnType<typeof milestoneStatusForHumanReview>;
    }
  > = {
    stop: {
      disposition: "stop",
      supervised: true,
      failFast: false,
      resolve: false,
      autonomousFailure: false,
      terminalPhase: "needs_human_review",
      terminalStatus: "needs_human_review",
      milestoneStatus: "needs_human_review",
    },
    fail: {
      disposition: "fail",
      supervised: false,
      failFast: true,
      resolve: false,
      autonomousFailure: true,
      terminalPhase: "failed",
      terminalStatus: "failed",
      milestoneStatus: "failed",
    },
    autonomous: {
      disposition: "resolve",
      supervised: false,
      failFast: false,
      resolve: true,
      autonomousFailure: true,
      terminalPhase: "failed",
      terminalStatus: "failed",
      milestoneStatus: "failed",
    },
  };

  for (const policy of Object.keys(expectations) as HumanReviewPolicy[]) {
    assert.equal(
      humanReviewPolicyDisposition(policy),
      expectations[policy].disposition,
    );
    assert.equal(
      isSupervisedHumanReviewPolicy(policy),
      expectations[policy].supervised,
    );
    assert.equal(
      isFailFastHumanReviewPolicy(policy),
      expectations[policy].failFast,
    );
    assert.equal(
      shouldAttemptAutonomousResolution(policy),
      expectations[policy].resolve,
    );
    assert.equal(
      isAutonomousHumanReviewFailure(policy),
      expectations[policy].autonomousFailure,
    );
    assert.equal(
      terminalPhaseForHumanReview(policy),
      expectations[policy].terminalPhase,
    );
    assert.equal(
      terminalStatusForHumanReview(policy),
      expectations[policy].terminalStatus,
    );
    assert.equal(
      milestoneStatusForHumanReview(policy),
      expectations[policy].milestoneStatus,
    );
  }
});
