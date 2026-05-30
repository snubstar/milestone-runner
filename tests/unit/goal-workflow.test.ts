import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildRunPaths, type RunPaths } from "../../src/artifacts/paths.js";
import { buildTimingArtifactPaths } from "../../src/artifacts/timing-artifacts.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import type { OrchestratorConfig } from "../../src/config/config-types.js";
import { runGoalWorkflow } from "../../src/orchestration/goal-workflow.js";
import type { GoalWorkflowOptions } from "../../src/orchestration/goal-workflow-types.js";
import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
} from "../../src/runners/agent-runner.js";
import { FakeRunner } from "../../src/runners/fake/fake-runner.js";
import { nodeCommandRunner } from "../../src/shell/command-runner.js";
import { createInitialState } from "../../src/state/initial-state.js";
import { readState, writeState } from "../../src/state/state-store.js";
import type { RunState } from "../../src/state/state-types.js";
import { createFixtureRepo } from "../helpers/fixture-repo.js";
import {
  createReadyForMilestoneRunFixture,
  createReadyForReviewRunFixture,
  sequenceClock,
} from "../helpers/run-fixture.js";
import { ScenarioRunner } from "../helpers/scenario-runner.js";

test("runGoalWorkflow completes the full fake multi-milestone path", async () => {
  const context = await createGoalContext();
  try {
    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(result.state.currentPhase, "passed");
    assert.equal(result.state.status, "passed");
    assert.equal(result.state.currentMilestoneId, null);
    assert.deepEqual(result.state.milestoneStatuses, {
      "1": "passed",
      "2": "passed",
    });
    assert.equal(
      result.state.artifacts.summaries?.goal,
      path.join("milestones", "90-goal-summary.md"),
    );
    await assertTimingArtifacts(context.paths, result.state);
    assert.deepEqual(
      runner.requests.map(({ phase, milestoneId }) => ({
        phase,
        milestoneId: milestoneId ?? null,
      })),
      [
        { phase: "major_plan", milestoneId: null },
        { phase: "major_plan_review", milestoneId: null },
        { phase: "final_major_plan", milestoneId: null },
        { phase: "final_plan_json", milestoneId: null },
        { phase: "milestone_plan", milestoneId: 1 },
        { phase: "implement_milestone", milestoneId: 1 },
        { phase: "review_milestone", milestoneId: 1 },
        { phase: "milestone_plan", milestoneId: 2 },
        { phase: "implement_milestone", milestoneId: 2 },
        { phase: "review_milestone", milestoneId: 2 },
      ],
    );

    await access(path.join(context.repo, "fake-milestone-1-implementation.txt"));
    await access(path.join(context.repo, "fake-milestone-2-implementation.txt"));

    const milestoneTwoDiff = await readFile(
      path.join(context.paths.dirs.diffs, "12-milestone-2.diff"),
      "utf8",
    );
    assert.match(
      milestoneTwoDiff,
      /diff --git a\/fake-milestone-2-implementation\.txt b\/fake-milestone-2-implementation\.txt/,
    );
    assert.doesNotMatch(milestoneTwoDiff, /fake-milestone-1-implementation\.txt/);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: passed/);
    assert.match(summary, /Current milestone: none/);
    assert.match(summary, /- 1: Planning workflow/);
    assert.match(summary, /- 2: First implementation milestone/);
    assert.match(summary, /fake-milestone-1-implementation\.txt/);
    assert.match(summary, /fake-milestone-2-implementation\.txt/);
    assert.match(summary, /Milestone 1: reviews\/20-milestone-1-review\.json \(pass\)/);
    assert.match(summary, /Milestone 2: reviews\/20-milestone-2-review\.json \(pass\)/);

    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow completes the full scrupulous fake multi-milestone path", async () => {
  const context = await createGoalContext({
    config: testConfig({ milestonePlanReviewPolicy: "scrupulous" }),
  });
  try {
    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.currentPhase, "passed");
    assert.equal(result.state.status, "passed");
    assert.deepEqual(
      runner.requests.map(({ phase, milestoneId }) => ({
        phase,
        milestoneId: milestoneId ?? null,
      })),
      [
        { phase: "major_plan", milestoneId: null },
        { phase: "major_plan_review", milestoneId: null },
        { phase: "final_major_plan", milestoneId: null },
        { phase: "final_plan_json", milestoneId: null },
        { phase: "milestone_plan", milestoneId: 1 },
        { phase: "milestone_plan_review", milestoneId: 1 },
        { phase: "final_milestone_plan", milestoneId: 1 },
        { phase: "implement_milestone", milestoneId: 1 },
        { phase: "review_milestone", milestoneId: 1 },
        { phase: "milestone_plan", milestoneId: 2 },
        { phase: "milestone_plan_review", milestoneId: 2 },
        { phase: "final_milestone_plan", milestoneId: 2 },
        { phase: "implement_milestone", milestoneId: 2 },
        { phase: "review_milestone", milestoneId: 2 },
      ],
    );

    for (const milestoneId of [1, 2]) {
      const key = String(milestoneId);
      const artifactPaths = [
        [
          result.state.artifacts.milestonePlanDrafts?.[key],
          path.join("milestones", `10-milestone-${milestoneId}-plan-draft.md`),
        ],
        [
          result.state.artifacts.milestonePlanReviews?.[key],
          path.join("milestones", `10-milestone-${milestoneId}-plan-review.md`),
        ],
        [
          result.state.artifacts.milestonePlans?.[key],
          path.join("milestones", `10-milestone-${milestoneId}-plan.md`),
        ],
        [
          result.state.artifacts.implementations?.[key],
          path.join("milestones", `11-milestone-${milestoneId}-implementation.md`),
        ],
        [
          result.state.artifacts.diffs?.[key],
          path.join("diffs", `12-milestone-${milestoneId}.diff`),
        ],
        [
          result.state.artifacts.checks?.[key],
          path.join("checks", `13-milestone-${milestoneId}-checks.txt`),
        ],
        [
          result.state.artifacts.summaries?.[key],
          path.join("milestones", `14-milestone-${milestoneId}-summary.md`),
        ],
        [
          result.state.artifacts.reviews?.[key],
          path.join("reviews", `20-milestone-${milestoneId}-review.json`),
        ],
      ] as const;

      for (const [actual, expected] of artifactPaths) {
        assert.equal(actual, expected);
        await access(path.join(context.paths.runDir, expected));
      }

      assert.match(
        await readFile(
          path.join(context.paths.dirs.milestones, `10-milestone-${milestoneId}-plan.md`),
          "utf8",
        ),
        new RegExp(`^# Fake Final Milestone ${milestoneId} Plan`),
      );
      assert.match(
        await readFile(
          path.join(
            context.paths.dirs.milestones,
            `10-milestone-${milestoneId}-plan-review.md`,
          ),
          "utf8",
        ),
        new RegExp(`^# Fake Milestone ${milestoneId} Plan Review`),
      );
      await access(path.join(context.repo, `fake-milestone-${milestoneId}-implementation.txt`));
    }
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow stops after planning when planningOnly is true", async () => {
  const context = await createGoalContext();
  try {
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      planningOnly: true,
      runner: new FakeRunner(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.currentPhase, "ready_for_milestone");
    assert.equal(result.state.status, "ready_for_milestone");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.deepEqual(result.state.milestoneStatuses, {
      "1": "pending",
      "2": "pending",
    });
    assert.equal(result.state.artifacts.summaries?.goal, undefined);
    await assertTimingArtifacts(context.paths, result.state);

    await assert.rejects(
      access(path.join(context.repo, "fake-milestone-1-implementation.txt")),
    );
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow preserves primary outcome when timing finalization fails", async () => {
  const context = await createGoalContext();
  try {
    const timingPaths = buildTimingArtifactPaths(context.paths);
    await mkdir(timingPaths.files.timingsMarkdown);

    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      planningOnly: true,
      runner: new FakeRunner(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.currentPhase, "ready_for_milestone");
    assert.equal(result.state.status, "ready_for_milestone");
    assert.equal(result.state.artifacts.logs?.timingsJson, undefined);
    assert.equal(result.state.artifacts.logs?.timingsMarkdown, undefined);
    assert.equal(
      result.timingWarnings?.some(
        (warning) => warning.code === "timing_finalization_failed",
      ),
      true,
    );
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow surfaces nested workflow timeline append warnings", async () => {
  const context = await createGoalContext();
  try {
    const timingPaths = buildTimingArtifactPaths(context.paths);
    await mkdir(timingPaths.files.timeline);

    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      planningOnly: true,
      runner: new FakeRunner(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.currentPhase, "ready_for_milestone");
    assert.equal(
      result.timingWarnings?.some(
        (warning) =>
          warning.code === "timeline_incomplete" &&
          warning.message.includes("phase_changed"),
      ),
      true,
    );
    assert.equal(result.state.artifacts.logs?.timingsJson, path.join("logs", "80-timings.json"));
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow stops after a constrained target milestone passes", async () => {
  const context = await createGoalContext();
  try {
    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
      executionLimits: {
        targetMilestoneId: 1,
        stopAfterTargetMilestone: true,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.nextAction, "resume without --milestone to continue remaining milestones");
    assert.equal(result.state.currentPhase, "passed");
    assert.equal(result.state.status, "passed");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.deepEqual(result.state.milestoneStatuses, {
      "1": "passed",
      "2": "pending",
    });
    assert.equal(result.state.artifacts.summaries?.goal, undefined);
    await assertTimingArtifacts(context.paths, result.state);
    assert.deepEqual(
      runner.requests.map(({ phase, milestoneId }) => ({
        phase,
        milestoneId: milestoneId ?? null,
      })),
      [
        { phase: "major_plan", milestoneId: null },
        { phase: "major_plan_review", milestoneId: null },
        { phase: "final_major_plan", milestoneId: null },
        { phase: "final_plan_json", milestoneId: null },
        { phase: "milestone_plan", milestoneId: 1 },
        { phase: "implement_milestone", milestoneId: 1 },
        { phase: "review_milestone", milestoneId: 1 },
      ],
    );

    await access(path.join(context.repo, "fake-milestone-1-implementation.txt"));
    await assert.rejects(
      access(path.join(context.repo, "fake-milestone-2-implementation.txt")),
    );
    await assert.rejects(
      access(path.join(context.paths.dirs.milestones, "90-goal-summary.md")),
    );
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow rejects a constrained target with unmet dependencies", async () => {
  const context = await createGoalContext();
  try {
    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
      executionLimits: {
        targetMilestoneId: 2,
        stopAfterTargetMilestone: true,
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Target milestone 2 cannot run/);
    assert.match(result.error ?? "", /dependencies are not passed: 1/);
    assert.equal(result.state.currentPhase, "ready_for_milestone");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.deepEqual(result.state.milestoneStatuses, {
      "1": "pending",
      "2": "pending",
    });
    assert.equal(
      runner.requests.some((request) => request.milestoneId !== undefined),
      false,
    );
    await assert.rejects(
      access(path.join(context.repo, "fake-milestone-1-implementation.txt")),
    );
    await assert.rejects(
      access(path.join(context.paths.dirs.milestones, "90-goal-summary.md")),
    );
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow rejects a constrained target missing from metadata", async () => {
  const context = await createGoalContext();
  try {
    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
      executionLimits: {
        targetMilestoneId: 99,
        stopAfterTargetMilestone: true,
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Target milestone 99 was not found/);
    assert.equal(result.state.currentPhase, "ready_for_milestone");
    assert.equal(
      runner.requests.some((request) => request.milestoneId !== undefined),
      false,
    );
    await assert.rejects(
      access(path.join(context.paths.dirs.milestones, "90-goal-summary.md")),
    );
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow resumes a passed milestone by advancing to the next pending milestone", async () => {
  const fixtureRepo = await createFixtureRepo({
    prefix: "milestone-runner-goal-workflow-resume-",
    gitignore: ".agent-work/\n",
    files: {
      "README.md": "# Fixture\n",
    },
  });

  try {
    const runFixture = await createReadyForMilestoneRunFixture({
      cwd: fixtureRepo.path,
      startSha: await fixtureRepo.git(["rev-parse", "HEAD"]),
      config: testConfig(),
    });
    const resumeState: RunState = {
      ...runFixture.state,
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "passed",
        "2": "pending",
      },
      updatedAt: "2026-05-10T12:00:20.000Z",
    };
    await writeState(runFixture.paths.files.state, resumeState);

    const result = await runGoalWorkflow({
      goal: runFixture.goal,
      config: runFixture.config,
      paths: runFixture.paths,
      initialState: resumeState,
      runner: new FakeRunner(),
      commandRunner: nodeCommandRunner,
      cwd: fixtureRepo.path,
      promptDir: promptDir(),
      now: sequenceClock("2026-05-10T12:03:00.000Z"),
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.currentPhase, "passed");
    assert.equal(result.state.status, "passed");
    assert.equal(result.state.currentMilestoneId, null);
    assert.deepEqual(result.state.milestoneStatuses, {
      "1": "passed",
      "2": "passed",
    });
    assert.equal(
      result.state.artifacts.summaries?.goal,
      path.join("milestones", "90-goal-summary.md"),
    );

    await assert.rejects(
      access(path.join(fixtureRepo.path, "fake-milestone-1-implementation.txt")),
    );
    await access(path.join(fixtureRepo.path, "fake-milestone-2-implementation.txt"));
    assert.deepEqual(await readState(runFixture.paths.files.state), result.state);
  } finally {
    await fixtureRepo.cleanup();
  }
});

test("runGoalWorkflow resumes ready_for_milestone without rerunning planning", async () => {
  const context = await createReadyGoalContext();
  try {
    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.currentPhase, "passed");
    assert.equal(result.state.status, "passed");
    assert.equal(result.state.currentMilestoneId, null);
    assert.deepEqual(result.state.milestoneStatuses, {
      "1": "passed",
      "2": "passed",
    });
    assert.deepEqual(
      runner.requests.slice(0, 3).map(({ phase, milestoneId }) => ({
        phase,
        milestoneId: milestoneId ?? null,
      })),
      [
        { phase: "milestone_plan", milestoneId: 1 },
        { phase: "implement_milestone", milestoneId: 1 },
        { phase: "review_milestone", milestoneId: 1 },
      ],
    );
    assert.equal(
      runner.requests.some((request) => request.phase === "major_plan"),
      false,
    );

    await access(path.join(context.repo, "fake-milestone-1-implementation.txt"));
    await access(path.join(context.repo, "fake-milestone-2-implementation.txt"));
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow resumes ready_for_review without rerunning implementation", async () => {
  const context = await createReadyReviewGoalContext();
  try {
    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.currentPhase, "passed");
    assert.equal(result.state.status, "passed");
    assert.equal(result.state.currentMilestoneId, null);
    assert.deepEqual(result.state.milestoneStatuses, {
      "1": "passed",
      "2": "passed",
    });
    assert.deepEqual(
      runner.requests.slice(0, 1).map(({ phase, milestoneId }) => ({
        phase,
        milestoneId: milestoneId ?? null,
      })),
      [{ phase: "review_milestone", milestoneId: 1 }],
    );
    assert.equal(
      runner.requests.some(
        (request) =>
          request.milestoneId === 1 &&
          (request.phase === "milestone_plan" ||
            request.phase === "implement_milestone"),
      ),
      false,
    );

    await assert.rejects(
      access(path.join(context.repo, "fake-milestone-1-implementation.txt")),
    );
    await access(path.join(context.repo, "fake-milestone-2-implementation.txt"));
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow resumes fully passed state by writing the missing final summary", async () => {
  const context = await createReadyGoalContext();
  try {
    const passedState: RunState = {
      ...context.workflowOptions.initialState,
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: 2,
      milestoneStatuses: {
        "1": "passed",
        "2": "passed",
      },
      updatedAt: "2026-05-10T12:00:20.000Z",
    };
    await writeState(context.paths.files.state, passedState);

    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      initialState: passedState,
      runner,
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.currentPhase, "passed");
    assert.equal(result.state.status, "passed");
    assert.equal(result.state.currentMilestoneId, null);
    assert.deepEqual(result.state.milestoneStatuses, {
      "1": "passed",
      "2": "passed",
    });
    assert.equal(
      result.state.artifacts.summaries?.goal,
      path.join("milestones", "90-goal-summary.md"),
    );
    assert.deepEqual(runner.requests, []);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: passed/);
    assert.match(summary, /Current milestone: none/);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow stops for human review on unsafe implementation resume", async () => {
  const context = await createReadyGoalContext();
  try {
    const unsafeState: RunState = {
      ...context.workflowOptions.initialState,
      currentPhase: "implementing",
      status: "implementing",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "implementing",
        "2": "pending",
      },
      updatedAt: "2026-05-10T12:00:20.000Z",
    };
    await writeState(context.paths.files.state, unsafeState);

    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      initialState: unsafeState,
      runner,
    });

    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.equal(result.state.status, "needs_human_review");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "implementing");
    assert.match(result.state.lastError?.message ?? "", /transient implementation work/);
    assert.equal(
      result.state.artifacts.summaries?.goal,
      path.join("milestones", "90-goal-summary.md"),
    );
    assert.deepEqual(runner.requests, []);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: needs_human_review/);
    assert.match(summary, /transient implementation work/);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow fails unsafe implementation resume under fail policy", async () => {
  const context = await createReadyGoalContext({
    config: testConfig({ humanReviewPolicy: "fail" }),
  });
  try {
    const unsafeState: RunState = {
      ...context.workflowOptions.initialState,
      currentPhase: "implementing",
      status: "implementing",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "implementing",
        "2": "pending",
      },
      updatedAt: "2026-05-10T12:00:20.000Z",
    };
    await writeState(context.paths.files.state, unsafeState);

    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      initialState: unsafeState,
      runner,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /transient implementation work/);
    assert.equal(result.state.currentPhase, "failed");
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.equal(result.state.milestoneStatuses["2"], "pending");
    assert.deepEqual(runner.requests, []);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: failed/);
    assert.match(summary, /transient implementation work/);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow resolves ambiguous ready-for-review resume autonomously", async () => {
  const context = await createReadyReviewGoalContext({
    config: testConfig({ humanReviewPolicy: "autonomous" }),
  });
  try {
    const ambiguousState: RunState = {
      ...context.workflowOptions.initialState,
      currentPhase: "ready_for_review",
      status: "ready_for_review",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "planned",
        "2": "pending",
      },
      updatedAt: "2026-05-10T12:00:20.000Z",
    };
    await writeState(context.paths.files.state, ambiguousState);

    const runner = new RecordingRunner(new FakeRunner(), [
      {
        phase: "resolve_resume_state",
        milestoneId: 1,
        result: resumeResolutionResult({
          action: "normalize_to_ready_for_review",
          summary: "Normalize milestone 1 to ready for review.",
        }),
      },
    ]);
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      initialState: ambiguousState,
      runner,
      executionLimits: {
        targetMilestoneId: 1,
        stopAfterTargetMilestone: true,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.currentPhase, "passed");
    assert.equal(result.state.status, "passed");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "passed");
    assert.equal(result.state.milestoneStatuses["2"], "pending");
    assert.equal(
      result.state.artifacts.logs?.["resume-resolution-1"],
      path.join("logs", "resolve-resume-state-1.json"),
    );
    assert.deepEqual(
      runner.requests.slice(0, 2).map(({ phase, milestoneId }) => ({
        phase,
        milestoneId: milestoneId ?? null,
      })),
      [
        { phase: "resolve_resume_state", milestoneId: 1 },
        { phase: "review_milestone", milestoneId: 1 },
      ],
    );

    const resolution = JSON.parse(
      await readFile(
        path.join(context.paths.dirs.logs, "resolve-resume-state-1.json"),
        "utf8",
      ),
    ) as { status?: string; resolution?: { action?: string } };
    assert.equal(resolution.status, "resolved");
    assert.equal(resolution.resolution?.action, "normalize_to_ready_for_review");
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow fails invalid autonomous resume resolution instead of asking for review", async () => {
  const context = await createReadyReviewGoalContext({
    config: testConfig({ humanReviewPolicy: "autonomous" }),
  });
  try {
    const ambiguousState: RunState = {
      ...context.workflowOptions.initialState,
      currentPhase: "ready_for_review",
      status: "ready_for_review",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "planned",
        "2": "pending",
      },
      updatedAt: "2026-05-10T12:00:20.000Z",
    };
    await writeState(context.paths.files.state, ambiguousState);

    const runner = new RecordingRunner(new FakeRunner(), [
      {
        phase: "resolve_resume_state",
        milestoneId: 1,
        result: resumeResolutionResult({
          action: "normalize_to_passed",
          summary: "Incorrectly normalize milestone 1 to passed.",
        }),
      },
      {
        phase: "resolve_resume_state",
        milestoneId: 1,
        result: resumeResolutionResult({
          action: "normalize_to_passed",
          summary: "Incorrectly normalize milestone 1 to passed again.",
        }),
      },
    ]);
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      initialState: ambiguousState,
      runner,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Resume state resolution failed after 2 attempt/);
    assert.equal(result.state.currentPhase, "failed");
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.equal(result.state.milestoneStatuses["2"], "pending");
    assert.equal(
      result.state.artifacts.logs?.["resume-resolution-2"],
      path.join("logs", "resolve-resume-state-2.json"),
    );
    assert.equal(
      runner.requests.some((request) => request.phase === "review_milestone"),
      false,
    );

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: failed/);
    assert.match(summary, /Resume state resolution failed after 2 attempt\(s\)\./);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow preserves already-terminal human-review resume under autonomous policy", async () => {
  const context = await createReadyReviewGoalContext({
    config: testConfig({ humanReviewPolicy: "autonomous" }),
  });
  try {
    const terminalState: RunState = {
      ...context.workflowOptions.initialState,
      currentPhase: "needs_human_review",
      status: "needs_human_review",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "needs_human_review",
        "2": "pending",
      },
      lastError: {
        message: "Legacy run already stopped for human review.",
        phase: "needs_human_review",
        occurredAt: "2026-05-10T12:00:20.000Z",
      },
      updatedAt: "2026-05-10T12:00:20.000Z",
    };
    await writeState(context.paths.files.state, terminalState);

    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      initialState: terminalState,
      runner,
    });

    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.equal(result.state.status, "needs_human_review");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "needs_human_review");
    assert.deepEqual(runner.requests, []);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: needs_human_review/);
    assert.match(summary, /Legacy run already stopped for human review/);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow stops for human review on unsafe review resume", async () => {
  const context = await createReadyReviewGoalContext();
  try {
    const unsafeState: RunState = {
      ...context.workflowOptions.initialState,
      currentPhase: "reviewing",
      status: "reviewing",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "reviewing",
        "2": "pending",
      },
      updatedAt: "2026-05-10T12:00:20.000Z",
    };
    await writeState(context.paths.files.state, unsafeState);

    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      initialState: unsafeState,
      runner,
    });

    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.equal(result.state.status, "needs_human_review");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "reviewing");
    assert.match(result.state.lastError?.message ?? "", /transient review work/);
    assert.equal(
      result.state.artifacts.summaries?.goal,
      path.join("milestones", "90-goal-summary.md"),
    );
    assert.deepEqual(runner.requests, []);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: needs_human_review/);
    assert.match(summary, /transient review work/);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow does not request milestone 2 when milestone 1 implementation fails", async () => {
  const context = await createReadyGoalContext();
  try {
    const runner = new ScenarioRunner([
      {
        phase: "milestone_plan",
        text: "# Milestone 1 Plan",
        exitCode: 0,
      },
      {
        phase: "implement_milestone",
        text: "implementation failed",
        exitCode: 1,
      },
    ]);

    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /implement_milestone failed/);
    assert.equal(result.state.currentPhase, "implementing");
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.equal(result.state.milestoneStatuses["2"], "pending");
    assert.equal(
      result.state.artifacts.summaries?.goal,
      path.join("milestones", "90-goal-summary.md"),
    );
    assertNoMilestone2Requests(runner.requests);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: failed/);
    assert.match(summary, /## Failed Milestones/);
    assert.match(summary, /- 1: First milestone/);
    assert.match(summary, /Stop reason: Runner phase implement_milestone failed with exit code 1\./);

    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow preserves failed state when final summary writing fails", async () => {
  const context = await createReadyGoalContext();
  try {
    await mkdir(path.join(context.paths.dirs.milestones, "90-goal-summary.md"));

    const runner = new ScenarioRunner([
      {
        phase: "milestone_plan",
        text: "# Milestone 1 Plan",
        exitCode: 0,
      },
      {
        phase: "implement_milestone",
        text: "implementation failed",
        exitCode: 1,
      },
    ]);

    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Runner phase implement_milestone failed/);
    assert.match(result.error ?? "", /Failed to write goal summary/);
    assert.equal(result.state.currentPhase, "implementing");
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.equal(result.state.milestoneStatuses["2"], "pending");
    assert.equal(result.state.artifacts.summaries?.goal, undefined);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow does not request milestone 2 when milestone 1 checks fail", async () => {
  const context = await createReadyGoalContext({
    config: testConfig({
      checks: [
        `${JSON.stringify(process.execPath)} -e "process.stderr.write('check failed'); process.exit(2)"`,
      ],
    }),
  });
  try {
    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Checks failed for milestone 1/);
    assert.equal(result.state.currentPhase, "checking");
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.equal(result.state.milestoneStatuses["2"], "pending");
    assert.equal(
      result.state.artifacts.summaries?.goal,
      path.join("milestones", "90-goal-summary.md"),
    );
    assertNoMilestone2Requests(runner.requests);

    const checks = await readFile(
      path.join(context.paths.dirs.checks, "13-milestone-1-checks.txt"),
      "utf8",
    );
    assert.match(checks, /Overall: failed/);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: failed/);
    assert.match(summary, /Stop reason: Checks failed for milestone 1\./);

    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow does not request milestone 2 when milestone 1 review fails", async () => {
  const context = await createReadyGoalContext();
  try {
    const runner = new RecordingRunner(new FakeRunner(), [
      {
        phase: "review_milestone",
        milestoneId: 1,
        result: {
          text: "review failed",
          exitCode: 1,
        },
      },
    ]);
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /review_milestone failed/);
    assert.equal(result.state.currentPhase, "reviewing");
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.equal(result.state.milestoneStatuses["2"], "pending");
    assert.equal(
      result.state.artifacts.summaries?.goal,
      path.join("milestones", "90-goal-summary.md"),
    );
    assertNoMilestone2Requests(runner.requests);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: failed/);
    assert.match(summary, /Stop reason: Runner phase review_milestone failed with exit code 1\./);

    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow does not request milestone 2 when milestone 1 needs human review", async () => {
  const context = await createReadyGoalContext();
  try {
    const runner = new RecordingRunner(new FakeRunner(), [
      {
        phase: "review_milestone",
        milestoneId: 1,
        result: reviewResult({
          verdict: "needs_human_review",
          summary: "The implementation depends on a manual product decision.",
          findings: [],
        }),
      },
    ]);
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.equal(result.state.status, "needs_human_review");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "needs_human_review");
    assert.equal(result.state.milestoneStatuses["2"], "pending");
    assert.match(result.state.lastError?.message ?? "", /manual product decision/);
    assert.equal(
      result.state.artifacts.summaries?.goal,
      path.join("milestones", "90-goal-summary.md"),
    );
    assertNoMilestone2Requests(runner.requests);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: needs_human_review/);
    assert.match(summary, /- 1: First milestone/);
    assert.match(summary, /manual product decision/);

    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow fails fast when milestone 1 needs human review under fail policy", async () => {
  const context = await createReadyGoalContext({
    config: testConfig({ humanReviewPolicy: "fail" }),
  });
  try {
    const runner = new RecordingRunner(new FakeRunner(), [
      {
        phase: "review_milestone",
        milestoneId: 1,
        result: reviewResult({
          verdict: "needs_human_review",
          summary: "The implementation depends on a manual product decision.",
          findings: [],
        }),
      },
    ]);
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /manual product decision/);
    assert.equal(result.state.currentPhase, "failed");
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.equal(result.state.milestoneStatuses["2"], "pending");
    assert.match(result.state.lastError?.message ?? "", /manual product decision/);
    assert.equal(
      result.state.artifacts.summaries?.goal,
      path.join("milestones", "90-goal-summary.md"),
    );
    assertNoMilestone2Requests(runner.requests);

    const reviewSummary = await readFile(
      path.join(context.paths.dirs.milestones, "25-milestone-1-review-summary.md"),
      "utf8",
    );
    assert.match(reviewSummary, /Status: failed/);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: failed/);
    assert.match(summary, /- 1: First milestone/);
    assert.match(summary, /manual product decision/);

    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow fails autonomous unresolved review ambiguity without requesting milestone 2", async () => {
  const context = await createReadyGoalContext({
    config: testConfig({ humanReviewPolicy: "autonomous" }),
  });
  try {
    const runner = new RecordingRunner(new FakeRunner(), [
      {
        phase: "review_milestone",
        milestoneId: 1,
        result: reviewResult({
          verdict: "needs_human_review",
          summary: "The implementation depends on a manual product decision.",
          findings: [],
        }),
      },
      {
        phase: "resolve_review_ambiguity",
        milestoneId: 1,
        result: reviewResolutionResult({
          verdict: "needs_human_review",
          summary: "The resolver could not decide.",
          findings: [],
        }),
      },
      {
        phase: "resolve_review_ambiguity",
        milestoneId: 1,
        result: reviewResolutionResult({
          verdict: "needs_human_review",
          summary: "The resolver could not decide.",
          findings: [],
        }),
      },
    ]);
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /resolution failed after 2 attempt/);
    assert.equal(result.state.currentPhase, "failed");
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.equal(result.state.milestoneStatuses["2"], "pending");
    assertNoMilestone2Requests(runner.requests);
    assert.equal(
      result.state.artifacts.summaries?.goal,
      path.join("milestones", "90-goal-summary.md"),
    );

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: failed/);
    assert.match(summary, /Review ambiguity resolution failed after 2 attempt\(s\)\./);

    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow preserves human-review state when final summary writing fails", async () => {
  const context = await createReadyGoalContext();
  try {
    await mkdir(path.join(context.paths.dirs.milestones, "90-goal-summary.md"));

    const runner = new RecordingRunner(new FakeRunner(), [
      {
        phase: "review_milestone",
        milestoneId: 1,
        result: reviewResult({
          verdict: "needs_human_review",
          summary: "The implementation depends on a manual product decision.",
          findings: [],
        }),
      },
    ]);
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /manual product decision/);
    assert.match(result.error ?? "", /Failed to write goal summary/);
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.equal(result.state.status, "needs_human_review");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "needs_human_review");
    assert.equal(result.state.milestoneStatuses["2"], "pending");
    assert.equal(result.state.artifacts.summaries?.goal, undefined);
    assertNoMilestone2Requests(runner.requests);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow does not request milestone 2 when milestone 1 exhausts fix attempts", async () => {
  const context = await createReadyGoalContext({
    config: testConfig({ maxFixAttempts: 1 }),
  });
  try {
    const runner = new RecordingRunner(new FakeRunner(), [
      {
        phase: "review_milestone",
        milestoneId: 1,
        result: reviewResult({
          verdict: "fail",
          summary: "The implementation misses required behavior.",
          findings: [blockingFinding()],
        }),
      },
      {
        phase: "review_milestone",
        milestoneId: 1,
        result: reviewResult({
          verdict: "fail",
          summary: "The implementation still misses required behavior.",
          findings: [blockingFinding()],
        }),
      },
    ]);
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.equal(result.state.status, "needs_human_review");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.equal(result.state.milestoneStatuses["1"], "needs_human_review");
    assert.equal(result.state.milestoneStatuses["2"], "pending");
    assert.deepEqual(result.state.fixAttempts, { "1": 1 });
    assert.match(result.state.lastError?.message ?? "", /Max fix attempts exhausted/);
    assert.equal(
      result.state.artifacts.summaries?.goal,
      path.join("milestones", "90-goal-summary.md"),
    );
    assertNoMilestone2Requests(runner.requests);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: needs_human_review/);
    assert.match(summary, /- Milestone 1: 1/);
    assert.match(summary, /Max fix attempts exhausted after 1 attempt\(s\)\./);

    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow stops for human review when milestone selection is blocked", async () => {
  const context = await createReadyGoalContext();
  try {
    const blockedState: RunState = {
      ...context.workflowOptions.initialState,
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "needs_human_review",
        "2": "pending",
      },
      updatedAt: "2026-05-10T12:00:20.000Z",
    };
    await writeState(context.paths.files.state, blockedState);

    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      initialState: blockedState,
      runner,
    });

    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.equal(result.state.status, "needs_human_review");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.deepEqual(result.state.milestoneStatuses, {
      "1": "needs_human_review",
      "2": "pending",
    });
    assert.match(result.state.lastError?.message ?? "", /already blocked/);
    assert.equal(
      result.state.artifacts.summaries?.goal,
      path.join("milestones", "90-goal-summary.md"),
    );
    assert.deepEqual(runner.requests, []);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: needs_human_review/);
    assert.match(summary, /A milestone is already blocked/);

    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runGoalWorkflow stops for human review when milestone selection finds invalid state", async () => {
  const context = await createReadyGoalContext();
  try {
    const invalidState: RunState = {
      ...context.workflowOptions.initialState,
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "passed",
        "2": "pending",
        "99": "pending",
      },
      updatedAt: "2026-05-10T12:00:20.000Z",
    };
    await writeState(context.paths.files.state, invalidState);

    const runner = new RecordingRunner(new FakeRunner());
    const result = await runGoalWorkflow({
      ...context.workflowOptions,
      initialState: invalidState,
      runner,
    });

    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.equal(result.state.status, "needs_human_review");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.deepEqual(result.state.milestoneStatuses, {
      "1": "passed",
      "2": "pending",
      "99": "pending",
    });
    assert.match(result.state.lastError?.message ?? "", /missing from metadata/);
    assert.equal(
      result.state.artifacts.summaries?.goal,
      path.join("milestones", "90-goal-summary.md"),
    );
    assert.deepEqual(runner.requests, []);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "90-goal-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: needs_human_review/);
    assert.match(summary, /State contains milestone statuses that are missing from metadata/);

    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

