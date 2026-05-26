import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDurationMs,
  formatTimingMarkdown,
} from "../../src/timings/timing-summary.js";
import type { FinalTimingsDocument } from "../../src/timings/timing-types.js";

test("formatTimingMarkdown writes a stable representative timing summary", () => {
  const document = {
    schemaVersion: 1,
    runId: "run-1",
    generatedAt: "2026-05-10T10:20:01.000Z",
    runStartedAt: "2026-05-10T10:00:00.000Z",
    latestInvocationStartedAt: "2026-05-10T10:15:00.000Z",
    runEndedAt: "2026-05-10T10:20:00.000Z",
    finalizedAt: "2026-05-10T10:20:02.000Z",
    lifecycleDurationMs: 1_200_000,
    activeWorkflowDurationMs: 600_000,
    latestInvocationDurationMs: 300_000,
    aggregates: {
      runnerDurationMs: 184_000,
      checkDurationMs: 5_000,
      knownWorkflowPhaseDurationMs: 540_000,
    },
    invocations: [
      {
        invocationId: "1",
        startedAt: "2026-05-10T10:00:00.000Z",
        endedAt: "2026-05-10T10:05:00.000Z",
        durationMs: 300_000,
        startPhase: "initialized",
        terminalPhase: "ready_for_milestone",
        terminalStatus: "ready_for_milestone",
      },
      {
        invocationId: "2",
        startedAt: "2026-05-10T10:15:00.000Z",
        endedAt: "2026-05-10T10:20:00.000Z",
        durationMs: 300_000,
        startPhase: "ready_for_milestone",
        terminalPhase: "passed",
        terminalStatus: "passed",
      },
    ],
    workflowPhases: [
      {
        phase: "initialized",
        milestoneId: null,
        startedAt: "2026-05-10T10:00:00.000Z",
        endedAt: "2026-05-10T10:01:00.000Z",
        durationMs: 60_000,
      },
      {
        phase: "planning",
        milestoneId: null,
        startedAt: "2026-05-10T10:01:00.000Z",
        endedAt: "2026-05-10T10:05:00.000Z",
        durationMs: 240_000,
      },
      {
        phase: "implementing",
        milestoneId: 1,
        startedAt: "2026-05-10T10:15:00.000Z",
        endedAt: "2026-05-10T10:17:00.000Z",
        durationMs: 120_000,
      },
      {
        phase: "checking",
        milestoneId: 1,
        startedAt: "2026-05-10T10:17:00.000Z",
        endedAt: "2026-05-10T10:17:30.000Z",
        durationMs: 30_000,
      },
      {
        phase: "reviewing",
        milestoneId: 1,
        startedAt: "2026-05-10T10:17:30.000Z",
        endedAt: "2026-05-10T10:19:00.000Z",
        durationMs: 90_000,
      },
    ],
    runnerPhases: [
      {
        phase: "major_plan",
        milestoneId: null,
        startedAt: "2026-05-10T10:01:00.000Z",
        endedAt: "2026-05-10T10:02:30.000Z",
        durationMs: 90_000,
        exitCode: 0,
        timedOut: false,
        sourceArtifact: "runner/major_plan-01.json",
      },
      {
        phase: "implement_milestone",
        milestoneId: 1,
        startedAt: "2026-05-10T10:15:10.000Z",
        endedAt: "2026-05-10T10:16:34.000Z",
        durationMs: 84_000,
        exitCode: 0,
        timedOut: false,
        sourceArtifact: "runner/implement_milestone-01.json",
      },
      {
        phase: "review_milestone",
        milestoneId: 1,
        startedAt: "2026-05-10T10:17:40.000Z",
        endedAt: "2026-05-10T10:17:50.000Z",
        durationMs: 10_000,
        exitCode: 1,
        timedOut: false,
        sourceArtifact: "runner/review_milestone-01.json",
      },
    ],
    checks: [
      {
        stateKey: "1",
        milestoneId: 1,
        attempt: null,
        commandIndex: 1,
        command: "npm run test|build",
        durationMs: 3_500,
        exitCode: 0,
        source: "structured",
        confidence: "high",
        sourceArtifact: "checks/13-milestone-1-checks.txt",
      },
      {
        stateKey: "1-fix-1",
        milestoneId: 1,
        attempt: 1,
        commandIndex: 1,
        command: "npm run lint",
        durationMs: 1_500,
        exitCode: 1,
        source: "parsed_report",
        confidence: "medium",
        sourceArtifact: "checks/23-milestone-1-checks-after-fix-1.txt",
      },
    ],
    warnings: [
      {
        code: "timeline_incomplete",
        source: "timeline",
        message: "Invocation 2 is missing an end event; closing it at runEndedAt.",
        details: { invocationId: "2" },
      },
    ],
  } satisfies FinalTimingsDocument;

  assert.equal(
    formatTimingMarkdown(document),
    [
      "# Timing Summary",
      "",
      "Run: run-1",
      "Run started: 2026-05-10T10:00:00.000Z",
      "Latest invocation started: 2026-05-10T10:15:00.000Z",
      "Run ended: 2026-05-10T10:20:00.000Z",
      "Generated: 2026-05-10T10:20:01.000Z",
      "Finalized: 2026-05-10T10:20:02.000Z",
      "",
      "## Totals",
      "",
      "| Metric | Duration |",
      "| --- | --- |",
      "| Lifecycle | 20m (1200000ms) |",
      "| Active workflow | 10m (600000ms) |",
      "| Latest invocation | 5m (300000ms) |",
      "| Known workflow phases | 9m (540000ms) |",
      "| Runner phases | 3m 4s (184000ms) |",
      "| Checks | 5s (5000ms) |",
      "",
      "## Slowest Runner Phases",
      "",
      "| Phase | Milestone | Duration | Outcome | Source |",
      "| --- | --- | --- | --- | --- |",
      "| major_plan | none | 1m 30s (90000ms) | exit 0 | runner/major_plan-01.json |",
      "| implement_milestone | 1 | 1m 24s (84000ms) | exit 0 | runner/implement_milestone-01.json |",
      "| review_milestone | 1 | 10s (10000ms) | exit 1 | runner/review_milestone-01.json |",
      "",
      "## Slowest Checks",
      "",
      "| Milestone | Attempt | Command | Duration | Exit | Source | Artifact |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| 1 | base | npm run test\\|build | 3s 500ms (3500ms) | exit 0 | structured/high | checks/13-milestone-1-checks.txt |",
      "| 1 | fix 1 | npm run lint | 1s 500ms (1500ms) | exit 1 | parsed_report/medium | checks/23-milestone-1-checks-after-fix-1.txt |",
      "",
      "## Milestone Timings",
      "",
      "| Milestone | Workflow wall time | Runner time | Check time | Checks |",
      "| --- | --- | --- | --- | --- |",
      "| 1 | 4m (240000ms) | 1m 34s (94000ms) | 5s (5000ms) | 2 |",
      "",
      "## Warnings",
      "",
      "- [timeline_incomplete] timeline: Invocation 2 is missing an end event; closing it at runEndedAt. ({\"invocationId\":\"2\"})",
    ].join("\n"),
  );
});

