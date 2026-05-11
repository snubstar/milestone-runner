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
): void {
  assert.equal(decision.kind, "needs_human_review");
  if (decision.kind === "needs_human_review") {
    assert.match(decision.message, messagePattern);
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
