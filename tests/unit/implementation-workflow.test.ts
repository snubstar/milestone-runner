import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { RunPaths } from "../../src/artifacts/paths.js";
import type { OrchestratorConfig } from "../../src/config/config-types.js";
import { runImplementationWorkflow } from "../../src/implementation/implementation-workflow.js";
import type { AgentRunner, AgentRunRequest, AgentRunResult } from "../../src/runners/agent-runner.js";
import { FakeRunner } from "../../src/runners/fake/fake-runner.js";
import { nodeCommandRunner } from "../../src/shell/command-runner.js";
import { readState } from "../../src/state/state-store.js";
import { setStatePhase } from "../../src/state/state-transitions.js";
import type { RunState } from "../../src/state/state-types.js";
import { createCheckTimingCollector } from "../../src/timings/check-timing-collector.js";
import { createFixtureRepo } from "../helpers/fixture-repo.js";
import {
  createReadyForMilestoneRunFixture,
  sequenceClock,
} from "../helpers/run-fixture.js";
import { ScenarioRunner } from "../helpers/scenario-runner.js";

test("runImplementationWorkflow implements one fake milestone and stops ready for review", async () => {
  const context = await createImplementationContext();
  const checkTimingCollector = createCheckTimingCollector();
  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner: new FakeRunner(),
      checkTimingCollector,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.milestoneId, 1);
    assert.equal(result.state.currentPhase, "ready_for_review");
    assert.equal(result.state.status, "ready_for_review");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.deepEqual(result.state.milestoneStatuses, {
      "1": "ready_for_review",
      "2": "pending",
    });
    assert.deepEqual(result.state.artifacts.milestonePlans, {
      "1": path.join("milestones", "10-milestone-1-plan.md"),
    });
    assert.deepEqual(result.state.artifacts.implementations, {
      "1": path.join("milestones", "11-milestone-1-implementation.md"),
    });
    assert.deepEqual(result.state.artifacts.diffs, {
      "1": path.join("diffs", "12-milestone-1.diff"),
    });
    assert.deepEqual(result.state.artifacts.checks, {
      "1": path.join("checks", "13-milestone-1-checks.txt"),
    });
    assert.deepEqual(result.state.artifacts.summaries, {
      "1": path.join("milestones", "14-milestone-1-summary.md"),
    });
    assert.deepEqual(Object.keys(result.state.milestoneBaselines), ["1"]);
    assert.match(result.state.milestoneBaselines["1"] ?? "", /^[0-9a-f]+$/);

    const implementationFile = path.join(context.repo, "fake-milestone-1-implementation.txt");
    assert.match(await readFile(implementationFile, "utf8"), /Milestone: 1/);

    const diff = await readFile(path.join(context.paths.dirs.diffs, "12-milestone-1.diff"), "utf8");
    assert.match(diff, /diff --git a\/fake-milestone-1-implementation\.txt b\/fake-milestone-1-implementation\.txt/);
    assert.match(diff, /new file mode/);

    const checks = await readFile(
      path.join(context.paths.dirs.checks, "13-milestone-1-checks.txt"),
      "utf8",
    );
    assert.match(checks, /Overall: passed/);
    assert.match(checks, /check ok/);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "14-milestone-1-summary.md"),
      "utf8",
    );
    assert.match(summary, /^# Milestone 1 Summary/);
    assert.match(summary, /Milestone 1 must review/);
    assert.doesNotMatch(summary, /Milestone 5 must review/);

    assert.deepEqual(await readState(context.paths.files.state), result.state);
    const checkTimings = checkTimingCollector.list();
    assert.equal(checkTimings.length, 1);
    assert.equal(checkTimings[0]?.stateKey, "1");
    assert.equal(checkTimings[0]?.milestoneId, 1);
    assert.equal(checkTimings[0]?.attempt, null);
    assert.equal(checkTimings[0]?.source, "structured");
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow excludes run artifacts from unignored implementation diffs", async () => {
  const context = await createImplementationContext({ ignoreArtifactRoot: false });
  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner: new FakeRunner(),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const diff = await readFile(path.join(context.paths.dirs.diffs, "12-milestone-1.diff"), "utf8");
    assert.match(diff, /diff --git a\/fake-milestone-1-implementation\.txt b\/fake-milestone-1-implementation\.txt/);
    assert.doesNotMatch(diff, /\.agent-work\/run-1/);
    assert.doesNotMatch(diff, /10-milestone-1-plan\.md/);
    assert.doesNotMatch(diff, /state\.json/);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow passes target cwd to milestone runner phases", async () => {
  const context = await createImplementationContext();
  const runner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Milestone Plan",
      exitCode: 0,
    },
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nWrote feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "implemented\n" }],
    },
  ], "codex-exec");

  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(runner.phases(), ["milestone_plan", "implement_milestone"]);
    assert.deepEqual(
      runner.requests.map((request) => request.cwd),
      [context.repo, context.repo],
    );
    assert.deepEqual(
      runner.requests.map((request) => request.outputSchemaPath),
      [undefined, undefined],
    );
    assert.deepEqual((await readdir(context.paths.dirs.runner)).sort(), [
      "implement_milestone-02.json",
      "milestone_plan-01.json",
    ]);
    const implementationDiagnostic = JSON.parse(
      await readFile(
        path.join(context.paths.dirs.runner, "implement_milestone-02.json"),
        "utf8",
      ),
    );
    assert.equal(implementationDiagnostic.phase, "implement_milestone");
    assert.equal(implementationDiagnostic.milestoneId, 1);
    assert.equal(implementationDiagnostic.runner, "codex-exec");
    assert.equal(implementationDiagnostic.cwd, context.repo);
    assert.equal(implementationDiagnostic.startedAt, "2026-05-10T12:01:07.000Z");
    assert.equal(implementationDiagnostic.endedAt, "2026-05-10T12:01:08.000Z");
    assert.equal(implementationDiagnostic.durationMs, 1000);
    assert.equal("prompt" in implementationDiagnostic, false);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow uses runner-backed milestone plans for always policy", async () => {
  const context = await createImplementationContext();
  const runner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Runner Milestone Plan\n\nUse the full planning result.",
      exitCode: 0,
    },
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nWrote feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "implemented\n" }],
    },
  ]);

  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(runner.phases(), ["milestone_plan", "implement_milestone"]);
    assert.match(
      runner.requests[1]?.prompt ?? "",
      /# Runner Milestone Plan\n\nUse the full planning result\./,
    );
    assert.equal(
      await readFile(
        path.join(context.paths.dirs.milestones, "10-milestone-1-plan.md"),
        "utf8",
      ),
      "# Runner Milestone Plan\n\nUse the full planning result.\n",
    );
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow reviews and corrects full milestone plans in scrupulous mode", async () => {
  const context = await createImplementationContext({
    config: implementationConfig("always", "scrupulous"),
  });
  const runner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Draft Milestone Plan\n\nDraft-only implementation direction.",
      exitCode: 0,
    },
    {
      phase: "milestone_plan_review",
      text: "# Draft Review\n\nTighten the implementation direction.",
      exitCode: 0,
    },
    {
      phase: "final_milestone_plan",
      text: "# Corrected Milestone Plan\n\nUse this final implementation direction.",
      exitCode: 0,
    },
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nWrote feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "implemented\n" }],
    },
  ]);

  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(runner.phases(), [
      "milestone_plan",
      "milestone_plan_review",
      "final_milestone_plan",
      "implement_milestone",
    ]);
    assert.deepEqual(result.state.artifacts.milestonePlanDrafts, {
      "1": path.join("milestones", "10-milestone-1-plan-draft.md"),
    });
    assert.deepEqual(result.state.artifacts.milestonePlanReviews, {
      "1": path.join("milestones", "10-milestone-1-plan-review.md"),
    });
    assert.deepEqual(result.state.artifacts.milestonePlans, {
      "1": path.join("milestones", "10-milestone-1-plan.md"),
    });

    assert.equal(
      await readFile(
        path.join(context.paths.dirs.milestones, "10-milestone-1-plan-draft.md"),
        "utf8",
      ),
      "# Draft Milestone Plan\n\nDraft-only implementation direction.\n",
    );
    assert.equal(
      await readFile(
        path.join(context.paths.dirs.milestones, "10-milestone-1-plan-review.md"),
        "utf8",
      ),
      "# Draft Review\n\nTighten the implementation direction.\n",
    );
    assert.equal(
      await readFile(
        path.join(context.paths.dirs.milestones, "10-milestone-1-plan.md"),
        "utf8",
      ),
      "# Corrected Milestone Plan\n\nUse this final implementation direction.\n",
    );
    assert.match(
      runner.requests[1]?.prompt ?? "",
      /# Draft Milestone Plan\n\nDraft-only implementation direction\./,
    );
    assert.match(
      runner.requests[2]?.prompt ?? "",
      /# Draft Review\n\nTighten the implementation direction\./,
    );
    assert.match(
      runner.requests[3]?.prompt ?? "",
      /# Corrected Milestone Plan\n\nUse this final implementation direction\./,
    );
    assert.doesNotMatch(runner.requests[3]?.prompt ?? "", /Draft-only implementation direction/);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow reviews and corrects light milestone plans in scrupulous mode", async () => {
  const context = await createImplementationContext({
    config: implementationConfig("light", "scrupulous"),
  });
  const runner = new ScenarioRunner([
    {
      phase: "milestone_plan_review",
      text: "# Light Plan Review\n\nNo changes required.",
      exitCode: 0,
    },
    {
      phase: "final_milestone_plan",
      text: "# Final Light Milestone Plan\n\nImplement the light milestone.",
      exitCode: 0,
    },
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nWrote feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "implemented\n" }],
    },
  ]);

  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(runner.phases(), [
      "milestone_plan_review",
      "final_milestone_plan",
      "implement_milestone",
    ]);
    assert.equal(
      runner.requests.some((request) => request.phase === "milestone_plan"),
      false,
    );
    assert.match(
      await readFile(
        path.join(context.paths.dirs.milestones, "10-milestone-1-plan-draft.md"),
        "utf8",
      ),
      /^# Milestone 1 Plan: First milestone/,
    );
    assert.equal(
      await readFile(
        path.join(context.paths.dirs.milestones, "10-milestone-1-plan.md"),
        "utf8",
      ),
      "# Final Light Milestone Plan\n\nImplement the light milestone.\n",
    );
    assert.match(runner.requests[0]?.prompt ?? "", /- Mode: light/);
    assert.match(runner.requests[2]?.prompt ?? "", /# Final Light Milestone Plan/);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow skips milestone_plan and writes a light plan for light policy", async () => {
  const context = await createImplementationContext({
    config: lightImplementationConfig(),
  });
  const runner = new ScenarioRunner([
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nWrote feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "implemented\n" }],
    },
  ]);

  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(runner.phases(), ["implement_milestone"]);
    assert.deepEqual(result.state.artifacts.milestonePlans, {
      "1": path.join("milestones", "10-milestone-1-plan.md"),
    });
    assert.deepEqual(result.state.artifacts.implementations, {
      "1": path.join("milestones", "11-milestone-1-implementation.md"),
    });
    assert.deepEqual(result.state.artifacts.diffs, {
      "1": path.join("diffs", "12-milestone-1.diff"),
    });
    assert.deepEqual(result.state.artifacts.checks, {
      "1": path.join("checks", "13-milestone-1-checks.txt"),
    });
    assert.deepEqual(result.state.artifacts.summaries, {
      "1": path.join("milestones", "14-milestone-1-summary.md"),
    });

    const plan = await readFile(
      path.join(context.paths.dirs.milestones, "10-milestone-1-plan.md"),
      "utf8",
    );
    assert.match(plan, /^# Milestone 1 Plan: First milestone/);
    assert.match(plan, /- Policy: light/);
    assert.match(plan, /- Mode: light/);
    assert.match(plan, /- Decision: policy=light/);
    assert.match(
      plan,
      /Implementation must produce concrete code or file changes for this active milestone\./,
    );
    assert.match(runner.requests[0]?.prompt ?? "", /- Mode: light/);

    assert.equal(
      runner.requests.some((request) => request.phase === "milestone_plan"),
      false,
    );
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow does not load milestone-plan prompt for light policy", async () => {
  const context = await createImplementationContext({
    config: lightImplementationConfig(),
  });
  const promptDir = path.join(context.repo, "minimal-prompts");
  await mkdir(promptDir);
  await writeFile(
    path.join(promptDir, "implement-milestone.md"),
    "# Implement\n\n{{milestonePlan}}\n",
    "utf8",
  );
  const runner = new ScenarioRunner([
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nWrote feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "implemented\n" }],
    },
  ]);

  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      promptDir,
      runner,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(runner.phases(), ["implement_milestone"]);
    assert.match(runner.requests[0]?.prompt ?? "", /# Milestone 1 Plan: First milestone/);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow auto-selects light for simple milestones", async () => {
  const context = await createImplementationContext({
    config: implementationConfig("auto"),
  });
  const runner = new ScenarioRunner([
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nWrote feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "implemented\n" }],
    },
  ]);

  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(runner.phases(), ["implement_milestone"]);

    const plan = await readFile(
      path.join(context.paths.dirs.milestones, "10-milestone-1-plan.md"),
      "utf8",
    );
    assert.match(plan, /- Policy: auto/);
    assert.match(plan, /- Mode: light/);
    assert.match(plan, /- Decision: auto: no dependencies, small scope, clear verification/);
    assert.match(runner.requests[0]?.prompt ?? "", /- Mode: light/);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow auto-selects full for dependency-bearing milestones", async () => {
  const context = await createImplementationContext({
    config: implementationConfig("auto"),
  });
  const runner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Runner Full Plan\n\nUse the runner-backed plan.",
      exitCode: 0,
    },
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nWrote feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "implemented\n" }],
    },
  ]);

  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      initialState: {
        ...context.workflowOptions.initialState,
        currentMilestoneId: 2,
        milestoneStatuses: {
          "1": "passed",
          "2": "pending",
        },
      },
      runner,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(runner.phases(), ["milestone_plan", "implement_milestone"]);

    const plan = await readFile(
      path.join(context.paths.dirs.milestones, "10-milestone-2-plan.md"),
      "utf8",
    );
    assert.match(plan, /- Policy: auto/);
    assert.match(plan, /- Mode: full/);
    assert.match(plan, /- Decision: auto: milestone has dependencies/);
    assert.match(plan, /## Runner Plan\n\n# Runner Full Plan\n\nUse the runner-backed plan\./);
    assert.match(runner.requests[1]?.prompt ?? "", /- Mode: full/);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "14-milestone-2-summary.md"),
      "utf8",
    );
    assert.match(summary, /^# Milestone 2 Summary/);
    assert.match(summary, /Milestone 2 must review/);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow allows an explicitly approved dirty baseline", async () => {
  const context = await createImplementationContext();
  try {
    await writeFile(path.join(context.repo, "README.md"), "# Dirty Fixture\n", "utf8");

    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      initialState: {
        ...context.workflowOptions.initialState,
        git: {
          ...context.workflowOptions.initialState.git,
          dirtyAtStart: true,
          dirtyOverride: true,
          statusPorcelain: " M README.md\n",
        },
      },
      runner: new FakeRunner(),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const diff = await readFile(path.join(context.paths.dirs.diffs, "12-milestone-1.diff"), "utf8");
    assert.match(diff, /diff --git a\/fake-milestone-1-implementation\.txt b\/fake-milestone-1-implementation\.txt/);
    assert.doesNotMatch(diff, /README\.md/);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow rejects states that are not ready for a milestone", async () => {
  const context = await createImplementationContext();
  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      initialState: setStatePhase(context.workflowOptions.initialState, "planning"),
      runner: new FakeRunner(),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /ready_for_milestone/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "implementing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow fails when the final major plan artifact is missing", async () => {
  const context = await createImplementationContext();
  try {
    await rm(path.join(context.paths.dirs.plans, "03-final-major-plan.md"));

    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner: new FakeRunner(),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Failed to read final major plan/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "implementing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.equal(result.state.artifacts.milestonePlans, undefined);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow rejects unsafe final major plan artifact paths from state", async () => {
  const context = await createImplementationContext();
  try {
    const outsidePlan = path.join(context.repo, "outside-plan.md");
    await writeFile(outsidePlan, "# Outside Plan\n", "utf8");

    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      initialState: {
        ...context.workflowOptions.initialState,
        artifacts: {
          ...context.workflowOptions.initialState.artifacts,
          finalMajorPlanMarkdown: outsidePlan,
        },
      },
      runner: new FakeRunner(),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Invalid final major plan artifact path/);
    assert.match(result.error, /run-relative/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "implementing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.equal(result.state.artifacts.milestonePlans, undefined);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow persists failed state when the milestone-plan runner throws", async () => {
  const context = await createImplementationContext();
  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([
        {
          phase: "milestone_plan",
          text: "",
          exitCode: 0,
          throwError: "milestone planning crashed",
        },
      ]),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Runner phase milestone_plan threw an error/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "implementing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.match(result.state.lastError?.message ?? "", /milestone planning crashed/);
    assert.equal(result.state.artifacts.milestonePlans, undefined);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow fails scrupulous plan review before implementation starts", async () => {
  const context = await createImplementationContext({
    config: implementationConfig("always", "scrupulous"),
  });
  const runner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Draft Plan\n\nNeeds review.",
      exitCode: 0,
    },
    {
      phase: "milestone_plan_review",
      text: "# Review Failure\n\nCould not review.",
      exitCode: 2,
    },
  ]);

  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Runner phase milestone_plan_review failed with exit code 2/);
    assert.deepEqual(runner.phases(), ["milestone_plan", "milestone_plan_review"]);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "implementing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.deepEqual(result.state.artifacts.milestonePlanDrafts, {
      "1": path.join("milestones", "10-milestone-1-plan-draft.md"),
    });
    assert.equal(result.state.artifacts.milestonePlanReviews, undefined);
    assert.equal(result.state.artifacts.milestonePlans, undefined);
    assert.equal(result.state.artifacts.implementations, undefined);
    assert.equal(result.state.artifacts.diffs, undefined);
    await assert.rejects(
      () => readFile(path.join(context.repo, "fake-milestone-1-implementation.txt"), "utf8"),
      /ENOENT/,
    );
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow fails scrupulous final plan correction before implementation starts", async () => {
  const context = await createImplementationContext({
    config: implementationConfig("always", "scrupulous"),
  });
  const runner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Draft Plan\n\nNeeds correction.",
      exitCode: 0,
    },
    {
      phase: "milestone_plan_review",
      text: "# Review\n\nCorrect the draft.",
      exitCode: 0,
    },
    {
      phase: "final_milestone_plan",
      text: "# Correction Failure\n\nCould not correct.",
      exitCode: 3,
    },
  ]);

  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Runner phase final_milestone_plan failed with exit code 3/);
    assert.deepEqual(runner.phases(), [
      "milestone_plan",
      "milestone_plan_review",
      "final_milestone_plan",
    ]);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "implementing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.deepEqual(result.state.artifacts.milestonePlanDrafts, {
      "1": path.join("milestones", "10-milestone-1-plan-draft.md"),
    });
    assert.deepEqual(result.state.artifacts.milestonePlanReviews, {
      "1": path.join("milestones", "10-milestone-1-plan-review.md"),
    });
    assert.equal(result.state.artifacts.milestonePlans, undefined);
    assert.equal(result.state.artifacts.implementations, undefined);
    assert.equal(result.state.artifacts.diffs, undefined);
    await assert.rejects(
      () => readFile(path.join(context.repo, "fake-milestone-1-implementation.txt"), "utf8"),
      /ENOENT/,
    );
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow fails empty scrupulous final plan before implementation starts", async () => {
  const context = await createImplementationContext({
    config: implementationConfig("always", "scrupulous"),
  });
  const runner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Draft Plan\n\nNeeds correction.",
      exitCode: 0,
    },
    {
      phase: "milestone_plan_review",
      text: "# Review\n\nCorrect the draft.",
      exitCode: 0,
    },
    {
      phase: "final_milestone_plan",
      text: "   \n",
      exitCode: 0,
    },
  ]);

  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Runner phase final_milestone_plan returned empty output/);
    assert.deepEqual(runner.phases(), [
      "milestone_plan",
      "milestone_plan_review",
      "final_milestone_plan",
    ]);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "implementing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.deepEqual(result.state.artifacts.milestonePlanDrafts, {
      "1": path.join("milestones", "10-milestone-1-plan-draft.md"),
    });
    assert.deepEqual(result.state.artifacts.milestonePlanReviews, {
      "1": path.join("milestones", "10-milestone-1-plan-review.md"),
    });
    assert.equal(result.state.artifacts.milestonePlans, undefined);
    assert.equal(result.state.artifacts.implementations, undefined);
    assert.equal(result.state.artifacts.diffs, undefined);
    await assert.rejects(
      () => readFile(path.join(context.repo, "fake-milestone-1-implementation.txt"), "utf8"),
      /ENOENT/,
    );
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow persists failed state when milestone artifact writes fail", async () => {
  const context = await createImplementationContext();
  try {
    await mkdir(path.join(context.paths.dirs.milestones, "10-milestone-1-plan.md"));

    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner: new FakeRunner(),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Failed to write milestone plan artifact/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "implementing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.equal(result.state.artifacts.milestonePlans, undefined);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow fails empty implementation diffs", async () => {
  const context = await createImplementationContext();
  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner: new ScriptedImplementationRunner({
        milestone_plan: {
          text: "# Plan",
          exitCode: 0,
        },
        implement_milestone: {
          text: "# Implementation\n\nNo changes made.",
          exitCode: 0,
        },
      }),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /empty diff/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "implementing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.equal(result.state.artifacts.diffs, undefined);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow persists check output and fails when checks fail", async () => {
  const context = await createImplementationContext({
    config: {
      checks: [`${JSON.stringify(process.execPath)} -e "process.stderr.write('check failed'); process.exit(2)"`],
      runner: { type: "fake" },
      maxFixAttempts: 0,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
      humanReviewPolicy: "stop",
    },
  });
  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner: new FakeRunner(),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Checks failed/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "failed");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.deepEqual(result.state.artifacts.checks, {
      "1": path.join("checks", "13-milestone-1-checks.txt"),
    });
    assert.deepEqual(result.state.artifacts.checkFailures, {
      "1-failed-1": path.join("checks", "13-milestone-1-check-failure-1.json"),
    });
    assert.equal(result.state.artifacts.summaries, undefined);
    assert.equal(
      (result.state.lastError?.details as { checkFailureSummary?: string }).checkFailureSummary,
      path.join("checks", "13-milestone-1-check-failure-1.json"),
    );
    const failedCheckResults = (result.state.lastError?.details as {
      results?: Array<{ command: string; exitCode: number | null; stderr: string }>;
    }).results;
    assert.equal(failedCheckResults?.[0]?.command, `${JSON.stringify(process.execPath)} -e "process.stderr.write('check failed'); process.exit(2)"`);
    assert.equal(failedCheckResults?.[0]?.exitCode, 2);
    assert.equal(failedCheckResults?.[0]?.stderr, "check failed");

    const checks = await readFile(
      path.join(context.paths.dirs.checks, "13-milestone-1-checks.txt"),
      "utf8",
    );
    assert.match(checks, /Overall: failed/);
    assert.match(checks, /check failed/);
    const checkFailure = JSON.parse(
      await readFile(
        path.join(context.paths.dirs.checks, "13-milestone-1-check-failure-1.json"),
        "utf8",
      ),
    );
    assert.equal(checkFailure.kind, "check_failure_summary");
    assert.equal(checkFailure.fullCheckReportArtifactPath, path.join("checks", "13-milestone-1-checks.txt"));
    assert.equal(checkFailure.failedChecks[0].stderr.snippet, "check failed");
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow repairs failed checks and stops ready for review", async () => {
  const checkCommand = fixedFileCheckCommand();
  const context = await createImplementationContext({
    config: {
      checks: [checkCommand],
      runner: { type: "fake" },
      maxFixAttempts: 1,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
      humanReviewPolicy: "stop",
    },
  });
  const checkTimingCollector = createCheckTimingCollector();
  const runner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Plan\n\nCreate feature.txt.",
      exitCode: 0,
    },
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nCreated feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "initial\n" }],
    },
    {
      phase: "fix_check_failures",
      text: "# Check Repair\n\nCreated fixed.txt.",
      exitCode: 0,
      writeFiles: [{ path: "fixed.txt", content: "fixed\n" }],
    },
  ]);

  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner,
      checkTimingCollector,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(runner.phases(), [
      "milestone_plan",
      "implement_milestone",
      "fix_check_failures",
    ]);
    assert.match(runner.requests[2]?.prompt ?? "", /missing fixed file/);
    assert.match(runner.requests[2]?.prompt ?? "", /Check repair attempts completed/);
    assert.equal(result.state.currentPhase, "ready_for_review");
    assert.equal(result.state.status, "ready_for_review");
    assert.equal(result.state.milestoneStatuses["1"], "ready_for_review");
    assert.equal(result.state.lastError, null);
    assert.deepEqual(result.state.checkFixAttempts, { "1": 1 });
    assert.deepEqual(result.state.fixAttempts, {});
    assert.equal(
      result.state.artifacts.fixes?.["1-repair-1"],
      path.join("fixes", "21-milestone-1-check-repair-1.md"),
    );
    assert.equal(
      result.state.artifacts.diffs?.["1-repair-1"],
      path.join("diffs", "22-milestone-1-diff-after-check-repair-1.diff"),
    );
    assert.equal(
      result.state.artifacts.diffs?.["1"],
      path.join("diffs", "22-milestone-1-diff-after-check-repair-1.diff"),
    );
    assert.equal(
      result.state.artifacts.checks?.["1-repair-1"],
      path.join("checks", "23-milestone-1-checks-after-check-repair-1.txt"),
    );
    assert.equal(
      result.state.artifacts.checks?.["1"],
      path.join("checks", "23-milestone-1-checks-after-check-repair-1.txt"),
    );
    assert.deepEqual(result.state.artifacts.checkFailures, {
      "1-failed-1": path.join("checks", "13-milestone-1-check-failure-1.json"),
    });

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "14-milestone-1-summary.md"),
      "utf8",
    );
    assert.match(summary, /22-milestone-1-diff-after-check-repair-1\.diff/);
    assert.match(summary, /23-milestone-1-checks-after-check-repair-1\.txt/);

    const checkTimings = checkTimingCollector.list();
    assert.equal(checkTimings.length, 2);
    assert.equal(checkTimings[0]?.stateKey, "1");
    assert.equal(checkTimings[0]?.attempt, null);
    assert.equal(checkTimings[1]?.stateKey, "1-repair-1");
    assert.equal(checkTimings[1]?.attempt, 1);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow exhausts failed check repairs using maxCheckFixAttempts", async () => {
  const context = await createImplementationContext({
    config: {
      checks: [`${JSON.stringify(process.execPath)} -e "process.stderr.write('still failing'); process.exit(2)"`],
      runner: { type: "fake" },
      maxFixAttempts: 5,
      maxCheckFixAttempts: 2,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
      humanReviewPolicy: "stop",
    },
  });
  const runner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Plan\n\nCreate feature.txt.",
      exitCode: 0,
    },
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nCreated feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "initial\n" }],
    },
    {
      phase: "fix_check_failures",
      text: "# Check Repair 1\n\nChanged feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "repair 1\n" }],
    },
    {
      phase: "fix_check_failures",
      text: "# Check Repair 2\n\nChanged feature.txt again.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "repair 2\n" }],
    },
  ]);

  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Check repair attempts exhausted after 2 attempt/);
    assert.equal(result.state.currentPhase, "failed");
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.deepEqual(result.state.checkFixAttempts, { "1": 2 });
    assert.deepEqual(result.state.fixAttempts, {});
    assert.equal(
      result.state.artifacts.fixes?.["1-repair-1"],
      path.join("fixes", "21-milestone-1-check-repair-1.md"),
    );
    assert.equal(
      result.state.artifacts.fixes?.["1-repair-2"],
      path.join("fixes", "21-milestone-1-check-repair-2.md"),
    );
    assert.equal(
      result.state.artifacts.checks?.["1-repair-2"],
      path.join("checks", "23-milestone-1-checks-after-check-repair-2.txt"),
    );
    assert.equal(
      result.state.artifacts.checkFailures?.["1-repair-2"],
      path.join("checks", "23-milestone-1-check-failure-after-check-repair-2.json"),
    );
    assert.equal(
      result.state.artifacts.diffs?.["1"],
      path.join("diffs", "22-milestone-1-diff-after-check-repair-2.diff"),
    );
    assert.equal(
      (result.state.lastError?.details as { latestCheckFailureSummary?: string })
        .latestCheckFailureSummary,
      path.join("checks", "23-milestone-1-check-failure-after-check-repair-2.json"),
    );
    assert.deepEqual(runner.phases(), [
      "milestone_plan",
      "implement_milestone",
      "fix_check_failures",
      "fix_check_failures",
    ]);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow resumes explicit repair_failed recovery", async () => {
  const checkCommand = fixedFileCheckCommand();
  const context = await createImplementationContext({
    config: {
      checks: [checkCommand],
      runner: { type: "fake" },
      maxFixAttempts: 0,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
      humanReviewPolicy: "stop",
    },
  });
  const initialRunner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Plan\n\nCreate feature.txt.",
      exitCode: 0,
    },
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nCreated feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "initial\n" }],
    },
  ]);
  const resumeRunner = new ScenarioRunner([
    {
      phase: "fix_check_failures",
      text: "# Check Repair\n\nCreated fixed.txt.",
      exitCode: 0,
      writeFiles: [{ path: "fixed.txt", content: "fixed\n" }],
    },
  ]);

  try {
    const failed = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner: initialRunner,
    });
    assert.equal(failed.ok, false);
    if (failed.ok) return;
    assert.equal(failed.state.currentPhase, "failed");
    assert.equal(failed.state.status, "failed");

    const resumed = await runImplementationWorkflow({
      ...context.workflowOptions,
      config: {
        ...context.workflowOptions.config,
        maxFixAttempts: 1,
      },
      initialState: failed.state,
      runner: resumeRunner,
      resumeRecoveryMode: "repair_failed",
    });

    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    assert.deepEqual(resumeRunner.phases(), ["fix_check_failures"]);
    assert.equal(resumed.state.currentPhase, "ready_for_review");
    assert.equal(resumed.state.milestoneStatuses["1"], "ready_for_review");
    assert.deepEqual(resumed.state.checkFixAttempts, { "1": 1 });
    assert.equal(resumed.state.lastError, null);
    assert.deepEqual(await readState(context.paths.files.state), resumed.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow synthesizes a check failure summary for legacy repair recovery", async () => {
  const checkCommand = fixedFileCheckCommand();
  const context = await createImplementationContext({
    config: {
      checks: [checkCommand],
      runner: { type: "fake" },
      maxFixAttempts: 0,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
      humanReviewPolicy: "stop",
    },
  });
  const initialRunner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Plan\n\nCreate feature.txt.",
      exitCode: 0,
    },
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nCreated feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "initial\n" }],
    },
  ]);
  const resumeRunner = new ScenarioRunner([
    {
      phase: "fix_check_failures",
      text: "# Check Repair\n\nCreated fixed.txt.",
      exitCode: 0,
      writeFiles: [{ path: "fixed.txt", content: "fixed\n" }],
    },
  ]);

  try {
    const failed = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner: initialRunner,
    });
    assert.equal(failed.ok, false);
    if (failed.ok) return;

    await rm(
      path.join(context.paths.dirs.checks, "13-milestone-1-check-failure-1.json"),
      { force: true },
    );
    const legacyState: RunState = {
      ...failed.state,
      currentPhase: "checking",
      status: "failed",
      artifacts: {
        ...failed.state.artifacts,
        checkFailures: undefined,
      },
      lastError: {
        message: "Checks failed for milestone 1.",
        phase: "checking",
        occurredAt: failed.state.updatedAt,
      },
    };

    const resumed = await runImplementationWorkflow({
      ...context.workflowOptions,
      config: {
        ...context.workflowOptions.config,
        maxFixAttempts: 1,
      },
      initialState: legacyState,
      runner: resumeRunner,
      resumeRecoveryMode: "repair_failed",
    });

    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    assert.deepEqual(resumeRunner.phases(), ["fix_check_failures"]);
    assert.match(resumeRunner.requests[0]?.prompt ?? "", /missing fixed file/);
    assert.equal(
      resumed.state.artifacts.checkFailures?.["1-failed-1"],
      path.join("checks", "13-milestone-1-check-failure-1.json"),
    );
    const synthesizedSummary = JSON.parse(
      await readFile(
        path.join(context.paths.dirs.checks, "13-milestone-1-check-failure-1.json"),
        "utf8",
      ),
    );
    assert.match(
      synthesizedSummary.failedChecks[0].command,
      /legacy failed check report artifact/,
    );
    assert.equal(resumed.state.currentPhase, "ready_for_review");
    assert.deepEqual(await readState(context.paths.files.state), resumed.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow rechecks a manually repaired failed milestone", async () => {
  const checkCommand = fixedFileCheckCommand();
  const context = await createImplementationContext({
    config: {
      checks: [checkCommand],
      runner: { type: "fake" },
      maxFixAttempts: 0,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
      humanReviewPolicy: "stop",
    },
  });
  const initialRunner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Plan\n\nCreate feature.txt.",
      exitCode: 0,
    },
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nCreated feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "initial\n" }],
    },
  ]);
  const recheckRunner = new ScenarioRunner([]);

  try {
    const failed = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner: initialRunner,
    });
    assert.equal(failed.ok, false);
    if (failed.ok) return;

    await writeFile(path.join(context.repo, "fixed.txt"), "fixed\n", "utf8");

    const rechecked = await runImplementationWorkflow({
      ...context.workflowOptions,
      initialState: failed.state,
      runner: recheckRunner,
      resumeRecoveryMode: "recheck_failed",
    });

    assert.equal(rechecked.ok, true);
    if (!rechecked.ok) return;
    assert.deepEqual(recheckRunner.phases(), []);
    assert.equal(rechecked.state.currentPhase, "ready_for_review");
    assert.equal(rechecked.state.status, "ready_for_review");
    assert.equal(rechecked.state.milestoneStatuses["1"], "ready_for_review");
    assert.equal(rechecked.state.lastError, null);
    assert.equal(
      rechecked.state.artifacts.diffs?.["1-recheck-1"],
      path.join("diffs", "30-milestone-1-recheck-1.diff"),
    );
    assert.equal(
      rechecked.state.artifacts.checks?.["1-recheck-1"],
      path.join("checks", "31-milestone-1-recheck-1.txt"),
    );
    assert.equal(
      rechecked.state.artifacts.summaries?.["1-recheck-1"],
      path.join("milestones", "32-milestone-1-recheck-1-summary.md"),
    );
    assert.equal(
      rechecked.state.artifacts.diffs?.["1"],
      path.join("diffs", "30-milestone-1-recheck-1.diff"),
    );
    assert.equal(
      rechecked.state.artifacts.checks?.["1"],
      path.join("checks", "31-milestone-1-recheck-1.txt"),
    );
    assert.equal(
      rechecked.state.artifacts.summaries?.["1"],
      path.join("milestones", "32-milestone-1-recheck-1-summary.md"),
    );

    const recheckSummary = await readFile(
      path.join(context.paths.dirs.milestones, "32-milestone-1-recheck-1-summary.md"),
      "utf8",
    );
    assert.match(recheckSummary, /Original failed checks: checks\/13-milestone-1-checks\.txt/);
    assert.match(recheckSummary, /Promoted: yes/);
    assert.deepEqual(await readState(context.paths.files.state), rechecked.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow keeps a still-failing manual recheck blocked", async () => {
  const checkCommand = fixedFileCheckCommand();
  const context = await createImplementationContext({
    config: {
      checks: [checkCommand],
      runner: { type: "fake" },
      maxFixAttempts: 0,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
      humanReviewPolicy: "stop",
    },
  });
  const initialRunner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Plan\n\nCreate feature.txt.",
      exitCode: 0,
    },
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nCreated feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "initial\n" }],
    },
  ]);

  try {
    const failed = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner: initialRunner,
    });
    assert.equal(failed.ok, false);
    if (failed.ok) return;

    const rechecked = await runImplementationWorkflow({
      ...context.workflowOptions,
      initialState: failed.state,
      runner: new ScenarioRunner([]),
      resumeRecoveryMode: "recheck_failed",
    });

    assert.equal(rechecked.ok, false);
    if (rechecked.ok) return;
    assert.equal(rechecked.state.currentPhase, "checks_failed");
    assert.equal(rechecked.state.status, "checks_failed");
    assert.equal(rechecked.state.milestoneStatuses["1"], "checks_failed");
    assert.equal(
      rechecked.state.artifacts.checks?.["1"],
      path.join("checks", "13-milestone-1-checks.txt"),
    );
    assert.equal(
      rechecked.state.artifacts.checks?.["1-recheck-1"],
      path.join("checks", "31-milestone-1-recheck-1.txt"),
    );
    assert.equal(
      rechecked.state.artifacts.checkFailures?.["1-recheck-1"],
      path.join("checks", "31-milestone-1-check-failure-after-recheck-1.json"),
    );
    assert.equal(
      (rechecked.state.lastError?.details as { checkFailureSummary?: string }).checkFailureSummary,
      path.join("checks", "31-milestone-1-check-failure-after-recheck-1.json"),
    );
    const recheckSummary = await readFile(
      path.join(context.paths.dirs.milestones, "32-milestone-1-recheck-1-summary.md"),
      "utf8",
    );
    assert.match(recheckSummary, /Promoted: no/);
    assert.deepEqual(await readState(context.paths.files.state), rechecked.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow repairs from the latest failure after a failed recheck", async () => {
  const checkCommand = stagedCheckRepairCommand();
  const context = await createImplementationContext({
    config: {
      checks: [checkCommand],
      runner: { type: "fake" },
      maxFixAttempts: 0,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
      humanReviewPolicy: "stop",
    },
  });
  const initialRunner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Plan\n\nCreate feature.txt.",
      exitCode: 0,
    },
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nCreated feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "initial\n" }],
    },
  ]);
  const repairRunner = new ScenarioRunner([
    {
      phase: "fix_check_failures",
      text: "# Check Repair 1\n\nCreated repair marker.",
      exitCode: 0,
      writeFiles: [{ path: "repair-marker.txt", content: "repair attempted\n" }],
    },
    {
      phase: "fix_check_failures",
      text: "# Check Repair 2\n\nCreated fixed marker.",
      exitCode: 0,
      writeFiles: [{ path: "fixed.txt", content: "fixed\n" }],
    },
  ]);

  try {
    const failed = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner: initialRunner,
    });
    assert.equal(failed.ok, false);
    if (failed.ok) return;

    const rechecked = await runImplementationWorkflow({
      ...context.workflowOptions,
      initialState: failed.state,
      runner: new ScenarioRunner([]),
      resumeRecoveryMode: "recheck_failed",
    });
    assert.equal(rechecked.ok, false);
    if (rechecked.ok) return;
    assert.equal(
      rechecked.state.artifacts.checkFailures?.["1-recheck-1"],
      path.join("checks", "31-milestone-1-check-failure-after-recheck-1.json"),
    );

    const repaired = await runImplementationWorkflow({
      ...context.workflowOptions,
      config: {
        ...context.workflowOptions.config,
        maxFixAttempts: 2,
      },
      initialState: rechecked.state,
      runner: repairRunner,
      resumeRecoveryMode: "repair_failed",
    });

    assert.equal(repaired.ok, true);
    if (!repaired.ok) return;
    assert.deepEqual(repairRunner.phases(), [
      "fix_check_failures",
      "fix_check_failures",
    ]);
    assert.match(
      repairRunner.requests[0]?.prompt ?? "",
      /initial check missing repair marker/,
    );
    assert.match(
      repairRunner.requests[1]?.prompt ?? "",
      /repair marker present but fixed marker missing/,
    );
    assert.match(
      repairRunner.requests[1]?.prompt ?? "",
      /Full check report: checks\/23-milestone-1-checks-after-check-repair-1\.txt/,
    );
    assert.doesNotMatch(
      repairRunner.requests[1]?.prompt ?? "",
      /Full check report: checks\/31-milestone-1-recheck-1\.txt/,
    );
    assert.equal(
      repaired.state.artifacts.checkFailures?.["1-repair-1"],
      path.join("checks", "23-milestone-1-check-failure-after-check-repair-1.json"),
    );
    assert.equal(
      repaired.state.artifacts.checks?.["1"],
      path.join("checks", "23-milestone-1-checks-after-check-repair-2.txt"),
    );
    assert.deepEqual(await readState(context.paths.files.state), repaired.state);
  } finally {
    await context.cleanup();
  }
});

