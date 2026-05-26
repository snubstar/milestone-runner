import assert from "node:assert/strict";
import test from "node:test";

import type { MilestoneMetadata } from "../../src/milestones/milestone-types.js";
import { selectNextRunnableMilestone } from "../../src/orchestration/milestone-selector.js";
import type { MilestoneStatus, RunState } from "../../src/state/state-types.js";

type SelectorState = Pick<RunState, "currentMilestoneId" | "milestoneStatuses">;

test("selectNextRunnableMilestone selects the lowest runnable pending milestone", () => {
  const decision = selectNextRunnableMilestone(testMetadata(), state({
    "1": "passed",
    "2": "pending",
    "3": "pending",
  }));

  assert.equal(decision.kind, "runnable");
  if (decision.kind === "runnable") {
    assert.equal(decision.milestone.id, 2);
  }
});

test("selectNextRunnableMilestone returns complete when all milestones passed", () => {
  const decision = selectNextRunnableMilestone(testMetadata(), state({
    "1": "passed",
    "2": "passed",
    "3": "passed",
  }));

  assert.deepEqual(decision, { kind: "complete" });
});

test("selectNextRunnableMilestone blocks when a milestone is failed", () => {
  const decision = selectNextRunnableMilestone(testMetadata(), state({
    "1": "failed",
    "2": "pending",
    "3": "pending",
  }));

  assert.equal(decision.kind, "blocked");
  if (decision.kind === "blocked") {
    assert.match(decision.message, /already blocked/);
  }
});

test("selectNextRunnableMilestone blocks active in-progress milestones", () => {
  const decision = selectNextRunnableMilestone(testMetadata(), state({
    "1": "passed",
    "2": "checking",
    "3": "pending",
  }, 2));

  assert.equal(decision.kind, "blocked");
  if (decision.kind === "blocked") {
    assert.match(decision.message, /must finish/);
  }
});

test("selectNextRunnableMilestone blocks pending milestones with unmet dependencies", () => {
  const metadata = testMetadata();
  metadata.milestones[0].dependencies = [99];

  const decision = selectNextRunnableMilestone(metadata, state({
    "1": "pending",
    "2": "pending",
    "3": "pending",
  }));

  assert.equal(decision.kind, "blocked");
  if (decision.kind === "blocked") {
    assert.match(decision.message, /none have all dependencies passed/);
  }
});

test("selectNextRunnableMilestone invalidates missing metadata milestone statuses", () => {
  const decision = selectNextRunnableMilestone(testMetadata(), state({
    "1": "passed",
    "2": "pending",
  }));

  assert.equal(decision.kind, "invalid_state");
  if (decision.kind === "invalid_state") {
    assert.match(decision.message, /missing statuses/);
  }
});

test("selectNextRunnableMilestone invalidates state milestone ids missing from metadata", () => {
  const decision = selectNextRunnableMilestone(testMetadata(), state({
    "1": "passed",
    "2": "pending",
    "3": "pending",
    "99": "pending",
  }));

  assert.equal(decision.kind, "invalid_state");
  if (decision.kind === "invalid_state") {
    assert.match(decision.message, /missing from metadata/);
  }
});

test("selectNextRunnableMilestone invalidates current milestone ids missing from metadata", () => {
  const decision = selectNextRunnableMilestone(testMetadata(), state({
    "1": "passed",
    "2": "pending",
    "3": "pending",
  }, 99));

  assert.equal(decision.kind, "invalid_state");
  if (decision.kind === "invalid_state") {
    assert.match(decision.message, /Current milestone 99/);
  }
});

test("selectNextRunnableMilestone invalidates duplicate metadata ids", () => {
  const metadata = testMetadata();
  metadata.milestones[2].id = 2;

  const decision = selectNextRunnableMilestone(metadata, state({
    "1": "passed",
    "2": "pending",
  }));

  assert.equal(decision.kind, "invalid_state");
  if (decision.kind === "invalid_state") {
    assert.match(decision.message, /duplicate ids/);
  }
});

test("selectNextRunnableMilestone invalidates nonterminal statuses that do not match currentMilestoneId", () => {
  const decision = selectNextRunnableMilestone(testMetadata(), state({
    "1": "passed",
    "2": "ready_for_review",
    "3": "pending",
  }, 1));

  assert.equal(decision.kind, "invalid_state");
  if (decision.kind === "invalid_state") {
    assert.match(decision.message, /do not match currentMilestoneId/);
  }
});

test("selectNextRunnableMilestone invalidates invalid milestone statuses", () => {
  const decision = selectNextRunnableMilestone(testMetadata(), state({
    "1": "passed",
    "2": "done" as MilestoneStatus,
    "3": "pending",
  }));

  assert.equal(decision.kind, "invalid_state");
  if (decision.kind === "invalid_state") {
    assert.match(decision.message, /invalid milestone statuses/);
  }
});

function state(
  milestoneStatuses: Record<string, MilestoneStatus>,
  currentMilestoneId: number | null = null,
): SelectorState {
  return {
    currentMilestoneId,
    milestoneStatuses,
  };
}

function testMetadata(): MilestoneMetadata {
  return {
    milestones: [
      {
        id: 1,
        title: "First milestone",
        summary: "Set up the first change.",
        scope: ["Create the first artifact"],
        acceptanceCriteria: ["First artifact exists"],
        verification: ["npm run test:build"],
        dependencies: [],
        status: "pending",
      },
      {
        id: 2,
        title: "Second milestone",
        summary: "Build on the first change.",
        scope: ["Create the second artifact"],
        acceptanceCriteria: ["Second artifact exists"],
        verification: ["npm run test:build"],
        dependencies: [1],
        status: "pending",
      },
      {
        id: 3,
        title: "Third milestone",
        summary: "Build on the first change after milestone 2.",
        scope: ["Create the third artifact"],
        acceptanceCriteria: ["Third artifact exists"],
        verification: ["npm run test:build"],
        dependencies: [1],
        status: "pending",
      },
    ],
  };
}