interface GoalContext {
  repo: string;
  paths: RunPaths;
  workflowOptions: Omit<GoalWorkflowOptions, "runner">;
  cleanup: () => Promise<void>;
}

interface RecordedAgentRequest {
  phase: string;
  artifacts: Record<string, string>;
  cwd?: string;
  milestoneId?: number;
}

interface RunnerOverride {
  phase: string;
  result: AgentRunResult;
  milestoneId?: number;
}

class RecordingRunner implements AgentRunner {
  readonly type: string;
  readonly requests: RecordedAgentRequest[] = [];
  private readonly overrides: RunnerOverride[];

  constructor(
    private readonly inner: AgentRunner,
    overrides: RunnerOverride[] = [],
  ) {
    this.type = inner.type;
    this.overrides = [...overrides];
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push({
      phase: request.phase,
      artifacts: { ...(request.artifacts ?? {}) },
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.milestoneId === undefined ? {} : { milestoneId: request.milestoneId }),
    });

    const overrideIndex = this.overrides.findIndex(
      (override) =>
        override.phase === request.phase &&
        (override.milestoneId === undefined ||
          override.milestoneId === request.milestoneId),
    );
    if (overrideIndex !== -1) {
      const [override] = this.overrides.splice(overrideIndex, 1);
      if (override) return override.result;
    }