test("runImplementationWorkflow blocks manual recheck promotion for an empty reconciled diff", async () => {
  const checkCommand = fixedFileCheckCommand();
  const context = await createImplementationContext({
    config: {
      checks: [checkCommand],
      runner: { type: "fake" },
      maxFixAttempts: 0,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
      humanReviewPolicy: "stop",
    },
  });
  const initialRunner = new ScenarioRunner([
    {
      phase: "milestone_plan",
      text: "# Plan\n\nCreate feature.txt.",
      exitCode: 0,
    },
    {
      phase: "implement_milestone",
      text: "# Implementation\n\nCreated feature.txt.",
      exitCode: 0,
      writeFiles: [{ path: "feature.txt", content: "initial\n" }],
    },
  ]);

  try {
    const failed = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner: initialRunner,
    });
    assert.equal(failed.ok, false);
    if (failed.ok) return;

    await rm(path.join(context.repo, "feature.txt"), { force: true });

    const rechecked = await runImplementationWorkflow({
      ...context.workflowOptions,
      initialState: failed.state,
      runner: new ScenarioRunner([]),
      resumeRecoveryMode: "recheck_failed",
    });

    assert.equal(rechecked.ok, false);
    if (rechecked.ok) return;
    assert.match(rechecked.error, /reconciled diff is empty/);
    assert.equal(rechecked.state.currentPhase, "checks_failed");
    assert.equal(rechecked.state.milestoneStatuses["1"], "checks_failed");
    assert.equal(rechecked.state.artifacts.diffs?.["1-recheck-1"], undefined);
    assert.equal(
      (rechecked.state.lastError?.details as { reason?: string }).reason,
      "empty_reconciled_diff",
    );
    assert.deepEqual(await readState(context.paths.files.state), rechecked.state);
  } finally {
    await context.cleanup();
  }
});

