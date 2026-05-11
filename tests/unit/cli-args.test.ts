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
    assert.equal(result.options.runner, "fake");
    assert.equal(result.options.configPath, "custom.json");
    assert.equal(result.options.artifactRoot, ".runs");
  }
});

test("parseArgs rejects missing goal", () => {
  const result = parseArgs(["--planning-only"]);

  assert.deepEqual(result, { ok: false, error: "Missing goal." });
});

test("parseArgs rejects unknown options", () => {
  const result = parseArgs(["--unknown", "Add feature X"]);

  assert.deepEqual(result, { ok: false, error: "Unknown option: --unknown" });
});

test("parseArgs rejects missing option values", () => {
  const result = parseArgs(["--config", "--runner", "fake", "Add feature X"]);

  assert.deepEqual(result, { ok: false, error: "Missing value for --config." });
});

test("parseArgs rejects invalid runner", () => {
  const result = parseArgs(["--runner", "other", "Add feature X"]);

  assert.deepEqual(result, {
    ok: false,
    error: 'Invalid --runner value "other". Expected "fake" or "codex-exec".',
  });
});

