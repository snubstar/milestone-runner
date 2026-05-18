import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRunPaths } from "../../src/artifacts/paths.js";
import { printRunReport } from "../../src/cli/run-report.js";
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
      runnerType: "codex-exec",
      configPath: "/repo/orchestrator.config.json",
      configSource: "config file",
      artifactRoot: ".agent-work",
      checks: [],
      maxFixAttempts: 0,
      milestonePlanPolicy: "always",
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
    });
  });

  assert.match(lines.join("\n"), /Runner diagnostic: runner\/major_plan-01\.json/);
  assert.match(lines.join("\n"), /Milestone plan policy: always/);
  assert.match(
    lines.join("\n"),
    /Timing warnings:\n  \[timing_finalization_failed\] finalization: Failed to finalize timing artifacts: EISDIR\./,
  );
});

test("printRunReport includes timing artifact paths and compact durations", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-report-"));
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
