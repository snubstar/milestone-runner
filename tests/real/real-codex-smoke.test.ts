import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { nodeCommandRunner } from "../../src/shell/command-runner.js";
import type { RunState } from "../../src/state/state-types.js";
import {
  assertReviewVerdictArtifact,
  assertRunStateShape,
} from "../helpers/assertions.js";
import { createFixtureRepo } from "../helpers/fixture-repo.js";

const projectRoot = process.cwd();
const expectedFile = "codex-real-smoke.txt";
const expectedLine = "real codex smoke test passed";

test(
  "real codex smoke test edits a fixture repository",
  {
    skip:
      process.env.RUN_REAL_CODEX === "1"
        ? false
        : "Set RUN_REAL_CODEX=1 to run the opt-in real Codex smoke test.",
    timeout: Number(process.env.REAL_CODEX_SMOKE_TEST_TIMEOUT_MS ?? 600000),
  },
  async () => {
    const repo = await createFixtureRepo({
      prefix: "milestone-runner-real-codex-",
      files: {
        "README.md": "# Real Codex Smoke Fixture\n",
      },
    });

    let completed = false;

    try {
      await installRealRunHarness(repo.path);
      await repo.git(["add", "."]);
      await repo.git([
        "-c",
        "user.name=Agent Orchestrator Test",
        "-c",
        "user.email=milestone-runner@example.invalid",
        "commit",
        "-m",
        "add real codex smoke harness",
      ]);

      const cliResult = await nodeCommandRunner.run({
        command: process.execPath,
        args: [
          path.join(projectRoot, "dist", "cli", "main.js"),
          "--runner",
          "codex-exec",
          "--milestone",
          "1",
          realSmokeGoal(),
        ],
        cwd: repo.path,
        timeoutMs: Number(process.env.REAL_CODEX_SMOKE_CLI_TIMEOUT_MS ?? 600000),
      });

      const state = await readLatestState(repo.path);
      assert.equal(
        cliResult.exitCode,
        0,
        await formatFailure(repo.path, cliResult.stdout, cliResult.stderr, state),
      );
      assert.ok(state, "real Codex smoke test should create a run state.");
      assertRunStateShape(state);

      assert.equal(state.config.snapshot?.runner.type, "codex-exec");
      assert.equal(state.milestoneStatuses["1"], "passed", await formatFailure(
        repo.path,
        cliResult.stdout,
        cliResult.stderr,
        state,
      ));
      assert.equal(
        await readFile(path.join(repo.path, expectedFile), "utf8"),
        `${expectedLine}\n`,
        await formatFailure(repo.path, cliResult.stdout, cliResult.stderr, state),
      );

      const diffArtifact = requireArtifact(state.artifacts.diffs?.["1"], "diff");
      const diffText = await readFile(path.join(state.runDir, diffArtifact), "utf8");
      assert.match(diffText, /diff --git a\/codex-real-smoke\.txt b\/codex-real-smoke\.txt/);
      assert.match(diffText, /real codex smoke test passed/);

      const checksArtifact = requireArtifact(state.artifacts.checks?.["1"], "checks");
      const checksText = await readFile(path.join(state.runDir, checksArtifact), "utf8");
      assert.match(checksText, /Overall: passed/);
      assert.match(checksText, /real codex smoke check ok/);

      const reviewArtifact = requireArtifact(state.artifacts.reviews?.["1"], "review");
      await assertReviewVerdictArtifact(path.join(state.runDir, reviewArtifact));

      const runnerDiagnostics = await readdir(path.join(state.runDir, "runner"));
      assert.ok(
        runnerDiagnostics.length > 0,
        `Expected runner diagnostics in ${path.join(state.runDir, "runner")}`,
      );

      completed = true;
    } finally {
      if (completed && process.env.REAL_CODEX_KEEP_SMOKE_FIXTURE !== "1") {
        await repo.cleanup();
      }
    }
  },
);

async function installRealRunHarness(repoPath: string): Promise<void> {
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await cp(path.join(projectRoot, "src", "prompts"), path.join(repoPath, "src", "prompts"), {
    recursive: true,
  });
  await cp(path.join(projectRoot, "schemas"), path.join(repoPath, "schemas"), {
    recursive: true,
  });
  await writeFile(
    path.join(repoPath, "orchestrator.config.json"),
    `${JSON.stringify(realCodexConfig(), null, 2)}\n`,
    "utf8",
  );
}

function realCodexConfig(): object {
  return {
    checks: [
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        [
          "const fs = require('node:fs');",
          `const value = fs.readFileSync(${JSON.stringify(expectedFile)}, 'utf8');`,
          `if (value !== ${JSON.stringify(`${expectedLine}\n`)}) process.exit(2);`,
          "process.stdout.write('real codex smoke check ok');",
        ].join(" "),
      )}`,
    ],
    runner: {
      type: "codex-exec",
      command: process.env.REAL_CODEX_COMMAND ?? "codex",
      options: {
        sandboxForPlanning: "read-only",
        sandboxForImplementation: "workspace-write",
        approvalPolicy: "never",
        timeoutMs: Number(process.env.REAL_CODEX_PHASE_TIMEOUT_MS ?? 180000),
        ...optionalStringOption("model", process.env.REAL_CODEX_MODEL),
        ...optionalStringOption("profile", process.env.REAL_CODEX_PROFILE),
      },
    },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
  };
}

function optionalStringOption(key: string, value: string | undefined): Record<string, string> {
  return value === undefined || value.trim().length === 0 ? {} : { [key]: value };
}

function realSmokeGoal(): string {
  return [
    "Create exactly one milestone that writes one fixture file for a smoke test.",
    `The only implementation change should create ${expectedFile} with exactly this single line: ${expectedLine}`,
    "Do not modify README.md.",
    "The configured check is the source of truth for acceptance.",
  ].join(" ");
}

async function readLatestState(repoPath: string): Promise<RunState | null> {
  const artifactRoot = path.join(repoPath, ".agent-work");
  let entries: string[];
  try {
    entries = await readdir(artifactRoot);
  } catch {
    return null;
  }

  const runIds = entries.filter((entry) => entry.startsWith("run-")).sort();
  const latestRunId = runIds.at(-1);
  if (!latestRunId) return null;

  const statePath = path.join(artifactRoot, latestRunId, "state.json");
  return JSON.parse(await readFile(statePath, "utf8")) as RunState;
}

function requireArtifact(artifactPath: string | undefined, label: string): string {
  assert.ok(artifactPath, `Expected ${label} artifact path in state.json.`);
  return artifactPath;
}

async function formatFailure(
  repoPath: string,
  stdout: string,
  stderr: string,
  state: RunState | null,
): Promise<string> {
  const runDir = state?.runDir;
  const diagnostics = runDir ? await diagnosticListing(runDir) : "(no run directory created)";

  return [
    "Real Codex smoke test failed.",
    `Fixture repository: ${repoPath}`,
    `Run directory: ${runDir ?? "(none)"}`,
    state?.lastError ? `Last error: ${JSON.stringify(state.lastError, null, 2)}` : undefined,
    "Stdout:",
    stdout.trimEnd() || "(empty)",
    "Stderr:",
    stderr.trimEnd() || "(empty)",
    "Runner diagnostics:",
    diagnostics,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

async function diagnosticListing(runDir: string): Promise<string> {
  const runnerDir = path.join(runDir, "runner");
  try {
    const files = await readdir(runnerDir);
    return files.length > 0
      ? files.map((file) => path.join(runnerDir, file)).join("\n")
      : "(runner diagnostics directory is empty)";
  } catch {
    return "(runner diagnostics directory missing)";
  }
}
