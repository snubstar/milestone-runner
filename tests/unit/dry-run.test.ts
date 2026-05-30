import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPlanningArtifactPaths,
  writeJsonArtifact,
} from "../../src/artifacts/planning-artifacts.js";
import { buildRunPaths } from "../../src/artifacts/paths.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import { buildResumeDryRunReport } from "../../src/cli/dry-run.js";
import type { OrchestratorConfig } from "../../src/config/config-types.js";
import { createInitialState } from "../../src/state/initial-state.js";
import { defaultTestConfig } from "../helpers/run-fixture.js";

test("resume dry-run routes unsafe resume states by human review policy", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-dry-run-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(paths, "Resume autonomously");
    await writeJsonArtifact(buildPlanningArtifactPaths(paths).files.milestones, {
      milestones: [
        {
          id: 1,
          title: "First milestone",
          summary: "Implement the first milestone.",
          scope: ["Create a fixture output file"],
          acceptanceCriteria: ["A fixture output file exists"],
          verification: ["Configured checks pass"],
          dependencies: [],
          status: "pending",
        },
      ],
    });

    const config = defaultTestConfig();
    const state = {
      ...createInitialState({
        runId: "run-1",
        goal: "Resume autonomously",
        paths,
        git: gitMetadata(tempDir),
        configPath: path.join(tempDir, "orchestrator.config.json"),
        configSnapshot: config,
      }),
      currentPhase: "implementing" as const,
      status: "implementing" as const,
      currentMilestoneId: 1,
      milestoneStatuses: {
        "1": "implementing" as const,
      },
    };

    const autonomous = await buildResumeDryRunReport({
      state,
      paths,
      config: configWithPolicy("autonomous"),
      planningOnly: false,
      allowDirty: false,
      allowNonGitPlanning: false,
      git: gitMetadata(tempDir),
      runnerType: "fake",
    });
    assert.equal(autonomous.allowed, true);
    assert.equal(autonomous.nextAction, "resolve_resume_state");
    assert.equal(
      autonomous.details.humanReviewHandling,
      "autonomous repair/resolution before failing",
    );
    assert.equal(
      autonomous.warnings.some((warning) =>
        warning.includes("Resume cannot prove that transient implementation work is safe"),
      ),
      true,
    );

    const failFast = await buildResumeDryRunReport({
      state,
      paths,
      config: configWithPolicy("fail"),
      planningOnly: false,
      allowDirty: false,
      allowNonGitPlanning: false,
      git: gitMetadata(tempDir),
      runnerType: "fake",
    });
    assert.equal(failFast.allowed, true);
    assert.equal(failFast.nextAction, "fail_unsafe_resume");
    assert.equal(
      failFast.details.humanReviewHandling,
      "fail-fast unattended failure on human-review-equivalent conditions",
    );

    const supervised = await buildResumeDryRunReport({
      state,
      paths,
      config: configWithPolicy("stop"),
      planningOnly: false,
      allowDirty: false,
      allowNonGitPlanning: false,
      git: gitMetadata(tempDir),
      runnerType: "fake",
    });
    assert.equal(supervised.allowed, false);
    assert.equal(supervised.nextAction, "blocked_unsafe_resume");
    assert.equal(
      supervised.details.humanReviewHandling,
      "supervised stop on human-review-equivalent conditions",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function configWithPolicy(
  humanReviewPolicy: OrchestratorConfig["humanReviewPolicy"],
): OrchestratorConfig {
  return {
    ...defaultTestConfig(),
    humanReviewPolicy,
  };
}

function gitMetadata(root: string) {
  return {
    required: true,
    planningOnly: false,
    root,
    startSha: "abc123",
    dirtyAtStart: false,
    dirtyOverride: false,
    statusPorcelain: "",
  };
}