    return this.inner.run(request);
  }
}

interface GoalContextOptions {
  config?: OrchestratorConfig;
}

async function createGoalContext(options: GoalContextOptions = {}): Promise<GoalContext> {
  const fixtureRepo = await createFixtureRepo({
    prefix: "milestone-runner-goal-workflow-",
    gitignore: ".agent-work/\n",
    files: {
      "README.md": "# Fixture\n",
    },
  });

  const goal = "Add feature X";
  const config = options.config ?? testConfig();
  const paths = buildRunPaths({
    cwd: fixtureRepo.path,
    artifactRoot: config.artifactRoot,
    runId: "run-1",
  });
  await createRunDirectory(paths, goal);

  const initialState = createState({
    paths,
    goal,
    config,
    repo: fixtureRepo.path,
    startSha: await fixtureRepo.git(["rev-parse", "HEAD"]),
  });
  await writeState(paths.files.state, initialState);

  return {
    repo: fixtureRepo.path,
    paths,
    workflowOptions: {
      goal,
      config,
      paths,
      initialState,
      commandRunner: nodeCommandRunner,
      cwd: fixtureRepo.path,
      promptDir: promptDir(),
      milestonesSchema: { type: "object" },
      now: sequenceClock("2026-05-10T12:01:00.000Z"),
    },
    cleanup: fixtureRepo.cleanup,
  };
}

