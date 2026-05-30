import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRunPaths } from "../../src/artifacts/paths.js";
import { buildRunJsonReport, printRunReport } from "../../src/cli/run-report.js";
import { createInitialState } from "../../src/state/initial-state.js";

test("printRunReport includes runner diagnostic paths from last error details", () => {
  const paths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const state = {
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
      configPath: "/repo/orchestrator.config.json",
      configSnapshot: {
        checks: [],
        runner: {
          type: "codex-exec",
          command: "codex",
          options: {
            sandboxForPlanning: "read-only",
            sandboxForImplementation: "workspace-write",
            approvalPolicy: "never",
          },
        },
        maxFixAttempts: 0,
        artifactRoot: ".agent-work",
        milestonePlanPolicy: "always",
        milestonePlanReviewPolicy: "normal",
        humanReviewPolicy: "stop",
      },
    }),
    currentPhase: "planning" as const,
    status: "failed" as const,
    lastError: {
      message: "Runner phase major_plan failed with exit code 1.",
      phase: "planning" as const,
      occurredAt: "2026-05-10T12:00:00.000Z",
      details: {
        diagnosticArtifact: "runner/major_plan-01.json",
      },
    },
  };

  const report = {
    mode: "new",
    runId: "run-1",
    paths,
    goal: "Add feature X",
    planningOnly: false,
    allowDirty: false,
    allowNonGitPlanning: false,
    targetMilestone: null,
    runnerType: "codex-exec",
    runnerConfig: {
      type: "codex-exec",
      command: "codex",
      accountLabel: "work-codex",
      options: {
        sandboxForPlanning: "read-only",
        sandboxForImplementation: "workspace-write",
        approvalPolicy: "never",
        profile: "automation",
      },
    },
    configPath: "/repo/orchestrator.config.json",
    configSource: "config file",
    artifactRoot: ".agent-work",
    checks: [],
    maxFixAttempts: 0,
    milestonePlanPolicy: "always",
    milestonePlanReviewPolicy: "normal",
    humanReviewPolicy: "stop",
    gitRequired: true,
    gitRoot: "/repo",
    gitDirty: false,
    gitDirtyOverride: false,
    gitNonGitPlanningOverride: false,
    finalState: state,
    timingWarnings: [
      {
        code: "timing_finalization_failed",
        source: "finalization",
        message: "Failed to finalize timing artifacts: EISDIR.",
      },
    ],
  } satisfies Parameters<typeof printRunReport>[0];

  const lines = captureConsoleLog(() => {
    printRunReport(report);
  });

  const output = lines.join("\n");
  assert.match(output, /Major plan source: runner/);
  assert.match(output, /Runner profile: automation/);
  assert.match(output, /Runner account label: work-codex/);
  assert.match(
    output,
    /Runner authentication: account label "work-codex" using Codex profile "automation"/,
  );
  assert.match(output, /Runner diagnostic: runner\/major_plan-01\.json/);
  assert.match(output, /Milestone plan policy: always/);
  assert.match(output, /Milestone plan review policy: normal/);
  assert.match(output, /Human review policy: stop/);
  assert.match(output, /Scrupulous review for next milestone: no \(policy normal\)/);
  assert.match(
    output,
    /Timing warnings:\n  \[timing_finalization_failed\] finalization: Failed to finalize timing artifacts: EISDIR\./,
  );

  const jsonReport = buildRunJsonReport(report, 1);
  assert.equal(jsonReport.details.runnerProfile, "automation");
  assert.equal(jsonReport.details.runnerAccountLabel, "work-codex");
  assert.equal(
    jsonReport.details.runnerAuthentication,
    'account label "work-codex" using Codex profile "automation"',
  );
  assert.deepEqual(jsonReport.details.majorPlanSource, {
    type: "runner",
    path: null,
  });
});