test("formatTimingMarkdown handles empty optional sections", () => {
  const document = {
    schemaVersion: 1,
    runId: "run-empty",
    generatedAt: "2026-05-10T10:00:01.000Z",
    runStartedAt: "2026-05-10T10:00:00.000Z",
    latestInvocationStartedAt: "2026-05-10T10:00:00.000Z",
    runEndedAt: "2026-05-10T10:00:00.000Z",
    finalizedAt: "2026-05-10T10:00:01.000Z",
    lifecycleDurationMs: 0,
    activeWorkflowDurationMs: 0,
    latestInvocationDurationMs: 0,
    aggregates: {
      runnerDurationMs: 0,
      checkDurationMs: 0,
      knownWorkflowPhaseDurationMs: 0,
    },
    invocations: [],
    workflowPhases: [],
    runnerPhases: [],
    checks: [],
    warnings: [],
  } satisfies FinalTimingsDocument;

  const markdown = formatTimingMarkdown(document);

  assert.match(markdown, /No runner timing recorded\./);
  assert.match(markdown, /No check timing recorded\./);
  assert.match(markdown, /No milestone-specific timing recorded\./);
  assert.match(markdown, /No timing warnings\./);
});

test("formatDurationMs writes compact stable duration labels", () => {
  assert.equal(formatDurationMs(undefined), "unknown");
  assert.equal(formatDurationMs(-1), "unknown");
  assert.equal(formatDurationMs(0), "0ms");
  assert.equal(formatDurationMs(999), "999ms");
  assert.equal(formatDurationMs(1_250), "1s 250ms (1250ms)");
  assert.equal(formatDurationMs(3_661_000), "1h 1m 1s (3661000ms)");
});
