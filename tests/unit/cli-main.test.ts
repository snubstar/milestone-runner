import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../../src/cli/main.js";
import { nodeCommandRunner } from "../../src/shell/command-runner.js";
import type { RunState } from "../../src/state/state-types.js";
import {
  assertMilestoneMetadataArtifact,
  assertReviewVerdictArtifact,
  assertRunStateShape,
} from "../helpers/assertions.js";

const projectRoot = process.cwd();

test("main stops after planning when --planning-only is set", async () => {
  const repo = await createCliFixtureRepo();
  try {
    const result = await runMainInRepo(repo, [
      "--planning-only",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Planning only: true/);
    assert.match(result.stdout, /State: ready_for_milestone/);
    assert.match(result.stdout, /Current milestone: 1/);
    assert.match(result.stdout, /Milestones:\n  1: pending\n  2: pending/);
    assert.doesNotMatch(result.stdout, /Final summary artifact:/);

    const state = await readOnlyRunState(repo);
    assert.equal(state.currentPhase, "ready_for_milestone");
    assert.equal(state.currentMilestoneId, 1);

    const runDir = path.join(repo, ".agent-work", state.runId);
    const metadata = await assertMilestoneMetadataArtifact(
      path.join(runDir, state.artifacts.milestones ?? ""),
    );
    assert.deepEqual(metadata.milestones.map((milestone) => milestone.id), [1, 2]);

    await assert.rejects(
      () => readFile(path.join(repo, "fake-milestone-1-implementation.txt"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main stores max fix attempts CLI override in new run state", async () => {
  const repo = await createCliFixtureRepo();
  try {
    const result = await runMainInRepo(repo, [
      "--planning-only",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "--max-fix-attempts",
      "2",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);

    const state = await readOnlyRunState(repo);
    assert.equal(state.config.snapshot?.maxFixAttempts, 2);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main dry-runs a new fake run without creating a run directory", async () => {
  const repo = await createCliFixtureRepo();
  try {
    const result = await runMainInRepo(repo, [
      "--dry-run",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Agent milestone orchestrator dry run/);
    assert.match(result.stdout, /Mode: new/);
    assert.match(result.stdout, /Allowed: true/);
    assert.match(result.stdout, /Next action: run_full_goal/);
    assert.match(result.stdout, /runner: fake/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main dry-runs blocked non-fake execution without creating a run directory", async () => {
  const repo = await createCliFixtureRepo({
    runner: {
      type: "codex-exec",
      command: process.execPath,
      options: {
        sandboxForPlanning: "read-only",
        sandboxForImplementation: "workspace-write",
        approvalPolicy: "never",
      },
    },
  });
  try {
    const result = await runMainInRepo(repo, [
      "--dry-run",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Mode: new/);
    assert.match(result.stdout, /Allowed: false/);
    assert.match(result.stdout, /Next action: blocked_runner_not_supported/);
    assert.match(result.stdout, /runner: codex-exec/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main dry-runs missing codex-exec runner command as an environment block", async () => {
  const repo = await createCliFixtureRepo({
    runner: {
      type: "codex-exec",
      command: "agent-orchestrator-missing-codex",
      options: {
        sandboxForPlanning: "read-only",
        sandboxForImplementation: "workspace-write",
        approvalPolicy: "never",
      },
    },
  });
  try {
    const result = await runMainInRepo(repo, [
      "--dry-run",
      "--planning-only",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Next action: blocked_missing_tool/);
    assert.match(result.stdout, /runner\.command/);
    assert.match(result.stdout, /agent-orchestrator-missing-codex --version/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main rejects missing codex-exec runner command before creating a run directory", async () => {
  const repo = await createCliFixtureRepo({
    runner: {
      type: "codex-exec",
      command: "agent-orchestrator-missing-codex",
      options: {
        sandboxForPlanning: "read-only",
        sandboxForImplementation: "workspace-write",
        approvalPolicy: "never",
      },
    },
  });
  try {
    const result = await runMainInRepo(repo, [
      "--planning-only",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Error: Configured codex-exec runner command/);
    assert.match(result.stderr, /runner\.command/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main dry-runs blocked dirty execution without creating a run directory", async () => {
  const repo = await createCliFixtureRepo();
  try {
    await writeFile(path.join(repo, "README.md"), "# Dirty CLI Fixture\n", "utf8");

    const result = await runMainInRepo(repo, [
      "--dry-run",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Mode: new/);
    assert.match(result.stdout, /Allowed: false/);
    assert.match(result.stdout, /Next action: blocked_dirty_tree/);
    assert.match(result.stdout, /gitDirty: true/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main resumes an existing fake run from saved state", async () => {
  const repo = await createCliFixtureRepo();
  try {
    const planningResult = await runMainInRepo(repo, [
      "--planning-only",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(planningResult.exitCode, 0);

    const plannedState = await readOnlyRunState(repo);
    assert.equal(plannedState.currentPhase, "ready_for_milestone");

    const resumeResult = await runMainInRepo(repo, [
      "--resume",
      plannedState.runDir,
    ]);

    assert.equal(resumeResult.exitCode, 0);
    assert.match(resumeResult.stdout, /State: passed/);
    assert.match(resumeResult.stdout, /Current milestone: none/);
    assert.match(resumeResult.stdout, /Milestones:\n  1: passed\n  2: passed/);

    const finalState = await readOnlyRunState(repo);
    assert.equal(finalState.currentPhase, "passed");
    assert.equal(finalState.currentMilestoneId, null);
    assert.equal(finalState.artifacts.summaries?.goal, path.join("milestones", "90-goal-summary.md"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main dry-runs resume without writing state changes", async () => {
  const repo = await createCliFixtureRepo();
  try {
    const planningResult = await runMainInRepo(repo, [
      "--planning-only",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(planningResult.exitCode, 0);

    const plannedState = await readOnlyRunState(repo);
    const statePath = path.join(plannedState.runDir, "state.json");
    const rawStateBefore = await readFile(statePath, "utf8");

    const result = await runMainInRepo(repo, [
      "--dry-run",
      "--resume",
      plannedState.runDir,
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Agent milestone orchestrator dry run/);
    assert.match(result.stdout, /Mode: resume/);
    assert.match(result.stdout, /Allowed: true/);
    assert.match(result.stdout, /Next action: continue_milestone/);

    const rawStateAfter = await readFile(statePath, "utf8");
    assert.equal(rawStateAfter, rawStateBefore);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main runs all fake milestones through review when planning-only is not set", async () => {
  const repo = await createCliFixtureRepo();
  try {
    const result = await runMainInRepo(repo, [
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Planning only: false/);
    assert.match(result.stdout, /State: passed/);
    assert.match(result.stdout, /Current milestone: none/);
    assert.match(result.stdout, /Milestones:\n  1: passed\n  2: passed/);
    assert.match(result.stdout, /Final summary artifact: milestones\/90-goal-summary\.md/);

    const state = await readOnlyRunState(repo);
    assert.equal(state.currentPhase, "passed");
    assert.equal(state.currentMilestoneId, null);
    assert.deepEqual(state.milestoneStatuses, {
      "1": "passed",
      "2": "passed",
    });
    assert.deepEqual(state.artifacts.reviews, {
      "1": path.join("reviews", "20-milestone-1-review.json"),
      "2": path.join("reviews", "20-milestone-2-review.json"),
    });
    assert.deepEqual(state.artifacts.summaries, {
      "1": path.join("milestones", "14-milestone-1-summary.md"),
      "1-review": path.join("milestones", "25-milestone-1-review-summary.md"),
      "2": path.join("milestones", "14-milestone-2-summary.md"),
      "2-review": path.join("milestones", "25-milestone-2-review-summary.md"),
      "goal": path.join("milestones", "90-goal-summary.md"),
    });

    const runDir = path.join(repo, ".agent-work", state.runId);
    const metadata = await assertMilestoneMetadataArtifact(
      path.join(runDir, state.artifacts.milestones ?? ""),
    );
    assert.deepEqual(metadata.milestones.map((milestone) => milestone.id), [1, 2]);
    assert.match(
      await readFile(path.join(runDir, state.artifacts.diffs?.["1"] ?? ""), "utf8"),
      /diff --git a\/fake-milestone-1-implementation\.txt b\/fake-milestone-1-implementation\.txt/,
    );
    assert.match(
      await readFile(path.join(runDir, state.artifacts.checks?.["1"] ?? ""), "utf8"),
      /cli check ok/,
    );
    assert.match(
      await readFile(path.join(runDir, state.artifacts.diffs?.["2"] ?? ""), "utf8"),
      /diff --git a\/fake-milestone-2-implementation\.txt b\/fake-milestone-2-implementation\.txt/,
    );
    assert.doesNotMatch(
      await readFile(path.join(runDir, state.artifacts.diffs?.["2"] ?? ""), "utf8"),
      /fake-milestone-1-implementation\.txt/,
    );
    assert.match(
      await readFile(path.join(runDir, state.artifacts.checks?.["2"] ?? ""), "utf8"),
      /cli check ok/,
    );
    assert.match(
      await readFile(path.join(runDir, state.artifacts.summaries?.["1-review"] ?? ""), "utf8"),
      /Fake review accepted milestone 1\./,
    );
    assert.match(
      await readFile(path.join(runDir, state.artifacts.summaries?.["2-review"] ?? ""), "utf8"),
      /Fake review accepted milestone 2\./,
    );
    const finalSummary = await readFile(
      path.join(runDir, state.artifacts.summaries?.goal ?? ""),
      "utf8",
    );
    assert.match(finalSummary, /Status: passed/);
    assert.match(finalSummary, /fake-milestone-1-implementation\.txt/);
    assert.match(finalSummary, /fake-milestone-2-implementation\.txt/);
    assert.match(
      await readFile(path.join(repo, "fake-milestone-1-implementation.txt"), "utf8"),
      /Milestone: 1/,
    );
    assert.match(
      await readFile(path.join(repo, "fake-milestone-2-implementation.txt"), "utf8"),
      /Milestone: 2/,
    );
    const review1 = await assertReviewVerdictArtifact(
      path.join(runDir, state.artifacts.reviews?.["1"] ?? ""),
    );
    assert.equal(review1.verdict, "pass");
    const review2 = await assertReviewVerdictArtifact(
      path.join(runDir, state.artifacts.reviews?.["2"] ?? ""),
    );
    assert.equal(review2.verdict, "pass");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main runs one constrained milestone and leaves remaining milestones resumable", async () => {
  const repo = await createCliFixtureRepo();
  try {
    const result = await runMainInRepo(repo, [
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "--milestone",
      "1",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Target milestone: 1/);
    assert.match(result.stdout, /State: passed/);
    assert.match(result.stdout, /Current milestone: 1/);
    assert.match(result.stdout, /Next action: resume without --milestone to continue remaining milestones/);
    assert.match(result.stdout, /Milestones:\n  1: passed\n  2: pending/);
    assert.doesNotMatch(result.stdout, /Final summary artifact:/);

    const state = await readOnlyRunState(repo);
    assert.equal(state.currentPhase, "passed");
    assert.equal(state.status, "passed");
    assert.equal(state.currentMilestoneId, 1);
    assert.deepEqual(state.milestoneStatuses, {
      "1": "passed",
      "2": "pending",
    });
    assert.equal(state.artifacts.summaries?.goal, undefined);

    await readFile(path.join(repo, "fake-milestone-1-implementation.txt"), "utf8");
    await assert.rejects(
      () => readFile(path.join(repo, "fake-milestone-2-implementation.txt"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main rejects a constrained milestone with unmet dependencies before implementation", async () => {
  const repo = await createCliFixtureRepo();
  try {
    const result = await runMainInRepo(repo, [
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "--milestone",
      "2",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Target milestone 2 cannot run/);
    assert.match(result.stderr, /dependencies are not passed: 1/);
    assert.match(result.stdout, /Target milestone: 2/);
    assert.match(result.stdout, /State: ready_for_milestone/);
    assert.match(result.stdout, /Milestones:\n  1: pending\n  2: pending/);
    assert.doesNotMatch(result.stdout, /Final summary artifact:/);

    const state = await readOnlyRunState(repo);
    assert.equal(state.currentPhase, "ready_for_milestone");
    assert.equal(state.currentMilestoneId, 1);
    await assert.rejects(
      () => readFile(path.join(repo, "fake-milestone-1-implementation.txt"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main prints final summary artifact when fake workflow fails after writing summary", async () => {
  const repo = await createCliFixtureRepo({
    checks: [
      `${JSON.stringify(process.execPath)} -e "process.stderr.write('cli check failed'); process.exit(2)"`,
    ],
  });
  try {
    const result = await runMainInRepo(repo, [
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Checks failed for milestone 1/);
    assert.match(result.stdout, /State: checking/);
    assert.match(result.stdout, /Current milestone: 1/);
    assert.match(result.stdout, /Milestones:\n  1: failed\n  2: pending/);
    assert.match(result.stdout, /Final summary artifact: milestones\/90-goal-summary\.md/);

    const state = await readOnlyRunState(repo);
    assert.equal(state.currentPhase, "checking");
    assert.equal(state.status, "failed");
    assert.equal(state.artifacts.summaries?.goal, path.join("milestones", "90-goal-summary.md"));

    const runDir = path.join(repo, ".agent-work", state.runId);
    const finalSummary = await readFile(
      path.join(runDir, state.artifacts.summaries?.goal ?? ""),
      "utf8",
    );
    assert.match(finalSummary, /Status: failed/);
    assert.match(finalSummary, /Stop reason: Checks failed for milestone 1\./);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main rejects dirty implementation runs before creating a run directory", async () => {
  const repo = await createCliFixtureRepo();
  try {
    await writeFile(path.join(repo, "README.md"), "# Dirty CLI Fixture\n", "utf8");

    const result = await runMainInRepo(repo, [
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Git working tree is dirty/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main allows dirty implementation runs with explicit override", async () => {
  const repo = await createCliFixtureRepo();
  try {
    await writeFile(path.join(repo, "README.md"), "# Dirty CLI Fixture\n", "utf8");

    const result = await runMainInRepo(repo, [
      "--allow-dirty",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /Warning: dirty Git working tree allowed by --allow-dirty/);
    assert.match(result.stdout, /Git dirty: true/);
    assert.match(result.stdout, /Git dirty override: true/);

    const state = await readOnlyRunState(repo);
    assert.equal(state.git.dirtyAtStart, true);
    assert.equal(state.git.dirtyOverride, true);
    assert.match(state.git.statusPorcelain, /README\.md/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main rejects non-Git planning-only without explicit override", async () => {
  const repo = await createCliFixtureProject();
  try {
    const result = await runMainInRepo(repo, [
      "--planning-only",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--allow-non-git-planning/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main allows non-Git planning-only with explicit override", async () => {
  const repo = await createCliFixtureProject();
  try {
    const result = await runMainInRepo(repo, [
      "--planning-only",
      "--allow-non-git-planning",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /Warning: planning outside Git allowed by --allow-non-git-planning/);
    assert.match(result.stdout, /Git required: false/);
    assert.match(result.stdout, /Git root: unavailable/);
    assert.match(result.stdout, /Non-Git planning override: true/);

    const state = await readOnlyRunState(repo);
    assert.equal(state.git.required, false);
    assert.equal(state.git.root, null);
    assert.equal(state.git.startSha, null);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main dry-runs non-Git planning-only with explicit override", async () => {
  const repo = await createCliFixtureProject();
  try {
    const result = await runMainInRepo(repo, [
      "--dry-run",
      "--planning-only",
      "--allow-non-git-planning",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Mode: new/);
    assert.match(result.stdout, /Allowed: true/);
    assert.match(result.stdout, /Next action: run_planning_only/);
    assert.match(result.stdout, /Planning outside Git allowed by --allow-non-git-planning/);
    assert.match(result.stdout, /gitNonGitPlanningOverride: true/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main rejects runner override with resume", async () => {
  const repo = await createCliFixtureRepo();
  try {
    const result = await runMainInRepo(repo, [
      "--resume",
      "run-1",
      "--runner",
      "fake",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--runner cannot be combined with --resume/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main rejects non-fake runners for Milestone 7 execution", async () => {
  const repo = await createCliFixtureRepo({
    runner: {
      type: "codex-exec",
      command: process.execPath,
      options: {
        sandboxForPlanning: "read-only",
        sandboxForImplementation: "workspace-write",
        approvalPolicy: "never",
      },
    },
  });
  try {
    const result = await runMainInRepo(repo, [
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Milestone 7 execution currently requires --runner fake/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main allows non-fake runners in planning-only mode", async () => {
  const repo = await createCliFixtureRepo({
    runner: {
      type: "codex-exec",
      command: process.execPath,
      options: {
        sandboxForPlanning: "read-only",
        sandboxForImplementation: "workspace-write",
        approvalPolicy: "never",
      },
    },
  });
  try {
    const result = await runMainInRepo(repo, [
      "--planning-only",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(result.stderr, /requires --runner fake/);
    assert.match(result.stderr, /Runner phase major_plan failed with exit code 1/);

    const state = await readOnlyRunState(repo);
    assert.equal(state.currentPhase, "planning");
    assert.equal(state.status, "failed");
    assert.match(state.lastError?.message ?? "", /Runner phase major_plan failed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

interface MainResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runMainInRepo(repo: string, argv: string[]): Promise<MainResult> {
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];

  process.chdir(repo);
  console.log = (...values: unknown[]) => {
    stdout.push(values.map(String).join(" "));
  };
  console.error = (...values: unknown[]) => {
    stderr.push(values.map(String).join(" "));
  };

  try {
    const exitCode = await main(argv);
    return {
      exitCode,
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.chdir(previousCwd);
  }
}

type CliFixtureRunnerConfig =
  | { type: "fake" }
  | {
      type: "codex-exec";
      command: string;
      options: {
        sandboxForPlanning: "read-only" | "workspace-write" | "danger-full-access";
        sandboxForImplementation: "read-only" | "workspace-write" | "danger-full-access";
        approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
      };
    };

async function createCliFixtureRepo(
  options: { runner?: CliFixtureRunnerConfig; checks?: string[] } = {},
): Promise<string> {
  const repo = await createCliFixtureProject(options);

  await git(repo, ["init"]);
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Agent Orchestrator Test",
    "-c",
    "user.email=agent-orchestrator@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);

  return repo;
}

async function createCliFixtureProject(
  options: { runner?: CliFixtureRunnerConfig; checks?: string[] } = {},
): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-cli-"));
  await writeFile(path.join(repo, ".gitignore"), ".agent-work/\n", "utf8");
  await writeFile(path.join(repo, "README.md"), "# CLI Fixture\n", "utf8");
  await writeFile(
    path.join(repo, "orchestrator.config.json"),
    `${JSON.stringify(
      {
        checks: options.checks ?? [
          `${JSON.stringify(process.execPath)} -e "process.stdout.write('cli check ok')"`,
        ],
        runner: options.runner ?? { type: "fake" },
        maxFixAttempts: 0,
        artifactRoot: ".agent-work",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await cp(path.join(projectRoot, "src", "prompts"), path.join(repo, "src", "prompts"), {
    recursive: true,
  });
  await cp(path.join(projectRoot, "schemas"), path.join(repo, "schemas"), {
    recursive: true,
  });

  return repo;
}

async function readOnlyRunState(repo: string): Promise<RunState> {
  const runRoot = path.join(repo, ".agent-work");
  const runIds = await readdir(runRoot);
  assert.equal(runIds.length, 1);
  const raw = await readFile(path.join(runRoot, runIds[0] ?? "", "state.json"), "utf8");
  const state: unknown = JSON.parse(raw);
  assertRunStateShape(state);
  return state;
}

async function git(repo: string, args: string[]): Promise<void> {
  const result = await nodeCommandRunner.run({
    command: "git",
    args,
    cwd: repo,
  });

  assert.equal(
    result.exitCode,
    0,
    `git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}