interface ImplementationContext {
  repo: string;
  paths: RunPaths;
  workflowOptions: {
    goal: string;
    config: OrchestratorConfig;
    paths: RunPaths;
    initialState: RunState;
    commandRunner: typeof nodeCommandRunner;
    cwd: string;
    promptDir: string;
    now: () => Date;
  };
  cleanup: () => Promise<void>;
}

interface ContextOptions {
  config?: OrchestratorConfig;
  ignoreArtifactRoot?: boolean;
}

async function createImplementationContext(
  options: ContextOptions = {},
): Promise<ImplementationContext> {
  const fixtureRepo = await createFixtureRepo({
    prefix: "milestone-runner-implementation-",
    gitignore: options.ignoreArtifactRoot === false ? false : ".agent-work/\n",
    files: {
      "README.md": "# Fixture\n",
    },
  });
  const repo = fixtureRepo.path;
  const runFixture = await createReadyForMilestoneRunFixture({
    cwd: repo,
    startSha: await fixtureRepo.git(["rev-parse", "HEAD"]),
    config: options.config,
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
      promptDir: path.join(process.cwd(), "src", "prompts"),
      now: sequenceClock("2026-05-10T12:01:00.000Z"),
    },
    cleanup: fixtureRepo.cleanup,
  };
}

