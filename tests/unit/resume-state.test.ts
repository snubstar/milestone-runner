import assert from "node:assert/strict";
import test from "node:test";

import { buildRunPaths } from "../../src/artifacts/paths.js";
import type { MilestoneMetadata } from "../../src/milestones/milestone-types.js";
import {
  normalizeStateForGoalResume,
  type ResumeDecision,
} from "../../src/orchestration/resume-state.js";
import { createInitialState } from "../../src/state/initial-state.js";
import type {
  MilestoneStatus,
  OrchestratorPhase,
  RunState,
  StateArtifacts,
} from "../../src/state/state-types.js";

test("normalizeStateForGoalResume continues planning phases", () => {
  const decision = normalizeStateForGoalResume(
    state({ currentPhase: "planning", status: "planning" }),
    metadata(),
  );

  assert.equal(decision.kind, "continue");
});

test("normalizeStateForGoalResume continues a valid ready_for_milestone state", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "ready_for_milestone",
      status: "ready_for_milestone",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "pending",
        "2": "pending",
      },
    }),
    metadata(),
  );

  assert.equal(decision.kind, "continue");
});

test("normalizeStateForGoalResume rejects a ready_for_milestone current id mismatch", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "ready_for_milestone",
      status: "ready_for_milestone",
      currentMilestoneId: 2,
      milestoneStatuses: {
        "1": "pending",
        "2": "pending",
      },
    }),
    metadata(),
  );

  assertNeedsHumanReview(decision, /does not match the next runnable milestone/);
});

test("normalizeStateForGoalResume continues ready_for_review with required artifacts", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "ready_for_review",
      status: "ready_for_review",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "ready_for_review",
        "2": "pending",
      },
      artifacts: readyForReviewArtifacts(1),
    }),
    metadata(),
  );

  assert.equal(decision.kind, "continue");
});

test("normalizeStateForGoalResume rejects ready_for_review with missing artifacts", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "ready_for_review",
      status: "ready_for_review",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "ready_for_review",
        "2": "pending",
      },
      artifacts: {
        milestonePlans: {
          "1": "milestones/10-milestone-1-plan.md",
        },
      },
    }),
    metadata(),
  );

  assertNeedsHumanReview(decision, /missing required milestone artifacts/);
});

test("normalizeStateForGoalResume advances passed state with pending runnable milestones", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "passed",
        "2": "pending",
      },
    }),
    metadata(),
  );

  assert.deepEqual(decision, {
    kind: "advance",
    milestoneId: 2,
  });
});

test("normalizeStateForGoalResume completes passed state when all milestones passed without a goal summary", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: 2,
      milestoneStatuses: {
        "1": "passed",
        "2": "passed",
      },
    }),
    metadata(),
  );

  assert.deepEqual(decision, {
    kind: "complete",
    summaryRequired: true,
  });
});

test("normalizeStateForGoalResume completes passed state without rewriting an existing goal summary", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: 2,
      milestoneStatuses: {
        "1": "passed",
        "2": "passed",
      },
      artifacts: {
        summaries: {
          goal: "milestones/90-goal-summary.md",
        },
      },
    }),
    metadata(),
  );

  assert.deepEqual(decision, {
    kind: "complete",
    summaryRequired: false,
  });
});

test("normalizeStateForGoalResume returns failed and human-review states as stopped", () => {
  assert.equal(
    normalizeStateForGoalResume(
      state({
        currentPhase: "implementing",
        status: "failed",
        currentMilestoneId: 1,
      }),
      metadata(),
    ).kind,
    "stopped",
  );

  assert.equal(
    normalizeStateForGoalResume(
      state({
        currentPhase: "needs_human_review",
        status: "needs_human_review",
        currentMilestoneId: 1,
      }),
      metadata(),
    ).kind,
    "stopped",
  );
});

test("normalizeStateForGoalResume recognizes explicit checks_failed recovery", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "checks_failed",
      status: "checks_failed",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "checks_failed",
        "2": "pending",
      },
    }),
    metadata(),
    { recoveryMode: "repair_failed" },
  );

  assert.deepEqual(decision, {
    kind: "recover",
    mode: "repair_failed",
    milestoneId: 1,
    legacyFailedCheck: false,
  });
});

