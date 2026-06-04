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
import { captureGitTree } from "../../src/git/git-diff.js";
import { nodeCommandRunner } from "../../src/shell/command-runner.js";
import { createInitialState } from "../../src/state/initial-state.js";
import type { RunState, StateArtifacts } from "../../src/state/state-types.js";
import { createFixtureRepo } from "../helpers/fixture-repo.js";
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

test("resume dry-run keeps plain terminal failed resumes blocked", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-dry-run-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(paths, "Resume failed run");
    await writeRecoveryMetadata(paths);

    const state = recoveryState({
      cwd: tempDir,
      paths,
      currentPhase: "failed",
      status: "failed",
      milestoneStatus: "failed",
    });

    const report = await buildResumeDryRunReport({
      state,
      paths,
      config: defaultTestConfig(),
      planningOnly: false,
      allowDirty: false,
      allowNonGitPlanning: false,
      git: gitMetadata(tempDir),
      runnerType: "fake",
    });

    assert.equal(report.allowed, false);
    assert.equal(report.nextAction, "stopped_failed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resume dry-run allows repair recovery for the active failed milestone", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-dry-run-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(paths, "Repair failed checks");
    await writeRecoveryMetadata(paths);

    const state = recoveryState({
      cwd: tempDir,
      paths,
      currentPhase: "checking",
      status: "failed",
      milestoneStatus: "failed",
      artifacts: completeRecoveryArtifacts(4),
      milestoneBaselines: { "4": "stored-baseline" },
    });

    const report = await buildResumeDryRunReport({
      state,
      paths,
      config: defaultTestConfig(),
      planningOnly: false,
      allowDirty: false,
      allowNonGitPlanning: false,
      targetMilestone: 4,
      resumeRecoveryMode: "repair_failed",
      git: gitMetadata(tempDir),
      runnerType: "fake",
    });

    assert.equal(report.allowed, true);
    assert.equal(report.nextAction, "repair_failed_milestone");
    assert.equal(report.details.resumeRecoveryMode, "repair_failed");
    assert.equal(
      report.warnings.some((warning) =>
        warning.includes("will synthesize one from the saved check report"),
      ),
      true,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resume dry-run rejects recovery for a later blocked milestone", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-dry-run-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(paths, "Repair failed checks");
    await writeRecoveryMetadata(paths);

    const state = recoveryState({
      cwd: tempDir,
      paths,
      currentPhase: "checks_failed",
      status: "checks_failed",
      milestoneStatus: "checks_failed",
      artifacts: completeRecoveryArtifacts(4),
      milestoneBaselines: { "4": "stored-baseline" },
    });

    const report = await buildResumeDryRunReport({
      state,
      paths,
      config: defaultTestConfig(),
      planningOnly: false,
      allowDirty: false,
      allowNonGitPlanning: false,
      targetMilestone: 5,
      resumeRecoveryMode: "repair_failed",
      git: gitMetadata(tempDir),
      runnerType: "fake",
    });

    assert.equal(report.allowed, false);
    assert.equal(report.nextAction, "blocked_unsafe_resume");
    assert.equal(
      report.warnings.some((warning) => warning.includes("requested milestone 5")),
      true,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resume dry-run allows recheck recovery with a stored baseline", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-dry-run-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(paths, "Recheck failed checks");
    await writeRecoveryMetadata(paths);

    const state = recoveryState({
      cwd: tempDir,
      paths,
      currentPhase: "checks_failed",
      status: "checks_failed",
      milestoneStatus: "checks_failed",
      artifacts: completeRecoveryArtifacts(4),
      milestoneBaselines: { "4": "stored-baseline" },
    });

    const report = await buildResumeDryRunReport({
      state,
      paths,
      config: defaultTestConfig(),
      planningOnly: false,
      allowDirty: true,
      allowNonGitPlanning: false,
      targetMilestone: 4,
      resumeRecoveryMode: "recheck_failed",
      git: gitMetadata(tempDir),
      runnerType: "fake",
    });

    assert.equal(report.allowed, true);
    assert.equal(report.nextAction, "recheck_failed_milestone");
    assert.equal(report.details.resumeRecoveryMode, "recheck_failed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resume dry-run blocks recheck recovery when no baseline can be resolved", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-dry-run-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(paths, "Recheck failed checks");
    await writeRecoveryMetadata(paths);

    const state = recoveryState({
      cwd: tempDir,
      paths,
      currentPhase: "checks_failed",
      status: "checks_failed",
      milestoneStatus: "checks_failed",
      gitStartSha: null,
      artifacts: completeRecoveryArtifacts(4),
    });

    const report = await buildResumeDryRunReport({
      state,
      paths,
      config: defaultTestConfig(),
      planningOnly: false,
      allowDirty: false,
      allowNonGitPlanning: false,
      resumeRecoveryMode: "recheck_failed",
      git: { ...gitMetadata(tempDir), startSha: null },
      runnerType: "fake",
    });

    assert.equal(report.allowed, false);
    assert.equal(report.nextAction, "blocked_missing_milestone_baseline");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resume dry-run blocks retry recovery when worktree differs from baseline", async () => {
  const repo = await createFixtureRepo();
  try {
    const paths = buildRunPaths({
      cwd: repo.path,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(paths, "Retry failed milestone");
    await writeRecoveryMetadata(paths);

    const baseline = await captureGitTree({
      cwd: repo.path,
      commandRunner: nodeCommandRunner,
      excludedPaths: [paths.runDir],
    });
    assert.equal(baseline.ok, true);
    if (!baseline.ok) return;

    await repo.writeFile("failed-change.txt", "failed change\n");
    const state = recoveryState({
      cwd: repo.path,
      paths,
      currentPhase: "checks_failed",
      status: "checks_failed",
      milestoneStatus: "checks_failed",
      artifacts: completeRecoveryArtifacts(4),
      milestoneBaselines: { "4": baseline.tree },
    });

    const report = await buildResumeDryRunReport({
      state,
      paths,
      config: defaultTestConfig(),
      planningOnly: false,
      allowDirty: true,
      allowNonGitPlanning: false,
      resumeRecoveryMode: "retry_failed",
      cwd: repo.path,
      commandRunner: nodeCommandRunner,
      git: gitMetadata(repo.path),
      runnerType: "fake",
    });

    assert.equal(report.allowed, false);
    assert.equal(report.nextAction, "blocked_dirty_retry_worktree");
  } finally {
    await repo.cleanup();
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

async function writeRecoveryMetadata(
  paths: ReturnType<typeof buildRunPaths>,
): Promise<void> {
  await writeJsonArtifact(buildPlanningArtifactPaths(paths).files.milestones, {
    milestones: [
      {
        id: 4,
        title: "Failed milestone",
        summary: "A milestone with failed deterministic checks.",
        scope: ["Create failed work"],
        acceptanceCriteria: ["Checks pass"],
        verification: ["Configured checks pass"],
        dependencies: [],
        status: "pending",
      },
      {
        id: 5,
        title: "Later milestone",
        summary: "A dependent later milestone.",
        scope: ["Do later work"],
        acceptanceCriteria: ["Milestone 4 passed"],
        verification: ["State inspection"],
        dependencies: [4],
        status: "pending",
      },
    ],
  });
}

function recoveryState(options: {
  cwd: string;
  paths: ReturnType<typeof buildRunPaths>;
  currentPhase: RunState["currentPhase"];
  status: RunState["status"];
  milestoneStatus: RunState["milestoneStatuses"][string];
  artifacts?: StateArtifacts;
  milestoneBaselines?: Record<string, string>;
  gitStartSha?: string | null;
}): RunState {
  return {
    ...createInitialState({
      runId: "run-1",
      goal: "Recover failed checks",
      paths: options.paths,
      git: {
        ...gitMetadata(options.cwd),
        startSha: options.gitStartSha === undefined ? "abc123" : options.gitStartSha,
      },
      configPath: null,
      configSnapshot: defaultTestConfig(),
    }),
    currentPhase: options.currentPhase,
    status: options.status,
    currentMilestoneId: 4,
    milestoneStatuses: {
      "4": options.milestoneStatus,
      "5": "pending",
    },
    milestoneBaselines: options.milestoneBaselines ?? {},
    artifacts: {
      goal: "00-goal.txt",
      ...(options.artifacts ?? {}),
    },
  };
}

function completeRecoveryArtifacts(milestoneId: number): StateArtifacts {
  const key = String(milestoneId);
  return {
    milestonePlans: {
      [key]: `milestones/10-milestone-${milestoneId}-plan.md`,
    },
    implementations: {
      [key]: `milestones/11-milestone-${milestoneId}-implementation.md`,
    },
    diffs: {
      [key]: `diffs/12-milestone-${milestoneId}.diff`,
    },
    checks: {
      [key]: `checks/13-milestone-${milestoneId}-checks.txt`,
    },
  };
}
