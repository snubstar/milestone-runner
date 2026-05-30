import assert from "node:assert/strict";
import test from "node:test";

import { buildRunPaths } from "../../src/artifacts/paths.js";
import type { MilestoneMetadata } from "../../src/milestones/milestone-types.js";
import {
  parseResumeResolutionJson,
  validateResumeResolution,
  validateResumeResolutionAction,
} from "../../src/orchestration/resume-resolution-validator.js";
import { createInitialState } from "../../src/state/initial-state.js";
import type { RunState } from "../../src/state/state-types.js";

const validResolution = {
  action: "normalize_to_ready_for_review",
  summary: "Normalize the active milestone to ready for review.",
  rationale: "All required implementation artifacts are present.",
  assumptions: ["The recorded check artifact is the latest check result."],
  currentMilestoneId: 1,
};

test("validateResumeResolution accepts a resume action document", () => {
  const result = validateResumeResolution(validResolution);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.action, "normalize_to_ready_for_review");
  assert.deepEqual(result.value.assumptions, [
    "The recorded check artifact is the latest check result.",
  ]);
});

test("parseResumeResolutionJson parses and validates JSON", () => {
  const result = parseResumeResolutionJson(JSON.stringify(validResolution));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.currentMilestoneId, 1);
});

test("parseResumeResolutionJson rejects invalid JSON", () => {
  const result = parseResumeResolutionJson("not json");

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Invalid resume resolution JSON/);
});

test("validateResumeResolution rejects unsupported fields", () => {
  const result = validateResumeResolution({
    ...validResolution,
    artifactPath: "milestones/14-milestone-1-summary.md",
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /unsupported fields: artifactPath/);
});

test("validateResumeResolutionAction accepts ready-for-review normalization with required artifacts", () => {
  const state = readyState();
  const parsed = validateResumeResolution(validResolution);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const error = validateResumeResolutionAction(parsed.value, {
    state,
    metadata: metadata(),
    originalDecision: resumeDecision(),
    existingArtifacts: new Set(requiredReadyForReviewArtifactPaths()),
  });

  assert.equal(error, null);
});

test("validateResumeResolutionAction rejects normalization that skips required artifacts", () => {
  const state = readyState({
    artifacts: {
      milestonePlans: { "1": "milestones/10-milestone-1-plan.md" },
    },
  });
  const parsed = validateResumeResolution(validResolution);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const error = validateResumeResolutionAction(parsed.value, {
    state,
    metadata: metadata(),
    originalDecision: resumeDecision(),
    existingArtifacts: new Set(["milestones/10-milestone-1-plan.md"]),
  });

  assert.match(error ?? "", /missing required artifacts/);
  assert.match(error ?? "", /implementations/);
});

test("validateResumeResolutionAction rejects passed normalization without review artifacts", () => {
  const state = readyState({
    milestoneStatuses: { "1": "passed", "2": "pending" },
  });
  const parsed = validateResumeResolution({
    ...validResolution,
    action: "normalize_to_passed",
    summary: "Normalize passed.",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const error = validateResumeResolutionAction(parsed.value, {
    state,
    metadata: metadata(),
    originalDecision: resumeDecision(),
    existingArtifacts: new Set(requiredReadyForReviewArtifactPaths()),
  });

  assert.match(error ?? "", /missing required artifacts/);
  assert.match(error ?? "", /reviewSummary/);
  assert.match(error ?? "", /review/);
});

function resumeDecision(): Parameters<typeof validateResumeResolutionAction>[1]["originalDecision"] {
  return {
    kind: "needs_human_review",
    message: "Resume ready_for_review state does not have a ready_for_review active milestone.",
    details: { milestoneId: 1 },
    currentMilestoneId: 1,
  };
}

function readyState(options: Partial<RunState> = {}): RunState {
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
        humanReviewPolicy: "autonomous",
      },
      now: new Date("2026-05-10T12:00:00.000Z"),
    }),
    currentPhase: "ready_for_review",
    status: "ready_for_review",
    currentMilestoneId: 1,
    milestoneStatuses: {
      "1": "planned",
      "2": "pending",
    },
    artifacts: {
      goal: "00-goal.txt",
      ...requiredReadyForReviewArtifacts(),
    },
    ...options,
  };
}

function requiredReadyForReviewArtifacts(): RunState["artifacts"] {
  return {
    milestonePlans: {
      "1": "milestones/10-milestone-1-plan.md",
    },
    implementations: {
      "1": "milestones/11-milestone-1-implementation.md",
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
  };
}

function requiredReadyForReviewArtifactPaths(): string[] {
  const artifacts = requiredReadyForReviewArtifacts();
  return [
    artifacts.milestonePlans?.["1"],
    artifacts.implementations?.["1"],
    artifacts.diffs?.["1"],
    artifacts.checks?.["1"],
    artifacts.summaries?.["1"],
  ].filter((artifactPath): artifactPath is string => artifactPath !== undefined);
}

function metadata(): MilestoneMetadata {
  return {
    milestones: [
      {
        id: 1,
        title: "First milestone",
        summary: "Implement the first milestone.",
        scope: ["Create output"],
        acceptanceCriteria: ["Output exists"],
        verification: ["Checks pass"],
        dependencies: [],
        status: "pending",
      },
      {
        id: 2,
        title: "Second milestone",
        summary: "A dependent milestone.",
        scope: ["Remain pending"],
        acceptanceCriteria: ["State inspection"],
        verification: ["State inspection"],
        dependencies: [1],
        status: "pending",
      },
    ],
  };
}
