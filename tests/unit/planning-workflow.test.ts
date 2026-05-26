import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import { buildRunPaths, type RunPaths } from "../../src/artifacts/paths.js";
import type { OrchestratorConfig } from "../../src/config/config-types.js";
import type { ResolvedSeedMajorPlan } from "../../src/inputs/initial-inputs.js";
import type { AgentRunner, AgentRunRequest, AgentRunResult } from "../../src/runners/agent-runner.js";
import { FakeRunner } from "../../src/runners/fake/fake-runner.js";
import { createInitialState } from "../../src/state/initial-state.js";
import { readState } from "../../src/state/state-store.js";
import type { RunState } from "../../src/state/state-types.js";
import { runPlanningWorkflow } from "../../src/planning/planning-workflow.js";
import {
  statePhaseForPlanningRunnerPhase,
  type PlanningRunnerPhase,
} from "../../src/planning/planning-types.js";
import { ScenarioRunner } from "../helpers/scenario-runner.js";

test("statePhaseForPlanningRunnerPhase maps runner phases to state phases", () => {
  assert.equal(statePhaseForPlanningRunnerPhase("major_plan"), "planning");
  assert.equal(statePhaseForPlanningRunnerPhase("major_plan_review"), "plan_reviewing");
  assert.equal(statePhaseForPlanningRunnerPhase("final_major_plan"), "planning");
  assert.equal(statePhaseForPlanningRunnerPhase("final_plan_json"), "planning");
});

