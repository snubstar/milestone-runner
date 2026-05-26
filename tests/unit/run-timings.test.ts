import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRunPaths, type RunPaths } from "../../src/artifacts/paths.js";
import { buildTimingArtifactPaths } from "../../src/artifacts/timing-artifacts.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import { createInitialState } from "../../src/state/initial-state.js";
import type { RunState } from "../../src/state/state-types.js";
import { createCheckTimingCollector } from "../../src/timings/check-timing-collector.js";
import {
  buildRunTimingsDocument,
  parseCheckArtifactStateKey,
  parseCheckReport,
  readRunnerPhaseTimings,
  readTimelineEvents,
  writeRunTimings,
} from "../../src/timings/run-timings.js";
import type {
  TimingWarning,
  WorkflowTimelineEvent,
} from "../../src/timings/timing-types.js";

test("readTimelineEvents parses valid JSONL events and warns on malformed lines", async () => {
  const context = await createTimingContext();
  try {
    const timingPaths = buildTimingArtifactPaths(context.paths);
    await writeFile(
      timingPaths.files.timeline,
      [
        JSON.stringify(timelineEvent("2026-05-10T10:00:00.000Z", "state_initialized", "initialized")),
        "{not json}",
        "",
      ].join("\n"),
      "utf8",
    );
    const warnings: TimingWarning[] = [];

    const events = await readTimelineEvents(context.paths, warnings);

    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "state_initialized");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.code, "timeline_incomplete");
  } finally {
    await context.cleanup();
  }
});

test("readRunnerPhaseTimings parses runner diagnostics and warns on malformed files", async () => {
  const context = await createTimingContext();
  try {
    await writeFile(
      path.join(context.paths.dirs.runner, "major_plan-01.json"),
      `${JSON.stringify({
        phase: "major_plan",
        startedAt: "2026-05-10T10:00:01.000Z",
        endedAt: "2026-05-10T10:00:04.000Z",
        durationMs: 3000,
        exitCode: 0,
        timedOut: false,
      })}\n`,
      "utf8",
    );
    await writeFile(path.join(context.paths.dirs.runner, "bad-02.json"), "{bad json}\n", "utf8");
    const warnings: TimingWarning[] = [];

    const timings = await readRunnerPhaseTimings(context.paths, warnings);

    assert.deepEqual(timings, [
      {
        phase: "major_plan",
        milestoneId: null,
        startedAt: "2026-05-10T10:00:01.000Z",
        endedAt: "2026-05-10T10:00:04.000Z",
        durationMs: 3000,
        exitCode: 0,
        timedOut: false,
        sourceArtifact: path.join("runner", "major_plan-01.json"),
      },
    ]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.code, "runner_diagnostic_malformed");
  } finally {
    await context.cleanup();
  }
});

test("parseCheckReport parses base and post-fix check report timings", () => {
  assert.deepEqual(parseCheckArtifactStateKey("1"), {
    milestoneId: 1,
    attempt: null,
  });
  assert.deepEqual(parseCheckArtifactStateKey("1-fix-2"), {
    milestoneId: 1,
    attempt: 2,
  });

  const warnings: TimingWarning[] = [];
  const timings = parseCheckReport({
    stateKey: "1-fix-2",
    milestoneId: 1,
    attempt: 2,
    artifactPath: "checks/23-milestone-1-checks-after-fix-2.txt",
    report: [
      "Check results",
      "",
      "Overall: passed",
      "",
      "## Check 1: npm run test:build",
      "",
      "Exit code: 0",
      "Duration: 42ms",
      "",
      "Stdout:",
      "(empty)",
      "",
    ].join("\n"),
    warnings,
  });

  assert.deepEqual(timings, [
    {
      stateKey: "1-fix-2",
      milestoneId: 1,
      attempt: 2,
      commandIndex: 1,
      command: "npm run test:build",
      durationMs: 42,
      exitCode: 0,
      source: "parsed_report",
      confidence: "medium",
      sourceArtifact: "checks/23-milestone-1-checks-after-fix-2.txt",
    },
  ]);
  assert.equal(warnings.length, 0);
});