function lightImplementationConfig(): OrchestratorConfig {
  return implementationConfig("light");
}

function implementationConfig(
  milestonePlanPolicy: OrchestratorConfig["milestonePlanPolicy"],
  milestonePlanReviewPolicy: OrchestratorConfig["milestonePlanReviewPolicy"] = "normal",
): OrchestratorConfig {
  return {
    checks: [`${JSON.stringify(process.execPath)} -e "process.stdout.write('check ok')" `],
    runner: { type: "fake" },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    milestonePlanPolicy,
    milestonePlanReviewPolicy,
    humanReviewPolicy: "stop",
  };
}

function fixedFileCheckCommand(): string {
  const script = "const fs = require('node:fs'); if (!fs.existsSync('fixed.txt')) { process.stderr.write('missing fixed file'); process.exit(2); } process.stdout.write('fixed ok');";
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function stagedCheckRepairCommand(): string {
  const script = [
    "const fs = require('node:fs');",
    "if (!fs.existsSync('repair-marker.txt')) {",
    "  process.stderr.write('initial check missing repair marker');",
    "  process.exit(2);",
    "}",
    "if (!fs.existsSync('fixed.txt')) {",
    "  process.stderr.write('repair marker present but fixed marker missing');",
    "  process.exit(3);",
    "}",
    "process.stdout.write('fixed ok');",
  ].join(" ");
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

type ImplementationPhase =
  | "milestone_plan"
  | "milestone_plan_review"
  | "final_milestone_plan"
  | "implement_milestone"
  | "fix_check_failures";

class ScriptedImplementationRunner implements AgentRunner {
  readonly type = "scripted";

  constructor(private readonly responses: Partial<Record<ImplementationPhase, AgentRunResult>>) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    return this.responses[request.phase as ImplementationPhase] ?? {
      text: `Unhandled phase ${request.phase}`,
      exitCode: 1,
    };
  }
}