async function createReadyGoalContext(
  options: GoalContextOptions = {},
): Promise<GoalContext> {
  const fixtureRepo = await createFixtureRepo({
    prefix: "milestone-runner-goal-workflow-ready-",
    gitignore: ".agent-work/\n",
    files: {
      "README.md": "# Fixture\n",
    },
  });
  const repo = fixtureRepo.path;
  const config = options.config ?? testConfig();
  const runFixture = await createReadyForMilestoneRunFixture({
    cwd: repo,
    startSha: await fixtureRepo.git(["rev-parse", "HEAD"]),
    config,
  });

  return {
    repo,
    paths: runFixture.paths,
    workflowOptions: {
      goal: runFixture.goal,
      config: runFixture.config,
      paths: runFixture.paths,
      initialState: runFixture.state,
      commandRunner: nodeCommandRunner,
      cwd: repo,
      promptDir: promptDir(),
      milestonesSchema: { type: "object" },
      now: sequenceClock("2026-05-10T12:01:00.000Z"),
    },
    cleanup: fixtureRepo.cleanup,
  };
}

async function createReadyReviewGoalContext(
  options: GoalContextOptions = {},
): Promise<GoalContext> {
  const fixtureRepo = await createFixtureRepo({
    prefix: "milestone-runner-goal-workflow-ready-review-",
    gitignore: ".agent-work/\n",
    files: {
      "README.md": "# Fixture\n",
    },
  });
  const repo = fixtureRepo.path;
  const config = options.config ?? testConfig();
  const runFixture = await createReadyForReviewRunFixture({
    cwd: repo,
    startSha: await fixtureRepo.git(["rev-parse", "HEAD"]),
    config,
  });

  return {
    repo,
    paths: runFixture.paths,
    workflowOptions: {
      goal: runFixture.goal,
      config: runFixture.config,
      paths: runFixture.paths,
      initialState: runFixture.state,
      commandRunner: nodeCommandRunner,
      cwd: repo,
      promptDir: promptDir(),
      milestonesSchema: { type: "object" },
      now: sequenceClock("2026-05-10T12:01:00.000Z"),
    },
    cleanup: fixtureRepo.cleanup,
  };
}

