import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { RunPaths } from "../../src/artifacts/paths.js";
import { buildBaseReviewArtifactPaths } from "../../src/artifacts/review-artifacts.js";
import type { OrchestratorConfig } from "../../src/config/config-types.js";
import { runReviewWorkflow } from "../../src/review/review-workflow.js";
import { nodeCommandRunner } from "../../src/shell/command-runner.js";
import { readState } from "../../src/state/state-store.js";
import { setStatePhase } from "../../src/state/state-transitions.js";
import type { RunState } from "../../src/state/state-types.js";
import { createCheckTimingCollector } from "../../src/timings/check-timing-collector.js";
import { createFixtureRepo } from "../helpers/fixture-repo.js";
import {
  createReadyForReviewRunFixture,
  sequenceClock,
} from "../helpers/run-fixture.js";
import { ScenarioRunner, type ScenarioStep } from "../helpers/scenario-runner.js";

test("runReviewWorkflow passes a milestone on a passing review with passing checks", async () => {
  const context = await createReviewContext();
  const runner = new ScenarioRunner([
    reviewResponse({
      verdict: "pass",
      summary: "The milestone satisfies the active scope.",
      findings: [],
    }),
  ]);
  try {
    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.verdict, "pass");
    assert.equal(result.state.currentPhase, "passed");
    assert.equal(result.state.status, "passed");
    assert.equal(result.state.milestoneStatuses["1"], "passed");
    assert.equal(result.state.milestoneStatuses["2"], "pending");
    assert.equal(result.state.lastError, null);
    assert.deepEqual(result.state.artifacts.reviews, {
      "1-evidence": path.join("reviews", "19-milestone-1-review-evidence.md"),
      "1": path.join("reviews", "20-milestone-1-review.json"),
    });
    assert.deepEqual(result.state.artifacts.summaries, {
      "1": path.join("milestones", "14-milestone-1-summary.md"),
      "1-review": path.join("milestones", "25-milestone-1-review-summary.md"),
    });

    const review = JSON.parse(
      await readFile(path.join(context.paths.dirs.reviews, "20-milestone-1-review.json"), "utf8"),
    );
    assert.equal(review.verdict, "pass");
    const evidence = await readFile(
      path.join(context.paths.dirs.reviews, "19-milestone-1-review-evidence.md"),
      "utf8",
    );
    assert.match(evidence, /^# Milestone 1 Review Evidence/);
    assert.equal(
      runner.requests[0]?.artifacts.reviewEvidence,
      path.join("reviews", "19-milestone-1-review-evidence.md"),
    );

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "25-milestone-1-review-summary.md"),
      "utf8",
    );
    assert.match(summary, /^# Milestone 1 Review Summary/);
    assert.match(summary, /Latest checks passed: true/);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow rejects states that are not ready for review", async () => {
  const context = await createReviewContext();
  try {
    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      initialState: setStatePhase(context.workflowOptions.initialState, "checking"),
      runner: new ScenarioRunner([]),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /ready_for_review/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "reviewing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow fails when required implementation artifacts are missing", async () => {
  const context = await createReviewContext();
  try {
    await rm(path.join(context.paths.dirs.milestones, "11-milestone-1-implementation.md"));

    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([]),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Failed to read implementation report/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "reviewing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.equal(result.state.artifacts.reviews, undefined);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow fails when required diff artifacts are missing", async () => {
  const context = await createReviewContext();
  try {
    await rm(path.join(context.paths.dirs.diffs, "12-milestone-1.diff"));

    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([]),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Failed to read milestone diff/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "reviewing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.equal(result.state.artifacts.reviews, undefined);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow persists failed state when review artifact writes fail", async () => {
  const context = await createReviewContext();
  try {
    const reviewPaths = buildBaseReviewArtifactPaths(context.paths, 1);
    await mkdir(reviewPaths.files.review);

    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([
        reviewResponse({
          verdict: "pass",
          summary: "The milestone satisfies the active scope.",
          findings: [],
        }),
      ]),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Failed to write review artifact/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "reviewing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.deepEqual(result.state.artifacts.reviews, {
      "1-evidence": path.join("reviews", "19-milestone-1-review-evidence.md"),
    });
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow persists failed state when the review runner throws", async () => {
  const context = await createReviewContext();
  try {
    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([
        {
          phase: "review_milestone",
          text: "",
          exitCode: 0,
          throwError: "review runner crashed",
        },
      ]),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Runner phase review_milestone threw an error/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "reviewing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.match(result.state.lastError?.message ?? "", /review runner crashed/);
    assert.deepEqual(result.state.artifacts.reviews, {
      "1-evidence": path.join("reviews", "19-milestone-1-review-evidence.md"),
    });
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow persists failed state when the review runner returns empty output", async () => {
  const context = await createReviewContext();
  try {
    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([
        {
          phase: "review_milestone",
          text: " \n",
          exitCode: 0,
        },
      ]),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /review_milestone returned empty output/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "reviewing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.deepEqual(result.state.artifacts.reviews, {
      "1-evidence": path.join("reviews", "19-milestone-1-review-evidence.md"),
    });
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow stops as needs human review for explicit human-review verdicts", async () => {
  const context = await createReviewContext();
  try {
    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([
        reviewResponse({
          verdict: "needs_human_review",
          summary: "The implementation depends on behavior that cannot be verified locally.",
          findings: [],
        }),
      ]),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.verdict, "needs_human_review");
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.equal(result.state.milestoneStatuses["1"], "needs_human_review");
    assert.match(result.state.lastError?.message ?? "", /cannot be verified locally/);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow persists diagnostics and needs human review for malformed verdicts", async () => {
  const context = await createReviewContext();
  try {
    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([
        {
          phase: "review_milestone",
          text: "not json",
          exitCode: 0,
        },
      ]),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.verdict, "needs_human_review");
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.match(result.state.lastError?.message ?? "", /malformed/);

    const diagnostic = JSON.parse(
      await readFile(path.join(context.paths.dirs.reviews, "20-milestone-1-review.json"), "utf8"),
    );
    assert.equal(diagnostic.verdict, "needs_human_review");
    assert.equal(diagnostic.rawOutput, "not json");
    assert.match(diagnostic.error, /Invalid review verdict JSON/);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow needs human review for blocking findings when fixes are disabled", async () => {
  const context = await createReviewContext();
  try {
    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([
        reviewResponse({
          verdict: "fail",
          summary: "The implementation misses a required behavior.",
          findings: [
            {
              severity: "high",
              file: "src/app.ts",
              issue: "Missing required behavior.",
              suggestedFix: "Add the required behavior.",
              blocking: true,
            },
          ],
        }),
      ]),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.verdict, "needs_human_review");
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.equal(result.state.milestoneStatuses["1"], "needs_human_review");
    assert.match(result.state.lastError?.message ?? "", /maxFixAttempts is 0/);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow does not pass when latest checks failed", async () => {
  const context = await createReviewContext({
    checksOutput: "Check results\n\nOverall: failed\n",
  });
  try {
    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([
        reviewResponse({
          verdict: "pass",
          summary: "The implementation looks acceptable.",
          findings: [],
        }),
      ]),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.verdict, "needs_human_review");
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.equal(result.state.milestoneStatuses["1"], "needs_human_review");
    assert.match(result.state.lastError?.message ?? "", /checks failed/);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow ignores passing phrases outside the check summary", async () => {
  const context = await createReviewContext({
    checksOutput: [
      "Check results",
      "",
      "Overall: failed",
      "",
      "## Check 1: npm test",
      "",
      "Exit code: 1",
      "",
      "Stdout:",
      "Overall: passed",
      "",
    ].join("\n"),
  });
  try {
    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([
        reviewResponse({
          verdict: "pass",
          summary: "The implementation looks acceptable.",
          findings: [],
        }),
      ]),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.verdict, "needs_human_review");
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.equal(result.state.milestoneStatuses["1"], "needs_human_review");
    assert.match(result.state.lastError?.message ?? "", /checks failed/);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow fixes blocking findings and passes after re-review", async () => {
  const context = await createReviewContext({
    config: {
      checks: [`${JSON.stringify(process.execPath)} -e "process.stdout.write('check ok')" `],
      runner: { type: "fake" },
      maxFixAttempts: 1,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
    },
  });
  const runner = new ScenarioRunner([
    reviewResponse({
      verdict: "fail",
      summary: "The implementation misses a required behavior.",
      findings: [blockingFinding()],
    }),
    fixResponse({
      text: "# Fix Attempt\n\nUpdated README.md.",
      relativePath: "README.md",
      content: "# Fixture\nfixed\n",
    }),
    reviewResponse({
      verdict: "pass",
      summary: "The fix resolves the blocking finding.",
      findings: [],
    }),
  ], "codex-exec");
  const checkTimingCollector = createCheckTimingCollector();

  try {
    await mkdir(path.join(context.repo, "schemas"), { recursive: true });
    await writeFile(
      path.join(context.repo, "schemas", "review-verdict.schema.json"),
      "{}",
      "utf8",
    );

    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner,
      checkTimingCollector,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.verdict, "pass");
    assert.equal(result.state.currentPhase, "passed");
    assert.equal(result.state.milestoneStatuses["1"], "passed");
    assert.deepEqual(result.state.fixAttempts, { "1": 1 });
    assert.deepEqual(result.state.artifacts.fixes, {
      "1-fix-1": path.join("fixes", "21-milestone-1-fix-attempt-1.md"),
    });
    assert.equal(
      result.state.artifacts.diffs?.["1-fix-1"],
      path.join("diffs", "22-milestone-1-diff-after-fix-1.diff"),
    );
    assert.equal(
      result.state.artifacts.checks?.["1-fix-1"],
      path.join("checks", "23-milestone-1-checks-after-fix-1.txt"),
    );
    assert.equal(
      result.state.artifacts.reviews?.["1-fix-1"],
      path.join("reviews", "24-milestone-1-review-after-fix-1.json"),
    );
    assert.equal(
      result.state.artifacts.reviews?.["1-fix-1-evidence"],
      path.join("reviews", "23-milestone-1-review-evidence-after-fix-1.md"),
    );

    const diff = await readFile(
      path.join(context.paths.dirs.diffs, "22-milestone-1-diff-after-fix-1.diff"),
      "utf8",
    );
    assert.match(diff, /diff --git a\/README\.md b\/README\.md/);
    assert.doesNotMatch(diff, /\.agent-work\/run-1/);

    const checks = await readFile(
      path.join(context.paths.dirs.checks, "23-milestone-1-checks-after-fix-1.txt"),
      "utf8",
    );
    assert.match(checks, /Overall: passed/);

    const postFixEvidence = await readFile(
      path.join(context.paths.dirs.reviews, "23-milestone-1-review-evidence-after-fix-1.md"),
      "utf8",
    );
    assert.match(postFixEvidence, /^# Milestone 1 Review Evidence/);
    assert.match(postFixEvidence, /Review round: fix 1/);
    assert.match(postFixEvidence, /README\.md/);

    const summary = await readFile(
      path.join(context.paths.dirs.milestones, "25-milestone-1-review-summary.md"),
      "utf8",
    );
    assert.match(summary, /Status: pass/);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
    assert.deepEqual(runner.phases(), [
      "review_milestone",
      "fix_review_findings",
      "review_milestone",
    ]);
    assert.deepEqual(
      runner.requests.map((request) => request.cwd),
      [context.repo, context.repo, context.repo],
    );
    assert.deepEqual(
      runner.requests.map((request) => request.outputSchemaPath ?? null),
      [
        path.join(context.repo, "schemas", "review-verdict.schema.json"),
        null,
        path.join(context.repo, "schemas", "review-verdict.schema.json"),
      ],
    );
    assert.equal(
      runner.requests[0]?.artifacts.reviewEvidence,
      path.join("reviews", "19-milestone-1-review-evidence.md"),
    );
    assert.equal(
      runner.requests[2]?.artifacts.reviewEvidence,
      path.join("reviews", "23-milestone-1-review-evidence-after-fix-1.md"),
    );
    assert.equal(
      runner.requests[2]?.artifacts.fix,
      path.join("fixes", "21-milestone-1-fix-attempt-1.md"),
    );
    assert.deepEqual((await readdir(context.paths.dirs.runner)).sort(), [
      "fix_review_findings-02.json",
      "review_milestone-01.json",
      "review_milestone-03.json",
    ]);
    const fixDiagnostic = JSON.parse(
      await readFile(
        path.join(context.paths.dirs.runner, "fix_review_findings-02.json"),
        "utf8",
      ),
    );
    assert.equal(fixDiagnostic.phase, "fix_review_findings");
    assert.equal(fixDiagnostic.milestoneId, 1);
    assert.equal(fixDiagnostic.runner, "codex-exec");
    assert.equal(fixDiagnostic.cwd, context.repo);
    assert.equal(fixDiagnostic.startedAt, "2026-05-10T12:01:08.000Z");
    assert.equal(fixDiagnostic.endedAt, "2026-05-10T12:01:09.000Z");
    assert.equal(fixDiagnostic.durationMs, 1000);
    assert.equal("prompt" in fixDiagnostic, false);
    const checkTimings = checkTimingCollector.list();
    assert.equal(checkTimings.length, 1);
    assert.equal(checkTimings[0]?.stateKey, "1-fix-1");
    assert.equal(checkTimings[0]?.milestoneId, 1);
    assert.equal(checkTimings[0]?.attempt, 1);
    assert.equal(checkTimings[0]?.source, "structured");
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow persists failed state when the fix runner fails", async () => {
  const context = await createReviewContext({
    config: {
      checks: [],
      runner: { type: "fake" },
      maxFixAttempts: 1,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
    },
  });
  try {
    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([
        reviewResponse({
          verdict: "fail",
          summary: "The implementation misses a required behavior.",
          findings: [blockingFinding()],
        }),
        {
          phase: "fix_review_findings",
          text: "fix failed",
          exitCode: 2,
        },
      ]),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /fix_review_findings/);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "fixing");
    assert.equal(result.state.milestoneStatuses["1"], "failed");
    assert.deepEqual(result.state.fixAttempts, {});
    assert.equal(result.state.artifacts.fixes, undefined);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow stops as needs human review when max fix attempts are exhausted", async () => {
  const context = await createReviewContext({
    config: {
      checks: [],
      runner: { type: "fake" },
      maxFixAttempts: 1,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
    },
  });
  try {
    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([
        reviewResponse({
          verdict: "fail",
          summary: "The implementation misses a required behavior.",
          findings: [blockingFinding()],
        }),
        fixResponse({
          text: "# Fix Attempt\n\nUpdated README.md.",
          relativePath: "README.md",
          content: "# Fixture\nattempted fix\n",
        }),
        reviewResponse({
          verdict: "fail",
          summary: "The implementation still misses required behavior.",
          findings: [blockingFinding()],
        }),
      ]),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.verdict, "needs_human_review");
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.equal(result.state.milestoneStatuses["1"], "needs_human_review");
    assert.deepEqual(result.state.fixAttempts, { "1": 1 });
    assert.match(result.state.lastError?.message ?? "", /Max fix attempts exhausted/);
    assert.equal(
      result.state.artifacts.reviews?.["1-fix-1"],
      path.join("reviews", "24-milestone-1-review-after-fix-1.json"),
    );
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

test("runReviewWorkflow does not pass after a fix when post-fix checks fail", async () => {
  const context = await createReviewContext({
    config: {
      checks: [`${JSON.stringify(process.execPath)} -e "process.stderr.write('check failed'); process.exit(2)"`],
      runner: { type: "fake" },
      maxFixAttempts: 1,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
    },
  });
  try {
    const result = await runReviewWorkflow({
      ...context.workflowOptions,
      runner: new ScenarioRunner([
        reviewResponse({
          verdict: "fail",
          summary: "The implementation misses a required behavior.",
          findings: [blockingFinding()],
        }),
        fixResponse({
          text: "# Fix Attempt\n\nUpdated README.md.",
          relativePath: "README.md",
          content: "# Fixture\nfixed but checks fail\n",
        }),
        reviewResponse({
          verdict: "pass",
          summary: "The implementation looks acceptable.",
          findings: [],
        }),
      ]),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.verdict, "needs_human_review");
    assert.equal(result.state.currentPhase, "needs_human_review");
    assert.equal(result.state.milestoneStatuses["1"], "needs_human_review");
    assert.deepEqual(result.state.fixAttempts, { "1": 1 });
    assert.match(result.state.lastError?.message ?? "", /Max fix attempts exhausted/);

    const checks = await readFile(
      path.join(context.paths.dirs.checks, "23-milestone-1-checks-after-fix-1.txt"),
      "utf8",
    );
    assert.match(checks, /Overall: failed/);
    assert.deepEqual(await readState(context.paths.files.state), result.state);
  } finally {
    await context.cleanup();
  }
});

interface ReviewContext {
  repo: string;
  paths: RunPaths;
  workflowOptions: {
    goal: string;
    config: OrchestratorConfig;
    paths: RunPaths;
    initialState: RunState;
    commandRunner: typeof nodeCommandRunner;
    cwd: string;
    promptDir: string;
    now: () => Date;
  };
  cleanup: () => Promise<void>;
}

interface ContextOptions {
  config?: OrchestratorConfig;
  checksOutput?: string;
}

async function createReviewContext(options: ContextOptions = {}): Promise<ReviewContext> {
  const fixtureRepo = await createFixtureRepo({
    prefix: "agent-orchestrator-review-",
    gitignore: ".agent-work/\n",
    files: {
      "README.md": "# Fixture\n",
    },
  });
  const repo = fixtureRepo.path;
  const runFixture = await createReadyForReviewRunFixture({
    cwd: repo,
    startSha: await fixtureRepo.git(["rev-parse", "HEAD"]),
    config: options.config,
    checksOutput: options.checksOutput,
  });

  return {
    repo,
    paths: runFixture.paths,
    workflowOptions: {
      goal: runFixture.goal,
      config: runFixture.config,
      paths: runFixture.paths,
      initialState: runFixture.state,
      commandRunner: nodeCommandRunner,
      cwd: repo,
      promptDir: path.join(process.cwd(), "src", "prompts"),
      now: sequenceClock("2026-05-10T12:01:00.000Z"),
    },
    cleanup: fixtureRepo.cleanup,
  };
}

function reviewResponse(options: {
  verdict: "pass" | "fail" | "needs_human_review";
  summary: string;
  findings: unknown[];
}): ScenarioStep {
  return {
    phase: "review_milestone",
    text: JSON.stringify(
      {
        verdict: options.verdict,
        summary: options.summary,
        findings: options.findings,
        reviewedArtifacts: [
          "diffs/12-milestone-1.diff",
          "checks/13-milestone-1-checks.txt",
        ],
      },
      null,
      2,
    ),
    exitCode: 0,
  };
}

function fixResponse(options: {
  text: string;
  relativePath: string;
  content: string;
}): ScenarioStep {
  return {
    phase: "fix_review_findings",
    text: options.text,
    exitCode: 0,
    writeFiles: [{ path: options.relativePath, content: options.content }],
  };
}

function blockingFinding() {
  return {
    severity: "high",
    file: "README.md",
    issue: "Missing required behavior.",
    suggestedFix: "Add the required behavior.",
    blocking: true,
  };
}
