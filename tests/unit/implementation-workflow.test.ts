import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
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
import { createFixtureRepo } from "../helpers/fixture-repo.js";
import {
  createReadyForMilestoneRunFixture,
  sequenceClock,
} from "../helpers/run-fixture.js";
import { ScenarioRunner } from "../helpers/scenario-runner.js";

test("runImplementationWorkflow implements one fake milestone and stops ready for review", async () => {
  const context = await createImplementationContext();
  try {
    const result = await runImplementationWorkflow({
      ...context.workflowOptions,
      runner: new FakeRunner(),
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
    assert.match(summary, /Milestone 5 must review/);

    assert.deepEqual(await readState(context.paths.files.state), result.state);
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
    assert.equal(result.state.currentPhase, "checking");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.deepEqual(result.state.artifacts.checks, {
      "1": path.join("checks", "13-milestone-1-checks.txt"),
    });
    assert.equal(result.state.artifacts.summaries, undefined);

    const checks = await readFile(
      path.join(context.paths.dirs.checks, "13-milestone-1-checks.txt"),
      "utf8",
    );
    assert.match(checks, /Overall: failed/);
    assert.match(checks, /check failed/);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
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
    prefix: "agent-orchestrator-implementation-",
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

type ImplementationPhase = "milestone_plan" | "implement_milestone";

class ScriptedImplementationRunner implements AgentRunner {
  readonly type = "scripted";

  constructor(private readonly responses: Record<ImplementationPhase, AgentRunResult>) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    return this.responses[request.phase as ImplementationPhase] ?? {
      text: `Unhandled phase ${request.phase}`,
      exitCode: 1,
    };
  }
}