test("normalizeStateForGoalResume recognizes explicit legacy failed-check recovery", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "checking",
      status: "failed",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "failed",
        "2": "pending",
      },
    }),
    metadata(),
    { recoveryMode: "recheck_failed" },
  );

  assert.deepEqual(decision, {
    kind: "recover",
    mode: "recheck_failed",
    milestoneId: 1,
    legacyFailedCheck: true,
  });
});

test("normalizeStateForGoalResume recognizes explicit terminal failed-check recovery", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "failed",
      status: "failed",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "failed",
        "2": "pending",
      },
      artifacts: {
        checkFailures: {
          "1-failed-1": "checks/13-milestone-1-check-failure-1.json",
        },
      },
    }),
    metadata(),
    { recoveryMode: "repair_failed" },
  );

  assert.deepEqual(decision, {
    kind: "recover",
    mode: "repair_failed",
    milestoneId: 1,
    legacyFailedCheck: false,
  });
});

test("normalizeStateForGoalResume rejects recovery mode outside check failure states", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "failed",
      status: "failed",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "failed",
        "2": "pending",
      },
    }),
    metadata(),
    { recoveryMode: "retry_failed" },
  );

  assertNeedsHumanReview(decision, /can only resume from checks_failed/);
});

test("normalizeStateForGoalResume recovers implementation transients with completed artifacts", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "checking",
      status: "checking",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "checking",
        "2": "pending",
      },
      artifacts: readyForReviewArtifacts(1),
    }),
    metadata(),
  );

  assert.deepEqual(decision, {
    kind: "normalize_to_ready_for_review",
    milestoneId: 1,
  });
});

test("normalizeStateForGoalResume refuses unsafe implementation transients", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "implementing",
      status: "implementing",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "implementing",
        "2": "pending",
      },
      artifacts: {
        milestonePlans: {
          "1": "milestones/10-milestone-1-plan.md",
        },
      },
    }),
    metadata(),
  );

  assertNeedsHumanReview(decision, /transient implementation work/);
});

test("normalizeStateForGoalResume refuses scrupulous plan-review interruption artifacts", () => {
  const cases: Array<{
    name: string;
    milestoneStatus: MilestoneStatus;
    artifacts: StateArtifacts;
  }> = [
    {
      name: "draft only",
      milestoneStatus: "pending",
      artifacts: {
        milestonePlanDrafts: {
          "1": "milestones/10-milestone-1-plan-draft.md",
        },
      },
    },
    {
      name: "draft and review only",
      milestoneStatus: "pending",
      artifacts: {
        milestonePlanDrafts: {
          "1": "milestones/10-milestone-1-plan-draft.md",
        },
        milestonePlanReviews: {
          "1": "milestones/10-milestone-1-plan-review.md",
        },
      },
    },
    {
      name: "final plan written before planned status",
      milestoneStatus: "pending",
      artifacts: {
        milestonePlanDrafts: {
          "1": "milestones/10-milestone-1-plan-draft.md",
        },
        milestonePlanReviews: {
          "1": "milestones/10-milestone-1-plan-review.md",
        },
        milestonePlans: {
          "1": "milestones/10-milestone-1-plan.md",
        },
      },
    },
    {
      name: "final plan with planned status",
      milestoneStatus: "planned",
      artifacts: {
        milestonePlans: {
          "1": "milestones/10-milestone-1-plan.md",
        },
      },
    },
    {
      name: "missing implementation",
      milestoneStatus: "implementing",
      artifacts: {
        milestonePlans: {
          "1": "milestones/10-milestone-1-plan.md",
        },
        diffs: {
          "1": "diffs/12-milestone-1.diff",
        },
        checks: {
          "1": "checks/13-milestone-1-checks.txt",
        },
        summaries: {
          "1": "milestones/14-milestone-1-summary.md",
        },
      },
    },
    {
      name: "missing diff",
      milestoneStatus: "implementing",
      artifacts: {
        milestonePlans: {
          "1": "milestones/10-milestone-1-plan.md",
        },
        implementations: {
          "1": "milestones/11-milestone-1-implementation.md",
        },
        checks: {
          "1": "checks/13-milestone-1-checks.txt",
        },
        summaries: {
          "1": "milestones/14-milestone-1-summary.md",
        },
      },
    },
    {
      name: "missing check",
      milestoneStatus: "implementing",
      artifacts: {
        milestonePlans: {
          "1": "milestones/10-milestone-1-plan.md",
        },
        implementations: {
          "1": "milestones/11-milestone-1-implementation.md",
        },
        diffs: {
          "1": "diffs/12-milestone-1.diff",
        },
        summaries: {
          "1": "milestones/14-milestone-1-summary.md",
        },
      },
    },
  ];

  for (const testCase of cases) {
    const decision = normalizeStateForGoalResume(
      state({
        currentPhase: "implementing",
        status: "implementing",
        currentMilestoneId: 1,
        milestoneStatuses: {
          "1": testCase.milestoneStatus,
          "2": "pending",
        },
        artifacts: testCase.artifacts,
      }),
      metadata(),
    );

    assertNeedsHumanReview(
      decision,
      /transient implementation work/u,
      testCase.name,
    );
  }
});

