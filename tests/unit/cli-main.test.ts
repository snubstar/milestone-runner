import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../../src/cli/main.js";
import { nodeCommandRunner } from "../../src/shell/command-runner.js";
import type { RunState } from "../../src/state/state-types.js";

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

test("main runs one fake milestone through review when planning-only is not set", async () => {
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
    assert.match(result.stdout, /Diff artifact: diffs\/12-milestone-1\.diff/);
    assert.match(result.stdout, /Checks artifact: checks\/13-milestone-1-checks\.txt/);
    assert.match(result.stdout, /Review artifact: reviews\/20-milestone-1-review\.json/);
    assert.match(result.stdout, /Fix attempts: 0/);
    assert.match(result.stdout, /Latest diff artifact: diffs\/12-milestone-1\.diff/);
    assert.match(result.stdout, /Latest checks artifact: checks\/13-milestone-1-checks\.txt/);
    assert.match(result.stdout, /Summary artifact: milestones\/25-milestone-1-review-summary\.md/);

    const state = await readOnlyRunState(repo);
    assert.equal(state.currentPhase, "passed");
    assert.deepEqual(state.milestoneStatuses, {
      "1": "passed",
      "2": "pending",
    });
    assert.deepEqual(state.artifacts.reviews, {
      "1": path.join("reviews", "20-milestone-1-review.json"),
    });
    assert.deepEqual(state.artifacts.summaries, {
      "1": path.join("milestones", "14-milestone-1-summary.md"),
      "1-review": path.join("milestones", "25-milestone-1-review-summary.md"),
    });
    assert.match(
      await readFile(path.join(repo, "fake-milestone-1-implementation.txt"), "utf8"),
      /Milestone: 1/,
    );
    const review = JSON.parse(
      await readFile(
        path.join(repo, ".agent-work", state.runId, "reviews", "20-milestone-1-review.json"),
        "utf8",
      ),
    );
    assert.equal(review.verdict, "pass");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main rejects --allow-dirty outside planning-only mode in Milestone 5", async () => {
  const repo = await createCliFixtureRepo();
  try {
    const result = await runMainInRepo(repo, [
      "--allow-dirty",
      "--runner",
      "fake",
      "--config",
      "orchestrator.config.json",
      "Add feature X",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--allow-dirty is only supported with --planning-only/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main rejects non-fake runners for Milestone 5 execution", async () => {
  const repo = await createCliFixtureRepo({
    runner: {
      type: "codex-exec",
      command: "codex",
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
    assert.match(result.stderr, /Milestone 5 prototype execution currently requires --runner fake/);
    await assert.rejects(() => readdir(path.join(repo, ".agent-work")), /ENOENT/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("main allows non-fake runners in planning-only mode", async () => {
  const repo = await createCliFixtureRepo({
    runner: {
      type: "codex-exec",
      command: "codex",
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
  options: { runner?: CliFixtureRunnerConfig } = {},
): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-cli-"));
  await writeFile(path.join(repo, ".gitignore"), ".agent-work/\n", "utf8");
  await writeFile(path.join(repo, "README.md"), "# CLI Fixture\n", "utf8");
  await writeFile(
    path.join(repo, "orchestrator.config.json"),
    `${JSON.stringify(
      {
        checks: [`${JSON.stringify(process.execPath)} -e "process.stdout.write('cli check ok')"`],
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

async function readOnlyRunState(repo: string): Promise<RunState> {
  const runRoot = path.join(repo, ".agent-work");
  const runIds = await readdir(runRoot);
  assert.equal(runIds.length, 1);
  const raw = await readFile(path.join(runRoot, runIds[0] ?? "", "state.json"), "utf8");
  return JSON.parse(raw) as RunState;
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