test("printRunReport includes seeded major plan source", () => {
  const paths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const state = createInitialState({
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
    configPath: null,
    configSnapshot: {
      checks: [],
      runner: { type: "fake" },
      maxFixAttempts: 0,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
      humanReviewPolicy: "stop",
    },
    inputs: {
      goalSource: { type: "argv", path: null },
      majorPlanSource: {
        type: "seed",
        path: "tasks/major-plan.md",
        sizeBytes: 123,
        sha256: "seed-sha",
      },
      context: [],
    },
  });

  const report = {
    mode: "new",
    runId: "run-1",
    paths,
    goal: "Add feature X",
    planningOnly: true,
    allowDirty: false,
    allowNonGitPlanning: false,
    targetMilestone: null,
    runnerType: "fake",
    configPath: null,
    configSource: "default config",
    artifactRoot: ".agent-work",
    checks: [],
    maxFixAttempts: 0,
    milestonePlanPolicy: "always",
    milestonePlanReviewPolicy: "normal",
    humanReviewPolicy: "stop",
    gitRequired: false,
    gitRoot: "unavailable",
    gitDirty: false,
    gitDirtyOverride: false,
    gitNonGitPlanningOverride: false,
    finalState: state,
  } satisfies Parameters<typeof printRunReport>[0];

  const output = captureConsoleLog(() => {
    printRunReport(report);
  }).join("\n");
  assert.match(output, /Major plan source: seeded from tasks\/major-plan\.md/);

  const jsonReport = buildRunJsonReport(report, 0);
  assert.deepEqual(jsonReport.details.majorPlanSource, {
    type: "seed",
    path: "tasks/major-plan.md",
  });
});

test("printRunReport shows saved resume review policy and next scrupulous status", () => {
  const paths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const state = {
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
      configPath: "/repo/orchestrator.config.json",
      configSnapshot: {
        checks: [],
        runner: { type: "fake" },
        maxFixAttempts: 0,
        artifactRoot: ".agent-work",
        milestonePlanPolicy: "always",
        milestonePlanReviewPolicy: "scrupulous",
        humanReviewPolicy: "autonomous",
      },
    }),
    currentPhase: "ready_for_milestone" as const,
    status: "ready_for_milestone" as const,
    currentMilestoneId: 1,
    milestoneStatuses: {
      "1": "pending" as const,
    },
  };

  const lines = captureConsoleLog(() => {
    printRunReport({
      mode: "resume",
      runId: "run-1",
      paths,
      goal: "Add feature X",
      planningOnly: false,
      allowDirty: false,
      allowNonGitPlanning: false,
      targetMilestone: null,
      runnerType: "fake",
      configPath: "/repo/orchestrator.config.json",
      configSource: "state snapshot",
      artifactRoot: ".agent-work",
      checks: [],
      maxFixAttempts: 0,
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "scrupulous",
      savedMilestonePlanReviewPolicy: "scrupulous",
      humanReviewPolicy: "autonomous",
      savedHumanReviewPolicy: "autonomous",
      gitRequired: true,
      gitRoot: "/repo",
      gitDirty: false,
      gitDirtyOverride: false,
      gitNonGitPlanningOverride: false,
      stateBeforeResume: "ready_for_milestone",
      nextAction: "continue_milestone",
      finalState: state,
    });
  });

  const output = lines.join("\n");
  assert.match(output, /Milestone plan review policy: scrupulous/);
  assert.match(output, /Saved milestone plan review policy: scrupulous/);
  assert.match(output, /Human review policy: autonomous/);
  assert.match(output, /Scrupulous review for next milestone: yes/);
});

