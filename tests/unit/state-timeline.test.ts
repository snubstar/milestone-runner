import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRunPaths, type RunPaths } from "../../src/artifacts/paths.js";
import { buildTimingArtifactPaths } from "../../src/artifacts/timing-artifacts.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import { createInitialState } from "../../src/state/initial-state.js";
import {
  recordPlanningArtifact,
  setMilestoneStatus,
  setStatePhase,
} from "../../src/state/state-transitions.js";
import type { RunState } from "../../src/state/state-types.js";
import {
  createTimingWarningCollector,
  type WorkflowTimelineEvent,
} from "../../src/timings/timing-types.js";
import {
  appendInvocationTimelineEvent,
  appendStateTimelineEvent,
  buildStateTimelineEvent,
  nextTimelineInvocationId,
} from "../../src/timings/state-timeline.js";

test("buildStateTimelineEvent records the initial state baseline", () => {
  const state = createTestState(
    buildRunPaths({ cwd: "/repo", artifactRoot: ".agent-work", runId: "run-1" }),
  );

  const event = buildStateTimelineEvent({
    previousState: null,
    nextState: state,
  });

  assert.deepEqual(event, {
    timestamp: "2026-05-10T12:00:00.000Z",
    event: "state_initialized",
    phase: "initialized",
    status: "initialized",
    currentMilestoneId: null,
    changedMilestoneStatuses: {},
  });
});

test("buildStateTimelineEvent prefers phase_changed when multiple fields changed", () => {
  const paths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const previousState = createTestState(paths);
  const nextState = {
    ...setStatePhase(previousState, "planning", new Date("2026-05-10T12:00:01.000Z")),
    currentMilestoneId: 1,
    milestoneStatuses: {
      "1": "pending",
    },
  } satisfies RunState;

  const event = buildStateTimelineEvent({ previousState, nextState });

  assert.equal(event?.event, "phase_changed");
  assert.equal(event?.previousPhase, "initialized");
  assert.equal(event?.previousStatus, "initialized");
  assert.equal(event?.previousCurrentMilestoneId, null);
  assert.deepEqual(event?.changedMilestoneStatuses, {
    "1": { next: "pending" },
  });
});

test("buildStateTimelineEvent records milestone-only changes as annotations", () => {
  const paths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const previousState = {
    ...createTestState(paths),
    milestoneStatuses: {
      "1": "pending",
    },
  } satisfies RunState;
  const nextState = setMilestoneStatus(
    previousState,
    1,
    "passed",
    new Date("2026-05-10T12:00:01.000Z"),
  );

  const event = buildStateTimelineEvent({ previousState, nextState });

  assert.equal(event?.event, "milestone_status_changed");
  assert.deepEqual(event?.changedMilestoneStatuses, {
    "1": { previous: "pending", next: "passed" },
  });
});

test("buildStateTimelineEvent ignores artifact-only state writes", () => {
  const paths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const previousState = createTestState(paths);
  const nextState = recordPlanningArtifact(
    previousState,
    "majorPlan",
    "plans/01-major-plan.md",
    new Date("2026-05-10T12:00:01.000Z"),
  );

  assert.equal(buildStateTimelineEvent({ previousState, nextState }), null);
});

test("appendStateTimelineEvent appends compact JSON lines", async () => {
  const context = await createTimelineContext();
  try {
    const result = await appendStateTimelineEvent({
      paths: context.paths,
      previousState: null,
      nextState: context.state,
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.appended, true);

    const events = await readTimelineEvents(context.paths);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "state_initialized");
    assert.equal(events[0]?.phase, "initialized");
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("invocation timeline events append and increment invocation ids", async () => {
  const context = await createTimelineContext();
  try {
    await appendStateTimelineEvent({
      paths: context.paths,
      previousState: null,
      nextState: context.state,
    });

    assert.equal(await nextTimelineInvocationId(context.paths), "1");

    await appendInvocationTimelineEvent({
      paths: context.paths,
      invocationId: "1",
      event: "invocation_started",
      timestamp: "2026-05-10T12:00:01.000Z",
      state: context.state,
    });

    assert.equal(await nextTimelineInvocationId(context.paths), "2");

    const events = await readTimelineEvents(context.paths);
    assert.equal(events.at(-1)?.event, "invocation_started");
    assert.equal(events.at(-1)?.invocationId, "1");
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("nextTimelineInvocationId reports malformed timeline warnings without throwing", async () => {
  const context = await createTimelineContext();
  try {
    const timingPaths = buildTimingArtifactPaths(context.paths);
    await writeFile(timingPaths.files.timeline, "{not json}\n", "utf8");
    const warnings = createTimingWarningCollector();

    const invocationId = await nextTimelineInvocationId(context.paths, warnings);

    assert.equal(invocationId, "1");
    assert.equal(warnings.list().length, 1);
    assert.equal(warnings.list()[0]?.code, "timeline_incomplete");
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

async function createTimelineContext(): Promise<{
  tempDir: string;
  paths: RunPaths;
  state: RunState;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-timeline-"));
  const paths = buildRunPaths({
    cwd: tempDir,
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  await createRunDirectory(paths, "Add feature X");
  return {
    tempDir,
    paths,
    state: createTestState(paths),
  };
}

function createTestState(paths: RunPaths): RunState {
  return createInitialState({
    runId: paths.runId,
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
    now: new Date("2026-05-10T12:00:00.000Z"),
  });
}

async function readTimelineEvents(paths: RunPaths): Promise<WorkflowTimelineEvent[]> {
  const timeline = buildTimingArtifactPaths(paths).files.timeline;
  const raw = await readFile(timeline, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as WorkflowTimelineEvent);
}
