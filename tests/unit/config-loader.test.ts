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
    assert.deepEqual(result.value.config.runner.options, {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "never",
      timeoutMs: 1800000,
      jsonEvents: false,
    });
    assert.equal(result.value.config.artifactRoot, ".agent-work");
    assert.equal(result.value.config.milestonePlanPolicy, "always");
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

test("validateConfig accepts extended codex runner options", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "codex-exec",
      command: "codex",
      options: {
        sandboxForPlanning: "read-only",
        sandboxForImplementation: "workspace-write",
        approvalPolicy: "on-request",
        timeoutMs: 120000,
        model: "gpt-5.5",
        profile: "automation",
        jsonEvents: true,
      },
    },
    maxFixAttempts: 2,
    artifactRoot: ".agent-work",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.runner.options, {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "on-request",
      timeoutMs: 120000,
      model: "gpt-5.5",
      profile: "automation",
      jsonEvents: true,
    });
    assert.equal(result.value.milestonePlanPolicy, "always");
  }
});

test("validateConfig defaults missing milestone plan policy to always", () => {
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
    assert.equal(result.value.milestonePlanPolicy, "always");
  }
});

test("validateConfig rejects invalid milestone plan policy", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "fake",
    },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    milestonePlanPolicy: "sometimes",
  });

  assert.deepEqual(result, {
    ok: false,
    error: '`milestonePlanPolicy` must be "always", "auto", or "light".',
  });
});

test("validateConfig rejects deprecated codex approval policy", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "codex-exec",
      command: "codex",
      options: {
        sandboxForPlanning: "read-only",
        sandboxForImplementation: "workspace-write",
        approvalPolicy: "on-failure",
      },
    },
    maxFixAttempts: 2,
    artifactRoot: ".agent-work",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /"on-failure" is deprecated/);
    assert.match(result.error, /Use "on-request"/);
  }
});

test("validateConfig rejects invalid extended codex runner options", () => {
  const base = {
    checks: [],
    runner: {
      type: "codex-exec",
      command: "codex",
      options: {
        sandboxForPlanning: "read-only",
        sandboxForImplementation: "workspace-write",
        approvalPolicy: "never",
      },
    },
    maxFixAttempts: 2,
    artifactRoot: ".agent-work",
  };

  const invalidTimeout = validateConfig({
    ...base,
    runner: {
      ...base.runner,
      options: {
        ...base.runner.options,
        timeoutMs: 0,
      },
    },
  });
  assert.equal(invalidTimeout.ok, false);
  if (!invalidTimeout.ok) {
    assert.match(invalidTimeout.error, /timeoutMs/);
  }

  const invalidModel = validateConfig({
    ...base,
    runner: {
      ...base.runner,
      options: {
        ...base.runner.options,
        model: "",
      },
    },
  });
  assert.equal(invalidModel.ok, false);
  if (!invalidModel.ok) {
    assert.match(invalidModel.error, /model/);
  }

  const invalidJsonEvents = validateConfig({
    ...base,
    runner: {
      ...base.runner,
      options: {
        ...base.runner.options,
        jsonEvents: "true",
      },
    },
  });
  assert.equal(invalidJsonEvents.ok, false);
  if (!invalidJsonEvents.ok) {
    assert.match(invalidJsonEvents.error, /jsonEvents/);
  }

  const unsupportedOption = validateConfig({
    ...base,
    runner: {
      ...base.runner,
      options: {
        ...base.runner.options,
        unsupported: true,
      },
    },
  });
  assert.equal(unsupportedOption.ok, false);
  if (!unsupportedOption.ok) {
    assert.match(unsupportedOption.error, /Unsupported codex-exec runner option/);
  }
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

test("applyConfigOverrides applies artifact root, runner type, max fix attempts, and milestone plan policy", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "fake",
    },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    milestonePlanPolicy: "always",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    const config = applyConfigOverrides(result.value, {
      artifactRoot: ".runs",
      runnerType: "codex-exec",
      maxFixAttempts: 3,
      milestonePlanPolicy: "light",
    });

    assert.equal(config.artifactRoot, ".runs");
    assert.equal(config.runner.type, "codex-exec");
    assert.equal(config.maxFixAttempts, 3);
    assert.equal(config.milestonePlanPolicy, "light");
  }
});
