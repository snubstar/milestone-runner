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
    assert.equal(result.options.maxFixAttempts, 1);
    assert.equal(result.options.milestone, 2);
    assert.equal(result.options.milestonePlanPolicy, "auto");
    assert.equal(result.options.milestonePlanReviewPolicy, "scrupulous");
    assert.equal(result.options.runner, "fake");
    assert.equal(result.options.configPath, "custom.json");
    assert.equal(result.options.artifactRoot, ".runs");
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

test("parseArgs rejects missing goal", () => {
  const result = parseArgs(["--planning-only"]);

  assert.deepEqual(result, { ok: false, error: "Missing goal." });
});

test("parseArgs rejects goal with resume", () => {
  const result = parseArgs(["--resume", "run-1", "Add feature X"]);

  assert.deepEqual(result, {
    ok: false,
    error: "Cannot provide a goal when --resume is set. The saved state provides the goal.",
  });
});

test("parseArgs rejects config with resume", () => {
  const result = parseArgs(["--resume", "run-1", "--config", "custom.json"]);

  assert.deepEqual(result, {
    ok: false,
    error: "--config cannot be combined with --resume in Milestone 8.",
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
