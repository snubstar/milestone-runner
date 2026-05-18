import assert from "node:assert/strict";
import test from "node:test";

import { buildRunPaths } from "../../src/artifacts/paths.js";
import { createInitialState } from "../../src/state/initial-state.js";
import {
  advanceToMilestoneState,
  completeGoalState,
  completePlanningState,
  failState,
  recordArtifactByKey,
  recordMilestoneArtifact,
  recordPlanningArtifact,
  setMilestoneStatus,
  setStatePhase,
  stopGoalForHumanReviewState,
} from "../../src/state/state-transitions.js";
import type { RunState } from "../../src/state/state-types.js";

test("setStatePhase updates current phase, status, and timestamp", () => {
  const state = setStatePhase(
    initialState(),
    "planning",
    new Date("2026-05-10T12:00:01.000Z"),
  );

  assert.equal(state.currentPhase, "planning");
  assert.equal(state.status, "planning");
  assert.equal(state.updatedAt, "2026-05-10T12:00:01.000Z");
});

test("recordPlanningArtifact records a run-relative planning artifact path", () => {
  const state = recordPlanningArtifact(
    initialState(),
    "majorPlan",
    "plans/01-major-plan.md",
    new Date("2026-05-10T12:00:02.000Z"),
  );

  assert.equal(state.artifacts.majorPlan, "plans/01-major-plan.md");
  assert.equal(state.artifacts.goal, "00-goal.txt");
  assert.equal(state.updatedAt, "2026-05-10T12:00:02.000Z");
});

test("completePlanningState moves state to ready_for_milestone", () => {
  const state = completePlanningState(initialState(), {
    currentMilestoneId: 1,
    milestoneStatuses: {
      "1": "pending",
      "2": "pending",
    },
    now: new Date("2026-05-10T12:00:03.000Z"),
  });

  assert.equal(state.currentPhase, "ready_for_milestone");
  assert.equal(state.status, "ready_for_milestone");
  assert.equal(state.currentMilestoneId, 1);
  assert.deepEqual(state.milestoneStatuses, {
    "1": "pending",
    "2": "pending",
  });
  assert.equal(state.lastError, null);
  assert.equal(state.updatedAt, "2026-05-10T12:00:03.000Z");
});

test("advanceToMilestoneState moves state to the selected milestone", () => {
  const state = advanceToMilestoneState(
    {
      ...initialState(),
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "passed",
        "2": "pending",
      },
      lastError: {
        message: "previous stop",
        phase: "needs_human_review",
        occurredAt: "2026-05-10T11:59:00.000Z",
      },
    },
    2,
    new Date("2026-05-10T12:00:08.000Z"),
  );

  assert.equal(state.currentPhase, "ready_for_milestone");
  assert.equal(state.status, "ready_for_milestone");
  assert.equal(state.currentMilestoneId, 2);
  assert.deepEqual(state.milestoneStatuses, {
    "1": "passed",
    "2": "pending",
  });
  assert.equal(state.lastError, null);
  assert.equal(state.updatedAt, "2026-05-10T12:00:08.000Z");
});

test("completeGoalState marks the goal passed with no active milestone", () => {
  const state = completeGoalState(
    {
      ...initialState(),
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: 2,
      milestoneStatuses: {
        "1": "passed",
        "2": "passed",
      },
      lastError: {
        message: "previous stop",
        phase: "needs_human_review",
        occurredAt: "2026-05-10T11:59:00.000Z",
      },
    },
    new Date("2026-05-10T12:00:09.000Z"),
  );

  assert.equal(state.currentPhase, "passed");
  assert.equal(state.status, "passed");
  assert.equal(state.currentMilestoneId, null);
  assert.deepEqual(state.milestoneStatuses, {
    "1": "passed",
    "2": "passed",
  });
  assert.equal(state.lastError, null);
  assert.equal(state.updatedAt, "2026-05-10T12:00:09.000Z");
});

test("stopGoalForHumanReviewState records a terminal human-review stop", () => {
  const state = stopGoalForHumanReviewState(
    {
      ...initialState(),
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "passed",
        "2": "pending",
      },
    },
    {
      message: "No pending milestone can run.",
      details: { blockedMilestoneIds: [2] },
    },
    new Date("2026-05-10T12:00:10.000Z"),
  );

  assert.equal(state.currentPhase, "needs_human_review");
  assert.equal(state.status, "needs_human_review");
  assert.equal(state.currentMilestoneId, 1);
  assert.deepEqual(state.milestoneStatuses, {
    "1": "passed",
    "2": "pending",
  });
  assert.deepEqual(state.lastError, {
    message: "No pending milestone can run.",
    phase: "needs_human_review",
    occurredAt: "2026-05-10T12:00:10.000Z",
    details: { blockedMilestoneIds: [2] },
  });
  assert.equal(state.updatedAt, "2026-05-10T12:00:10.000Z");
});

