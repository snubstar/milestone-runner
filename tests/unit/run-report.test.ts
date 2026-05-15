import assert from "node:assert/strict";
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
      gitRequired: true,
      gitRoot: "/repo",
      gitDirty: false,
      gitDirtyOverride: false,
      gitNonGitPlanningOverride: false,
      finalState: state,
    });
  });

  assert.match(lines.join("\n"), /Runner diagnostic: runner\/major_plan-01\.json/);
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