test("buildRunTimingsDocument separates lifecycle and active workflow duration across resumes", async () => {
  const context = await createTimingContext();
  try {
    await writeTimeline(context.paths, [
      timelineEvent("2026-05-10T10:00:00.000Z", "state_initialized", "initialized"),
      timelineEvent("2026-05-10T10:00:00.000Z", "invocation_started", "initialized", {
        invocationId: "1",
      }),
      timelineEvent("2026-05-10T10:01:00.000Z", "phase_changed", "planning"),
      timelineEvent("2026-05-10T10:05:00.000Z", "invocation_ended", "ready_for_milestone", {
        invocationId: "1",
      }),
      timelineEvent("2026-05-10T10:15:00.000Z", "invocation_started", "ready_for_milestone", {
        invocationId: "2",
      }),
      timelineEvent("2026-05-10T10:16:00.000Z", "phase_changed", "implementing", {
        currentMilestoneId: 1,
      }),
      timelineEvent("2026-05-10T10:20:00.000Z", "invocation_ended", "passed", {
        invocationId: "2",
        currentMilestoneId: null,
      }),
    ]);

    const document = await buildRunTimingsDocument({
      paths: context.paths,
      state: context.state,
      runEndedAt: "2026-05-10T10:20:00.000Z",
      generatedAt: "2026-05-10T10:20:01.000Z",
      finalizedAt: "2026-05-10T10:20:02.000Z",
    });

    assert.equal(document.lifecycleDurationMs, 20 * 60 * 1000);
    assert.equal(document.activeWorkflowDurationMs, 10 * 60 * 1000);
    assert.equal(document.latestInvocationDurationMs, 5 * 60 * 1000);
    assert.deepEqual(
      document.workflowPhases.map((phase) => ({
        phase: phase.phase,
        startedAt: phase.startedAt,
        endedAt: phase.endedAt,
        durationMs: phase.durationMs,
      })),
      [
        {
          phase: "initialized",
          startedAt: "2026-05-10T10:00:00.000Z",
          endedAt: "2026-05-10T10:01:00.000Z",
          durationMs: 60 * 1000,
        },
        {
          phase: "planning",
          startedAt: "2026-05-10T10:01:00.000Z",
          endedAt: "2026-05-10T10:05:00.000Z",
          durationMs: 4 * 60 * 1000,
        },
        {
          phase: "planning",
          startedAt: "2026-05-10T10:15:00.000Z",
          endedAt: "2026-05-10T10:16:00.000Z",
          durationMs: 60 * 1000,
        },
        {
          phase: "implementing",
          startedAt: "2026-05-10T10:16:00.000Z",
          endedAt: "2026-05-10T10:20:00.000Z",
          durationMs: 4 * 60 * 1000,
        },
      ],
    );
  } finally {
    await context.cleanup();
  }
});

test("buildRunTimingsDocument prefers structured check timings and parses reports only for missing entries", async () => {
  const context = await createTimingContext({
    checks: {
      "1": path.join("checks", "13-milestone-1-checks.txt"),
      "1-fix-1": path.join("checks", "23-milestone-1-checks-after-fix-1.txt"),
    },
  });
  try {
    await writeTimeline(context.paths, [
      timelineEvent("2026-05-10T10:00:00.000Z", "state_initialized", "initialized"),
      timelineEvent("2026-05-10T10:00:00.000Z", "invocation_started", "initialized", {
        invocationId: "1",
      }),
      timelineEvent("2026-05-10T10:05:00.000Z", "invocation_ended", "passed", {
        invocationId: "1",
      }),
    ]);
    await mkdir(context.paths.dirs.checks, { recursive: true });
    await writeFile(
      path.join(context.paths.runDir, "checks", "13-milestone-1-checks.txt"),
      checkReport("npm run parsed-base", 999),
      "utf8",
    );
    await writeFile(
      path.join(context.paths.runDir, "checks", "23-milestone-1-checks-after-fix-1.txt"),
      checkReport("npm run parsed-fix", 500),
      "utf8",
    );
    const collector = createCheckTimingCollector();
    collector.recordCheckRun({
      stateKey: "1",
      milestoneId: 1,
      attempt: null,
      artifactPath: path.join("checks", "13-milestone-1-checks.txt"),
      result: {
        ok: true,
        report: "structured report",
        results: [
          {
            command: "npm run structured",
            exitCode: 0,
            stdout: "not copied",
            stderr: "",
            durationMs: 100,
          },
        ],
      },
    });

    const document = await buildRunTimingsDocument({
      paths: context.paths,
      state: context.state,
      runEndedAt: "2026-05-10T10:05:00.000Z",
      checkTimingCollector: collector,
    });

    assert.deepEqual(
      document.checks.map((check) => ({
        stateKey: check.stateKey,
        command: check.command,
        durationMs: check.durationMs,
        source: check.source,
      })),
      [
        {
          stateKey: "1",
          command: "npm run structured",
          durationMs: 100,
          source: "structured",
        },
        {
          stateKey: "1-fix-1",
          command: "npm run parsed-fix",
          durationMs: 500,
          source: "parsed_report",
        },
      ],
    );
    assert.equal(document.aggregates.checkDurationMs, 600);
  } finally {
    await context.cleanup();
  }
});