test("printRunReport distinguishes human review handling outcomes", () => {
  const paths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const stateFor = (
    humanReviewPolicy: "stop" | "fail" | "autonomous",
    overrides: Partial<ReturnType<typeof createInitialState>>,
  ) => ({
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
      configPath: "/repo/orchestrator.config.json",
      configSnapshot: {
        checks: [],
        runner: { type: "fake" },
        maxFixAttempts: 0,
        artifactRoot: ".agent-work",
        milestonePlanPolicy: "always",
        milestonePlanReviewPolicy: "normal",
        humanReviewPolicy,
      },
    }),
    ...overrides,
  });
  const reportFor = (
    humanReviewPolicy: "stop" | "fail" | "autonomous",
    finalState: ReturnType<typeof createInitialState>,
  ) => ({
    mode: "new" as const,
    runId: "run-1",
    paths,
    goal: "Add feature X",
    planningOnly: false,
    allowDirty: false,
    allowNonGitPlanning: false,
    targetMilestone: null,
    runnerType: "fake",
    configPath: "/repo/orchestrator.config.json",
    configSource: "config file",
    artifactRoot: ".agent-work",
    checks: [],
    maxFixAttempts: 0,
    milestonePlanPolicy: "always" as const,
    milestonePlanReviewPolicy: "normal" as const,
    humanReviewPolicy,
    gitRequired: true,
    gitRoot: "/repo",
    gitDirty: false,
    gitDirtyOverride: false,
    gitNonGitPlanningOverride: false,
    finalState,
  });

  const supervisedStop = reportFor(
    "stop",
    stateFor("stop", {
      currentPhase: "needs_human_review",
      status: "needs_human_review",
    }),
  );
  assert.match(
    captureConsoleLog(() => printRunReport(supervisedStop)).join("\n"),
    /Human review handling: supervised stop: human review required/,
  );

  const failFast = reportFor(
    "fail",
    stateFor("fail", {
      currentPhase: "failed",
      status: "failed",
    }),
  );
  assert.match(
    captureConsoleLog(() => printRunReport(failFast)).join("\n"),
    /Human review handling: fail-fast unattended failure/,
  );

  const autonomousResolved = reportFor(
    "autonomous",
    stateFor("autonomous", {
      currentPhase: "passed",
      status: "passed",
      artifacts: {
        reviews: {
          "1-resolution-1":
            "reviews/22-milestone-1-autonomous-resolution-1.json",
        },
      },
    }),
  );
  const autonomousResolvedOutput = captureConsoleLog(() =>
    printRunReport(autonomousResolved),
  ).join("\n");
  assert.match(
    autonomousResolvedOutput,
    /Human review handling: autonomous resolved continuation/,
  );
  assert.match(
    autonomousResolvedOutput,
    /Autonomous decision artifacts: reviews\/22-milestone-1-autonomous-resolution-1\.json/,
  );
  const autonomousJson = buildRunJsonReport(autonomousResolved, 0);
  assert.equal(
    autonomousJson.details.humanReviewHandling,
    "autonomous resolved continuation",
  );
  assert.deepEqual(autonomousJson.details.autonomousDecisionArtifacts, [
    "reviews/22-milestone-1-autonomous-resolution-1.json",
  ]);

  const autonomousExhausted = reportFor(
    "autonomous",
    stateFor("autonomous", {
      currentPhase: "failed",
      status: "failed",
      artifacts: {
        logs: {
          "resume-resolution-2": "logs/resolve-resume-state-2.json",
        },
      },
      lastError: {
        message: "Resume state resolution failed after 2 attempt(s).",
        phase: "failed",
        occurredAt: "2026-05-10T12:00:00.000Z",
      },
    }),
  );
  assert.match(
    captureConsoleLog(() => printRunReport(autonomousExhausted)).join("\n"),
    /Human review handling: autonomous exhausted failure/,
  );
});

