import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildCheckFailureArtifactPath,
  buildMilestoneArtifactPaths,
} from "../../src/artifacts/milestone-artifacts.js";
import { buildRunPaths, type RunPaths } from "../../src/artifacts/paths.js";
import {
  buildPlanningArtifactPaths,
  writeJsonArtifact,
  writeTextArtifact,
} from "../../src/artifacts/planning-artifacts.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import { buildCheckFailureSummaryArtifact } from "../../src/checks/check-failure-summary.js";
import { formatCheckRunReport } from "../../src/checks/check-runner.js";
import type { CheckRunResult } from "../../src/checks/check-types.js";
import { buildResumeDryRunReport } from "../../src/cli/dry-run.js";
import {
  loadResumeRun,
  type LoadResumeRunResult,
} from "../../src/cli/run-loader.js";
import type { OrchestratorConfig } from "../../src/config/config-types.js";
import { captureGitTree } from "../../src/git/git-diff.js";
import type { MilestoneMetadata } from "../../src/milestones/milestone-types.js";
import { writeGoalSummary } from "../../src/orchestration/goal-summary.js";
import { runGoalWorkflow } from "../../src/orchestration/goal-workflow.js";
import {
  nodeCommandRunner,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "../../src/shell/command-runner.js";
import { createInitialState } from "../../src/state/initial-state.js";
import type {
  MilestoneStatus,
  OrchestratorPhase,
  RunState,
} from "../../src/state/state-types.js";
import {
  createFixtureRepo,
  type FixtureRepo,
} from "../helpers/fixture-repo.js";
import {
  defaultTestConfig,
  sequenceClock,
} from "../helpers/run-fixture.js";
import { ScenarioRunner } from "../helpers/scenario-runner.js";

type LoadedResumeRun = Extract<LoadResumeRunResult, { ok: true }>;
type WaazooFailureShape = "legacy_failed" | "checks_failed";

interface WaazooFixture {
  repo: FixtureRepo;
  paths: RunPaths;
  goal: string;
  config: OrchestratorConfig;
  metadata: MilestoneMetadata;
  baselineTree: string;
  cleanup: () => Promise<void>;
}

test("waazoo phase 3 legacy failed-check state dry-run gates recovery modes", async () => {
  const fixture = await createWaazooPhase3Fixture({
    failureShape: "legacy_failed",
    storedBaseline: false,
    omitRecoveryFields: true,
  });
  try {
    const loaded = await loadWaazooFixture(fixture);

    assert.deepEqual(loaded.state.checkFixAttempts, {});
    assert.deepEqual(loaded.state.milestoneBaselines, {});

    const plain = await dryRunWaazooResume(fixture, loaded);
    assert.equal(plain.allowed, false);
    assert.equal(plain.nextAction, "stopped_failed");

    const repair = await dryRunWaazooResume(fixture, loaded, {
      resumeRecoveryMode: "repair_failed",
      targetMilestone: 4,
      allowDirty: true,
      withGitContext: true,
    });
    assert.equal(repair.allowed, true);
    assert.equal(repair.nextAction, "repair_failed_milestone");
    assert.equal(
      repair.warnings.some((warning) =>
        warning.includes("baseline was reconstructed from legacy artifacts"),
      ),
      true,
    );

    const recheck = await dryRunWaazooResume(fixture, loaded, {
      resumeRecoveryMode: "recheck_failed",
      targetMilestone: 4,
      allowDirty: true,
      withGitContext: true,
    });
    assert.equal(recheck.allowed, true);
    assert.equal(recheck.nextAction, "recheck_failed_milestone");

    const missingBaselineState: RunState = {
      ...loaded.state,
      git: {
        ...loaded.state.git,
        startSha: null,
      },
      milestoneBaselines: {},
    };
    const missingBaseline = await buildResumeDryRunReport({
      state: missingBaselineState,
      paths: loaded.paths,
      config: loaded.config,
      planningOnly: false,
      allowDirty: true,
      allowNonGitPlanning: false,
      resumeRecoveryMode: "recheck_failed",
      cwd: fixture.repo.path,
      commandRunner: nodeCommandRunner,
      git: missingBaselineState.git,
      runnerType: "scenario",
    });
    assert.equal(missingBaseline.allowed, false);
    assert.equal(missingBaseline.nextAction, "blocked_missing_milestone_baseline");

    const retry = await dryRunWaazooResume(fixture, loaded, {
      resumeRecoveryMode: "retry_failed",
      targetMilestone: 4,
      allowDirty: true,
      withGitContext: true,
    });
    assert.equal(retry.allowed, false);
    assert.equal(retry.nextAction, "blocked_dirty_retry_worktree");
  } finally {
    await fixture.cleanup();
  }
});

test("waazoo checks_failed state can use a stored milestone baseline without git reconstruction", async () => {
  const fixture = await createWaazooPhase3Fixture({
    failureShape: "checks_failed",
    storedBaseline: true,
    omitRecoveryFields: false,
  });
  try {
    const loaded = await loadWaazooFixture(fixture);
    assert.equal(loaded.state.milestoneBaselines["4"], fixture.baselineTree);

    const recheck = await dryRunWaazooResume(fixture, loaded, {
      resumeRecoveryMode: "recheck_failed",
      targetMilestone: 4,
      allowDirty: true,
      withGitContext: false,
    });

    assert.equal(recheck.allowed, true);
    assert.equal(recheck.nextAction, "recheck_failed_milestone");
    assert.equal(
      recheck.warnings.some((warning) =>
        warning.includes("baseline was reconstructed from legacy artifacts"),
      ),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("waazoo legacy failure writes a terminal summary without recovery", async () => {
  const fixture = await createWaazooPhase3Fixture({
    failureShape: "legacy_failed",
    storedBaseline: false,
    omitRecoveryFields: true,
  });
  try {
    const loaded = await loadWaazooFixture(fixture);
    const result = await runGoalWorkflow({
      ...workflowOptions(fixture, loaded.state, loaded.config),
      runner: new ScenarioRunner([]),
    });

    assert.equal(result.ok, false);
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.currentPhase, "checking");
    assert.equal(result.state.currentMilestoneId, 4);
    assert.equal(result.state.milestoneStatuses["4"], "failed");
    assert.equal(result.state.milestoneStatuses["5"], "pending");

    const summary = await readGoalSummary(fixture);
    assert.match(summary, /Status: failed/);
    assert.match(summary, /Current milestone: 4/);
    assert.match(summary, /Stop reason: Checks failed for milestone 4\./);
    assert.match(summary, /Milestone 4: checks\/13-milestone-4-check-failure-1\.json/);
  } finally {
    await fixture.cleanup();
  }
});

test("waazoo legacy failure repairs checks autonomously without consuming review fix attempts", async () => {
  const fixture = await createWaazooPhase3Fixture({
    failureShape: "legacy_failed",
    storedBaseline: false,
    omitRecoveryFields: true,
  });
  const commandRunner = new RecordingCommandRunner(nodeCommandRunner);
  try {
    const loaded = await loadWaazooFixture(fixture);
    const runner = new ScenarioRunner([
      {
        phase: "fix_check_failures",
        text: "# Check Repair\n\nCreated the missing deterministic check file.",
        exitCode: 0,
        writeFiles: [{ path: "fixed.txt", content: "fixed\n" }],
      },
      {
        phase: "review_milestone",
        text: reviewPassJson("The repaired milestone satisfies the contract."),
        exitCode: 0,
      },
    ]);

    const repaired = await runGoalWorkflow({
      ...workflowOptions(fixture, loaded.state, loaded.config, commandRunner),
      runner,
      resumeRecoveryMode: "repair_failed",
      executionLimits: {
        targetMilestoneId: 4,
        stopAfterTargetMilestone: true,
      },
    });

    assert.equal(repaired.ok, true);
    assert.equal(
      repaired.nextAction,
      "resume without --milestone to continue remaining milestones",
    );
    assert.equal(repaired.state.currentPhase, "passed");
    assert.equal(repaired.state.currentMilestoneId, 4);
    assert.equal(repaired.state.milestoneStatuses["4"], "passed");
    assert.equal(repaired.state.milestoneStatuses["5"], "pending");
    assert.deepEqual(runner.phases(), [
      "fix_check_failures",
      "review_milestone",
    ]);
    assert.deepEqual(repaired.state.checkFixAttempts, { "4": 1 });
    assert.deepEqual(repaired.state.fixAttempts, {});
    assert.equal(
      repaired.state.artifacts.checks?.["4"],
      path.join("checks", "23-milestone-4-checks-after-check-repair-1.txt"),
    );
    assert.equal(
      commandRunner.requests.some(isFixedFileCheckRequest),
      true,
    );

    const summary = await writeStandaloneGoalSummary(fixture, repaired.state);
    assert.match(summary, /Status: passed/);
    assert.match(
      summary,
      /Milestone 4: checks\/23-milestone-4-checks-after-check-repair-1\.txt/,
    );
    assert.match(summary, /- Milestone 4: 0/);
  } finally {
    await fixture.cleanup();
  }
});

test("waazoo legacy failure reconciles a passing manual recheck", async () => {
  const fixture = await createWaazooPhase3Fixture({
    failureShape: "legacy_failed",
    storedBaseline: false,
    omitRecoveryFields: true,
  });
  try {
    const loaded = await loadWaazooFixture(fixture);
    await fixture.repo.writeFile("fixed.txt", "fixed\n");
    const runner = new ScenarioRunner([
      {
        phase: "review_milestone",
        text: reviewPassJson("The manually rechecked milestone is acceptable."),
        exitCode: 0,
      },
    ]);

    const rechecked = await runGoalWorkflow({
      ...workflowOptions(fixture, loaded.state, loaded.config),
      runner,
      resumeRecoveryMode: "recheck_failed",
      executionLimits: {
        targetMilestoneId: 4,
        stopAfterTargetMilestone: true,
      },
    });

    assert.equal(rechecked.ok, true);
    assert.equal(rechecked.state.currentPhase, "passed");
    assert.equal(rechecked.state.currentMilestoneId, 4);
    assert.equal(rechecked.state.milestoneStatuses["4"], "passed");
    assert.equal(rechecked.state.milestoneStatuses["5"], "pending");
    assert.deepEqual(runner.phases(), ["review_milestone"]);
    assert.deepEqual(rechecked.state.checkFixAttempts, {});
    assert.equal(
      rechecked.state.artifacts.diffs?.["4"],
      path.join("diffs", "30-milestone-4-recheck-1.diff"),
    );
    assert.equal(
      rechecked.state.artifacts.checks?.["4"],
      path.join("checks", "31-milestone-4-recheck-1.txt"),
    );

    const summary = await writeStandaloneGoalSummary(fixture, rechecked.state);
    assert.match(summary, /Status: passed/);
    assert.match(summary, /Milestone 4: checks\/31-milestone-4-recheck-1\.txt/);
  } finally {
    await fixture.cleanup();
  }
});

test("waazoo legacy failure records a failed manual recheck summary", async () => {
  const fixture = await createWaazooPhase3Fixture({
    failureShape: "legacy_failed",
    storedBaseline: false,
    omitRecoveryFields: true,
  });
  try {
    const loaded = await loadWaazooFixture(fixture);

    const rechecked = await runGoalWorkflow({
      ...workflowOptions(fixture, loaded.state, loaded.config),
      runner: new ScenarioRunner([]),
      resumeRecoveryMode: "recheck_failed",
      executionLimits: {
        targetMilestoneId: 4,
        stopAfterTargetMilestone: true,
      },
    });

    assert.equal(rechecked.ok, false);
    assert.equal(rechecked.state.currentPhase, "checks_failed");
    assert.equal(rechecked.state.status, "checks_failed");
    assert.equal(rechecked.state.milestoneStatuses["4"], "checks_failed");
    assert.equal(
      rechecked.state.artifacts.checkFailures?.["4-recheck-1"],
      path.join("checks", "31-milestone-4-check-failure-after-recheck-1.json"),
    );

    const summary = await readGoalSummary(fixture);
    assert.match(summary, /Status: checks_failed/);
    assert.match(
      summary,
      /Stop reason: Checks failed during manual recheck attempt 1 for milestone 4\./,
    );
    assert.match(
      summary,
      /Milestone 4: checks\/31-milestone-4-check-failure-after-recheck-1\.json/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("waazoo legacy retry block leaves the raw legacy state file unchanged", async () => {
  const fixture = await createWaazooPhase3Fixture({
    failureShape: "legacy_failed",
    storedBaseline: false,
    omitRecoveryFields: true,
  });
  try {
    const loaded = await loadWaazooFixture(fixture);
    const before = await readFile(loaded.statePath, "utf8");
    const runner = new ScenarioRunner([]);

    const retried = await runGoalWorkflow({
      ...workflowOptions(fixture, loaded.state, loaded.config),
      runner,
      resumeRecoveryMode: "retry_failed",
      executionLimits: {
        targetMilestoneId: 4,
        stopAfterTargetMilestone: true,
      },
    });

    assert.equal(retried.ok, false);
    assert.equal(retried.nextAction, "blocked_dirty_retry_worktree");
    assert.deepEqual(runner.phases(), []);
    assert.equal(await readFile(loaded.statePath, "utf8"), before);
  } finally {
    await fixture.cleanup();
  }
});

async function createWaazooPhase3Fixture(options: {
  failureShape: WaazooFailureShape;
  storedBaseline: boolean;
  omitRecoveryFields: boolean;
}): Promise<WaazooFixture> {
  const repo = await createFixtureRepo({
    prefix: "milestone-runner-waazoo-regression-",
    gitignore: ".agent-work/\n",
    files: {
      "README.md": "# Waazoo regression fixture\n",
    },
  });

  try {
    const goal = "Recover Waazoo Phase 3 failed checks";
    const runId = "waazoo-phase3";
    const config = defaultTestConfig({
      checks: [fixedFileCheckCommand()],
      maxFixAttempts: 3,
      humanReviewPolicy: "autonomous",
    });
    const startSha = await repo.git(["rev-parse", "HEAD"]);
    const paths = buildRunPaths({
      cwd: repo.path,
      artifactRoot: config.artifactRoot,
      runId,
    });
    await createRunDirectory(paths, goal);

    const metadata = waazooMetadata();
    const planningPaths = buildPlanningArtifactPaths(paths);
    await writeTextArtifact(
      planningPaths.files.finalMajorPlanMarkdown,
      "# Waazoo Phase 3 Plan\n\nRecover deterministic check failures without starting later milestones.",
    );
    await writeJsonArtifact(planningPaths.files.milestones, metadata);

    const diffs: Record<string, string> = {};
    for (const milestoneId of [1, 2, 3]) {
      const milestonePaths = buildMilestoneArtifactPaths(paths, milestoneId);
      await writeTextArtifact(milestonePaths.files.diff, "");
      diffs[String(milestoneId)] = milestonePaths.statePaths.diff;
    }

    const milestonePaths = buildMilestoneArtifactPaths(paths, 4);
    await writeTextArtifact(
      milestonePaths.files.milestonePlan,
      "# Milestone 4 Plan\n\nImplement the Phase 3 behavior and satisfy configured checks.",
    );
    await writeTextArtifact(
      milestonePaths.files.implementation,
      "# Milestone 4 Implementation\n\nCreated Phase 3 work, but the check prerequisite is missing.",
    );
    await writeTextArtifact(
      milestonePaths.files.diff,
      [
        "diff --git a/feature.txt b/feature.txt",
        "new file mode 100644",
        "index 0000000..d95f3ad",
        "--- /dev/null",
        "+++ b/feature.txt",
        "@@ -0,0 +1 @@",
        "+broken",
      ].join("\n"),
    );
    const failedCheckResult = failedCheckRunResult();
    await writeTextArtifact(milestonePaths.files.checks, failedCheckResult.report);

    const checkFailurePath = buildCheckFailureArtifactPath(paths, 4, 1);
    await writeJsonArtifact(
      checkFailurePath.file,
      buildCheckFailureSummaryArtifact({
        milestoneId: 4,
        attempt: 1,
        stateKey: checkFailurePath.stateKey,
        fullCheckReportArtifactPath: milestonePaths.statePaths.checks,
        result: failedCheckResult,
        generatedAt: new Date("2026-06-04T10:00:00.000Z"),
      }),
    );

    const baseline = await captureGitTree({
      cwd: repo.path,
      commandRunner: nodeCommandRunner,
      excludedPaths: [paths.runDir],
    });
    if (!baseline.ok) throw new Error(baseline.error);
    assert.equal(baseline.ok, true);

    await repo.writeFile("feature.txt", "broken\n");

    const currentPhase: OrchestratorPhase =
      options.failureShape === "checks_failed" ? "checks_failed" : "checking";
    const status: OrchestratorPhase =
      options.failureShape === "checks_failed" ? "checks_failed" : "failed";
    const milestoneStatus: MilestoneStatus =
      options.failureShape === "checks_failed" ? "checks_failed" : "failed";
    const git = {
      required: true,
      planningOnly: false,
      root: repo.path,
      startSha,
      dirtyAtStart: false,
      dirtyOverride: false,
      statusPorcelain: "",
    };
    const initialState = createInitialState({
      runId,
      goal,
      paths,
      git,
      configPath: path.join(repo.path, "orchestrator.config.json"),
      configSnapshot: config,
      workspace: {
        invocationCwd: repo.path,
        targetCwd: repo.path,
      },
      inputs: {
        goalSource: { type: "argv", path: null },
        majorPlanSource: { type: "runner", path: null },
        context: [],
      },
      now: new Date("2026-06-04T09:59:00.000Z"),
    });

    const state: RunState = {
      ...initialState,
      currentPhase,
      status,
      currentMilestoneId: 4,
      milestoneStatuses: {
        "1": "passed",
        "2": "passed",
        "3": "passed",
        "4": milestoneStatus,
        "5": "pending",
      },
      milestoneBaselines: options.storedBaseline ? { "4": baseline.tree } : {},
      artifacts: {
        ...initialState.artifacts,
        finalMajorPlanMarkdown: planningPaths.statePaths.finalMajorPlanMarkdown,
        milestones: planningPaths.statePaths.milestones,
        milestonePlans: {
          "4": milestonePaths.statePaths.milestonePlan,
        },
        implementations: {
          "4": milestonePaths.statePaths.implementation,
        },
        diffs: {
          ...diffs,
          "4": milestonePaths.statePaths.diff,
        },
        checks: {
          "4": milestonePaths.statePaths.checks,
        },
        checkFailures: {
          [checkFailurePath.stateKey]: checkFailurePath.statePath,
        },
      },
      lastError: {
        message: "Checks failed for milestone 4.",
        phase: currentPhase,
        occurredAt: "2026-06-04T10:00:01.000Z",
        details: {
          checkFailureSummary: checkFailurePath.statePath,
          checks: milestonePaths.statePaths.checks,
          maxCheckFixAttempts: 3,
          attemptsCompleted: 0,
          results: failedCheckResult.results,
        },
      },
      updatedAt: "2026-06-04T10:00:01.000Z",
    };

    const rawState = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    if (options.omitRecoveryFields) {
      delete rawState.checkFixAttempts;
      delete rawState.milestoneBaselines;
    }
    await writeFile(paths.files.state, `${JSON.stringify(rawState, null, 2)}\n`, "utf8");

    return {
      repo,
      paths,
      goal,
      config,
      metadata,
      baselineTree: baseline.tree,
      cleanup: repo.cleanup,
    };
  } catch (error) {
    await repo.cleanup();
    throw error;
  }
}

async function loadWaazooFixture(fixture: WaazooFixture): Promise<LoadedResumeRun> {
  const loaded = await loadResumeRun({
    cwd: fixture.repo.path,
    artifactRoot: fixture.config.artifactRoot,
    resumeValue: fixture.paths.runId,
    commandRunner: nodeCommandRunner,
  });
  if (!loaded.ok) throw new Error(loaded.error);
  assert.equal(loaded.ok, true);
  return loaded;
}

async function dryRunWaazooResume(
  fixture: WaazooFixture,
  loaded: LoadedResumeRun,
  options: {
    resumeRecoveryMode?: "repair_failed" | "recheck_failed" | "retry_failed";
    targetMilestone?: number;
    allowDirty?: boolean;
    withGitContext?: boolean;
  } = {},
) {
  return buildResumeDryRunReport({
    state: loaded.state,
    paths: loaded.paths,
    config: loaded.config,
    planningOnly: false,
    allowDirty: options.allowDirty ?? false,
    allowNonGitPlanning: false,
    ...(options.targetMilestone === undefined
      ? {}
      : { targetMilestone: options.targetMilestone }),
    ...(options.resumeRecoveryMode === undefined
      ? {}
      : { resumeRecoveryMode: options.resumeRecoveryMode }),
    ...(options.withGitContext
      ? { cwd: fixture.repo.path, commandRunner: nodeCommandRunner }
      : {}),
    git: loaded.state.git,
    runnerType: "scenario",
  });
}

function workflowOptions(
  fixture: WaazooFixture,
  state: RunState,
  config: OrchestratorConfig,
  commandRunner: CommandRunner = nodeCommandRunner,
) {
  return {
    goal: fixture.goal,
    config,
    paths: fixture.paths,
    initialState: state,
    commandRunner,
    cwd: fixture.repo.path,
    promptDir: path.join(process.cwd(), "src", "prompts"),
    milestonesSchema: { type: "object" },
    now: sequenceClock("2026-06-04T10:01:00.000Z"),
  };
}

function waazooMetadata(): MilestoneMetadata {
  return {
    milestones: [
      {
        id: 1,
        title: "Foundation",
        summary: "Existing completed setup.",
        scope: ["Preserved prior work"],
        acceptanceCriteria: ["Prior setup remains intact"],
        verification: ["State inspection"],
        dependencies: [],
        status: "pending",
      },
      {
        id: 2,
        title: "Core workflow",
        summary: "Existing completed core workflow.",
        scope: ["Preserved core work"],
        acceptanceCriteria: ["Core workflow remains intact"],
        verification: ["State inspection"],
        dependencies: [1],
        status: "pending",
      },
      {
        id: 3,
        title: "Phase 3 preparation",
        summary: "Existing completed Phase 3 preparation.",
        scope: ["Preserved preparation work"],
        acceptanceCriteria: ["Preparation remains intact"],
        verification: ["State inspection"],
        dependencies: [2],
        status: "pending",
      },
      {
        id: 4,
        title: "Phase 3 failing milestone",
        summary: "The active milestone failed deterministic checks.",
        scope: ["Recover the failed check result"],
        acceptanceCriteria: ["Configured checks pass"],
        verification: ["Run the configured check command"],
        dependencies: [3],
        status: "pending",
      },
      {
        id: 5,
        title: "Later milestone",
        summary: "A later milestone that must remain pending during recovery.",
        scope: ["Do not start while milestone 4 is being recovered"],
        acceptanceCriteria: ["Milestone 5 remains pending"],
        verification: ["State inspection"],
        dependencies: [4],
        status: "pending",
      },
    ],
  };
}

function failedCheckRunResult(): CheckRunResult {
  const command = fixedFileCheckCommand();
  const result = {
    command,
    exitCode: 2,
    stdout: "",
    stderr: "missing fixed file",
    durationMs: 12,
  };

  return {
    ok: false,
    results: [result],
    report: formatCheckRunReport([result]),
  };
}

function fixedFileCheckCommand(): string {
  const script =
    "const fs = require('node:fs'); if (!fs.existsSync('fixed.txt')) { process.stderr.write('missing fixed file'); process.exit(2); } process.stdout.write('fixed ok');";
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function reviewPassJson(summary: string): string {
  return JSON.stringify(
    {
      verdict: "pass",
      summary,
      findings: [],
      reviewedArtifacts: [
        "diffs/12-milestone-4.diff",
        "checks/13-milestone-4-checks.txt",
      ],
    },
    null,
    2,
  );
}

async function readGoalSummary(fixture: WaazooFixture): Promise<string> {
  return readFile(
    path.join(fixture.paths.dirs.milestones, "90-goal-summary.md"),
    "utf8",
  );
}

async function writeStandaloneGoalSummary(
  fixture: WaazooFixture,
  state: RunState,
): Promise<string> {
  const summary = await writeGoalSummary({
    paths: fixture.paths,
    state,
    metadata: fixture.metadata,
    cwd: fixture.repo.path,
    commandRunner: nodeCommandRunner,
  });
  if (!summary.ok) throw new Error(summary.error);
  assert.equal(summary.ok, true);
  return summary.content;
}

function isFixedFileCheckRequest(request: CommandRequest): boolean {
  return request.command === "sh" &&
    request.args[0] === "-lc" &&
    request.args[1] === fixedFileCheckCommand();
}

class RecordingCommandRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  constructor(private readonly inner: CommandRunner) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push({
      ...request,
      args: [...request.args],
    });
    return this.inner.run(request);
  }
}
