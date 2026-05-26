import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRunPaths, type RunPaths } from "../../src/artifacts/paths.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import { writeTextArtifact } from "../../src/artifacts/planning-artifacts.js";
import {
  buildDashboardStreamEvents,
  startDashboardRunEventStream,
} from "../../src/dashboard/event-stream.js";
import type { DashboardStreamEvent } from "../../src/dashboard/api-types.js";
import { readDashboardRun } from "../../src/dashboard/run-reader.js";
import { createInitialState } from "../../src/state/initial-state.js";
import { writeState } from "../../src/state/state-store.js";
import type { RunState } from "../../src/state/state-types.js";
import {
  appendInvocationTimelineEvent,
  appendStateTimelineEvent,
} from "../../src/timings/state-timeline.js";
import { defaultTestConfig } from "../helpers/run-fixture.js";

test("buildDashboardStreamEvents reconstructs timeline, artifact, and runner diagnostic events", async () => {
  const context = await createEventStreamContext("run-stream-1");
  try {
    await writeTextArtifact(
      path.join(context.paths.dirs.diffs, "12-milestone-1.diff"),
      "diff --git a/file.txt b/file.txt",
    );
    await writeFile(
      path.join(context.paths.dirs.runner, "major_plan-01.json"),
      JSON.stringify({ phase: "major_plan", runner: "codex-exec" }),
      "utf8",
    );
    const state = await writeDashboardState(context.paths, {
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: 1,
      milestoneStatuses: { "1": "passed" },
      artifacts: {
        diffs: { "1": "diffs/12-milestone-1.diff" },
      },
    });
    await appendStateTimelineEvent({
      paths: context.paths,
      previousState: null,
      nextState: state,
    });
    await appendInvocationTimelineEvent({
      paths: context.paths,
      invocationId: "1",
      event: "invocation_started",
      timestamp: "2026-05-10T12:00:01.000Z",
      state,
    });
    await appendInvocationTimelineEvent({
      paths: context.paths,
      invocationId: "1",
      event: "invocation_ended",
      timestamp: "2026-05-10T12:00:02.000Z",
      state,
    });

    const run = await readRun(context, "run-stream-1");
    const events = buildDashboardStreamEvents(run);
    const eventNames = new Set(events.map((event) => event.event));

    assert.equal(eventNames.has("phase_changed"), true);
    assert.equal(eventNames.has("milestone_status_changed"), true);
    assert.equal(eventNames.has("artifact_written"), true);
    assert.equal(eventNames.has("runner_diagnostic_written"), true);
    assert.equal(eventNames.has("invocation_started"), true);
    assert.equal(eventNames.has("invocation_ended"), true);
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("buildDashboardStreamEvents emits only newly visible artifacts when given a previous snapshot", async () => {
  const context = await createEventStreamContext("run-stream-2");
  try {
    const initialState = await writeDashboardState(context.paths, {
      currentPhase: "implementing",
      status: "implementing",
      currentMilestoneId: 1,
      milestoneStatuses: { "1": "implementing" },
    });
    await appendStateTimelineEvent({
      paths: context.paths,
      previousState: null,
      nextState: initialState,
    });
    const firstRun = await readRun(context, "run-stream-2");

    await writeTextArtifact(
      path.join(context.paths.dirs.checks, "13-checks-milestone-1.md"),
      "checks passed",
    );
    await writeDashboardState(context.paths, {
      currentPhase: "implementing",
      status: "implementing",
      currentMilestoneId: 1,
      milestoneStatuses: { "1": "implementing" },
      artifacts: {
        checks: { "1": "checks/13-checks-milestone-1.md" },
      },
    });

    const secondRun = await readRun(context, "run-stream-2");
    const events = buildDashboardStreamEvents(secondRun, firstRun);

    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "artifact_written");
    assert.equal(events[0]?.artifact?.relativePath, "checks/13-checks-milestone-1.md");
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("startDashboardRunEventStream keeps polling until a launched run writes state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-stream-late-"));
  const runId = "run-late-state";
  const paths = buildRunPaths({
    cwd: tempDir,
    artifactRoot: ".agent-work",
    runId,
  });
  const events: string[] = [];
  const stream = await startDashboardRunEventStream(
    {
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId,
      pollIntervalMs: 20,
      heartbeatIntervalMs: 1000,
      now: () => new Date("2026-05-10T12:00:00.000Z"),
    },
    {
      send(event) {
        events.push(event.event);
      },
    },
  );

  try {
    assert.equal(stream.ok, true);
    await createRunDirectory(paths, "Late state run");
    const state = await writeDashboardState(paths, {
      currentPhase: "planning",
      status: "planning",
    });
    await appendStateTimelineEvent({
      paths,
      previousState: null,
      nextState: state,
    });

    await waitFor(() => events.includes("phase_changed"));
    assert.equal(events.includes("stream_error"), true);
  } finally {
    if (stream.ok) stream.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("startDashboardRunEventStream replays running launcher diagnostics", async () => {
  const context = await createEventStreamContext("run-stream-launcher");
  try {
    const state = await writeDashboardState(context.paths, {
      currentPhase: "implementing",
      status: "implementing",
      currentMilestoneId: 1,
      milestoneStatuses: { "1": "implementing" },
    });
    await appendStateTimelineEvent({
      paths: context.paths,
      previousState: null,
      nextState: state,
    });

    const diagnosticsDir = path.join(context.tempDir, ".agent-work", "dashboard-launches");
    await mkdir(diagnosticsDir, { recursive: true });
    await writeFile(
      path.join(diagnosticsDir, "launch-running.json"),
      `${JSON.stringify({
        launchId: "launch-running",
        runId: "run-stream-launcher",
        status: "running",
        updatedAt: "2026-05-10T12:00:05.000Z",
        stdout: "",
        stderr: "early launcher output\n",
      })}\n`,
      "utf8",
    );

    const events: DashboardStreamEvent[] = [];
    const stream = await startDashboardRunEventStream(
      {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        runId: "run-stream-launcher",
        pollIntervalMs: 20,
        heartbeatIntervalMs: 1000,
      },
      {
        send(event) {
          events.push(event);
        },
      },
    );

    try {
      assert.equal(stream.ok, true);
      await waitFor(() => launcherOutputEvents(events).length >= 1);
      const launcherEvent = launcherOutputEvents(events)[0];
      assert.equal(launcherEvent?.launcher?.status, "running");
      assert.equal(launcherEvent?.launcher?.stream, "stderr");
      assert.match(launcherEvent?.launcher?.text ?? "", /early launcher output/);

      await writeFile(
        path.join(diagnosticsDir, "launch-running.json"),
        `${JSON.stringify({
          launchId: "launch-running",
          runId: "run-stream-launcher",
          status: "running",
          updatedAt: "2026-05-10T12:00:06.000Z",
          stdout: "",
          stderr: "early launcher output\nlater launcher output\n",
        })}\n`,
        "utf8",
      );

      await waitFor(() => launcherOutputEvents(events).length >= 2);
      const launcherEvents = launcherOutputEvents(events);
      assert.equal(new Set(launcherEvents.map((event) => event.id)).size, 2);
      assert.match(
        launcherEvents[1]?.launcher?.text ?? "",
        /later launcher output/,
      );
    } finally {
      if (stream.ok) stream.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

async function createEventStreamContext(runId: string): Promise<{
  tempDir: string;
  paths: RunPaths;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-stream-"));
  const paths = buildRunPaths({
    cwd: tempDir,
    artifactRoot: ".agent-work",
    runId,
  });
  await createRunDirectory(paths, "Add dashboard stream");
  return { tempDir, paths };
}

async function writeDashboardState(
  paths: RunPaths,
  overrides: Partial<RunState>,
): Promise<RunState> {
  const base = createInitialState({
    runId: paths.runId,
    goal: "Add dashboard stream",
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
    configSnapshot: defaultTestConfig(),
    now: new Date("2026-05-10T12:00:00.000Z"),
  });
  const state: RunState = {
    ...base,
    ...overrides,
    artifacts: {
      ...base.artifacts,
      ...overrides.artifacts,
    },
  };
  await writeState(paths.files.state, state);
  return state;
}

async function readRun(context: { tempDir: string }, runId: string) {
  const result = await readDashboardRun({
    cwd: context.tempDir,
    artifactRoot: ".agent-work",
    runId,
  });
  if (!result.ok) assert.fail(result.error.message);
  return result.run;
}

function launcherOutputEvents(events: DashboardStreamEvent[]): DashboardStreamEvent[] {
  return events.filter((event) => event.event === "launcher_output");
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > 1000) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for dashboard stream event."));
      }
    }, 10);
  });
}
