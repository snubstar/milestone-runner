import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../src/cli/args.js";

test("parseArgs accepts a quoted goal", () => {
  const result = parseArgs(["Add feature X"]);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.options.goal, "Add feature X");
    assert.equal(result.options.planningOnly, false);
    assert.equal(result.options.allowDirty, false);
    assert.equal(result.options.allowNonGitPlanning, false);
    assert.equal(result.options.dryRun, false);
  }
});

test("parseArgs joins unquoted goal words", () => {
  const result = parseArgs(["Add", "feature", "X"]);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.options.goal, "Add feature X");
  }
});

test("parseArgs accepts supported options", () => {
  const result = parseArgs([
    "--planning-only",
    "--allow-dirty",
    "--allow-non-git-planning",
    "--dry-run",
    "--json",
    "--run-id",
    "run-dashboard-1",
    "--max-fix-attempts",
    "1",
    "--milestone",
    "2",
    "--milestone-plan-policy",
    "auto",
    "--milestone-plan-review-policy",
    "scrupulous",
    "--runner",
    "fake",
    "--config",
    "custom.json",
    "--artifact-root",
    ".runs",
    "Add feature X",
  ]);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.options.goal, "Add feature X");
    assert.equal(result.options.planningOnly, true);
    assert.equal(result.options.allowDirty, true);
    assert.equal(result.options.allowNonGitPlanning, true);
    assert.equal(result.options.dryRun, true);
    assert.equal(result.options.json, true);
    assert.equal(result.options.runId, "run-dashboard-1");
    assert.equal(result.options.maxFixAttempts, 1);
    assert.equal(result.options.milestone, 2);
    assert.equal(result.options.milestonePlanPolicy, "auto");
    assert.equal(result.options.milestonePlanReviewPolicy, "scrupulous");
    assert.equal(result.options.runner, "fake");
    assert.equal(result.options.configPath, "custom.json");
    assert.equal(result.options.artifactRoot, ".runs");
  }
});

test("parseArgs accepts target repo, goal file, and repeated context files", () => {
  const result = parseArgs([
    "--repo",
    "../target-repo",
    "--goal-file",
    "docs/task.md",
    "--seed-major-plan",
    "docs/major-plan.md",
    "--context",
    "README.md",
    "--context",
    "docs/architecture.md",
    "--runner",
    "fake",
  ]);

  assert.equal(result.ok, true);
  if (result.ok) {
    const options = result.options as typeof result.options & {
      repoPath?: string;
      goalFile?: string;
      contextPaths?: string[];
      seedMajorPlanFile?: string;
    };
    assert.equal(options.goal, null);
    assert.equal(options.repoPath, "../target-repo");
    assert.equal(options.goalFile, "docs/task.md");
    assert.equal(options.seedMajorPlanFile, "docs/major-plan.md");
    assert.deepEqual(options.contextPaths, [
      "README.md",
      "docs/architecture.md",
    ]);
    assert.equal(options.runner, "fake");
  }
});

test("parseArgs accepts seed major plan with argv goal", () => {
  const result = parseArgs([
    "--seed-major-plan",
    "tasks/major-plan.md",
    "Add feature X",
  ]);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.options.goal, "Add feature X");
    assert.equal(result.options.seedMajorPlanFile, "tasks/major-plan.md");
  }
});

test("parseArgs accepts resume without a goal", () => {
  const result = parseArgs(["--resume", ".agent-work/run-1"]);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.options.goal, null);
    assert.equal(result.options.resume, ".agent-work/run-1");
  }
});

test("parseArgs accepts resume by run id with artifact root", () => {
  const result = parseArgs(["--artifact-root", ".runs", "--resume", "run-1"]);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.options.goal, null);
    assert.equal(result.options.artifactRoot, ".runs");
    assert.equal(result.options.resume, "run-1");
  }
});

test("parseArgs accepts recovery flags with resume", () => {
  const result = parseArgs([
    "--resume",
    ".agent-work/run-1",
    "--repair-failed",
  ]);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.options.goal, null);
    assert.equal(result.options.resumeRecoveryMode, "repair_failed");
  }
});

test("parseArgs accepts milestone plan policy with resume", () => {
  const result = parseArgs([
    "--resume",
    ".agent-work/run-1",
    "--milestone-plan-policy",
    "light",
  ]);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.options.goal, null);
    assert.equal(result.options.resume, ".agent-work/run-1");
    assert.equal(result.options.milestonePlanPolicy, "light");
  }
});

test("parseArgs accepts milestone plan review policy with resume", () => {
  const result = parseArgs([
    "--resume",
    ".agent-work/run-1",
    "--milestone-plan-review-policy",
    "scrupulous",
  ]);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.options.goal, null);
    assert.equal(result.options.resume, ".agent-work/run-1");
    assert.equal(result.options.milestonePlanReviewPolicy, "scrupulous");
  }
});

test("parseArgs accepts repo with resume", () => {
  const result = parseArgs(["--repo", "../target-repo", "--resume", "run-1"]);

  assert.equal(result.ok, true);
  if (result.ok) {
    const options = result.options as typeof result.options & { repoPath?: string };
    assert.equal(options.goal, null);
    assert.equal(options.repoPath, "../target-repo");
    assert.equal(options.resume, "run-1");
  }
});

test("parseArgs rejects missing goal", () => {
  const result = parseArgs(["--planning-only"]);

  assert.deepEqual(result, { ok: false, error: "Missing goal." });
});

test("parseArgs rejects argv goal combined with goal file", () => {
  const result = parseArgs([
    "--goal-file",
    "docs/task.md",
    "Add feature X",
  ]);

  assert.deepEqual(result, {
    ok: false,
    error: "Cannot provide both an argv goal and --goal-file.",
  });
});

