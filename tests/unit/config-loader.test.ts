import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyConfigOverrides,
  loadConfig,
  validateConfig,
} from "../../src/config/config-loader.js";

test("loadConfig reads the example config", async () => {
  const result = await loadConfig({ cwd: process.cwd() });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(path.basename(result.value.path), "orchestrator.config.example.json");
    assert.equal(result.value.config.runner.type, "codex-exec");
    assert.equal(result.value.config.artifactRoot, ".agent-work");
  }
});

test("loadConfig reports invalid JSON clearly", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-config-"));
  try {
    const configPath = path.join(tempDir, "broken.json");
    await writeFile(configPath, "{", "utf8");

    const result = await loadConfig({ cwd: tempDir, configPath });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /Invalid JSON in config/);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("validateConfig rejects missing codex runner command", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "codex-exec",
      options: {
        sandboxForPlanning: "read-only",
        sandboxForImplementation: "workspace-write",
        approvalPolicy: "never",
      },
    },
    maxFixAttempts: 2,
    artifactRoot: ".agent-work",
  });

  assert.deepEqual(result, {
    ok: false,
    error: "`runner.command` is required for codex-exec.",
  });
});

test("validateConfig rejects missing codex runner options", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "codex-exec",
      command: "codex",
    },
    maxFixAttempts: 2,
    artifactRoot: ".agent-work",
  });

  assert.deepEqual(result, {
    ok: false,
    error: "`runner.options` is required for codex-exec.",
  });
});

test("validateConfig accepts fake runner without command", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "fake",
    },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.runner.type, "fake");
  }
});

test("applyConfigOverrides applies artifact root, runner type, and max fix attempts", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "fake",
    },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    const config = applyConfigOverrides(result.value, {
      artifactRoot: ".runs",
      runnerType: "codex-exec",
      maxFixAttempts: 3,
    });

    assert.equal(config.artifactRoot, ".runs");
    assert.equal(config.runner.type, "codex-exec");
    assert.equal(config.maxFixAttempts, 3);
  }
});
