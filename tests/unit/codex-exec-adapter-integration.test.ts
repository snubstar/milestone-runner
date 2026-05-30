import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRunPaths } from "../../src/artifacts/paths.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import type { OrchestratorConfig } from "../../src/config/config-types.js";
import { runGoalWorkflow } from "../../src/orchestration/goal-workflow.js";
import { createAgentRunner } from "../../src/runners/create-runner.js";
import { nodeCommandRunner } from "../../src/shell/command-runner.js";
import { createInitialState } from "../../src/state/initial-state.js";
import { writeState } from "../../src/state/state-store.js";
import { createFixtureRepo } from "../helpers/fixture-repo.js";
import { assertReviewVerdictArtifact } from "../helpers/assertions.js";

const projectRoot = process.cwd();

test("codex-exec adapter runs a deterministic fake codex through the workflow", async () => {
  const repo = await createFixtureRepo({
    prefix: "milestone-runner-fake-codex-",
    files: {
      "README.md": "# Fake Codex Fixture\n",
    },
  });
  const toolDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-fake-codex-bin-"));
  const fakeCodexPath = path.join(toolDir, "fake-codex.cjs");
  const invocationLog = path.join(toolDir, "invocations.jsonl");
  const previousInvocationLog = process.env.FAKE_CODEX_INVOCATIONS;

  try {
    await installFakeCodex(fakeCodexPath);
    await cp(path.join(projectRoot, "src", "prompts"), path.join(repo.path, "src", "prompts"), {
      recursive: true,
    });
    await cp(path.join(projectRoot, "schemas"), path.join(repo.path, "schemas"), {
      recursive: true,
    });

    process.env.FAKE_CODEX_INVOCATIONS = invocationLog;

    const config: OrchestratorConfig = {
      checks: [
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
          [
            "const fs = require('node:fs');",
            "const value = fs.readFileSync('codex-fixture-output.txt', 'utf8');",
            "if (value !== 'implemented by fake codex\\n') process.exit(2);",
            "process.stdout.write('fake codex check ok');",
          ].join(" "),
        )}`,
      ],
      runner: {
        type: "codex-exec",
        command: fakeCodexPath,
        options: {
          sandboxForPlanning: "read-only",
          sandboxForImplementation: "workspace-write",
          approvalPolicy: "never",
          timeoutMs: 10000,
        },
      },
      maxFixAttempts: 0,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "scrupulous",
      humanReviewPolicy: "stop",
    };
    const runnerResult = createAgentRunner(config.runner);
    assert.equal(runnerResult.ok, true);
    if (!runnerResult.ok) return;

    const paths = buildRunPaths({
      cwd: repo.path,
      artifactRoot: config.artifactRoot,
      runId: "run-1",
    });
    const goal = "Create a deterministic fixture output file.";

    await createRunDirectory(paths, goal);
    const state = createInitialState({
      runId: paths.runId,
      goal,
      paths,
      git: {
        required: true,
        planningOnly: false,
        root: repo.path,
        startSha: await repo.git(["rev-parse", "HEAD"]),
        dirtyAtStart: false,
        dirtyOverride: false,
        statusPorcelain: "",
      },
      configPath: path.join(repo.path, "orchestrator.config.json"),
      configSnapshot: config,
      now: new Date("2026-05-10T12:00:00.000Z"),
    });
    await writeState(paths.files.state, state);

    const result = await runGoalWorkflow({
      goal,
      config,
      paths,
      initialState: state,
      runner: runnerResult.runner,
      commandRunner: nodeCommandRunner,
      cwd: repo.path,
      promptDir: path.join(repo.path, "src", "prompts"),
      now: sequenceClock("2026-05-10T12:00:01.000Z"),
    });

    assert.equal(
      result.ok,
      true,
      result.ok
        ? undefined
        : `${result.error}\n${JSON.stringify(result.state.lastError, null, 2)}`,
    );
    assert.equal(result.state.currentPhase, "passed");
    assert.equal(result.state.status, "passed");
    assert.equal(result.state.milestoneStatuses["1"], "passed");
    assert.equal(
      await readFile(path.join(repo.path, "codex-fixture-output.txt"), "utf8"),
      "implemented by fake codex\n",
    );

    assert.match(
      await readFile(path.join(paths.runDir, result.state.artifacts.diffs?.["1"] ?? ""), "utf8"),
      /diff --git a\/codex-fixture-output\.txt b\/codex-fixture-output\.txt/,
    );
    assert.match(
      await readFile(path.join(paths.runDir, result.state.artifacts.checks?.["1"] ?? ""), "utf8"),
      /fake codex check ok/,
    );
    const review = await assertReviewVerdictArtifact(
      path.join(paths.runDir, result.state.artifacts.reviews?.["1"] ?? ""),
    );
    assert.equal(review.verdict, "pass");

    assert.deepEqual((await readdir(paths.dirs.runner)).sort(), [
      "final_major_plan-03.json",
      "final_milestone_plan-07.json",
      "final_plan_json-04.json",
      "implement_milestone-08.json",
      "major_plan-01.json",
      "major_plan_review-02.json",
      "milestone_plan-05.json",
      "milestone_plan_review-06.json",
      "review_milestone-09.json",
    ]);

    const finalPlanJsonDiagnostic = JSON.parse(
      await readFile(path.join(paths.dirs.runner, "final_plan_json-04.json"), "utf8"),
    );
    assert.equal(finalPlanJsonDiagnostic.phase, "final_plan_json");
    assert.match(finalPlanJsonDiagnostic.outputSchemaPath, /schemas\/milestones\.schema\.json$/);

    const implementationDiagnostic = JSON.parse(
      await readFile(path.join(paths.dirs.runner, "implement_milestone-08.json"), "utf8"),
    );
    assert.equal(implementationDiagnostic.phase, "implement_milestone");
    assert.equal(implementationDiagnostic.sandbox, "workspace-write");
    assert.match(implementationDiagnostic.stdout, /fake-codex:implement_milestone/);
    assert.equal("prompt" in implementationDiagnostic, false);

    const milestonePlanReviewDiagnostic = JSON.parse(
      await readFile(path.join(paths.dirs.runner, "milestone_plan_review-06.json"), "utf8"),
    );
    assert.equal(milestonePlanReviewDiagnostic.phase, "milestone_plan_review");
    assert.equal(milestonePlanReviewDiagnostic.sandbox, "read-only");
    assert.equal("outputSchemaPath" in milestonePlanReviewDiagnostic, false);

    const finalMilestonePlanDiagnostic = JSON.parse(
      await readFile(path.join(paths.dirs.runner, "final_milestone_plan-07.json"), "utf8"),
    );
    assert.equal(finalMilestonePlanDiagnostic.phase, "final_milestone_plan");
    assert.equal(finalMilestonePlanDiagnostic.sandbox, "read-only");
    assert.equal("outputSchemaPath" in finalMilestonePlanDiagnostic, false);

    const reviewDiagnostic = JSON.parse(
      await readFile(path.join(paths.dirs.runner, "review_milestone-09.json"), "utf8"),
    );
    assert.equal(reviewDiagnostic.phase, "review_milestone");
    assert.equal(reviewDiagnostic.sandbox, "read-only");
    assert.match(reviewDiagnostic.outputSchemaPath, /schemas\/review-verdict\.schema\.json$/);

    const invocations = await readFakeCodexInvocations(invocationLog);
    assert.deepEqual(
      invocations.map((invocation) => invocation.phase),
      [
        "major_plan",
        "major_plan_review",
        "final_major_plan",
        "final_plan_json",
        "milestone_plan",
        "milestone_plan_review",
        "final_milestone_plan",
        "implement_milestone",
        "review_milestone",
      ],
    );
    assert.ok(invocations.every((invocation) => invocation.promptLength > 0));
    assert.ok(invocations.every((invocation) => invocation.promptFromStdin));
  } finally {
    if (previousInvocationLog === undefined) {
      delete process.env.FAKE_CODEX_INVOCATIONS;
    } else {
      process.env.FAKE_CODEX_INVOCATIONS = previousInvocationLog;
    }
    await repo.cleanup();
    await rm(toolDir, { recursive: true, force: true });
  }
});

interface FakeCodexInvocation {
  phase: string;
  promptLength: number;
  promptFromStdin: boolean;
}

async function installFakeCodex(filePath: string): Promise<void> {
  await writeFile(filePath, fakeCodexSource(), "utf8");
  await chmod(filePath, 0o755);
}

async function readFakeCodexInvocations(filePath: string): Promise<FakeCodexInvocation[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FakeCodexInvocation);
}

function sequenceClock(startIso: string): () => Date {
  let offset = 0;
  const start = new Date(startIso).getTime();

  return () => {
    const date = new Date(start + offset);
    offset += 1000;
    return date;
  };
}

function fakeCodexSource(): string {
  return String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.0.0\n");
  process.exit(0);
}

main();

function main() {
  const args = process.argv.slice(2);
  const fail = (message) => {
    process.stderr.write(message + "\n");
    process.exit(1);
  };

  if (args[0] !== "exec") fail("expected codex exec");
  if (args[args.length - 1] !== "-") fail("expected stdin prompt marker");

  const cd = requiredValue(args, "--cd", fail);
  const sandbox = requiredValue(args, "--sandbox", fail);
  const outputLastMessage = requiredValue(args, "--output-last-message", fail);
  const outputSchema = optionalValue(args, "--output-schema");
  const prompt = fs.readFileSync(0, "utf8");
  if (prompt.trim().length === 0) fail("expected prompt on stdin");
  if (fs.realpathSync(cd) !== fs.realpathSync(process.cwd())) {
    fail("--cd did not match process cwd");
  }

  const phase = phaseForPrompt(prompt);
  if (!phase) fail("could not detect phase");

  if (phase === "implement_milestone") {
    if (sandbox !== "workspace-write") fail("implementation must use workspace-write");
  } else if (sandbox !== "read-only") {
    fail(phase + " must use read-only");
  }

  if (phase === "final_plan_json") {
    if (!outputSchema || path.basename(outputSchema) !== "milestones.schema.json") {
      fail("final_plan_json must receive milestones schema");
    }
  } else if (phase === "review_milestone") {
    if (!outputSchema || path.basename(outputSchema) !== "review-verdict.schema.json") {
      fail("review_milestone must receive review schema");
    }
  } else if (outputSchema) {
    fail(phase + " must not receive an output schema");
  }

  if (phase === "implement_milestone") {
    fs.writeFileSync(path.join(cd, "codex-fixture-output.txt"), "implemented by fake codex\n");
  }

  const finalMessage = finalMessageForPhase(phase);
  fs.writeFileSync(outputLastMessage, finalMessage);
  process.stdout.write("fake-codex:" + phase + "\n");

  if (process.env.FAKE_CODEX_INVOCATIONS) {
    fs.appendFileSync(
      process.env.FAKE_CODEX_INVOCATIONS,
      JSON.stringify({
        phase,
        promptLength: prompt.length,
        promptFromStdin: args[args.length - 1] === "-",
      }) + "\n",
    );
  }
}

function requiredValue(args, flag, fail) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) fail("missing " + flag);
  return args[index + 1];
}

function optionalValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function phaseForPrompt(prompt) {
  if (prompt.startsWith("# Major Plan Prompt")) return "major_plan";
  if (prompt.startsWith("# Major Plan Review Prompt")) return "major_plan_review";
  if (prompt.startsWith("# Final Major Plan Prompt")) return "final_major_plan";
  if (prompt.startsWith("# Final Plan JSON Prompt")) return "final_plan_json";
  if (prompt.startsWith("# Milestone Implementation Plan Prompt")) return "milestone_plan";
  if (prompt.startsWith("# Milestone Plan Review Prompt")) return "milestone_plan_review";
  if (prompt.startsWith("# Final Milestone Plan Prompt")) return "final_milestone_plan";
  if (prompt.startsWith("# Implement Milestone Prompt")) return "implement_milestone";
  if (prompt.startsWith("# Review Milestone")) return "review_milestone";
  return null;
}

function finalMessageForPhase(phase) {
  switch (phase) {
    case "major_plan":
      return "# Major Plan\n\nCreate a deterministic fixture output file.\n";
    case "major_plan_review":
      return "# Major Plan Review\n\nThe plan is appropriately scoped.\n";
    case "final_major_plan":
      return "# Final Major Plan\n\nMilestone 1 creates codex-fixture-output.txt and verifies it.\n";
    case "final_plan_json":
      return JSON.stringify({
        milestones: [
          {
            id: 1,
            title: "Create fixture output",
            summary: "Create a deterministic fixture output file.",
            scope: ["Create codex-fixture-output.txt"],
            acceptanceCriteria: ["codex-fixture-output.txt contains fake codex output"],
            verification: ["Configured checks pass"],
            dependencies: [],
            status: "pending",
          },
        ],
      });
    case "milestone_plan":
      return "# Milestone Plan\n\nWrite codex-fixture-output.txt with deterministic content.\n";
    case "milestone_plan_review":
      return "# Milestone Plan Review\n\nThe draft plan is concrete and correctly scoped.\n";
    case "final_milestone_plan":
      return "# Final Milestone Plan\n\nWrite codex-fixture-output.txt with deterministic content.\n";
    case "implement_milestone":
      return "# Implementation Report\n\nWrote codex-fixture-output.txt.\n";
    case "review_milestone":
      return JSON.stringify({
        verdict: "pass",
        summary: "The deterministic fixture output satisfies the milestone.",
        findings: [],
        reviewedArtifacts: [
          "plans/03-final-major-plan.md",
          "milestones/10-milestone-1-plan.md",
          "milestones/11-milestone-1-implementation.md",
          "diffs/12-milestone-1.diff",
          "checks/13-milestone-1-checks.txt",
        ],
      });
    default:
      throw new Error("unhandled phase " + phase);
  }
}
`;
}
