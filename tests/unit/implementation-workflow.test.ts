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
    assert.equal(implementationDiagnostic.startedAt, "2026-05-10T12:01:06.000Z");
    assert.equal(implementationDiagnostic.endedAt, "2026-05-10T12:01:07.000Z");
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
      milestonePlanPolicy: "always",
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

function lightImplementationConfig(): OrchestratorConfig {
  return implementationConfig("light");
}

function implementationConfig(
  milestonePlanPolicy: OrchestratorConfig["milestonePlanPolicy"],
): OrchestratorConfig {
  return {
    checks: [`${JSON.stringify(process.execPath)} -e "process.stdout.write('check ok')" `],
    runner: { type: "fake" },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    milestonePlanPolicy,
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
