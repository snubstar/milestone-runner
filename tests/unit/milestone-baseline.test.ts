import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import { buildMilestoneArtifactPaths } from "../../src/artifacts/milestone-artifacts.js";
import { buildRunPaths } from "../../src/artifacts/paths.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import { captureGitDiff, captureGitTree } from "../../src/git/git-diff.js";
import type { MilestoneMetadata } from "../../src/milestones/milestone-types.js";
import {
  captureReviewableMilestoneDiff,
  resolveMilestoneBaseline,
} from "../../src/orchestration/milestone-baseline.js";
import { nodeCommandRunner } from "../../src/shell/command-runner.js";
import { createInitialState } from "../../src/state/initial-state.js";
import type { RunState } from "../../src/state/state-types.js";
import { createFixtureRepo } from "../helpers/fixture-repo.js";
import { defaultTestConfig } from "../helpers/run-fixture.js";

test("resolveMilestoneBaseline returns stored milestone baselines first", async () => {
  const repo = await createFixtureRepo();
  try {
    const paths = buildRunPaths({
      cwd: repo.path,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    const state = {
      ...baseState(repo.path, paths, await repo.git(["rev-parse", "HEAD"])),
      milestoneBaselines: {
        "2": "stored-tree",
      },
    };

    const result = await resolveMilestoneBaseline({
      state,
      metadata: testMetadata(),
      milestoneId: 2,
      paths,
      cwd: repo.path,
      commandRunner: nodeCommandRunner,
    });

    assert.deepEqual(result, {
      ok: true,
      baselineTree: "stored-tree",
      source: "stored",
    });
  } finally {
    await repo.cleanup();
  }
});

test("captureReviewableMilestoneDiff captures diff against milestone baseline", async () => {
  const repo = await createFixtureRepo();
  try {
    const paths = buildRunPaths({
      cwd: repo.path,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(paths, "Add feature X");
    await repo.writeFile("prior.txt", "prior\n");

    const baseline = await captureGitTree({
      cwd: repo.path,
      commandRunner: nodeCommandRunner,
      excludedPaths: [paths.runDir],
    });
    assert.equal(baseline.ok, true);
    if (!baseline.ok) return;

    await repo.writeFile("current.txt", "current\n");

    const result = await captureReviewableMilestoneDiff({
      cwd: repo.path,
      commandRunner: nodeCommandRunner,
      paths,
      baselineTree: baseline.tree,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.diff, /diff --git a\/current\.txt b\/current\.txt/);
    assert.doesNotMatch(result.diff, /prior\.txt/);
    assert.doesNotMatch(result.diff, /\.agent-work\/run-1/);
  } finally {
    await repo.cleanup();
  }
});

test("resolveMilestoneBaseline reconstructs legacy baseline from passed milestone diffs", async () => {
  const repo = await createFixtureRepo();
  try {
    const startSha = await repo.git(["rev-parse", "HEAD"]);
    const paths = buildRunPaths({
      cwd: repo.path,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(paths, "Add feature X");

    await repo.writeFile("prior.txt", "prior\n");
    const priorDiff = await captureGitDiff({
      cwd: repo.path,
      commandRunner: nodeCommandRunner,
      excludedPaths: [paths.runDir],
    });
    assert.equal(priorDiff.ok, true);
    if (!priorDiff.ok) return;

    const milestone1Paths = buildMilestoneArtifactPaths(paths, 1);
    await writeFile(milestone1Paths.files.diff, priorDiff.diff, "utf8");

    const expectedBaseline = await captureGitTree({
      cwd: repo.path,
      commandRunner: nodeCommandRunner,
      excludedPaths: [paths.runDir],
    });
    assert.equal(expectedBaseline.ok, true);
    if (!expectedBaseline.ok) return;

    await repo.writeFile("current.txt", "current\n");
    const initial = baseState(repo.path, paths, startSha);
    const state = {
      ...initial,
      milestoneStatuses: {
        "1": "passed",
        "2": "failed",
      },
      artifacts: {
        ...initial.artifacts,
        diffs: {
          "1": milestone1Paths.statePaths.diff,
        },
      },
    } satisfies RunState;

    const result = await resolveMilestoneBaseline({
      state,
      metadata: testMetadata(),
      milestoneId: 2,
      paths,
      cwd: repo.path,
      commandRunner: nodeCommandRunner,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.source, "reconstructed");
    assert.equal(result.baselineTree, expectedBaseline.tree);
  } finally {
    await repo.cleanup();
  }
});

test("resolveMilestoneBaseline fails safely when a prior passed diff is missing", async () => {
  const repo = await createFixtureRepo();
  try {
    const paths = buildRunPaths({
      cwd: repo.path,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    const state = {
      ...baseState(repo.path, paths, await repo.git(["rev-parse", "HEAD"])),
      milestoneStatuses: {
        "1": "passed",
        "2": "failed",
      },
    } satisfies RunState;

    const result = await resolveMilestoneBaseline({
      state,
      metadata: testMetadata(),
      milestoneId: 2,
      paths,
      cwd: repo.path,
      commandRunner: nodeCommandRunner,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /passed milestone 1 has no diff artifact/);
    }
  } finally {
    await repo.cleanup();
  }
});

function baseState(
  cwd: string,
  paths: ReturnType<typeof buildRunPaths>,
  startSha: string,
): RunState {
  return createInitialState({
    runId: "run-1",
    goal: "Add feature X",
    paths,
    git: {
      required: true,
      planningOnly: false,
      root: cwd,
      startSha,
      dirtyAtStart: false,
      dirtyOverride: false,
      statusPorcelain: "",
    },
    configPath: null,
    configSnapshot: defaultTestConfig(),
  });
}

function testMetadata(): MilestoneMetadata {
  return {
    milestones: [
      {
        id: 1,
        title: "First milestone",
        summary: "Implement first milestone.",
        scope: ["Create first file"],
        acceptanceCriteria: ["First file exists"],
        verification: ["Checks pass"],
        dependencies: [],
        status: "pending",
      },
      {
        id: 2,
        title: "Second milestone",
        summary: "Implement second milestone.",
        scope: ["Create second file"],
        acceptanceCriteria: ["Second file exists"],
        verification: ["Checks pass"],
        dependencies: [1],
        status: "pending",
      },
    ],
  };
}
