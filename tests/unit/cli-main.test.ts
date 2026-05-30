import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../../src/cli/main.js";
import type { OrchestratorConfig } from "../../src/config/config-types.js";
import { nodeCommandRunner } from "../../src/shell/command-runner.js";
import { writeState } from "../../src/state/state-store.js";
import type { RunState } from "../../src/state/state-types.js";
import {
  assertMilestoneMetadataArtifact,
  assertReviewVerdictArtifact,
  assertRunStateShape,
} from "../helpers/assertions.js";
import {
  createReadyForMilestoneRunFixture,
  createReadyForReviewRunFixture,
} from "../helpers/run-fixture.js";

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
    assert.match(result.stdout, /Mode: new/);
    assert.match(result.stdout, /Planning only: true/);
    assert.match(result.stdout, /Config source: config file/);
    assert.match(result.stdout, /Effective max fix attempts: 0/);
    assert.match(result.stdout, /Milestone plan policy: always/);
    assert.match(result.stdout, /Milestone plan review policy: normal/);
    assert.match(result.stdout, /Scrupulous review for next milestone: no \(policy normal\)/);
    assert.match(result.stdout, /State: ready_for_milestone/);
    assert.match(result.stdout, /Current milestone: 1/);
    assert.match(result.stdout, /Milestones:\n  1: pending\n  2: pending/);
    assert.match(result.stdout, /Timing timeline artifact: logs\/timeline\.jsonl/);
    assert.match(result.stdout, /Timing JSON artifact: logs\/80-timings\.json/);
    assert.match(result.stdout, /Timing Markdown artifact: logs\/81-timings\.md/);
    assert.match(result.stdout, /Lifecycle duration: /);
    assert.match(result.stdout, /Active workflow duration: /);
    assert.match(result.stdout, /Latest invocation duration: /);
    assert.match(result.stdout, /Runner duration: /);
    assert.match(result.stdout, /Check duration: /);
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