test("stopGoalForHumanReviewState can override the active milestone id", () => {
  const state = stopGoalForHumanReviewState(
    {
      ...initialState(),
      currentPhase: "ready_for_milestone",
      status: "ready_for_milestone",
      currentMilestoneId: 2,
      milestoneStatuses: {
        "1": "passed",
        "2": "pending",
      },
    },
    {
      message: "Resume state is unsafe.",
      currentMilestoneId: null,
    },
    new Date("2026-05-10T12:00:11.000Z"),
  );

  assert.equal(state.currentPhase, "needs_human_review");
  assert.equal(state.status, "needs_human_review");
  assert.equal(state.currentMilestoneId, null);
  assert.deepEqual(state.lastError, {
    message: "Resume state is unsafe.",
    phase: "needs_human_review",
    occurredAt: "2026-05-10T12:00:11.000Z",
  });
  assert.equal(state.updatedAt, "2026-05-10T12:00:11.000Z");
});

test("setStatePhase accepts ready_for_review", () => {
  const state = setStatePhase(
    initialState(),
    "ready_for_review",
    new Date("2026-05-10T12:00:04.000Z"),
  );

  assert.equal(state.currentPhase, "ready_for_review");
  assert.equal(state.status, "ready_for_review");
  assert.equal(state.updatedAt, "2026-05-10T12:00:04.000Z");
});

test("recordMilestoneArtifact records per-milestone artifact paths", () => {
  const state = recordMilestoneArtifact(
    {
      ...initialState(),
      artifacts: {
        goal: "00-goal.txt",
        milestonePlans: {
          "1": "milestones/10-milestone-1-plan.md",
        },
      },
    },
    "implementations",
    1,
    "milestones/11-milestone-1-implementation.md",
    new Date("2026-05-10T12:00:05.000Z"),
  );

  assert.deepEqual(state.artifacts.milestonePlans, {
    "1": "milestones/10-milestone-1-plan.md",
  });
  assert.deepEqual(state.artifacts.implementations, {
    "1": "milestones/11-milestone-1-implementation.md",
  });
  assert.equal(state.updatedAt, "2026-05-10T12:00:05.000Z");
});

test("recordArtifactByKey records string-keyed artifact paths", () => {
  const state = recordArtifactByKey(
    {
      ...initialState(),
      artifacts: {
        goal: "00-goal.txt",
        reviews: {
          "1": "reviews/20-milestone-1-review.json",
        },
      },
    },
    "fixes",
    "1-fix-1",
    "fixes/21-milestone-1-fix-attempt-1.md",
    new Date("2026-05-10T12:00:07.000Z"),
  );

  assert.deepEqual(state.artifacts.reviews, {
    "1": "reviews/20-milestone-1-review.json",
  });
  assert.deepEqual(state.artifacts.fixes, {
    "1-fix-1": "fixes/21-milestone-1-fix-attempt-1.md",
  });
  assert.equal(state.updatedAt, "2026-05-10T12:00:07.000Z");
});

test("setMilestoneStatus updates one milestone without changing others", () => {
  const state = setMilestoneStatus(
    {
      ...initialState(),
      milestoneStatuses: {
        "1": "pending",
        "2": "pending",
      },
    },
    1,
    "ready_for_review",
    new Date("2026-05-10T12:00:06.000Z"),
  );

  assert.deepEqual(state.milestoneStatuses, {
    "1": "ready_for_review",
    "2": "pending",
  });
  assert.equal(state.updatedAt, "2026-05-10T12:00:06.000Z");
});

test("failState records a schema-valid failure state", () => {
  const state = failState(initialState(), {
    phase: "plan_reviewing",
    message: "Runner failed",
    details: { exitCode: 1 },
    now: new Date("2026-05-10T12:00:04.000Z"),
  });

  assert.equal(state.currentPhase, "plan_reviewing");
  assert.equal(state.status, "failed");
  assert.deepEqual(state.lastError, {
    message: "Runner failed",
    phase: "plan_reviewing",
    occurredAt: "2026-05-10T12:00:04.000Z",
    details: { exitCode: 1 },
  });
  assert.equal(state.updatedAt, "2026-05-10T12:00:04.000Z");
});

function initialState(): RunState {
  const paths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });

  return createInitialState({
    runId: "run-1",
    goal: "Add feature X",
    paths,
    git: {
      required: false,
      planningOnly: true,
      root: null,
      startSha: null,
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
    },
    now: new Date("2026-05-10T12:00:00.000Z"),
  });
}
