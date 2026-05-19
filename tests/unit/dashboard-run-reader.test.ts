import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRunPaths, type RunPaths } from "../../src/artifacts/paths.js";
import { createRunDirectory, writeRunLog } from "../../src/artifacts/run-directory.js";
import { writeTextArtifact } from "../../src/artifacts/planning-artifacts.js";
import {
  findDashboardArtifact,
  listDashboardRuns,
  readDashboardRun,
} from "../../src/dashboard/run-reader.js";
import { createInitialState } from "../../src/state/initial-state.js";
import { writeState } from "../../src/state/state-store.js";
import type { RunState } from "../../src/state/state-types.js";
import { appendStateTimelineEvent } from "../../src/timings/state-timeline.js";
import { defaultTestConfig } from "../helpers/run-fixture.js";

test("readDashboardRun loads a completed run with artifacts and timeline", async () => {
  const context = await createDashboardRunContext("run-1");
  try {
    await writeTextArtifact(
      path.join(context.paths.dirs.diffs, "12-milestone-1.diff"),
      "diff --git a/file.txt b/file.txt",
    );
    await writeRunLog(context.paths, "Initialized run run-1");
    const state = await writeDashboardState(context.paths, {
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: 1,
      milestoneStatuses: { "1": "passed" },
      artifacts: {
        goal: "00-goal.txt",
        diffs: { "1": "diffs/12-milestone-1.diff" },
        logs: { run: "logs/run.log" },
      },
    });
    await appendStateTimelineEvent({
      paths: context.paths,
      previousState: null,
      nextState: state,
    });

    const result = await readDashboardRun(readerOptions(context, "run-1"));

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.run.status, "passed");
      assert.equal(result.run.active, false);
      assert.equal(result.run.milestoneStatuses["1"], "passed");
      assert.equal(result.run.artifacts.diffs.length, 1);
      assert.equal(result.run.artifacts.diffs[0]?.exists, true);
      assert.equal(result.run.timeline.length, 1);
      assert.equal(result.run.timeline[0]?.event, "state_initialized");

      const artifact = findDashboardArtifact(
        result.run,
        result.run.artifacts.diffs[0]?.id ?? "",
      );
      assert.equal(artifact?.relativePath, "diffs/12-milestone-1.diff");
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("readDashboardRun exposes review evidence artifacts in the reviews group", async () => {
  const context = await createDashboardRunContext("run-review-evidence");
  try {
    await writeTextArtifact(
      path.join(context.paths.dirs.reviews, "19-milestone-1-review-evidence.md"),
      "# Milestone 1 Review Evidence",
    );
    await writeTextArtifact(
      path.join(
        context.paths.dirs.reviews,
        "23-milestone-1-review-evidence-after-fix-1.md",
      ),
      "# Milestone 1 Review Evidence After Fix 1",
    );
    await writeDashboardState(context.paths, {
      currentPhase: "needs_human_review",
      status: "needs_human_review",
      currentMilestoneId: 1,
      milestoneStatuses: { "1": "needs_human_review" },
      artifacts: {
        reviews: {
          "1-evidence": "reviews/19-milestone-1-review-evidence.md",
          "1-fix-1-evidence":
            "reviews/23-milestone-1-review-evidence-after-fix-1.md",
        },
      },
    });

    const result = await readDashboardRun(
      readerOptions(context, "run-review-evidence"),
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      const reviewPaths = result.run.artifacts.reviews.map(
        (artifact) => artifact.relativePath,
      );
      assert.deepEqual(reviewPaths, [
        "reviews/19-milestone-1-review-evidence.md",
        "reviews/23-milestone-1-review-evidence-after-fix-1.md",
      ]);
      assert.equal(result.run.artifacts.reviews[0]?.exists, true);
      assert.equal(result.run.artifacts.reviews[0]?.source, "state");
      assert.equal(result.run.artifacts.reviews[0]?.milestoneId, 1);
      assert.equal(result.run.artifacts.reviews[1]?.exists, true);
      assert.equal(result.run.artifacts.reviews[1]?.source, "state");
      assert.equal(result.run.artifacts.reviews[1]?.milestoneId, 1);
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("readDashboardRun loads a needs_human_review run", async () => {
  const context = await createDashboardRunContext("run-review");
  try {
    await writeDashboardState(context.paths, {
      currentPhase: "needs_human_review",
      status: "needs_human_review",
      currentMilestoneId: 1,
      milestoneStatuses: { "1": "needs_human_review" },
      lastError: {
        message: "Review requires a human decision.",
        phase: "needs_human_review",
        occurredAt: "2026-05-10T12:00:01.000Z",
      },
    });

    const result = await readDashboardRun(readerOptions(context, "run-review"));

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.run.status, "needs_human_review");
      assert.equal(result.run.active, false);
      assert.equal(result.run.lastError !== null, true);
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("readDashboardRun treats a missing timeline as a warning", async () => {
  const context = await createDashboardRunContext("run-missing-timeline");
  try {
    await writeDashboardState(context.paths, {});

    const result = await readDashboardRun(readerOptions(context, "run-missing-timeline"));

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.run.timeline, []);
      assert.equal(
        result.run.warnings.some((warning) => warning.code === "timeline_missing"),
        true,
      );
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("readDashboardRun skips malformed timeline lines with a warning", async () => {
  const context = await createDashboardRunContext("run-bad-timeline");
  try {
    await writeDashboardState(context.paths, {});
    await writeFile(
      path.join(context.paths.dirs.logs, "timeline.jsonl"),
      [
        "{not json}",
        JSON.stringify({
          timestamp: "2026-05-10T12:00:01.000Z",
          event: "phase_changed",
          phase: "planning",
          status: "planning",
          currentMilestoneId: null,
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await readDashboardRun(readerOptions(context, "run-bad-timeline"));

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.run.timeline.length, 1);
      assert.equal(result.run.timeline[0]?.event, "phase_changed");
      assert.equal(
        result.run.warnings.some((warning) => warning.code === "timeline_malformed"),
        true,
      );
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("readDashboardRun normalizes partial timeline entries and milestone records", async () => {
  const context = await createDashboardRunContext("run-normalized");
  try {
    await writeDashboardState(context.paths, {
      currentPhase: "failed",
      status: "failed",
      milestoneStatuses: {
        "1": "passed",
        "2": 42 as unknown as RunState["milestoneStatuses"][string],
      },
    });
    await writeFile(
      path.join(context.paths.dirs.logs, "timeline.jsonl"),
      [
        JSON.stringify("raw string event"),
        JSON.stringify({
          timestamp: "",
          event: "",
          phase: 123,
          status: "failed",
          currentMilestoneId: "1",
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await readDashboardRun(readerOptions(context, "run-normalized"));

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.run.active, false);
      assert.deepEqual(result.run.milestoneStatuses, { "1": "passed" });
      assert.equal(result.run.timeline[0]?.event, "unknown");
      assert.equal(result.run.timeline[0]?.timestamp, null);
      assert.equal(result.run.timeline[0]?.raw, "raw string event");
      assert.equal(result.run.timeline[1]?.event, "unknown");
      assert.equal(result.run.timeline[1]?.timestamp, null);
      assert.equal(result.run.timeline[1]?.phase, undefined);
      assert.equal(result.run.timeline[1]?.status, "failed");
      assert.equal(result.run.timeline[1]?.currentMilestoneId, undefined);
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("readDashboardRun does not expose unsafe artifact paths", async () => {
  const context = await createDashboardRunContext("run-unsafe-artifact");
  try {
    await writeDashboardState(context.paths, {
      artifacts: {
        diffs: { "1": "../secret.diff" },
      },
    });

    const result = await readDashboardRun(readerOptions(context, "run-unsafe-artifact"));

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.run.artifacts.diffs.length, 0);
      assert.equal(
        result.run.warnings.some((warning) => warning.code === "artifact_path_invalid"),
        true,
      );
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("readDashboardRun does not expose symlinked artifact files", async () => {
  const context = await createDashboardRunContext("run-symlink-artifact");
  try {
    const outsideArtifact = path.join(context.tempDir, "outside.diff");
    const linkedArtifact = path.join(context.paths.dirs.diffs, "linked.diff");
    await writeFile(outsideArtifact, "secret outside artifact\n", "utf8");
    await symlink(outsideArtifact, linkedArtifact);
    await writeDashboardState(context.paths, {
      artifacts: {
        diffs: { "1": "diffs/linked.diff" },
      },
    });

    const result = await readDashboardRun(readerOptions(context, "run-symlink-artifact"));

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.run.artifacts.diffs.length, 0);
      assert.equal(
        result.run.warnings.some(
          (warning) => warning.code === "artifact_symlink_unsupported",
        ),
        true,
      );
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("readDashboardRun includes missing state artifacts with warnings", async () => {
  const context = await createDashboardRunContext("run-missing-artifact");
  try {
    await writeDashboardState(context.paths, {
      artifacts: {
        diffs: { "1": "diffs/missing.diff" },
      },
    });

    const result = await readDashboardRun(readerOptions(context, "run-missing-artifact"));

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.run.artifacts.diffs.length, 1);
      assert.equal(result.run.artifacts.diffs[0]?.exists, false);
      assert.equal(
        result.run.warnings.some((warning) => warning.code === "artifact_missing"),
        true,
      );
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("listDashboardRuns skips directories without state and reports malformed state summaries", async () => {
  const context = await createDashboardRunContext("run-good");
  try {
    await writeDashboardState(context.paths, {});

    const missingStatePaths = buildRunPaths({
      cwd: context.tempDir,
      artifactRoot: ".agent-work",
      runId: "run-no-state",
    });
    await createRunDirectory(missingStatePaths, "Missing state");

    const malformedPaths = buildRunPaths({
      cwd: context.tempDir,
      artifactRoot: ".agent-work",
      runId: "run-malformed",
    });
    await createRunDirectory(malformedPaths, "Malformed state");
    await writeFile(malformedPaths.files.state, "{not json}", "utf8");

    const summaries = await listDashboardRuns({
      cwd: context.tempDir,
      artifactRoot: ".agent-work",
    });

    assert.equal(
      summaries.some((summary) => summary.runId === "run-no-state"),
      false,
    );
    assert.equal(
      summaries.some((summary) => summary.runId === "run-good"),
      true,
    );
    const malformed = summaries.find((summary) => summary.runId === "run-malformed");
    assert.equal(malformed?.status, "unreadable");
    assert.equal(malformed?.warnings[0]?.code, "state_malformed");
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("readDashboardRun returns a structured error for malformed state", async () => {
  const context = await createDashboardRunContext("run-malformed-detail");
  try {
    await writeFile(context.paths.files.state, "{not json}", "utf8");

    const result = await readDashboardRun(
      readerOptions(context, "run-malformed-detail"),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "state_malformed");
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

async function createDashboardRunContext(runId: string): Promise<{
  tempDir: string;
  paths: RunPaths;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-dashboard-"));
  const paths = buildRunPaths({
    cwd: tempDir,
    artifactRoot: ".agent-work",
    runId,
  });
  await createRunDirectory(paths, "Add dashboard reader");
  return { tempDir, paths };
}

async function writeDashboardState(
  paths: RunPaths,
  overrides: Partial<RunState>,
): Promise<RunState> {
  const base = createInitialState({
    runId: paths.runId,
    goal: "Add dashboard reader",
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

function readerOptions(
  context: { tempDir: string },
  runId: string,
): { cwd: string; artifactRoot: string; runId: string } {
  return {
    cwd: context.tempDir,
    artifactRoot: ".agent-work",
    runId,
  };
}
