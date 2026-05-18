import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import { buildRunPaths, type RunPaths } from "../../src/artifacts/paths.js";
import type { OrchestratorConfig } from "../../src/config/config-types.js";
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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-planning-"));
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