test("parseArgs rejects goal file with resume", () => {
  const result = parseArgs([
    "--resume",
    "run-1",
    "--goal-file",
    "docs/task.md",
  ]);

  assert.deepEqual(result, {
    ok: false,
    error: "--goal-file cannot be combined with --resume.",
  });
});

test("parseArgs rejects context files with resume", () => {
  const result = parseArgs([
    "--resume",
    "run-1",
    "--context",
    "README.md",
  ]);

  assert.deepEqual(result, {
    ok: false,
    error: "--context cannot be combined with --resume.",
  });
});

test("parseArgs rejects seed major plan with resume", () => {
  const result = parseArgs([
    "--resume",
    "run-1",
    "--seed-major-plan",
    "tasks/major-plan.md",
  ]);

  assert.deepEqual(result, {
    ok: false,
    error: "--seed-major-plan cannot be combined with --resume.",
  });
});

test("parseArgs rejects goal with resume", () => {
  const result = parseArgs(["--resume", "run-1", "Add feature X"]);

  assert.deepEqual(result, {
    ok: false,
    error: "Cannot provide a goal when --resume is set. The saved state provides the goal.",
  });
});

test("parseArgs rejects run id with resume", () => {
  const result = parseArgs(["--resume", "run-1", "--run-id", "run-2"]);

  assert.deepEqual(result, {
    ok: false,
    error: "--run-id cannot be combined with --resume.",
  });
});

test("parseArgs rejects config with resume", () => {
  const result = parseArgs(["--resume", "run-1", "--config", "custom.json"]);

  assert.deepEqual(result, {
    ok: false,
    error: "--config cannot be combined with --resume in Milestone 8.",
  });
});

test("parseArgs rejects recovery flags without resume", () => {
  const result = parseArgs(["--recheck", "Add feature X"]);

  assert.deepEqual(result, {
    ok: false,
    error:
      "--repair-failed, --recheck, and --retry-failed can only be used with --resume.",
  });
});

test("parseArgs rejects multiple recovery flags", () => {
  const result = parseArgs([
    "--resume",
    "run-1",
    "--repair-failed",
    "--retry-failed",
  ]);

  assert.deepEqual(result, {
    ok: false,
    error: "Only one recovery flag can be supplied.",
  });
});

test("parseArgs rejects unknown options", () => {
  const result = parseArgs(["--unknown", "Add feature X"]);

  assert.deepEqual(result, { ok: false, error: "Unknown option: --unknown" });
});

test("parseArgs rejects missing option values", () => {
  const result = parseArgs(["--config", "--runner", "fake", "Add feature X"]);

  assert.deepEqual(result, { ok: false, error: "Missing value for --config." });
});

test("parseArgs rejects missing resume value", () => {
  const result = parseArgs(["--resume"]);

  assert.deepEqual(result, { ok: false, error: "Missing value for --resume." });
});

test("parseArgs rejects missing seed major plan value", () => {
  const result = parseArgs(["--seed-major-plan", "--context", "README.md", "Goal"]);

  assert.deepEqual(result, {
    ok: false,
    error: "Missing value for --seed-major-plan.",
  });
});

test("parseArgs rejects invalid max fix attempts", () => {
  for (const value of ["-1", "1.5", "abc", "9007199254740992"]) {
    const result = parseArgs(["--max-fix-attempts", value, "Add feature X"]);

    assert.deepEqual(result, {
      ok: false,
      error: `Invalid --max-fix-attempts value "${value}". Expected a non-negative integer.`,
    });
  }
});

test("parseArgs rejects invalid milestone ids", () => {
  for (const value of ["0", "-1", "1.5", "abc", "9007199254740992"]) {
    const result = parseArgs(["--milestone", value, "Add feature X"]);

    assert.deepEqual(result, {
      ok: false,
      error: `Invalid --milestone value "${value}". Expected a positive integer.`,
    });
  }
});

test("parseArgs rejects invalid runner", () => {
  const result = parseArgs(["--runner", "other", "Add feature X"]);

  assert.deepEqual(result, {
    ok: false,
    error: 'Invalid --runner value "other". Expected "fake" or "codex-exec".',
  });
});

test("parseArgs rejects invalid run ids", () => {
  for (const value of ["", "job-1", "../run-1", "run-", "run-1/2"]) {
    const argv = value === "" ? ["--run-id", "", "Add feature X"] : ["--run-id", value, "Add feature X"];
    const result = parseArgs(argv);

    if (value === "") {
      assert.deepEqual(result, { ok: false, error: "Missing value for --run-id." });
    } else {
      assert.deepEqual(result, {
        ok: false,
        error:
          `Invalid --run-id value "${value}". ` +
          'Expected a filesystem-safe id beginning with "run-".',
      });
    }
  }
});

test("parseArgs rejects invalid milestone plan policy", () => {
  const result = parseArgs([
    "--milestone-plan-policy",
    "sometimes",
    "Add feature X",
  ]);

  assert.deepEqual(result, {
    ok: false,
    error:
      'Invalid --milestone-plan-policy value "sometimes". Expected "always", "auto", or "light".',
  });
});

test("parseArgs rejects invalid milestone plan review policy", () => {
  const result = parseArgs([
    "--milestone-plan-review-policy",
    "sometimes",
    "Add feature X",
  ]);

  assert.deepEqual(result, {
    ok: false,
    error:
      'Invalid --milestone-plan-review-policy value "sometimes". Expected "normal" or "scrupulous".',
  });
});