test("buildRunTimingsDocument emits warnings for missing timing sources", async () => {
  const context = await createTimingContext({
    checks: {
      invalid: path.join("checks", "missing.txt"),
    },
  });
  try {
    const document = await buildRunTimingsDocument({
      paths: context.paths,
      state: context.state,
      runEndedAt: "2026-05-10T10:01:00.000Z",
    });

    assert.deepEqual(
      document.warnings.map((warning) => warning.code).sort(),
      ["check_report_malformed", "timeline_missing"],
    );
  } finally {
    await context.cleanup();
  }
});

test("buildRunTimingsDocument rejects unsafe check artifact paths from state", async () => {
  const context = await createTimingContext();
  try {
    const outsideChecks = path.join(context.tempDir, "outside-checks.txt");
    await writeFile(outsideChecks, checkReport("npm run outside", 123), "utf8");

    const document = await buildRunTimingsDocument({
      paths: context.paths,
      state: {
        ...context.state,
        artifacts: {
          ...context.state.artifacts,
          checks: {
            "1": outsideChecks,
          },
        },
      },
      runEndedAt: "2026-05-10T10:01:00.000Z",
    });

    assert.deepEqual(document.checks, []);
    assert.equal(
      document.warnings.some(
        (warning) =>
          warning.code === "check_report_malformed" &&
          warning.message.includes("Artifact path must be run-relative"),
      ),
      true,
    );
  } finally {
    await context.cleanup();
  }
});

test("writeRunTimings writes JSON and Markdown timing artifacts", async () => {
  const context = await createTimingContext();
  try {
    await writeTimeline(context.paths, [
      timelineEvent("2026-05-10T10:00:00.000Z", "invocation_started", "initialized", {
        invocationId: "1",
      }),
      timelineEvent("2026-05-10T10:01:00.000Z", "invocation_ended", "passed", {
        invocationId: "1",
      }),
    ]);

    const result = await writeRunTimings({
      paths: context.paths,
      state: context.state,
      runEndedAt: "2026-05-10T10:01:00.000Z",
      generatedAt: "2026-05-10T10:01:01.000Z",
      finalizedAt: "2026-05-10T10:01:01.000Z",
    });

    assert.deepEqual(result.statePaths, {
      timingsJson: path.join("logs", "80-timings.json"),
      timingsMarkdown: path.join("logs", "81-timings.md"),
    });
    const timingPaths = buildTimingArtifactPaths(context.paths);
    const json = JSON.parse(await readFile(timingPaths.files.timingsJson, "utf8")) as {
      runId?: string;
      runEndedAt?: string;
    };
    const markdown = await readFile(timingPaths.files.timingsMarkdown, "utf8");

    assert.equal(json.runId, "run-1");
    assert.equal(json.runEndedAt, "2026-05-10T10:01:00.000Z");
    assert.match(markdown, /^# Timing Summary/);
    assert.match(markdown, /Lifecycle/);
  } finally {
    await context.cleanup();
  }
});

interface TimingContext {
  tempDir: string;
  paths: RunPaths;
  state: RunState;
  cleanup: () => Promise<void>;
}

async function createTimingContext(options: {
  checks?: Record<string, string>;
} = {}): Promise<TimingContext> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-run-timings-"));
  const paths = buildRunPaths({
    cwd: tempDir,
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  await createRunDirectory(paths, "Add feature X");
  const state = {
    ...createInitialState({
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
      configSnapshot: null,
      now: new Date("2026-05-10T10:00:00.000Z"),
    }),
    artifacts: {
      goal: "00-goal.txt",
      logs: { run: "logs/run.log" },
      ...(options.checks === undefined ? {} : { checks: options.checks }),
    },
  } satisfies RunState;

  return {
    tempDir,
    paths,
    state,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

async function writeTimeline(
  paths: RunPaths,
  events: WorkflowTimelineEvent[],
): Promise<void> {
  const timingPaths = buildTimingArtifactPaths(paths);
  await writeFile(
    timingPaths.files.timeline,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

function timelineEvent(
  timestamp: string,
  event: WorkflowTimelineEvent["event"],
  phase: WorkflowTimelineEvent["phase"],
  overrides: Partial<WorkflowTimelineEvent> = {},
): WorkflowTimelineEvent {
  return {
    timestamp,
    event,
    phase,
    status: phase,
    currentMilestoneId: null,
    ...overrides,
  };
}

function checkReport(command: string, durationMs: number): string {
  return [
    "Check results",
    "",
    "Overall: passed",
    "",
    `## Check 1: ${command}`,
    "",
    "Exit code: 0",
    `Duration: ${durationMs}ms`,
    "",
    "Stdout:",
    "(empty)",
    "",
    "Stderr:",
    "(empty)",
    "",
  ].join("\n");
}