test("main stores config CLI overrides in new run state", async () => {
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
      "--milestone-plan-policy",
      "light",
      "--milestone-plan-review-policy",
      "scrupulous",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Effective max fix attempts: 2/);
    assert.match(result.stdout, /Milestone plan policy: light/);
    assert.match(result.stdout, /Milestone plan review policy: scrupulous/);
    assert.match(result.stdout, /Human review policy: stop/);
    assert.match(result.stdout, /Scrupulous review for next milestone: no \(planning only\)/);

    const state = await readOnlyRunState(repo);
    assert.equal(state.config.snapshot?.maxFixAttempts, 2);
    assert.equal(state.config.snapshot?.milestonePlanPolicy, "light");
    assert.equal(state.config.snapshot?.milestonePlanReviewPolicy, "scrupulous");
    assert.equal(state.config.snapshot?.humanReviewPolicy, "stop");
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
    assert.match(result.stdout, /Milestone Runner dry run/);
    assert.match(result.stdout, /Mode: new/);
    assert.match(result.stdout, /Allowed: true/);
    assert.match(result.stdout, /Next action: run_full_goal/);
    assert.match(result.stdout, /invocationCwd: /);
    assert.match(result.stdout, /targetCwd: /);
    assert.match(result.stdout, /goalSource: argv/);
    assert.match(result.stdout, /contextInputs: none/);
    assert.match(result.stdout, /runner: fake/);
    assert.match(result.stdout, /maxFixAttempts: 0/);
    assert.match(result.stdout, /milestonePlanPolicy: always/);
    assert.match(result.stdout, /milestonePlanReviewPolicy: normal/);
    assert.match(result.stdout, /humanReviewPolicy: stop/);
    assert.match(result.stdout, /scrupulousReviewForNextMilestone: no \(policy normal\)/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main prints machine-readable dry-run JSON", async () => {
  const repo = await createCliFixtureRepo();
  try {
    const result = await runMainInRepo(repo, [
      "--dry-run",
      "--json",
      "--run-id",
      "run-dashboard-test",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout) as {
      allowed: boolean;
      exitCode: number;
      nextAction: string;
      runId: string;
      runDir: string;
      details: { runner: string; runId: string; runDir: string };
    };
    assert.equal(report.allowed, true);
    assert.equal(report.exitCode, 0);
    assert.equal(report.nextAction, "run_full_goal");
    assert.equal(report.runId, "run-dashboard-test");
    assert.equal(report.details.runner, "fake");
    assert.equal(report.details.runId, "run-dashboard-test");
    assert.equal(
      report.runDir,
      path.join(await realpath(repo), ".agent-work", "run-dashboard-test"),
    );
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main dry-run JSON reports target repo and initial inputs", async () => {
  const invocationDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-invocation-"));
  const targetRepo = await createCliFixtureRepo({ copyResources: false });
  try {
    await mkdir(path.join(targetRepo, "docs"), { recursive: true });
    await writeFile(
      path.join(targetRepo, "docs", "task.md"),
      "Implement task from a file.\n",
      "utf8",
    );
    await writeFile(
      path.join(targetRepo, "docs", "architecture.md"),
      "# Architecture\n",
      "utf8",
    );
    await writeFile(
      path.join(targetRepo, "docs", "major-plan.md"),
      "# Seeded Major Plan\n",
      "utf8",
    );
    await git(targetRepo, [
      "add",
      "docs/task.md",
      "docs/architecture.md",
      "docs/major-plan.md",
    ]);
    await git(targetRepo, [
      "-c",
      "user.name=Agent Orchestrator Test",
      "-c",
      "user.email=milestone-runner@example.invalid",
      "commit",
      "-m",
      "add input docs",
    ]);

    const result = await runMainInRepo(invocationDir, [
      "--repo",
      targetRepo,
      "--dry-run",
      "--json",
      "--run-id",
      "run-input-dry-run",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "--goal-file",
      "docs/task.md",
      "--seed-major-plan",
      "docs/major-plan.md",
      "--context",
      "README.md",
      "--context",
      "docs/architecture.md",
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout) as {
      nextAction: string;
      details: {
        invocationCwd: string;
        targetCwd: string;
        goalSource: string;
        majorPlanSource: { type: string; path: string | null };
        contextInputs: string;
        runDir: string;
      };
    };
    assert.equal(report.details.invocationCwd, await realpath(invocationDir));
    assert.equal(report.details.targetCwd, await realpath(targetRepo));
    assert.equal(report.details.goalSource, "file:docs/task.md");
    assert.equal(report.nextAction, "review_seeded_major_plan");
    assert.deepEqual(report.details.majorPlanSource, {
      type: "seed",
      path: "docs/major-plan.md",
    });
    assert.equal(report.details.contextInputs, "README.md, docs/architecture.md");
    assert.equal(
      report.details.runDir,
      path.join(await realpath(targetRepo), ".agent-work", "run-input-dry-run"),
    );
    await assert.rejects(() => readdir(path.join(targetRepo, ".agent-work")), /ENOENT/);
    await assert.rejects(() => readdir(path.join(invocationDir, ".agent-work")), /ENOENT/);
  } finally {
    await rm(targetRepo, { recursive: true, force: true });
    await rm(invocationDir, { recursive: true, force: true });
  }
});

test("main prints machine-readable final run JSON with an explicit run id", async () => {
  const repo = await createCliFixtureRepo();
  try {
    const result = await runMainInRepo(repo, [
      "--json",
      "--run-id",
      "run-dashboard-real",
      "--planning-only",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);
    const report = JSON.parse(result.stdout) as {
      allowed: boolean;
      exitCode: number;
      runId: string;
      runDir: string;
      details: {
        state: string;
        status: string;
        currentMilestone: number;
      };
    };
    assert.equal(report.allowed, true);
    assert.equal(report.exitCode, 0);
    assert.equal(report.runId, "run-dashboard-real");
    assert.equal(
      report.runDir,
      path.join(await realpath(repo), ".agent-work", "run-dashboard-real"),
    );
    assert.equal(report.details.state, "ready_for_milestone");
    assert.equal(report.details.status, "ready_for_milestone");
    assert.equal(report.details.currentMilestone, 1);
    const state = JSON.parse(
      await readFile(path.join(report.runDir, "state.json"), "utf8"),
    ) as RunState;
    assert.equal(state.runId, "run-dashboard-real");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main targets a separate repo without requiring bundled resources in the target", async () => {
  const invocationDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-invocation-"));
  const targetRepo = await createCliFixtureRepo({ copyResources: false });
  try {
    await assert.rejects(
      () => readdir(path.join(targetRepo, "src", "prompts")),
      /ENOENT/,
    );
    await assert.rejects(
      () => readdir(path.join(targetRepo, "schemas")),
      /ENOENT/,
    );

    const result = await runMainInRepo(invocationDir, [
      "--repo",
      targetRepo,
      "--planning-only",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Mode: new/);
    assert.match(result.stdout, /Planning only: true/);

    const state = await readOnlyRunState(targetRepo) as RunState & {
      workspace?: { invocationCwd: string; targetCwd: string };
    };
    assert.equal(state.workspace?.targetCwd, await realpath(targetRepo));
    assert.equal(state.workspace?.invocationCwd, await realpath(invocationDir));
    await assert.rejects(
      () => readdir(path.join(invocationDir, ".agent-work")),
      /ENOENT/,
    );
  } finally {
    await rm(targetRepo, { recursive: true, force: true });
    await rm(invocationDir, { recursive: true, force: true });
  }
});

test("main records goal-file and context inputs as run artifacts", async () => {
  const invocationDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-invocation-"));
  const targetRepo = await createCliFixtureRepo({ copyResources: false });
  try {
    await mkdir(path.join(targetRepo, "docs"), { recursive: true });
    await writeFile(
      path.join(targetRepo, "docs", "task.md"),
      "Implement task from a file.\n",
      "utf8",
    );
    await writeFile(
      path.join(targetRepo, "docs", "architecture.md"),
      "# Architecture\n",
      "utf8",
    );
    await git(targetRepo, ["add", "docs/task.md", "docs/architecture.md"]);
    await git(targetRepo, [
      "-c",
      "user.name=Agent Orchestrator Test",
      "-c",
      "user.email=milestone-runner@example.invalid",
      "commit",
      "-m",
      "add input docs",
    ]);

    const result = await runMainInRepo(invocationDir, [
      "--repo",
      targetRepo,
      "--planning-only",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "--goal-file",
      "docs/task.md",
      "--context",
      "README.md",
      "--context",
      "docs/architecture.md",
    ]);

    assert.equal(result.exitCode, 0);
    const state = await readOnlyRunState(targetRepo) as RunState & {
      inputs?: {
        goalSource: { type: string; path: string | null };
        context: Array<{ path: string; artifactPath: string; sha256: string }>;
      };
      artifacts: RunState["artifacts"] & {
        inputs?: { manifest: string; context?: Record<string, string> };
      };
    };
    assert.equal(state.goal, "Implement task from a file.\n");
    assert.equal(state.inputs?.goalSource.type, "file");
    assert.equal(state.inputs?.goalSource.path, "docs/task.md");
    assert.deepEqual(
      state.inputs?.context.map((entry) => entry.path),
      ["README.md", "docs/architecture.md"],
    );
    assert.equal(state.artifacts.inputs?.manifest, path.join("inputs", "01-inputs.json"));
    const manifest = JSON.parse(
      await readFile(
        path.join(state.runDir, state.artifacts.inputs?.manifest ?? ""),
        "utf8",
      ),
    ) as { context: Array<{ path: string }> };
    assert.deepEqual(
      manifest.context.map((entry) => entry.path),
      ["README.md", "docs/architecture.md"],
    );
  } finally {
    await rm(targetRepo, { recursive: true, force: true });
    await rm(invocationDir, { recursive: true, force: true });
  }
});

test("main uses a seeded major plan in planning-only runs", async () => {
  const repo = await createCliFixtureRepo();
  const seedText = "# Operator Major Plan\n\nUse this prepared plan.";
  try {
    await mkdir(path.join(repo, "docs"), { recursive: true });
    await writeFile(path.join(repo, "docs", "major-plan.md"), seedText, "utf8");
    await git(repo, ["add", "docs/major-plan.md"]);
    await git(repo, [
      "-c",
      "user.name=Agent Orchestrator Test",
      "-c",
      "user.email=milestone-runner@example.invalid",
      "commit",
      "-m",
      "add seeded major plan",
    ]);

    const result = await runMainInRepo(repo, [
      "--planning-only",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "--seed-major-plan",
      "docs/major-plan.md",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Major plan source: seeded from docs\/major-plan\.md/);

    const state = await readOnlyRunState(repo);
    assert.equal(state.currentPhase, "ready_for_milestone");
    assert.equal(state.inputs?.majorPlanSource?.type, "seed");
    assert.equal(state.inputs?.majorPlanSource?.path, "docs/major-plan.md");
    assert.equal(state.inputs?.majorPlanSource?.sizeBytes, Buffer.byteLength(seedText));
    assert.equal(typeof state.inputs?.majorPlanSource?.sha256, "string");
    assert.equal(state.artifacts.majorPlan, path.join("plans", "01-major-plan.md"));
    assert.equal(
      await readFile(path.join(state.runDir, state.artifacts.majorPlan ?? ""), "utf8"),
      `${seedText}\n`,
    );
    assert.doesNotMatch(
      await readFile(path.join(state.runDir, state.artifacts.majorPlan ?? ""), "utf8"),
      /# Fake Major Plan/,
    );

    const manifest = JSON.parse(
      await readFile(path.join(state.runDir, state.artifacts.inputs?.manifest ?? ""), "utf8"),
    ) as {
      majorPlanSource?: {
        type: string;
        path: string;
        sizeBytes: number;
        sha256: string;
      };
    };
    assert.deepEqual(manifest.majorPlanSource, {
      type: "seed",
      path: "docs/major-plan.md",
      sizeBytes: Buffer.byteLength(seedText),
      sha256: state.inputs?.majorPlanSource?.sha256,
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main uses a seeded major plan in full fake runs", async () => {
  const repo = await createCliFixtureRepo();
  const seedText = "# Operator Full Run Plan\n\nUse this prepared plan.";
  try {
    await mkdir(path.join(repo, "docs"), { recursive: true });
    await writeFile(path.join(repo, "docs", "major-plan.md"), seedText, "utf8");
    await git(repo, ["add", "docs/major-plan.md"]);
    await git(repo, [
      "-c",
      "user.name=Agent Orchestrator Test",
      "-c",
      "user.email=milestone-runner@example.invalid",
      "commit",
      "-m",
      "add seeded major plan",
    ]);

    const result = await runMainInRepo(repo, [
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "--seed-major-plan",
      "docs/major-plan.md",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Planning only: false/);
    assert.match(result.stdout, /State: passed/);

    const state = await readOnlyRunState(repo);
    assert.equal(state.currentPhase, "passed");
    assert.equal(state.inputs?.majorPlanSource?.type, "seed");
    assert.equal(
      await readFile(path.join(state.runDir, state.artifacts.majorPlan ?? ""), "utf8"),
      `${seedText}\n`,
    );
    assert.match(
      await readFile(path.join(repo, "fake-milestone-1-implementation.txt"), "utf8"),
      /Fake milestone implementation/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main rejects invalid seed major plans before creating run artifacts", async () => {
  const repo = await createCliFixtureRepo();
  try {
    await mkdir(path.join(repo, "docs"), { recursive: true });
    await writeFile(path.join(repo, "docs", "empty-major-plan.md"), " \n", "utf8");

    const result = await runMainInRepo(repo, [
      "--planning-only",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "--seed-major-plan",
      "docs/empty-major-plan.md",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Seed major plan file must not be empty/);
    assert.equal(result.stdout, "");
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main rejects invalid UTF-8 goal files before creating run artifacts", async () => {
  const repo = await createCliFixtureRepo();
  try {
    await mkdir(path.join(repo, "docs"), { recursive: true });
    await writeFile(path.join(repo, "docs", "invalid-goal.md"), Buffer.from([0xff]));

    const result = await runMainInRepo(repo, [
      "--planning-only",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "--goal-file",
      "docs/invalid-goal.md",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Goal file must be valid UTF-8/);
    assert.equal(result.stdout, "");
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main rejects unsafe artifact roots before creating run artifacts", async () => {
  for (const artifactRoot of ["/tmp/milestone-runner-outside", "../outside", "."]) {
    const repo = await createCliFixtureRepo();
    try {
      const result = await runMainInRepo(repo, [
        "--dry-run",
        "--runner",
        "fake",
        "--config",
        "orchestrator.config.json",
        "--artifact-root",
        artifactRoot,
        "Add feature X",
      ]);

      assert.equal(result.exitCode, 1);
      assert.match(`${result.stdout}\n${result.stderr}`, /artifactRoot|artifact root/i);
      await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }
});

test("main rejects symlink artifact roots before creating run artifacts", async () => {
  const repo = await createCliFixtureRepo();
  const outside = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-outside-"));
  try {
    await symlink(outside, path.join(repo, ".agent-work"));

    const result = await runMainInRepo(repo, [
      "--planning-only",
      "--allow-non-git-planning",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /symbolic link/i);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("main rejects sibling-prefix goal and context paths before runner calls", async () => {
  const invocationDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-invocation-"));
  const targetRepo = await createCliFixtureRepo({ copyResources: false });
  const siblingDir = `${targetRepo}-other`;
  try {
    await mkdir(siblingDir, { recursive: true });
    await writeFile(path.join(siblingDir, "task.md"), "outside goal\n", "utf8");
    await writeFile(path.join(siblingDir, "context.md"), "outside context\n", "utf8");

    const escapedGoal = path.relative(targetRepo, path.join(siblingDir, "task.md"));
    const escapedContext = path.relative(targetRepo, path.join(siblingDir, "context.md"));
    const result = await runMainInRepo(invocationDir, [
      "--repo",
      targetRepo,
      "--planning-only",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "--goal-file",
      escapedGoal,
      "--context",
      escapedContext,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /outside the target|inside the target|escapes/i);
    await assert.rejects(() => readdir(path.join(targetRepo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(siblingDir, { recursive: true, force: true });
    await rm(targetRepo, { recursive: true, force: true });
    await rm(invocationDir, { recursive: true, force: true });
  }
});

test("main dry-runs explicit milestone plan policies", async () => {
  for (const policy of ["light", "auto"] as const) {
    const repo = await createCliFixtureRepo();
    try {
      const result = await runMainInRepo(repo, [
        "--dry-run",
        "--runner",
        "fake",
        "--config",
        "orchestrator.config.json",
        "--milestone-plan-policy",
        policy,
        "Add feature X",
      ]);

      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, new RegExp(`milestonePlanPolicy: ${policy}`));
      await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }
});

test("main dry-runs explicit milestone plan review policy", async () => {
  const repo = await createCliFixtureRepo();
  try {
    const result = await runMainInRepo(repo, [
      "--dry-run",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "--milestone-plan-review-policy",
      "scrupulous",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /milestonePlanReviewPolicy: scrupulous/);
    assert.match(result.stdout, /scrupulousReviewForNextMilestone: yes \(after planning\)/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main dry-runs codex-exec execution without creating a run directory", async () => {
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

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Mode: new/);
    assert.match(result.stdout, /Allowed: true/);
    assert.match(result.stdout, /Next action: run_full_goal/);
    assert.match(result.stdout, /runner: codex-exec/);
    assert.match(result.stdout, /runnerExecution: codex exec via /);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main dry-runs blocked codex-exec execution without creating a run directory", async () => {
  const repo = await createCliFixtureRepo({
    runner: {
      type: "codex-exec",
      command: "milestone-runner-missing-codex",
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
    assert.match(result.stdout, /Next action: blocked_missing_tool/);
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
      command: "milestone-runner-missing-codex",
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
    assert.match(result.stdout, /milestone-runner-missing-codex --version/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main rejects missing codex-exec runner command before creating a run directory", async () => {
  const repo = await createCliFixtureRepo({
    runner: {
      type: "codex-exec",
      command: "milestone-runner-missing-codex",
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
    assert.equal(plannedState.artifacts.logs?.timingsJson, path.join("logs", "80-timings.json"));
    const plannedTimings = await readTimingJson(plannedState);
    assert.equal(plannedTimings.invocations.length, 1);

    const resumeResult = await runMainInRepo(repo, [
      "--resume",
      plannedState.runDir,
    ]);

    assert.equal(resumeResult.exitCode, 0);
    assert.match(resumeResult.stdout, /Mode: resume/);
    assert.match(resumeResult.stdout, /Config source: state snapshot/);
    assert.match(resumeResult.stdout, /State before resume: ready_for_milestone/);
    assert.match(resumeResult.stdout, /State: passed/);
    assert.match(resumeResult.stdout, /Current milestone: none/);
    assert.match(resumeResult.stdout, /Milestones:\n  1: passed\n  2: passed/);

    const finalState = await readOnlyRunState(repo);
    assert.equal(finalState.currentPhase, "passed");
    assert.equal(finalState.currentMilestoneId, null);
    assert.equal(finalState.artifacts.summaries?.goal, path.join("milestones", "90-goal-summary.md"));
    assert.equal(finalState.artifacts.logs?.timingsJson, plannedState.artifacts.logs?.timingsJson);
    assert.equal(finalState.artifacts.logs?.timingsMarkdown, path.join("logs", "81-timings.md"));
    const finalTimings = await readTimingJson(finalState);
    assert.equal(finalTimings.runId, plannedState.runId);
    assert.equal(finalTimings.invocations.length, 2);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main reports resume max fix attempts override without mutating saved snapshot", async () => {
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
    assert.equal(plannedState.config.snapshot?.maxFixAttempts, 0);
    assert.equal(plannedState.config.snapshot?.milestonePlanPolicy, "always");
    assert.equal(plannedState.config.snapshot?.milestonePlanReviewPolicy, "normal");
    assert.equal(plannedState.config.snapshot?.humanReviewPolicy, "stop");

    const resumeResult = await runMainInRepo(repo, [
      "--resume",
      plannedState.runDir,
      "--max-fix-attempts",
      "2",
      "--milestone-plan-policy",
      "auto",
      "--milestone-plan-review-policy",
      "scrupulous",
    ]);

    assert.equal(resumeResult.exitCode, 0);
    assert.match(resumeResult.stdout, /Mode: resume/);
    assert.match(resumeResult.stdout, /Effective max fix attempts: 2/);
    assert.match(resumeResult.stdout, /Saved max fix attempts: 0/);
    assert.match(resumeResult.stdout, /Milestone plan policy: auto/);
    assert.match(resumeResult.stdout, /Saved milestone plan policy: always/);
    assert.match(resumeResult.stdout, /Milestone plan review policy: scrupulous/);
    assert.match(resumeResult.stdout, /Saved milestone plan review policy: normal/);
    assert.match(resumeResult.stdout, /Human review policy: stop/);
    assert.match(
      resumeResult.stdout,
      /Scrupulous review for next milestone: no \(no runnable milestone\)/,
    );

    const finalState = await readOnlyRunState(repo);
    assert.equal(finalState.currentPhase, "passed");
    assert.equal(finalState.config.snapshot?.maxFixAttempts, 0);
    assert.equal(finalState.config.snapshot?.milestonePlanPolicy, "always");
    assert.equal(finalState.config.snapshot?.milestonePlanReviewPolicy, "normal");
    assert.equal(finalState.config.snapshot?.humanReviewPolicy, "stop");
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
      "--milestone-plan-policy",
      "auto",
      "--milestone-plan-review-policy",
      "scrupulous",
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Milestone Runner dry run/);
    assert.match(result.stdout, /Mode: resume/);
    assert.match(result.stdout, /Allowed: true/);
    assert.match(result.stdout, /Next action: continue_milestone/);
    assert.match(result.stdout, /milestonePlanPolicy: auto/);
    assert.match(result.stdout, /savedMilestonePlanPolicy: always/);
    assert.match(result.stdout, /milestonePlanReviewPolicy: scrupulous/);
    assert.match(result.stdout, /savedMilestonePlanReviewPolicy: normal/);
    assert.match(result.stdout, /humanReviewPolicy: stop/);
    assert.match(result.stdout, /savedHumanReviewPolicy: stop/);
    assert.match(result.stdout, /scrupulousReviewForNextMilestone: yes/);

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
    assert.match(result.stdout, /Mode: new/);
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
      "1-evidence": path.join("reviews", "19-milestone-1-review-evidence.md"),
      "1": path.join("reviews", "20-milestone-1-review.json"),
      "2-evidence": path.join("reviews", "19-milestone-2-review-evidence.md"),
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
    assert.match(
      await readFile(path.join(runDir, state.artifacts.reviews?.["1-evidence"] ?? ""), "utf8"),
      /^# Milestone 1 Review Evidence/,
    );
    const review2 = await assertReviewVerdictArtifact(
      path.join(runDir, state.artifacts.reviews?.["2"] ?? ""),
    );
    assert.equal(review2.verdict, "pass");
    assert.match(
      await readFile(path.join(runDir, state.artifacts.reviews?.["2-evidence"] ?? ""), "utf8"),
      /^# Milestone 2 Review Evidence/,
    );
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
    assert.match(result.stdout, /Target milestone 1 stopped before goal completion\./);
    assert.match(result.stdout, /Pending milestones remain: 2\./);
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
    assert.match(result.stdout, /Last error: Checks failed for milestone 1\./);
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

test("main reaches codex-exec runner for implementation-capable execution", async () => {
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
    assert.doesNotMatch(result.stderr, /requires --runner fake/);
    assert.match(result.stderr, /Runner phase major_plan failed with exit code 1/);

    const state = await readOnlyRunState(repo);
    assert.equal(state.currentPhase, "planning");
    assert.equal(state.status, "failed");
    assert.match(state.lastError?.message ?? "", /Runner phase major_plan failed/);
    assert.equal(state.artifacts.logs?.run, path.join("logs", "run.log"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main resumes codex-exec implementation-capable runs through the adapter", async () => {
  const runner: CliFixtureRunnerConfig = {
    type: "codex-exec",
    command: process.execPath,
    options: {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "never",
    },
  };
  const repo = await createCliFixtureRepo({ runner });
  try {
    await createReadyForMilestoneRunFixture({
      cwd: repo,
      startSha: await gitOutput(repo, ["rev-parse", "HEAD"]),
      config: {
        checks: [`${JSON.stringify(process.execPath)} -e "process.stdout.write('cli check ok')"`],
        runner,
        maxFixAttempts: 0,
        artifactRoot: ".agent-work",
        milestonePlanPolicy: "always",
        milestonePlanReviewPolicy: "normal",
        humanReviewPolicy: "stop",
      },
      configPath: path.join(repo, "orchestrator.config.json"),
    });

    const dryRun = await runMainInRepo(repo, [
      "--dry-run",
      "--resume",
      "run-1",
    ]);
    assert.equal(dryRun.exitCode, 0);
    assert.equal(dryRun.stderr, "");
    assert.match(dryRun.stdout, /Allowed: true/);
    assert.match(dryRun.stdout, /Next action: continue_milestone/);
    assert.match(dryRun.stdout, /runnerExecution: codex exec via /);

    const result = await runMainInRepo(repo, [
      "--resume",
      "run-1",
    ]);

    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(result.stderr, /requires a fake runner/);
    assert.match(result.stderr, /Runner phase milestone_plan failed with exit code 1/);
    assert.match(result.stdout, /Mode: resume/);
    assert.match(result.stdout, /State before resume: ready_for_milestone/);

    const state = await readOnlyRunState(repo);
    assert.equal(state.currentPhase, "implementing");
    assert.equal(state.status, "failed");
    assert.match(state.lastError?.message ?? "", /milestone_plan failed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main exits non-zero when autonomous review resolution is exhausted", async () => {
  const toolDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-cli-codex-"));
  const fakeCodexPath = path.join(toolDir, "fake-codex.cjs");
  const runner: CliFixtureRunnerConfig = {
    type: "codex-exec",
    command: fakeCodexPath,
    options: {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "never",
      timeoutMs: 10000,
    },
  };
  const checks = [
    `${JSON.stringify(process.execPath)} -e "process.stdout.write('cli check ok')"`,
  ];
  const config: OrchestratorConfig = {
    checks,
    runner,
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    milestonePlanPolicy: "always",
    milestonePlanReviewPolicy: "normal",
    humanReviewPolicy: "autonomous",
  };
  const repo = await createCliFixtureRepo({
    runner,
    checks,
    humanReviewPolicy: "autonomous",
    copyResources: false,
  });

  try {
    await installAutonomousReviewFakeCodex(fakeCodexPath);
    const repoPath = await realpath(repo);
    await createReadyForReviewRunFixture({
      cwd: repoPath,
      startSha: await gitOutput(repoPath, ["rev-parse", "HEAD"]),
      config,
      configPath: path.join(repoPath, "orchestrator.config.json"),
    });

    const result = await runMainInRepo(repoPath, [
      "--resume",
      "run-1",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Review ambiguity resolution failed after 2 attempt\(s\)\./);
    assert.match(result.stdout, /Mode: resume/);
    assert.match(result.stdout, /State: failed/);
    assert.match(result.stdout, /Human review policy: autonomous/);

    const state = await readOnlyRunState(repoPath);
    assert.equal(state.currentPhase, "failed");
    assert.equal(state.status, "failed");
    assert.equal(state.milestoneStatuses["1"], "failed");
    assert.equal(state.artifacts.summaries?.goal, path.join("milestones", "90-goal-summary.md"));
    assert.equal(
      state.artifacts.reviews?.["1-resolution-2"],
      path.join("reviews", "22-milestone-1-autonomous-resolution-2.json"),
    );

    const runDir = path.join(repoPath, ".agent-work", state.runId);
    const reviewSummary = await readFile(
      path.join(runDir, "milestones", "25-milestone-1-review-summary.md"),
      "utf8",
    );
    assert.match(reviewSummary, /Status: failed/);
    const goalSummary = await readFile(
      path.join(runDir, state.artifacts.summaries?.goal ?? ""),
      "utf8",
    );
    assert.match(goalSummary, /Status: failed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(toolDir, { recursive: true, force: true });
  }
});

test("main exits non-zero when autonomous resume resolution is exhausted", async () => {
  const toolDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-cli-codex-"));
  const fakeCodexPath = path.join(toolDir, "fake-codex.cjs");
  const runner: CliFixtureRunnerConfig = {
    type: "codex-exec",
    command: fakeCodexPath,
    options: {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "never",
      timeoutMs: 10000,
    },
  };
  const checks = [
    `${JSON.stringify(process.execPath)} -e "process.stdout.write('cli check ok')"`,
  ];
  const config: OrchestratorConfig = {
    checks,
    runner,
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    milestonePlanPolicy: "always",
    milestonePlanReviewPolicy: "normal",
    humanReviewPolicy: "autonomous",
  };
  const repo = await createCliFixtureRepo({
    runner,
    checks,
    humanReviewPolicy: "autonomous",
    copyResources: false,
  });

  try {
    await installAutonomousReviewFakeCodex(fakeCodexPath);
    const repoPath = await realpath(repo);
    const fixture = await createReadyForReviewRunFixture({
      cwd: repoPath,
      startSha: await gitOutput(repoPath, ["rev-parse", "HEAD"]),
      config,
      configPath: path.join(repoPath, "orchestrator.config.json"),
    });
    const ambiguousState: RunState = {
      ...fixture.state,
      milestoneStatuses: {
        "1": "planned",
        "2": "pending",
      },
      updatedAt: "2026-05-10T12:00:20.000Z",
    };
    await writeState(fixture.paths.files.state, ambiguousState);

    const result = await runMainInRepo(repoPath, [
      "--resume",
      "run-1",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Resume state resolution failed after 2 attempt\(s\)\./);
    assert.match(result.stdout, /Mode: resume/);
    assert.match(result.stdout, /State: failed/);
    assert.match(result.stdout, /Human review policy: autonomous/);

    const state = await readOnlyRunState(repoPath);
    assert.equal(state.currentPhase, "failed");
    assert.equal(state.status, "failed");
    assert.equal(state.milestoneStatuses["1"], "failed");
    assert.equal(
      state.artifacts.logs?.["resume-resolution-2"],
      path.join("logs", "resolve-resume-state-2.json"),
    );
    assert.equal(state.artifacts.summaries?.goal, path.join("milestones", "90-goal-summary.md"));

    const goalSummary = await readFile(
      path.join(repoPath, ".agent-work", state.runId, state.artifacts.summaries?.goal ?? ""),
      "utf8",
    );
    assert.match(goalSummary, /Status: failed/);
    assert.match(goalSummary, /Resume state resolution failed after 2 attempt\(s\)\./);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(toolDir, { recursive: true, force: true });
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

async function installAutonomousReviewFakeCodex(filePath: string): Promise<void> {
  await writeFile(filePath, autonomousReviewFakeCodexSource(), "utf8");
  await chmod(filePath, 0o755);
}

function autonomousReviewFakeCodexSource(): string {
  return String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.0.0\n");
  process.exit(0);
}

const args = process.argv.slice(2);
const fail = (message) => {
  process.stderr.write(message + "\n");
  process.exit(1);
};
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args[0] !== "exec") fail("expected codex exec");
const outputLastMessage = valueAfter("--output-last-message");
if (!outputLastMessage) fail("missing --output-last-message");
const outputSchema = valueAfter("--output-schema");
if (!outputSchema) fail("missing --output-schema");

const schemaName = path.basename(outputSchema);
if (schemaName === "review-verdict.schema.json") {
  fs.writeFileSync(outputLastMessage, JSON.stringify({
    verdict: "needs_human_review",
    summary: "The implementation depends on a manual product decision.",
    findings: [],
    reviewedArtifacts: [
      "diffs/12-milestone-1.diff",
      "checks/13-milestone-1-checks.txt"
    ]
  }, null, 2));
  process.exit(0);
}

if (schemaName === "review-resolution.schema.json") {
  fs.writeFileSync(outputLastMessage, JSON.stringify({
    resolution: {
      summary: "Could not resolve review ambiguity autonomously.",
      rationale: "The fake codex keeps the ambiguity unresolved.",
      assumptions: [],
      sourceCondition: "explicit_needs_human_review"
    },
    verdict: {
      verdict: "needs_human_review",
      summary: "The resolver still cannot decide.",
      findings: [],
      reviewedArtifacts: [
        "reviews/20-milestone-1-review.json",
        "diffs/12-milestone-1.diff",
        "checks/13-milestone-1-checks.txt"
      ]
    }
  }, null, 2));
  process.exit(0);
}

if (schemaName === "resume-resolution.schema.json") {
  fs.writeFileSync(outputLastMessage, JSON.stringify({
    action: "normalize_to_passed",
    summary: "Incorrectly normalize milestone 1 to passed.",
    rationale: "The fake codex keeps choosing an invalid resume action.",
    assumptions: [],
    currentMilestoneId: 1
  }, null, 2));
  process.exit(0);
}

fail("unexpected schema " + schemaName);
`;
}

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
        approvalPolicy: "never" | "on-request" | "untrusted";
        timeoutMs?: number;
      };
    };

async function createCliFixtureRepo(
  options: {
    runner?: CliFixtureRunnerConfig;
    checks?: string[];
    copyResources?: boolean;
    humanReviewPolicy?: "stop" | "fail" | "autonomous";
  } = {},
): Promise<string> {
  const repo = await createCliFixtureProject(options);

  await git(repo, ["init"]);
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Agent Orchestrator Test",
    "-c",
    "user.email=milestone-runner@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);

  return repo;
}

async function createCliFixtureProject(
  options: {
    runner?: CliFixtureRunnerConfig;
    checks?: string[];
    copyResources?: boolean;
    humanReviewPolicy?: "stop" | "fail" | "autonomous";
  } = {},
): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-cli-"));
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
        ...(options.humanReviewPolicy === undefined
          ? {}
          : { humanReviewPolicy: options.humanReviewPolicy }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (options.copyResources !== false) {
    await cp(path.join(projectRoot, "src", "prompts"), path.join(repo, "src", "prompts"), {
      recursive: true,
    });
    await cp(path.join(projectRoot, "schemas"), path.join(repo, "schemas"), {
      recursive: true,
    });
  }

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

async function readTimingJson(state: RunState): Promise<{
  runId?: string;
  invocations: unknown[];
}> {
  const timingPath = state.artifacts.logs?.timingsJson;
  assert.equal(typeof timingPath, "string");
  const parsed = JSON.parse(
    await readFile(path.join(state.runDir, timingPath ?? ""), "utf8"),
  ) as {
    runId?: string;
    invocations?: unknown;
  };

  assert.ok(Array.isArray(parsed.invocations));
  return {
    runId: parsed.runId,
    invocations: parsed.invocations,
  };
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

async function gitOutput(repo: string, args: string[]): Promise<string> {
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
  return result.stdout.trim();
}
