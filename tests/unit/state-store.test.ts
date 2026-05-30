import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRunPaths } from "../../src/artifacts/paths.js";
import { createRunDirectory, writeRunLog } from "../../src/artifacts/run-directory.js";
import { createInitialState } from "../../src/state/initial-state.js";
import { readState, writeState } from "../../src/state/state-store.js";

test("createRunDirectory writes goal and log files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-artifacts-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });

    await createRunDirectory(paths, "Add feature X");
    await writeRunLog(paths, "Initialized run run-1");

    assert.equal(await readFile(paths.files.goal, "utf8"), "Add feature X\n");
    assert.equal(await readFile(paths.files.runLog, "utf8"), "Initialized run run-1\n");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("createRunDirectory refuses to reuse an existing run directory", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-artifacts-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });

    await mkdir(paths.runDir, { recursive: true });

    await assert.rejects(
      () => createRunDirectory(paths, "Add feature X"),
      /Run directory already exists/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("createInitialState writes required initial fields", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-state-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
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
      configPath: "/repo/orchestrator.config.example.json",
      configSnapshot: {
        checks: [],
        runner: { type: "fake" },
        maxFixAttempts: 0,
        artifactRoot: ".agent-work",
        milestonePlanPolicy: "always",
        milestonePlanReviewPolicy: "normal",
        humanReviewPolicy: "stop",
      },
      now: new Date("2026-05-10T12:34:56.789Z"),
    });

    assert.equal(state.currentPhase, "initialized");
    assert.equal(state.status, "initialized");
    assert.equal(state.currentMilestoneId, null);
    assert.equal(state.artifacts.goal, "00-goal.txt");
    assert.deepEqual(state.artifacts.logs, { run: "logs/run.log" });
    assert.equal(state.createdAt, "2026-05-10T12:34:56.789Z");

    await createRunDirectory(paths, "Add feature X");
    await writeState(paths.files.state, state);
    const roundTrip = await readState(paths.files.state);

    assert.deepEqual(roundTrip, state);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