function createState(options: {
  paths: RunPaths;
  goal: string;
  config: OrchestratorConfig;
  repo: string;
  startSha: string;
}): RunState {
  return createInitialState({
    runId: options.paths.runId,
    goal: options.goal,
    paths: options.paths,
    git: {
      required: true,
      planningOnly: false,
      root: options.repo,
      startSha: options.startSha,
      dirtyAtStart: false,
      dirtyOverride: false,
      statusPorcelain: "",
    },
    configPath: "/repo/orchestrator.config.example.json",
    configSnapshot: options.config,
    now: new Date("2026-05-10T12:00:00.000Z"),
  });
}

function testConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    checks: [],
    runner: { type: "fake" },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    milestonePlanPolicy: "always",
    milestonePlanReviewPolicy: "normal",
    humanReviewPolicy: "stop",
    ...overrides,
  };
}

function promptDir(): string {
  return path.join(process.cwd(), "src", "prompts");
}

async function assertTimingArtifacts(paths: RunPaths, state: RunState): Promise<void> {
  const timingPaths = buildTimingArtifactPaths(paths);
  assert.equal(state.artifacts.logs?.timingsJson, timingPaths.statePaths.timingsJson);
  assert.equal(
    state.artifacts.logs?.timingsMarkdown,
    timingPaths.statePaths.timingsMarkdown,
  );

  const document = JSON.parse(
    await readFile(timingPaths.files.timingsJson, "utf8"),
  ) as {
    runId?: string;
    runEndedAt?: string;
    lifecycleDurationMs?: number;
  };
  const markdown = await readFile(timingPaths.files.timingsMarkdown, "utf8");

  assert.equal(document.runId, state.runId);
  assert.equal(typeof document.lifecycleDurationMs, "number");
  assert.equal(typeof document.runEndedAt, "string");
  assert.ok(
    Date.parse(state.updatedAt) > Date.parse(document.runEndedAt ?? ""),
    "timing artifact state recording must not move runEndedAt",
  );
  assert.match(markdown, /^# Timing Summary/);
}

function assertNoMilestone2Requests(requests: readonly RecordedAgentRequest[]): void {
  assert.equal(
    requests.some((request) => request.milestoneId === 2),
    false,
  );
}

function reviewResult(options: {
  verdict: "pass" | "fail" | "needs_human_review";
  summary: string;
  findings: unknown[];
}): AgentRunResult {
  return {
    text: JSON.stringify(
      {
        verdict: options.verdict,
        summary: options.summary,
        findings: options.findings,
        reviewedArtifacts: [
          "diffs/12-milestone-1.diff",
          "checks/13-milestone-1-checks.txt",
        ],
      },
      null,
      2,
    ),
    exitCode: 0,
  };
}

function reviewResolutionResult(options: {
  verdict: "pass" | "fail" | "needs_human_review";
  summary: string;
  findings: unknown[];
}): AgentRunResult {
  return {
    text: JSON.stringify(
      {
        resolution: {
          summary: "Resolved review ambiguity autonomously.",
          rationale: "The resolver selected the safest supported verdict.",
          assumptions: [],
          sourceCondition: "explicit_needs_human_review",
        },
        verdict: {
          verdict: options.verdict,
          summary: options.summary,
          findings: options.findings,
          reviewedArtifacts: [
            "reviews/20-milestone-1-review.json",
            "diffs/12-milestone-1.diff",
            "checks/13-milestone-1-checks.txt",
          ],
        },
      },
      null,
      2,
    ),
    exitCode: 0,
  };
}

function resumeResolutionResult(options: {
  action:
    | "continue"
    | "normalize_to_ready_for_review"
    | "normalize_to_passed"
    | "fail";
  summary: string;
  currentMilestoneId?: number | null;
}): AgentRunResult {
  return {
    text: JSON.stringify(
      {
        action: options.action,
        summary: options.summary,
        rationale: "The fake resolver selected the requested resume action.",
        assumptions: [],
        currentMilestoneId: options.currentMilestoneId ?? 1,
      },
      null,
      2,
    ),
    exitCode: 0,
  };
}

function blockingFinding(): Record<string, unknown> {
  return {
    severity: "high",
    file: "README.md",
    issue: "Missing required behavior.",
    suggestedFix: "Add the required behavior.",
    blocking: true,
  };
}
