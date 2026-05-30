import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildMilestoneArtifactPaths } from "../../src/artifacts/milestone-artifacts.js";
import {
  buildBaseReviewArtifactPaths,
  buildFixAttemptArtifactPaths,
} from "../../src/artifacts/review-artifacts.js";
import { buildRunPaths, type RunPaths } from "../../src/artifacts/paths.js";
import { writeJsonArtifact } from "../../src/artifacts/planning-artifacts.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import type { MilestoneMetadata } from "../../src/milestones/milestone-types.js";
import { writeGoalSummary } from "../../src/orchestration/goal-summary.js";
import type { ReviewVerdictDocument } from "../../src/review/review-types.js";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../../src/shell/command-runner.js";
import { createInitialState } from "../../src/state/initial-state.js";
import type { RunState } from "../../src/state/state-types.js";

test("writeGoalSummary writes a passed summary with changed files, artifacts, and residual risks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-goal-summary-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(paths, "Add feature X");

    const metadata = testMilestoneMetadata();
    const milestone1FixPaths = buildFixAttemptArtifactPaths(paths, 1, 1);
    const milestone2Paths = buildMilestoneArtifactPaths(paths, 2);
    const milestone2ReviewPaths = buildBaseReviewArtifactPaths(paths, 2);

    await writeJsonArtifact(
      milestone1FixPaths.files.review,
      passingReview("Milestone 1 passed after fixes.", [
        {
          severity: "low",
          file: "src/app.ts",
          issue: "Minor cleanup remains.",
          suggestedFix: "Fold the cleanup into a later tidy-up.",
          blocking: false,
        },
      ]),
    );
    await writeJsonArtifact(
      milestone2ReviewPaths.files.review,
      passingReview("Milestone 2 passed.", []),
    );

    const state: RunState = {
      ...baseState(paths, tempDir),
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: null,
      milestoneStatuses: {
        "1": "passed",
        "2": "passed",
      },
      fixAttempts: {
        "1": 1,
      },
      artifacts: {
        ...baseState(paths, tempDir).artifacts,
        checks: {
          "1-fix-1": milestone1FixPaths.statePaths.checks,
          "2": milestone2Paths.statePaths.checks,
        },
        reviews: {
          "1-fix-1": milestone1FixPaths.statePaths.review,
          "2": milestone2ReviewPaths.statePaths.review,
        },
      },
      lastError: null,
      updatedAt: "2026-05-10T12:00:00.000Z",
    };

    const result = await writeGoalSummary({
      paths,
      state,
      metadata,
      cwd: tempDir,
      commandRunner: diffRunner({
        stdout: [
          "src/app.ts",
          ".agent-work/run-1/state.json",
          "README.md",
          "",
        ].join("\n"),
      }),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.statePath, path.join("milestones", "90-goal-summary.md"));
    const content = await readFile(result.file, "utf8");
    assert.equal(content, `${result.content}\n`);

    assert.match(content, /Status: passed/);
    assert.match(content, /Current milestone: none/);
    assert.match(content, /## Accepted Milestones/);
    assert.match(content, /- 1: First milestone/);
    assert.match(content, /- 2: Second milestone/);
    assert.match(content, /- README\.md/);
    assert.match(content, /- src\/app\.ts/);
    assert.doesNotMatch(content, /\.agent-work\/run-1\/state\.json/);
    assert.match(content, /Milestone 1: checks\/23-milestone-1-checks-after-fix-1\.txt \(after fix 1\)/);
    assert.match(content, /Milestone 2: checks\/13-milestone-2-checks\.txt/);
    assert.match(content, /Milestone 1: reviews\/24-milestone-1-review-after-fix-1\.json \(after fix 1\) \(pass\)/);
    assert.match(content, /Milestone 2: reviews\/20-milestone-2-review\.json \(pass\)/);
    assert.match(content, /Milestone 1: 1/);
    assert.match(content, /Milestone 2: 0/);
    assert.match(content, /Nonblocking finding from milestone 1 \(src\/app\.ts\): Minor cleanup remains\./);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("writeGoalSummary includes autonomous decision artifacts and assumptions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-goal-summary-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(paths, "Add feature X");

    const reviewResolutionPath = path.join(
      paths.dirs.reviews,
      "22-milestone-1-autonomous-resolution-1.json",
    );
    const resumeResolutionPath = path.join(
      paths.dirs.logs,
      "resolve-resume-state-1.json",
    );
    await writeJsonArtifact(reviewResolutionPath, {
      phase: "resolve_review_ambiguity",
      attempt: 1,
      status: "resolved",
      sourceCondition: "explicit_needs_human_review",
      resolutionError: null,
      resolution: {
        resolution: {
          summary: "Autonomous review accepted the milestone.",
          rationale: "The recorded evidence covers the active milestone.",
          assumptions: ["The diff maps to the active milestone."],
          sourceCondition: "explicit_needs_human_review",
        },
        verdict: passingReview("Milestone 1 passed.", []),
      },
    });
    await writeJsonArtifact(resumeResolutionPath, {
      phase: "resolve_resume_state",
      attempt: 1,
      status: "resolved",
      resolutionError: null,
      resolution: {
        action: "normalize_to_ready_for_review",
        summary: "Autonomous resume normalized the state.",
        rationale: "Required implementation artifacts were present.",
        assumptions: ["Recorded implementation artifacts are complete."],
        currentMilestoneId: 1,
      },
    });

    const state: RunState = {
      ...baseState(paths, tempDir),
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: null,
      milestoneStatuses: {
        "1": "passed",
        "2": "pending",
      },
      artifacts: {
        ...baseState(paths, tempDir).artifacts,
        reviews: {
          "1-resolution-1":
            "reviews/22-milestone-1-autonomous-resolution-1.json",
        },
        logs: {
          "resume-resolution-1": "logs/resolve-resume-state-1.json",
        },
      },
      lastError: null,
      updatedAt: "2026-05-10T12:00:00.000Z",
    };

    const result = await writeGoalSummary({
      paths,
      state,
      metadata: testMilestoneMetadata(),
      cwd: tempDir,
      commandRunner: diffRunner({ stdout: "" }),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const content = await readFile(result.file, "utf8");
    assert.match(content, /## Autonomous Decisions/);
    assert.match(
      content,
      /Review resolution attempt 1 for milestone 1: resolved; artifact reviews\/22-milestone-1-autonomous-resolution-1\.json/,
    );
    assert.match(content, /source explicit_needs_human_review/);
    assert.match(content, /assumptions The diff maps to the active milestone\./);
    assert.match(
      content,
      /Resume resolution attempt 1 for milestone 1: resolved; artifact logs\/resolve-resume-state-1\.json; action normalize_to_ready_for_review/,
    );
    assert.match(
      content,
      /assumptions Recorded implementation artifacts are complete\./,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("writeGoalSummary writes blocked summaries with stop diagnostics and changed-file capture risk", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-goal-summary-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(paths, "Add feature X");

    const metadata = testMilestoneMetadata();
    const milestone1Paths = buildMilestoneArtifactPaths(paths, 1);
    const milestone1ReviewPaths = buildBaseReviewArtifactPaths(paths, 1);

    await writeJsonArtifact(
      milestone1ReviewPaths.files.review,
      passingReview("Milestone 1 passed.", []),
    );

    const state: RunState = {
      ...baseState(paths, tempDir),
      currentPhase: "needs_human_review",
      status: "needs_human_review",
      currentMilestoneId: 2,
      milestoneStatuses: {
        "1": "passed",
        "2": "needs_human_review",
      },
      artifacts: {
        ...baseState(paths, tempDir).artifacts,
        checks: {
          "1": milestone1Paths.statePaths.checks,
        },
        reviews: {
          "1": milestone1ReviewPaths.statePaths.review,
        },
      },
      lastError: {
        message: "Dependency cycle blocked progression.",
        phase: "needs_human_review",
        occurredAt: "2026-05-10T12:00:00.000Z",
        details: { pendingMilestoneIds: [2] },
      },
      updatedAt: "2026-05-10T12:00:00.000Z",
    };

    const result = await writeGoalSummary({
      paths,
      state,
      metadata,
      cwd: tempDir,
      commandRunner: diffRunner({
        exitCode: 1,
        stderr: "fatal: bad revision\n",
      }),
      diagnostics: [
        {
          message: "Selector returned blocked.",
          details: { pendingMilestoneIds: [2] },
        },
      ],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const content = await readFile(result.file, "utf8");
    assert.match(content, /Status: needs_human_review/);
    assert.match(content, /Current milestone: 2/);
    assert.match(content, /## Needs Human Review/);
    assert.match(content, /- 2: Second milestone/);
    assert.match(content, /- No changed files captured\./);
    assert.match(content, /Stop reason: Dependency cycle blocked progression\./);
    assert.match(content, /Stop details: \{"pendingMilestoneIds":\[2\]\}/);
    assert.match(content, /Diagnostic: Selector returned blocked\. Details: \{"pendingMilestoneIds":\[2\]\}/);
    assert.match(content, /Changed-file capture failed: git diff --name-only exited with code 1: fatal: bad revision/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("writeGoalSummary reports unsafe review artifact paths without reading them", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-goal-summary-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(paths, "Add feature X");
    const outsideReview = path.join(tempDir, "outside-review.json");
    await writeJsonArtifact(outsideReview, passingReview("Outside review passed.", []));

    const state: RunState = {
      ...baseState(paths, tempDir),
      currentPhase: "passed",
      status: "passed",
      currentMilestoneId: null,
      milestoneStatuses: {
        "1": "passed",
        "2": "pending",
      },
      artifacts: {
        ...baseState(paths, tempDir).artifacts,
        reviews: {
          "1": outsideReview,
        },
      },
      lastError: null,
      updatedAt: "2026-05-10T12:00:00.000Z",
    };

    const result = await writeGoalSummary({
      paths,
      state,
      metadata: testMilestoneMetadata(),
      cwd: tempDir,
      commandRunner: diffRunner({ stdout: "" }),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const content = await readFile(result.file, "utf8");
    assert.match(content, /Milestone 1: .*outside-review\.json.*unreadable/);
    assert.match(content, /Artifact path must be run-relative/);
    assert.doesNotMatch(content, /Milestone 1: .*outside-review\.json \(pass\)/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("writeGoalSummary returns a structured error when the summary cannot be written", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-goal-summary-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });

    const result = await writeGoalSummary({
      paths,
      state: {
        ...baseState(paths, tempDir),
        currentPhase: "passed",
        status: "passed",
        currentMilestoneId: null,
        milestoneStatuses: {
          "1": "passed",
          "2": "passed",
        },
      },
      metadata: testMilestoneMetadata(),
      cwd: tempDir,
      commandRunner: diffRunner({ stdout: "src/app.ts\n" }),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Failed to write goal summary:/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function baseState(paths: RunPaths, cwd: string): RunState {
  return createInitialState({
    runId: paths.runId,
    goal: "Add feature X",
    paths,
    git: {
      required: true,
      planningOnly: false,
      root: cwd,
      startSha: "abc123",
      dirtyAtStart: false,
      dirtyOverride: false,
      statusPorcelain: "",
    },
    configPath: "/repo/orchestrator.config.example.json",
    configSnapshot: {
      checks: [],
      runner: { type: "fake" },
      maxFixAttempts: 0,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
      milestonePlanReviewPolicy: "normal",
      humanReviewPolicy: "stop",
    },
    now: new Date("2026-05-10T12:00:00.000Z"),
  });
}

function testMilestoneMetadata(): MilestoneMetadata {
  return {
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
      {
        id: 2,
        title: "Second milestone",
        summary: "Implement the second milestone.",
        scope: ["Extend the fixture output"],
        acceptanceCriteria: ["The second fixture output exists"],
        verification: ["Configured checks pass"],
        dependencies: [1],
        status: "pending",
      },
    ],
  };
}

function passingReview(
  summary: string,
  findings: ReviewVerdictDocument["findings"],
): ReviewVerdictDocument {
  return {
    verdict: "pass",
    summary,
    findings,
    reviewedArtifacts: ["diffs/12-milestone-1.diff"],
  };
}

function diffRunner(options: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  untrackedExitCode?: number;
  untrackedStdout?: string;
  untrackedStderr?: string;
}): CommandRunner {
  return {
    async run(request) {
      if (request.command === "git" && request.args.join(" ") === "diff --name-only abc123") {
        return commandResult(
          request,
          options.exitCode ?? 0,
          options.stdout ?? "",
          options.stderr ?? "",
        );
      }

      if (
        request.command === "git" &&
        request.args.join(" ") === "ls-files --others --exclude-standard"
      ) {
        return commandResult(
          request,
          options.untrackedExitCode ?? 0,
          options.untrackedStdout ?? "",
          options.untrackedStderr ?? "",
        );
      }

      return commandResult(request, 1, "", `Unexpected command: ${request.command} ${request.args.join(" ")}`);
    },
  };
}

function commandResult(
  request: CommandRequest,
  exitCode: number,
  stdout = "",
  stderr = "",
): CommandResult {
  return {
    ...request,
    exitCode,
    stdout,
    stderr,
  };
}