test("runPlanningWorkflow writes planning artifacts and ready state", async () => {
  const context = await createWorkflowContext();
  try {
    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      runner: new FakeRunner(),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.state.currentPhase, "ready_for_milestone");
    assert.equal(result.state.status, "ready_for_milestone");
    assert.equal(result.state.currentMilestoneId, 1);
    assert.deepEqual(result.state.milestoneStatuses, {
      "1": "pending",
      "2": "pending",
    });
    assert.equal(result.state.artifacts.majorPlan, "plans/01-major-plan.md");
    assert.equal(result.state.artifacts.majorPlanReview, "plans/02-major-plan-review.md");
    assert.equal(
      result.state.artifacts.finalMajorPlanMarkdown,
      "plans/03-final-major-plan.md",
    );
    assert.equal(result.state.artifacts.milestones, "milestones/05-milestones.json");

    assert.match(
      await readFile(path.join(context.paths.dirs.plans, "01-major-plan.md"), "utf8"),
      /^# Fake Major Plan/,
    );
    assert.match(
      await readFile(path.join(context.paths.dirs.plans, "02-major-plan-review.md"), "utf8"),
      /^# Fake Major Plan Review/,
    );
    assert.match(
      await readFile(path.join(context.paths.dirs.plans, "03-final-major-plan.md"), "utf8"),
      /^# Fake Final Major Plan/,
    );

    const milestones = JSON.parse(
      await readFile(path.join(context.paths.dirs.milestones, "05-milestones.json"), "utf8"),
    ) as { milestones: unknown[] };
    assert.equal(milestones.milestones.length, 2);

    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow passes target cwd to every runner phase", async () => {
  const context = await createWorkflowContext();
  const runner = new ScenarioRunner([
    {
      phase: "major_plan",
      text: "# Major Plan",
      exitCode: 0,
    },
    {
      phase: "major_plan_review",
      text: "# Major Plan Review",
      exitCode: 0,
    },
    {
      phase: "final_major_plan",
      text: "# Final Major Plan",
      exitCode: 0,
    },
    {
      phase: "final_plan_json",
      text: JSON.stringify({
        milestones: [
          {
            id: 1,
            title: "First milestone",
            summary: "Implement the first milestone.",
            scope: ["Create a fixture output file"],
            acceptanceCriteria: ["A fixture output file exists"],
            verification: ["Configured checks pass"],
            dependencies: [],
            status: "pending",
          },
        ],
      }),
      exitCode: 0,
    },
  ], "codex-exec");

  try {
    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(runner.phases(), [
      "major_plan",
      "major_plan_review",
      "final_major_plan",
      "final_plan_json",
    ]);
    assert.deepEqual(
      runner.requests.map((request) => request.cwd),
      [
        context.workflowOptions.cwd,
        context.workflowOptions.cwd,
        context.workflowOptions.cwd,
        context.workflowOptions.cwd,
      ],
    );
    assert.deepEqual(
      runner.requests.map((request) => request.outputSchemaPath ?? null),
      [
        null,
        null,
        null,
        path.resolve(
          context.workflowOptions.cwd,
          "schemas",
          "milestones.schema.json",
        ),
      ],
    );

    assert.deepEqual((await readdir(context.paths.dirs.runner)).sort(), [
      "final_major_plan-03.json",
      "final_plan_json-04.json",
      "major_plan-01.json",
      "major_plan_review-02.json",
    ]);
    const finalPlanDiagnostic = JSON.parse(
      await readFile(
        path.join(context.paths.dirs.runner, "final_plan_json-04.json"),
        "utf8",
      ),
    );
    assert.equal(finalPlanDiagnostic.phase, "final_plan_json");
    assert.equal(finalPlanDiagnostic.runner, "codex-exec");
    assert.equal(finalPlanDiagnostic.exitCode, 0);
    assert.equal(
      finalPlanDiagnostic.outputSchemaPath,
      path.resolve(context.workflowOptions.cwd, "schemas", "milestones.schema.json"),
    );
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow includes initial context in major plan prompt and artifacts", async () => {
  const context = await createWorkflowContext();
  const initialState: RunState = {
    ...context.workflowOptions.initialState,
    inputs: {
      goalSource: { type: "file", path: "docs/task.md" },
      context: [
        {
          path: "README.md",
          artifactPath: "inputs/context/01-README.md",
          sizeBytes: 12,
          sha256: "readme-sha",
        },
        {
          path: "docs/architecture.md",
          artifactPath: "inputs/context/02-architecture.md",
          sizeBytes: 18,
          sha256: "architecture-sha",
        },
      ],
    },
    artifacts: {
      ...context.workflowOptions.initialState.artifacts,
      inputs: {
        manifest: "inputs/01-inputs.json",
        context: {
          "README.md": "inputs/context/01-README.md",
          "docs/architecture.md": "inputs/context/02-architecture.md",
        },
      },
    },
  };
  const runner = new ScenarioRunner([
    {
      phase: "major_plan",
      text: "# Major Plan",
      exitCode: 0,
    },
    {
      phase: "major_plan_review",
      text: "# Major Plan Review",
      exitCode: 0,
    },
    {
      phase: "final_major_plan",
      text: "# Final Major Plan",
      exitCode: 0,
    },
    {
      phase: "final_plan_json",
      text: JSON.stringify({
        milestones: [
          {
            id: 1,
            title: "First milestone",
            summary: "Implement the first milestone.",
            scope: ["Create a fixture output file"],
            acceptanceCriteria: ["A fixture output file exists"],
            verification: ["Configured checks pass"],
            dependencies: [],
            status: "pending",
          },
        ],
      }),
      exitCode: 0,
    },
  ]);

  try {
    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      initialState,
      runner,
    });

    assert.equal(result.ok, true);
    const majorPlanRequest = runner.requests[0];
    assert.equal(majorPlanRequest?.phase, "major_plan");
    assert.match(majorPlanRequest?.prompt ?? "", /Initial context files:/);
    assert.match(majorPlanRequest?.prompt ?? "", /README\.md/);
    assert.match(majorPlanRequest?.prompt ?? "", /docs\/architecture\.md/);
    assert.match(majorPlanRequest?.prompt ?? "", /snapshot artifact/);
    assert.deepEqual(majorPlanRequest?.artifacts, {
      goal: "00-goal.txt",
      initialInputsManifest: "inputs/01-inputs.json",
      initialContext1: "inputs/context/01-README.md",
      initialContext2: "inputs/context/02-architecture.md",
    });
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow uses a seeded major plan and skips the major_plan runner phase", async () => {
  const context = await createWorkflowContext();
  const seed = resolvedSeedMajorPlan(
    "docs/seeded-major-plan.md",
    "# Seeded Major Plan\n\nUse this operator-drafted plan.",
  );
  const initialState = withSeededMajorPlanSource(
    context.workflowOptions.initialState,
    seed,
    {
      withContext: true,
    },
  );
  const runner = new ScenarioRunner([
    {
      phase: "major_plan_review",
      text: "# Major Plan Review",
      exitCode: 0,
    },
    {
      phase: "final_major_plan",
      text: "# Final Major Plan",
      exitCode: 0,
    },
    {
      phase: "final_plan_json",
      text: singlePendingMilestoneJson(),
      exitCode: 0,
    },
  ], "codex-exec");

  try {
    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      initialState,
      resolvedSeedMajorPlan: seed,
      runner,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(runner.phases(), [
      "major_plan_review",
      "final_major_plan",
      "final_plan_json",
    ]);

    assert.equal(
      await readFile(path.join(context.paths.dirs.plans, "01-major-plan.md"), "utf8"),
      `${seed.text.trimEnd()}\n`,
    );

    const reviewRequest = runner.requests[0];
    assert.equal(reviewRequest?.phase, "major_plan_review");
    assert.match(reviewRequest?.prompt ?? "", /# Seeded Major Plan/);
    assert.match(reviewRequest?.prompt ?? "", /Initial context files:/);
    assert.match(reviewRequest?.prompt ?? "", /README\.md/);
    assert.match(reviewRequest?.prompt ?? "", /reviewing or finalizing/);
    assert.deepEqual(reviewRequest?.artifacts, {
      goal: "00-goal.txt",
      majorPlan: "plans/01-major-plan.md",
      initialInputsManifest: "inputs/01-inputs.json",
      initialContext1: "inputs/context/01-README.md",
    });

    assert.deepEqual((await readdir(context.paths.dirs.runner)).sort(), [
      "final_major_plan-02.json",
      "final_plan_json-03.json",
      "major_plan_review-01.json",
    ]);
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow rejects a seed cache that does not match run state", async () => {
  const context = await createWorkflowContext();
  const seed = resolvedSeedMajorPlan("docs/seeded-major-plan.md", "# Seeded Plan");
  const mismatchedSeed: ResolvedSeedMajorPlan = {
    ...seed,
    sha256: "0".repeat(64),
  };
  const runner = new ScenarioRunner([]);

  try {
    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      initialState: withSeededMajorPlanSource(
        context.workflowOptions.initialState,
        seed,
      ),
      resolvedSeedMajorPlan: mismatchedSeed,
      runner,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /does not match saved seeded major plan source/);
    assert.deepEqual(runner.phases(), []);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "planning");
    assert.equal(result.state.artifacts.majorPlan, undefined);
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow rejects a seed cache when run state is not seeded", async () => {
  const context = await createWorkflowContext();
  const runner = new ScenarioRunner([]);

  try {
    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      resolvedSeedMajorPlan: resolvedSeedMajorPlan(
        "docs/seeded-major-plan.md",
        "# Seeded Plan",
      ),
      runner,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /run state does not mark the major plan source as seed/i);
    assert.deepEqual(runner.phases(), []);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "planning");
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow fails seeded plan review as plan_reviewing", async () => {
  const context = await createWorkflowContext();
  const seed = resolvedSeedMajorPlan("docs/seeded-major-plan.md", "# Seeded Plan");
  const runner = new ScenarioRunner([
    {
      phase: "major_plan_review",
      text: "review failed",
      exitCode: 7,
    },
  ]);

  try {
    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      initialState: withSeededMajorPlanSource(
        context.workflowOptions.initialState,
        seed,
      ),
      resolvedSeedMajorPlan: seed,
      runner,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /major_plan_review failed with exit code 7/);
    assert.deepEqual(runner.phases(), ["major_plan_review"]);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "plan_reviewing");
    assert.equal(result.state.lastError?.phase, "plan_reviewing");
    assert.equal(result.state.artifacts.majorPlan, "plans/01-major-plan.md");
    assert.equal(result.state.artifacts.majorPlanReview, undefined);
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow resumes seeded planning from an existing major plan artifact", async () => {
  const context = await createWorkflowContext();
  const seed = resolvedSeedMajorPlan(
    "docs/seeded-major-plan.md",
    "# Seeded Resume Plan\n\nContinue reviewing this plan.\n",
  );
  const initialState = withMajorPlanArtifact(
    asResumedPlanningState(
      withSeededMajorPlanSource(context.workflowOptions.initialState, seed),
    ),
    "plans/01-major-plan.md",
  );
  const runner = seededResumeRunner();

  try {
    await writeRunArtifact(
      context.paths,
      "plans/01-major-plan.md",
      `${seed.text.trimEnd()}\n`,
    );

    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      initialState,
      runner,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(runner.phases(), [
      "major_plan_review",
      "final_major_plan",
      "final_plan_json",
    ]);
    assert.equal(runner.requests[0]?.phase, "major_plan_review");
    assert.match(runner.requests[0]?.prompt ?? "", /# Seeded Resume Plan/);
    assert.equal(
      await readFile(path.join(context.paths.dirs.plans, "01-major-plan.md"), "utf8"),
      `${seed.text.trimEnd()}\n`,
    );
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow resumes seeded planning by recreating a missing major plan artifact from source", async () => {
  const context = await createWorkflowContext();
  const seed = resolvedSeedMajorPlan(
    "docs/seeded-major-plan.md",
    "# Seeded Source Plan\n\nRecreate the artifact from this file.\n",
  );
  const runner = seededResumeRunner();

  try {
    await writeTargetRepositoryFile(context, seed.path, seed.text);

    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      ...targetWorkflowOptions(context),
      initialState: asResumedPlanningState(
        withSeededMajorPlanSource(context.workflowOptions.initialState, seed),
      ),
      runner,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(runner.phases(), [
      "major_plan_review",
      "final_major_plan",
      "final_plan_json",
    ]);
    assert.equal(result.state.artifacts.majorPlan, "plans/01-major-plan.md");
    assert.equal(
      await readFile(path.join(context.paths.dirs.plans, "01-major-plan.md"), "utf8"),
      `${seed.text.trimEnd()}\n`,
    );
    assert.match(runner.requests[0]?.prompt ?? "", /# Seeded Source Plan/);
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow blocks seeded resume when the source file hash changed", async () => {
  const context = await createWorkflowContext();
  const seed = resolvedSeedMajorPlan(
    "docs/seeded-major-plan.md",
    "# Original Seed Plan\n",
  );
  const runner = new ScenarioRunner([]);

  try {
    await writeTargetRepositoryFile(context, seed.path, "# Changed Seed Plan\n");

    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      ...targetWorkflowOptions(context),
      initialState: asResumedPlanningState(
        withSeededMajorPlanSource(context.workflowOptions.initialState, seed),
      ),
      runner,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /changed since the run was initialized/);
    assert.deepEqual(runner.phases(), []);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "planning");
    assert.equal(result.state.artifacts.majorPlan, undefined);
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow blocks seeded resume when both artifact and source are unavailable", async () => {
  const context = await createWorkflowContext();
  const seed = resolvedSeedMajorPlan(
    "docs/missing-seeded-major-plan.md",
    "# Missing Seed Plan\n",
  );
  const runner = new ScenarioRunner([]);

  try {
    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      ...targetWorkflowOptions(context),
      initialState: asResumedPlanningState(
        withSeededMajorPlanSource(context.workflowOptions.initialState, seed),
      ),
      runner,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Seed major plan file is unavailable/);
    assert.deepEqual(runner.phases(), []);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "planning");
    assert.equal(result.state.artifacts.majorPlan, undefined);
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow blocks seeded resume when the saved major plan artifact is invalid UTF-8", async () => {
  const context = await createWorkflowContext();
  const seed = resolvedSeedMajorPlan(
    "docs/seeded-major-plan.md",
    "# Seeded Resume Plan\n",
  );
  const initialState = withMajorPlanArtifact(
    asResumedPlanningState(
      withSeededMajorPlanSource(context.workflowOptions.initialState, seed),
    ),
    "plans/01-major-plan.md",
  );
  const runner = new ScenarioRunner([]);

  try {
    await writeRunArtifact(
      context.paths,
      "plans/01-major-plan.md",
      Buffer.from([0xff, 0xfe, 0xfd]),
    );

    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      initialState,
      runner,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Seeded major plan artifact must be valid UTF-8 text/);
    assert.deepEqual(runner.phases(), []);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "planning");
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow writes diagnostics and references them on codex runner failure", async () => {
  const context = await createWorkflowContext();
  const runner = new ScenarioRunner([
    {
      phase: "major_plan",
      text: "failed",
      exitCode: 2,
      metadata: {
        runner: "codex-exec",
        command: "codex",
        args: ["exec", "-"],
        cwd: context.workflowOptions.cwd,
        stdout: "",
        stderr: "runner failed",
        error: "process exited",
        env: { SECRET: "SECRET_VALUE" },
      },
    },
  ], "codex-exec");

  try {
    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /major_plan failed with exit code 2/);

    const diagnosticArtifact = diagnosticArtifactFromDetails(
      result.state.lastError?.details,
    );
    assert.equal(diagnosticArtifact, path.join("runner", "major_plan-01.json"));

    const raw = await readFile(
      path.join(context.paths.runDir, diagnosticArtifact ?? ""),
      "utf8",
    );
    assert.doesNotMatch(raw, /SECRET_VALUE/);
    const diagnostic = JSON.parse(raw);
    assert.equal(diagnostic.phase, "major_plan");
    assert.equal(diagnostic.runner, "codex-exec");
    assert.equal(diagnostic.command, "codex");
    assert.deepEqual(diagnostic.args, ["exec", "-"]);
    assert.equal(diagnostic.exitCode, 2);
    assert.equal(diagnostic.stderr, "runner failed");
    assert.equal(diagnostic.error, "process exited");
    assert.equal(diagnostic.startedAt, "2026-05-10T12:00:02.000Z");
    assert.equal(diagnostic.endedAt, "2026-05-10T12:00:03.000Z");
    assert.equal(diagnostic.durationMs, 1000);
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow fails before final_plan_json runner call when codex schema is missing", async () => {
  const context = await createWorkflowContext();
  const runner = new ScenarioRunner([
    {
      phase: "major_plan",
      text: "# Major Plan",
      exitCode: 0,
    },
    {
      phase: "major_plan_review",
      text: "# Major Plan Review",
      exitCode: 0,
    },
    {
      phase: "final_major_plan",
      text: "# Final Major Plan",
      exitCode: 0,
    },
    {
      phase: "final_plan_json",
      text: "{}",
      exitCode: 0,
    },
  ], "codex-exec");

  try {
    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      cwd: context.paths.runDir,
      promptDir: path.join(process.cwd(), "src", "prompts"),
      runner,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Required output schema for phase final_plan_json/);
    assert.deepEqual(runner.phases(), [
      "major_plan",
      "major_plan_review",
      "final_major_plan",
    ]);
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow persists failed state on runner failure", async () => {
  const context = await createWorkflowContext();
  try {
    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      runner: new ScriptedRunner({
        major_plan: {
          text: "failed",
          exitCode: 1,
        },
      }),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;

    assert.match(result.error, /Runner phase major_plan failed/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "planning");
    assert.equal(result.state.lastError?.phase, "planning");
    assert.match(result.state.lastError?.message ?? "", /major_plan/);
    assert.equal(result.state.artifacts.majorPlan, undefined);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow persists failed state when a runner phase throws", async () => {
  const context = await createWorkflowContext();
  try {
    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([
        {
          phase: "major_plan",
          text: "",
          exitCode: 0,
          throwError: "planning runner crashed",
        },
      ]),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;

    assert.match(result.error, /Runner phase major_plan threw an error/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "planning");
    assert.equal(result.state.lastError?.phase, "planning");
    assert.match(result.state.lastError?.message ?? "", /planning runner crashed/);
    assert.equal(result.state.artifacts.majorPlan, undefined);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow persists failed state on empty runner output", async () => {
  const context = await createWorkflowContext();
  try {
    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      runner: new ScriptedRunner({
        major_plan: {
          text: "  \n",
          exitCode: 0,
        },
      }),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;

    assert.match(result.error, /major_plan returned empty output/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "planning");
    assert.equal(result.state.artifacts.majorPlan, undefined);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runPlanningWorkflow preserves earlier artifacts when milestone JSON is invalid", async () => {
  const context = await createWorkflowContext();
  try {
    const result = await runPlanningWorkflow({
      ...context.workflowOptions,
      runner: new ScriptedRunner({
        major_plan: {
          text: "# Major Plan",
          exitCode: 0,
        },
        major_plan_review: {
          text: "# Review",
          exitCode: 0,
        },
        final_major_plan: {
          text: "# Final Plan",
          exitCode: 0,
        },
        final_plan_json: {
          text: "{",
          exitCode: 0,
        },
      }),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;

    assert.match(result.error, /Invalid milestone metadata JSON/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "planning");
    assert.equal(result.state.artifacts.majorPlan, "plans/01-major-plan.md");
    assert.equal(result.state.artifacts.majorPlanReview, "plans/02-major-plan-review.md");
    assert.equal(
      result.state.artifacts.finalMajorPlanMarkdown,
      "plans/03-final-major-plan.md",
    );
    assert.equal(result.state.artifacts.milestones, undefined);
    await assert.rejects(
      () => access(path.join(context.paths.dirs.milestones, "05-milestones.json")),
      /ENOENT/,
    );
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

function resolvedSeedMajorPlan(
  filePath: string,
  text: string,
): ResolvedSeedMajorPlan {
  return {
    text,
    path: filePath,
    canonicalPath: path.resolve("/repo", filePath),
    sizeBytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

function withSeededMajorPlanSource(
  state: RunState,
  seed: ResolvedSeedMajorPlan,
  options: { withContext?: boolean } = {},
): RunState {
  const context = options.withContext
    ? [
        {
          path: "README.md",
          artifactPath: "inputs/context/01-README.md",
          sizeBytes: 12,
          sha256: "readme-sha",
        },
      ]
    : [];

  return {
    ...state,
    inputs: {
      goalSource: { type: "argv", path: null },
      majorPlanSource: {
        type: "seed",
        path: seed.path,
        sizeBytes: seed.sizeBytes,
        sha256: seed.sha256,
      },
      context,
    },
    artifacts: {
      ...state.artifacts,
      inputs: {
        manifest: "inputs/01-inputs.json",
        ...(context.length === 0
          ? {}
          : { context: { "README.md": "inputs/context/01-README.md" } }),
      },
    },
  };
}

function asResumedPlanningState(
  state: RunState,
  phase: "planning" | "plan_reviewing" = "planning",
): RunState {
  return {
    ...state,
    currentPhase: phase,
    status: phase,
  };
}

function withMajorPlanArtifact(
  state: RunState,
  artifactPath: string,
): RunState {
  return {
    ...state,
    artifacts: {
      ...state.artifacts,
      majorPlan: artifactPath,
    },
  };
}

function seededResumeRunner(): ScenarioRunner {
  return new ScenarioRunner([
    {
      phase: "major_plan_review",
      text: "# Major Plan Review",
      exitCode: 0,
    },
    {
      phase: "final_major_plan",
      text: "# Final Major Plan",
      exitCode: 0,
    },
    {
      phase: "final_plan_json",
      text: singlePendingMilestoneJson(),
      exitCode: 0,
    },
  ], "codex-exec");
}

function targetWorkflowOptions(
  context: WorkflowContext,
): { cwd: string; promptDir: string; schemaRoot: string } {
  return {
    cwd: targetRoot(context),
    promptDir: path.resolve(process.cwd(), "src", "prompts"),
    schemaRoot: path.resolve(process.cwd(), "schemas"),
  };
}

function targetRoot(context: WorkflowContext): string {
  return path.dirname(context.paths.artifactRoot);
}

async function writeTargetRepositoryFile(
  context: WorkflowContext,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = path.join(targetRoot(context), relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function writeRunArtifact(
  paths: RunPaths,
  artifactPath: string,
  content: string | Buffer,
): Promise<void> {
  const filePath = path.resolve(paths.runDir, ...artifactPath.split("/"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

function singlePendingMilestoneJson(): string {
  return JSON.stringify({
    milestones: [
      {
        id: 1,
        title: "First milestone",
        summary: "Implement the first milestone.",
        scope: ["Create a fixture output file"],
        acceptanceCriteria: ["A fixture output file exists"],
        verification: ["Configured checks pass"],
        dependencies: [],
        status: "pending",
      },
    ],
  });
}

interface WorkflowContext {
  paths: RunPaths;
  workflowOptions: {
    goal: string;
    config: OrchestratorConfig;
    paths: RunPaths;
    initialState: RunState;
    cwd: string;
    milestonesSchema: object;
    now: () => Date;
  };
  cleanup: () => Promise<void>;
}

async function createWorkflowContext(): Promise<WorkflowContext> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-planning-"));
  const paths = buildRunPaths({
    cwd: tempDir,
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const goal = "Add feature X";
  const config: OrchestratorConfig = {
    checks: [],
    runner: { type: "fake" },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    milestonePlanPolicy: "always",
    milestonePlanReviewPolicy: "normal",
  };

  await createRunDirectory(paths, goal);
  const initialState = createInitialState({
    runId: "run-1",
    goal,
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
    configSnapshot: config,
    now: new Date("2026-05-10T12:00:00.000Z"),
  });

  return {
    paths,
    workflowOptions: {
      goal,
      config,
      paths,
      initialState,
      cwd: process.cwd(),
      milestonesSchema: { type: "object" },
      now: sequenceClock("2026-05-10T12:00:01.000Z"),
    },
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

function sequenceClock(startIso: string): () => Date {
  let offset = 0;
  const start = new Date(startIso).getTime();

  return () => {
    const date = new Date(start + offset);
    offset += 1000;
    return date;
  };
}

class ScriptedRunner implements AgentRunner {
  readonly type = "scripted";

  constructor(private readonly responses: Partial<Record<PlanningRunnerPhase, AgentRunResult>>) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    return (
      this.responses[request.phase as PlanningRunnerPhase] ?? {
        text: `Unhandled phase ${request.phase}`,
        exitCode: 1,
      }
    );
  }
}

function diagnosticArtifactFromDetails(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  if (!("diagnosticArtifact" in details)) return undefined;
  return typeof details.diagnosticArtifact === "string"
    ? details.diagnosticArtifact
    : undefined;
}