test("printRunReport includes timing artifact paths and compact durations", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-report-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await mkdir(paths.dirs.logs, { recursive: true });
    await writeFile(path.join(paths.dirs.logs, "timeline.jsonl"), "", "utf8");
    await writeFile(
      path.join(paths.dirs.logs, "80-timings.json"),
      `${JSON.stringify({
        lifecycleDurationMs: 192_000,
        activeWorkflowDurationMs: 168_000,
        latestInvocationDurationMs: 41_000,
        aggregates: {
          runnerDurationMs: 124_000,
          checkDurationMs: 5_000,
        },
      })}\n`,
      "utf8",
    );

    const baseState = createInitialState({
      runId: "run-1",
      goal: "Add feature X",
      paths,
      git: {
        required: true,
        planningOnly: false,
        root: tempDir,
        startSha: "abc123",
        dirtyAtStart: false,
        dirtyOverride: false,
        statusPorcelain: "",
      },
      configPath: path.join(tempDir, "orchestrator.config.json"),
      configSnapshot: {
        checks: [],
        runner: {
          type: "fake",
        },
        maxFixAttempts: 0,
        artifactRoot: ".agent-work",
        milestonePlanPolicy: "always",
        milestonePlanReviewPolicy: "normal",
        humanReviewPolicy: "stop",
      },
    });
    const state = {
      ...baseState,
      artifacts: {
        ...baseState.artifacts,
        logs: {
          run: path.join("logs", "run.log"),
          timingsJson: path.join("logs", "80-timings.json"),
          timingsMarkdown: path.join("logs", "81-timings.md"),
        },
      },
    };

    const lines = captureConsoleLog(() => {
      printRunReport({
        mode: "new",
        runId: "run-1",
        paths,
        goal: "Add feature X",
        planningOnly: false,
        allowDirty: false,
        allowNonGitPlanning: false,
        targetMilestone: null,
        runnerType: "fake",
        configPath: path.join(tempDir, "orchestrator.config.json"),
        configSource: "config file",
        artifactRoot: ".agent-work",
        checks: [],
        maxFixAttempts: 0,
        milestonePlanPolicy: "always",
        milestonePlanReviewPolicy: "normal",
        humanReviewPolicy: "stop",
        gitRequired: true,
        gitRoot: tempDir,
        gitDirty: false,
        gitDirtyOverride: false,
        gitNonGitPlanningOverride: false,
        finalState: state,
      });
    });

    const output = lines.join("\n");
    assert.match(output, /Timing timeline artifact: logs\/timeline\.jsonl/);
    assert.match(output, /Timing JSON artifact: logs\/80-timings\.json/);
    assert.match(output, /Timing Markdown artifact: logs\/81-timings\.md/);
    assert.match(output, /Lifecycle duration: 3m12s/);
    assert.match(output, /Active workflow duration: 2m48s/);
    assert.match(output, /Latest invocation duration: 41s/);
    assert.match(output, /Runner duration: 2m04s/);
    assert.match(output, /Check duration: 5s/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("printRunReport explains constrained target stops with pending milestones", () => {
  const paths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const state = {
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
      configPath: "/repo/orchestrator.config.json",
      configSnapshot: {
        checks: [],
        runner: { type: "fake" },
        maxFixAttempts: 0,
        artifactRoot: ".agent-work",
        milestonePlanPolicy: "always",
        milestonePlanReviewPolicy: "normal",
        humanReviewPolicy: "stop",
      },
    }),
    currentPhase: "passed" as const,
    status: "passed" as const,
    currentMilestoneId: 1,
    milestoneStatuses: {
      "1": "passed" as const,
      "2": "pending" as const,
      "3": "pending" as const,
    },
  };
  const report = {
    mode: "new" as const,
    runId: "run-1",
    paths,
    goal: "Add feature X",
    planningOnly: false,
    allowDirty: false,
    allowNonGitPlanning: false,
    targetMilestone: 1,
    runnerType: "fake",
    configPath: "/repo/orchestrator.config.json",
    configSource: "config file",
    artifactRoot: ".agent-work",
    checks: [],
    maxFixAttempts: 0,
    milestonePlanPolicy: "always" as const,
    milestonePlanReviewPolicy: "normal" as const,
    humanReviewPolicy: "stop" as const,
    gitRequired: true,
    gitRoot: "/repo",
    gitDirty: false,
    gitDirtyOverride: false,
    gitNonGitPlanningOverride: false,
    nextAction: "resume without --milestone to continue remaining milestones",
    finalState: state,
  };

  const lines = captureConsoleLog(() => {
    printRunReport(report);
  });

  const output = lines.join("\n");
  assert.match(output, /Target milestone 1 stopped before goal completion\./);
  assert.match(output, /Pending milestones remain: 2, 3\./);
  assert.match(
    output,
    /Next action: resume without --milestone to continue remaining milestones/,
  );

  const jsonReport = buildRunJsonReport(report, 0);
  assert.deepEqual(jsonReport.details.pendingMilestones, ["2", "3"]);
});

function captureConsoleLog(callback: () => void): string[] {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  };

  try {
    callback();
  } finally {
    console.log = original;
  }

  return lines;
}
