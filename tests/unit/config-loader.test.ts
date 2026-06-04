import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    assert.equal(result.value.config.milestonePlanReviewPolicy, "normal");
    assert.equal(result.value.config.humanReviewPolicy, "stop");
  }
});

test("loadConfig reports invalid JSON clearly", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-config-"));
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
    assert.equal(result.value.milestonePlanReviewPolicy, "normal");
  }
});

test("validateConfig accepts optional maxCheckFixAttempts", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "fake",
    },
    maxFixAttempts: 2,
    maxCheckFixAttempts: 4,
    artifactRoot: ".agent-work",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.maxFixAttempts, 2);
    assert.equal(result.value.maxCheckFixAttempts, 4);
  }
});

test("validateConfig rejects invalid maxCheckFixAttempts", () => {
  for (const maxCheckFixAttempts of [-1, 1.5, "2"]) {
    const result = validateConfig({
      checks: [],
      runner: {
        type: "fake",
      },
      maxFixAttempts: 2,
      maxCheckFixAttempts,
      artifactRoot: ".agent-work",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /maxCheckFixAttempts/);
    }
  }
});

test("validateConfig preserves optional runner account label", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "codex-exec",
      command: "codex",
      accountLabel: "work-codex",
      options: {
        sandboxForPlanning: "read-only",
        sandboxForImplementation: "workspace-write",
        approvalPolicy: "on-request",
        profile: "work-profile",
      },
    },
    maxFixAttempts: 2,
    artifactRoot: ".agent-work",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    const runner = result.value.runner as typeof result.value.runner & {
      accountLabel?: string;
    };
    assert.equal(runner.accountLabel, "work-codex");
    assert.equal(result.value.runner.options?.profile, "work-profile");
  }
});

test("validateConfig rejects invalid runner account labels", () => {
  for (const accountLabel of ["", "   ", 42]) {
    const result = validateConfig({
      checks: [],
      runner: {
        type: "fake",
        accountLabel,
      },
      maxFixAttempts: 0,
      artifactRoot: ".agent-work",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /runner\.accountLabel/);
    }
  }
});

test("validateConfig rejects unsupported top-level config fields", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "fake",
    },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    milestonePlanReviewPolciy: "scrupulous",
  });

  assert.deepEqual(result, {
    ok: false,
    error: "Unsupported config field(s): milestonePlanReviewPolciy.",
  });
});

test("validateConfig rejects unsupported runner fields", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "fake",
      accountLable: "work-codex",
    },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
  });

  assert.deepEqual(result, {
    ok: false,
    error: "Unsupported runner field(s): accountLable.",
  });
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
    assert.equal(result.value.milestonePlanReviewPolicy, "normal");
    assert.equal(result.value.humanReviewPolicy, "stop");
  }
});

test("validateConfig accepts human review fail policy", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "fake",
    },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    humanReviewPolicy: "fail",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.humanReviewPolicy, "fail");
  }
});

test("validateConfig accepts human review autonomous policy", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "fake",
    },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    humanReviewPolicy: "autonomous",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.humanReviewPolicy, "autonomous");
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

test("validateConfig rejects invalid milestone plan review policy", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "fake",
    },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    milestonePlanReviewPolicy: "careless",
  });

  assert.deepEqual(result, {
    ok: false,
    error: '`milestonePlanReviewPolicy` must be "normal" or "scrupulous".',
  });
});

test("validateConfig rejects invalid human review policy", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "fake",
    },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    humanReviewPolicy: "continue",
  });

  assert.deepEqual(result, {
    ok: false,
    error: '`humanReviewPolicy` must be "stop", "fail", or "autonomous".',
  });
});

test("config schema keeps humanReviewPolicy optional with all supported values", async () => {
  const raw = await readFile(
    path.join(process.cwd(), "schemas", "config.schema.json"),
    "utf8",
  );
  const schema = JSON.parse(raw) as {
    required?: string[];
    properties?: Record<string, { enum?: string[] }>;
  };

  assert.ok(!schema.required?.includes("humanReviewPolicy"));
  assert.deepEqual(schema.properties?.humanReviewPolicy?.enum, [
    "stop",
    "fail",
    "autonomous",
  ]);
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

test("applyConfigOverrides applies artifact root, runner type, max fix attempts, and milestone plan policies", () => {
  const result = validateConfig({
    checks: [],
    runner: {
      type: "fake",
    },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    milestonePlanPolicy: "always",
    milestonePlanReviewPolicy: "normal",
    humanReviewPolicy: "fail",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    const config = applyConfigOverrides(result.value, {
      artifactRoot: ".runs",
      runnerType: "codex-exec",
      maxFixAttempts: 3,
      milestonePlanPolicy: "light",
      milestonePlanReviewPolicy: "scrupulous",
    });

    assert.equal(config.artifactRoot, ".runs");
    assert.equal(config.runner.type, "codex-exec");
    assert.equal(config.maxFixAttempts, 3);
    assert.equal(config.milestonePlanPolicy, "light");
    assert.equal(config.milestonePlanReviewPolicy, "scrupulous");
    assert.equal(config.humanReviewPolicy, "fail");
  }
});