test("normalizeStateForGoalResume recovers review transients with terminal passed proof", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "reviewing",
      status: "reviewing",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "passed",
        "2": "pending",
      },
      artifacts: {
        summaries: {
          "1-review": "milestones/25-milestone-1-review-summary.md",
        },
      },
    }),
    metadata(),
  );

  assert.deepEqual(decision, {
    kind: "normalize_to_passed",
    milestoneId: 1,
  });
});

test("normalizeStateForGoalResume refuses ambiguous review transients", () => {
  const decision = normalizeStateForGoalResume(
    state({
      currentPhase: "fixing",
      status: "fixing",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "fixing",
        "2": "pending",
      },
    }),
    metadata(),
  );

  assertNeedsHumanReview(decision, /transient review work/);
});

function assertNeedsHumanReview(
  decision: ResumeDecision,
  messagePattern: RegExp,
  message?: string,
): void {
  assert.equal(decision.kind, "needs_human_review", message);
  if (decision.kind === "needs_human_review") {
    assert.match(decision.message, messagePattern, message);
  }
}

function state(options: {
  currentPhase: OrchestratorPhase;
  status: OrchestratorPhase;
  currentMilestoneId?: number | null;
  milestoneStatuses?: Record<string, MilestoneStatus>;
  artifacts?: StateArtifacts;
}): RunState {
  const paths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });

  return {
    ...createInitialState({
      runId: "run-1",
      goal: "Add feature X",
      paths,
      git: {
        required: true,
        planningOnly: false,
        root: "/repo",
        startSha: "abc123",
        dirtyAtStart: false,
        dirtyOverride: false,
        statusPorcelain: "",
      },
      configPath: "/repo/orchestrator.config.example.json",
      configSnapshot: {
        checks: [],
        runner: { type: "fake" },
        maxFixAttempts: 0,
        artifactRoot: ".agent-work",
        milestonePlanPolicy: "always",
        milestonePlanReviewPolicy: "normal",
        humanReviewPolicy: "stop",
      },
      now: new Date("2026-05-10T12:00:00.000Z"),
    }),
    currentPhase: options.currentPhase,
    status: options.status,
    currentMilestoneId: options.currentMilestoneId ?? null,
    milestoneStatuses: options.milestoneStatuses ?? {},
    artifacts: {
      goal: "00-goal.txt",
      ...(options.artifacts ?? {}),
    },
  };
}

function readyForReviewArtifacts(milestoneId: number): StateArtifacts {
  const key = String(milestoneId);
  return {
    milestonePlans: {
      [key]: `milestones/10-milestone-${milestoneId}-plan.md`,
    },
    implementations: {
      [key]: `milestones/11-milestone-${milestoneId}-implementation.md`,
    },
    diffs: {
      [key]: `diffs/12-milestone-${milestoneId}.diff`,
    },
    checks: {
      [key]: `checks/13-milestone-${milestoneId}-checks.txt`,
    },
    summaries: {
      [key]: `milestones/14-milestone-${milestoneId}-summary.md`,
    },
  };
}

function metadata(): MilestoneMetadata {
  return {
    milestones: [
      {
        id: 1,
        title: "First milestone",
        summary: "Implement the first milestone.",
        scope: ["Create the first output"],
        acceptanceCriteria: ["The first output exists"],
        verification: ["Configured checks pass"],
        dependencies: [],
        status: "pending",
      },
      {
        id: 2,
        title: "Second milestone",
        summary: "Implement the second milestone.",
        scope: ["Create the second output"],
        acceptanceCriteria: ["The second output exists"],
        verification: ["Configured checks pass"],
        dependencies: [1],
        status: "pending",
      },
    ],
  };
}
