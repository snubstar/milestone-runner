import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { launchDashboardRun } from "../../src/dashboard/run-launcher.js";
import { goalFileMaxBytes } from "../../src/inputs/initial-inputs.js";
import { createFixtureRepo } from "../helpers/fixture-repo.js";

test("launchDashboardRun performs a dry run through the built CLI JSON contract", async () => {
  const context = await createLauncherContext();
  try {
    const result = await launchDashboardRun(
      {
        prompt: "Add feature X",
        runner: "fake",
        dryRun: true,
        milestone: 2,
        milestonePlanPolicy: "light",
        milestonePlanReviewPolicy: "scrupulous",
        allowDirty: true,
      },
      {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      },
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.statusCode, 200);
      assert.equal(result.response.dryRun, true);
      assert.equal(result.response.started, false);
      assert.match(result.response.runId, /^run-/);
      assert.equal(result.response.exitCode, 0);
      const report = result.response.report as {
        allowed: boolean;
        runId: string;
        details: { runner: string };
      };
      assert.equal(report.allowed, true);
      assert.equal(report.runId, result.response.runId);
      assert.equal(report.details.runner, "fake");
      const diagnostics = JSON.parse(
        await readFile(
          path.join(context.tempDir, ".agent-work", result.response.diagnosticsPath),
          "utf8",
        ),
      ) as { status: string; args: string[] };
      assert.equal(diagnostics.status, "completed");
      assert.equal(diagnostics.args.includes("--run-id"), true);
      assert.equal(diagnostics.args.includes("--json"), true);
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun starts a real CLI process without waiting for completion", async () => {
  const context = await createLauncherContext();
  try {
    const result = await launchDashboardRun(
      {
        prompt: "Add feature X",
        runner: "fake",
        dryRun: false,
      },
      {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      },
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.statusCode, 202);
      assert.equal(result.response.started, true);
      assert.equal(result.response.exitCode, null);
      await waitForFile(path.join(context.tempDir, "stub-args.json"));
      const args = JSON.parse(
        await readFile(path.join(context.tempDir, "stub-args.json"), "utf8"),
      ) as string[];
      assert.equal(args.includes("--dry-run"), false);
      assert.equal(args.includes("--run-id"), true);
      assert.equal(args.includes(result.response.runId), true);
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun returns blocked dry-run reports with clear diagnostics", async () => {
  const context = await createLauncherContext();
  try {
    const cliPath = await writeBlockedDryRunCli(context.tempDir);
    const result = await launchDashboardRun(
      {
        prompt: "Add feature X",
        runner: "codex-exec",
        dryRun: true,
      },
      {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        cliPath,
      },
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.statusCode, 200);
      assert.equal(result.response.started, false);
      assert.equal(result.response.exitCode, 1);
      const report = result.response.report as {
        allowed: boolean;
        nextAction: string;
        warnings: string[];
        details: { gitDirty: boolean; runner: string };
      };
      assert.equal(report.allowed, false);
      assert.equal(report.nextAction, "blocked_dirty_tree");
      assert.deepEqual(report.warnings, [
        "Working tree is dirty. Re-run with --allow-dirty only if intentional.",
      ]);
      assert.equal(report.details.gitDirty, true);
      assert.equal(report.details.runner, "codex-exec");
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun keeps concurrent live launch identities isolated", async () => {
  const context = await createLauncherContext();
  try {
    const cliPath = await writeConcurrentStubCli(context.tempDir);
    const now = () => new Date("2026-05-10T12:00:00.000Z");
    const results = await Promise.all([
      launchDashboardRun(
        {
          prompt: "Add feature X",
          runner: "fake",
          dryRun: false,
        },
        {
          cwd: context.tempDir,
          artifactRoot: ".agent-work",
          cliPath,
          now,
        },
      ),
      launchDashboardRun(
        {
          prompt: "Add feature Y",
          runner: "fake",
          dryRun: false,
        },
        {
          cwd: context.tempDir,
          artifactRoot: ".agent-work",
          cliPath,
          now,
        },
      ),
    ]);

    assert.equal(results[0]?.ok, true);
    assert.equal(results[1]?.ok, true);
    const [left, right] = results;
    if (!left.ok || !right.ok) return;

    assert.notEqual(left.response.runId, right.response.runId);
    for (const result of [left, right]) {
      assert.equal(result.response.started, true);
      await waitForFile(path.join(result.response.runDir, "state.json"));
      const argsPath = path.join(result.response.runDir, "stub-args.json");
      await waitForFile(argsPath);
      const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
      assert.equal(args.includes("--run-id"), true);
      assert.equal(args.includes(result.response.runId), true);
      assert.equal(path.basename(result.response.runDir), result.response.runId);
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun persists live process output before completion", async () => {
  const context = await createLauncherContext();
  try {
    const cliPath = await writeSlowOutputCli(context.tempDir);
    const result = await launchDashboardRun(
      {
        prompt: "Add feature X",
        runner: "fake",
        dryRun: false,
      },
      {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        cliPath,
      },
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      const diagnosticsFile = path.join(
        context.tempDir,
        ".agent-work",
        result.response.diagnosticsPath,
      );
      const runningDiagnostics = await waitForDiagnostics(diagnosticsFile, (diagnostics) => {
        return diagnostics.status === "running" &&
          typeof diagnostics.stderr === "string" &&
          diagnostics.stderr.includes("early launcher stderr");
      });
      assert.equal(runningDiagnostics.status, "running");
      assert.match(String(runningDiagnostics.stderr), /early launcher stderr/);

      await waitForDiagnostics(diagnosticsFile, (diagnostics) => {
        return diagnostics.status === "completed";
      });
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun forwards target repo and validated context paths", async () => {
  const context = await createLauncherContext();
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-target-"));
  try {
    await mkdir(path.join(targetDir, "docs"), { recursive: true });
    await writeFile(path.join(targetDir, "README.md"), "# Target\n", "utf8");
    await writeFile(path.join(targetDir, "docs", "architecture.md"), "# Architecture\n", "utf8");
    const canonicalTargetDir = await realpath(targetDir);

    const result = await launchDashboardRun(
      {
        prompt: "Add feature X",
        runner: "fake",
        dryRun: true,
        contextPaths: ["README.md", "docs/architecture.md"],
      },
      {
        cwd: context.tempDir,
        targetCwd: targetDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      } as Parameters<typeof launchDashboardRun>[1] & { targetCwd: string },
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      const args = JSON.parse(
        await readFile(path.join(context.tempDir, "stub-args.json"), "utf8"),
      ) as string[];
      assert.equal(args.includes("--repo"), true);
      assert.equal(args[args.indexOf("--repo") + 1], canonicalTargetDir);
      assert.deepEqual(valuesAfterRepeated(args, "--context"), [
        "README.md",
        "docs/architecture.md",
      ]);

      const diagnostics = JSON.parse(
        await readFile(
          path.join(targetDir, ".agent-work", result.response.diagnosticsPath),
          "utf8",
        ),
      ) as { cwd?: string; targetCwd?: string; requestedContextPaths?: string[] };
      assert.equal(diagnostics.cwd, context.tempDir);
      assert.equal(diagnostics.targetCwd, canonicalTargetDir);
      assert.deepEqual(diagnostics.requestedContextPaths, [
        "README.md",
        "docs/architecture.md",
      ]);
    }
  } finally {
    await rm(targetDir, { recursive: true, force: true });
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun forwards and records a validated seed major plan path", async () => {
  const context = await createLauncherContext();
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-target-"));
  try {
    await mkdir(path.join(targetDir, "docs"), { recursive: true });
    await writeFile(
      path.join(targetDir, "docs", "major-plan.md"),
      "# Seeded Plan\n\nUse this plan.\n",
      "utf8",
    );

    const result = await launchDashboardRun(
      {
        prompt: "Add feature X",
        runner: "fake",
        dryRun: true,
        seedMajorPlanPath: "docs/major-plan.md",
        contextPaths: ["docs/major-plan.md"],
      },
      {
        cwd: context.tempDir,
        targetCwd: targetDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      } as Parameters<typeof launchDashboardRun>[1] & { targetCwd: string },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const args = JSON.parse(
      await readFile(path.join(context.tempDir, "stub-args.json"), "utf8"),
    ) as string[];
    assert.equal(args.includes("--seed-major-plan"), true);
    assert.equal(args[args.indexOf("--seed-major-plan") + 1], "docs/major-plan.md");
    assert.deepEqual(valuesAfterRepeated(args, "--context"), ["docs/major-plan.md"]);

    const report = result.response.report as {
      details: {
        majorPlanSource: { type: string; path: string | null };
      };
    };
    assert.deepEqual(report.details.majorPlanSource, {
      type: "seed",
      path: "docs/major-plan.md",
    });

    const diagnostics = JSON.parse(
      await readFile(
        path.join(targetDir, ".agent-work", result.response.diagnosticsPath),
        "utf8",
      ),
    ) as {
      requestedContextPaths?: string[];
      requestedSeedMajorPlanPath?: string;
    };
    assert.deepEqual(diagnostics.requestedContextPaths, ["docs/major-plan.md"]);
    assert.equal(diagnostics.requestedSeedMajorPlanPath, "docs/major-plan.md");
  } finally {
    await rm(targetDir, { recursive: true, force: true });
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun forwards and records a goal file launch", async () => {
  const context = await createLauncherContext();
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-target-"));
  try {
    await mkdir(path.join(targetDir, "docs"), { recursive: true });
    await writeFile(path.join(targetDir, "docs", "task.md"), "Goal from file\n", "utf8");
    await writeFile(
      path.join(targetDir, "docs", "major-plan.md"),
      "# Seeded Plan\n\nUse this plan.\n",
      "utf8",
    );

    const result = await launchDashboardRun(
      {
        goalFilePath: "docs/task.md",
        runner: "fake",
        dryRun: true,
        seedMajorPlanPath: "docs/major-plan.md",
        contextPaths: ["docs/task.md"],
      },
      {
        cwd: context.tempDir,
        targetCwd: targetDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      } as Parameters<typeof launchDashboardRun>[1] & { targetCwd: string },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const args = JSON.parse(
      await readFile(path.join(context.tempDir, "stub-args.json"), "utf8"),
    ) as string[];
    assert.equal(args.includes("--goal-file"), true);
    assert.equal(args[args.indexOf("--goal-file") + 1], "docs/task.md");
    assert.equal(args.includes("--"), false);
    assert.equal(args.includes("Goal from file"), false);
    assert.deepEqual(valuesAfterRepeated(args, "--context"), ["docs/task.md"]);
    assert.equal(args[args.indexOf("--seed-major-plan") + 1], "docs/major-plan.md");

    const report = result.response.report as {
      nextAction: string;
      details: {
        goalSource: string;
        majorPlanSource: { type: string; path: string | null };
      };
    };
    assert.equal(report.nextAction, "review_seeded_major_plan");
    assert.equal(report.details.goalSource, "file:docs/task.md");
    assert.deepEqual(report.details.majorPlanSource, {
      type: "seed",
      path: "docs/major-plan.md",
    });

    const diagnostics = JSON.parse(
      await readFile(
        path.join(targetDir, ".agent-work", result.response.diagnosticsPath),
        "utf8",
      ),
    ) as {
      requestedGoalFilePath?: string;
      requestedContextPaths?: string[];
      requestedSeedMajorPlanPath?: string;
    };
    assert.equal(diagnostics.requestedGoalFilePath, "docs/task.md");
    assert.deepEqual(diagnostics.requestedContextPaths, ["docs/task.md"]);
    assert.equal(diagnostics.requestedSeedMajorPlanPath, "docs/major-plan.md");
  } finally {
    await rm(targetDir, { recursive: true, force: true });
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun rejects invalid goal source combinations", async () => {
  const context = await createLauncherContext();
  try {
    for (const input of [
      {
        prompt: "Add feature X",
        goalFilePath: "docs/task.md",
        runner: "fake",
      },
      {
        runner: "fake",
      },
      {
        prompt: "",
        goalFilePath: "",
        runner: "fake",
      },
    ]) {
      const result = await launchDashboardRun(input, {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      });

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.statusCode, 400);
        assert.equal(result.error.code, "invalid_launch_request");
        assert.match(result.error.message, /exactly one/i);
      }
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun rejects absolute browser goal file paths", async () => {
  const context = await createLauncherContext();
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-target-"));
  try {
    const result = await launchDashboardRun(
      {
        goalFilePath: path.join(targetDir, "docs", "task.md"),
        runner: "fake",
        dryRun: true,
      },
      {
        cwd: context.tempDir,
        targetCwd: targetDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      } as Parameters<typeof launchDashboardRun>[1] & { targetCwd: string },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 400);
      assert.equal(result.error.code, "invalid_launch_request");
      assert.match(result.error.message, /repository-relative/i);
    }
  } finally {
    await rm(targetDir, { recursive: true, force: true });
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "missing",
    goalFilePath: "docs/missing-task.md",
    expected: /unavailable/i,
    setup: async () => {},
  },
  {
    name: "directory",
    goalFilePath: "docs/task-dir",
    expected: /regular file/i,
    setup: async ({ targetDir }: GoalPathScenarioContext) => {
      await mkdir(path.join(targetDir, "docs", "task-dir"), { recursive: true });
    },
  },
  {
    name: "invalid UTF-8",
    goalFilePath: "docs/invalid.md",
    expected: /valid UTF-8/i,
    setup: async ({ targetDir }: GoalPathScenarioContext) => {
      await writeScenarioFile(targetDir, "docs/invalid.md", Buffer.from([0xff, 0xfe]));
    },
  },
  {
    name: "oversized",
    goalFilePath: "docs/oversized.md",
    expected: /size limit/i,
    setup: async ({ targetDir }: GoalPathScenarioContext) => {
      await writeScenarioFile(
        targetDir,
        "docs/oversized.md",
        Buffer.alloc(goalFileMaxBytes + 1, 0x61),
      );
    },
  },
  {
    name: "outside target",
    goalFilePath: "../outside-task.md",
    expected: /inside the target repository/i,
    setup: async ({ rootDir }: GoalPathScenarioContext) => {
      await writeFile(path.join(rootDir, "outside-task.md"), "Outside\n", "utf8");
    },
  },
  {
    name: "sibling-prefix escape",
    goalFilePath: "../target-other/task.md",
    expected: /inside the target repository/i,
    setup: async ({ rootDir }: GoalPathScenarioContext) => {
      await mkdir(path.join(rootDir, "target-other"), { recursive: true });
      await writeFile(path.join(rootDir, "target-other", "task.md"), "Outside\n", "utf8");
    },
  },
  {
    name: "symlink escape",
    goalFilePath: "docs/escaped.md",
    expected: /inside the target repository/i,
    setup: async ({ rootDir, targetDir }: GoalPathScenarioContext) => {
      await mkdir(path.join(targetDir, "docs"), { recursive: true });
      await writeFile(path.join(rootDir, "outside-symlink.md"), "Outside\n", "utf8");
      await symlink(
        path.join(rootDir, "outside-symlink.md"),
        path.join(targetDir, "docs", "escaped.md"),
      );
    },
  },
] satisfies GoalPathScenario[]) {
  test(`launchDashboardRun rejects ${scenario.name} goal file paths`, async () => {
    const context = await createLauncherContext();
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-orchestrator-goal-launch-"),
    );
    const targetDir = path.join(rootDir, "target");
    try {
      await mkdir(targetDir, { recursive: true });
      await scenario.setup({ rootDir, targetDir });

      const result = await launchDashboardRun(
        {
          goalFilePath: scenario.goalFilePath,
          runner: "fake",
          dryRun: true,
        },
        {
          cwd: context.tempDir,
          targetCwd: targetDir,
          artifactRoot: ".agent-work",
          cliPath: context.cliPath,
        } as Parameters<typeof launchDashboardRun>[1] & { targetCwd: string },
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.statusCode, 400);
        assert.equal(result.error.code, "invalid_launch_request");
        assert.match(result.error.message, scenario.expected);
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
      await rm(context.tempDir, { recursive: true, force: true });
    }
  });
}

test("launchDashboardRun rejects context paths that escape by sibling prefix", async () => {
  const context = await createLauncherContext();
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-target-"));
  const siblingDir = `${targetDir}-other`;
  try {
    await mkdir(siblingDir, { recursive: true });
    await writeFile(path.join(siblingDir, "secret.md"), "outside\n", "utf8");

    const result = await launchDashboardRun(
      {
        prompt: "Add feature X",
        runner: "fake",
        dryRun: true,
        contextPaths: [
          path.relative(targetDir, path.join(siblingDir, "secret.md")),
        ],
      },
      {
        cwd: context.tempDir,
        targetCwd: targetDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      } as Parameters<typeof launchDashboardRun>[1] & { targetCwd: string },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 400);
      assert.equal(result.error.code, "invalid_launch_request");
      assert.match(result.error.message, /context/i);
    }
  } finally {
    await rm(siblingDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun rejects absolute browser context paths", async () => {
  const context = await createLauncherContext();
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-target-"));
  try {
    await writeFile(path.join(targetDir, "README.md"), "# Target\n", "utf8");

    const result = await launchDashboardRun(
      {
        prompt: "Add feature X",
        runner: "fake",
        dryRun: true,
        contextPaths: [path.join(targetDir, "README.md")],
      },
      {
        cwd: context.tempDir,
        targetCwd: targetDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      } as Parameters<typeof launchDashboardRun>[1] & { targetCwd: string },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 400);
      assert.equal(result.error.code, "invalid_launch_request");
      assert.match(result.error.message, /repository-relative/i);
    }
  } finally {
    await rm(targetDir, { recursive: true, force: true });
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun rejects absolute browser seed major plan paths", async () => {
  const context = await createLauncherContext();
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-target-"));
  try {
    const result = await launchDashboardRun(
      {
        prompt: "Add feature X",
        runner: "fake",
        dryRun: true,
        seedMajorPlanPath: path.join(targetDir, "docs", "major-plan.md"),
      },
      {
        cwd: context.tempDir,
        targetCwd: targetDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      } as Parameters<typeof launchDashboardRun>[1] & { targetCwd: string },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 400);
      assert.equal(result.error.code, "invalid_launch_request");
      assert.match(result.error.message, /repository-relative/i);
    }
  } finally {
    await rm(targetDir, { recursive: true, force: true });
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "missing",
    seedMajorPlanPath: "docs/missing-major-plan.md",
    expected: /unavailable/i,
    setup: async () => {},
  },
  {
    name: "directory",
    seedMajorPlanPath: "docs/seed-dir",
    expected: /regular file/i,
    setup: async ({ targetDir }: SeedPathScenarioContext) => {
      await mkdir(path.join(targetDir, "docs", "seed-dir"), { recursive: true });
    },
  },
  {
    name: "invalid UTF-8",
    seedMajorPlanPath: "docs/invalid.md",
    expected: /valid UTF-8/i,
    setup: async ({ targetDir }: SeedPathScenarioContext) => {
      await writeScenarioFile(targetDir, "docs/invalid.md", Buffer.from([0xff, 0xfe]));
    },
  },
  {
    name: "oversized",
    seedMajorPlanPath: "docs/oversized.md",
    expected: /size limit/i,
    setup: async ({ targetDir }: SeedPathScenarioContext) => {
      await writeScenarioFile(
        targetDir,
        "docs/oversized.md",
        Buffer.alloc(1024 * 1024 + 1, 0x61),
      );
    },
  },
  {
    name: "outside target",
    seedMajorPlanPath: "../outside-major-plan.md",
    expected: /inside the target repository/i,
    setup: async ({ rootDir }: SeedPathScenarioContext) => {
      await writeFile(path.join(rootDir, "outside-major-plan.md"), "# Outside\n", "utf8");
    },
  },
  {
    name: "sibling-prefix escape",
    seedMajorPlanPath: "../target-other/seed.md",
    expected: /inside the target repository/i,
    setup: async ({ rootDir }: SeedPathScenarioContext) => {
      await mkdir(path.join(rootDir, "target-other"), { recursive: true });
      await writeFile(path.join(rootDir, "target-other", "seed.md"), "# Outside\n", "utf8");
    },
  },
  {
    name: "symlink escape",
    seedMajorPlanPath: "docs/escaped.md",
    expected: /inside the target repository/i,
    setup: async ({ rootDir, targetDir }: SeedPathScenarioContext) => {
      await mkdir(path.join(targetDir, "docs"), { recursive: true });
      await writeFile(path.join(rootDir, "outside-symlink.md"), "# Outside\n", "utf8");
      await symlink(
        path.join(rootDir, "outside-symlink.md"),
        path.join(targetDir, "docs", "escaped.md"),
      );
    },
  },
] satisfies SeedPathScenario[]) {
  test(`launchDashboardRun rejects ${scenario.name} seed major plan paths`, async () => {
    const context = await createLauncherContext();
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-orchestrator-seed-launch-"),
    );
    const targetDir = path.join(rootDir, "target");
    try {
      await mkdir(targetDir, { recursive: true });
      await scenario.setup({ rootDir, targetDir });

      const result = await launchDashboardRun(
        {
          prompt: "Add feature X",
          runner: "fake",
          dryRun: true,
          seedMajorPlanPath: scenario.seedMajorPlanPath,
        },
        {
          cwd: context.tempDir,
          targetCwd: targetDir,
          artifactRoot: ".agent-work",
          cliPath: context.cliPath,
        } as Parameters<typeof launchDashboardRun>[1] & { targetCwd: string },
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.statusCode, 400);
        assert.equal(result.error.code, "invalid_launch_request");
        assert.match(result.error.message, scenario.expected);
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
      await rm(context.tempDir, { recursive: true, force: true });
    }
  });
}

test("launchDashboardRun rejects missing target repos before writing diagnostics", async () => {
  const context = await createLauncherContext();
  const missingTarget = path.join(context.tempDir, "missing-target");
  try {
    const result = await launchDashboardRun(
      {
        prompt: "Add feature X",
        runner: "fake",
        dryRun: true,
      },
      {
        cwd: context.tempDir,
        targetCwd: missingTarget,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      } as Parameters<typeof launchDashboardRun>[1] & { targetCwd: string },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 500);
      assert.equal(result.error.code, "target_unavailable");
    }
    await assert.rejects(stat(missingTarget));
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun allows ignored artifact roots in Git repos", async () => {
  const context = await createLauncherContext();
  const repo = await createFixtureRepo();
  try {
    const result = await launchDashboardRun(
      {
        prompt: "Add feature X",
        runner: "fake",
        dryRun: true,
      },
      {
        cwd: context.tempDir,
        targetCwd: repo.path,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      } as Parameters<typeof launchDashboardRun>[1] & { targetCwd: string },
    );

    assert.equal(result.ok, true);
  } finally {
    await repo.cleanup();
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun rejects unignored artifact roots before dirtying Git", async () => {
  const context = await createLauncherContext();
  const repo = await createFixtureRepo({ gitignore: false });
  try {
    const result = await launchDashboardRun(
      {
        prompt: "Add feature X",
        runner: "fake",
        dryRun: true,
      },
      {
        cwd: context.tempDir,
        targetCwd: repo.path,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      } as Parameters<typeof launchDashboardRun>[1] & { targetCwd: string },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 400);
      assert.equal(result.error.code, "invalid_launch_request");
      assert.match(result.error.message, /ignored by Git/i);
    }
    await assert.rejects(stat(path.join(repo.path, ".agent-work")));
  } finally {
    await repo.cleanup();
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun validates browser launch input before spawning", async () => {
  const context = await createLauncherContext();
  try {
    const result = await launchDashboardRun(
      {
        prompt: "Add feature X",
        artifactRoot: "../outside",
      },
      {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 400);
      assert.equal(result.error.code, "invalid_launch_request");
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("launchDashboardRun reports a missing built CLI clearly", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-launcher-"));
  try {
    const result = await launchDashboardRun(
      {
        prompt: "Add feature X",
        dryRun: true,
      },
      {
        cwd: tempDir,
        artifactRoot: ".agent-work",
        cliPath: "dist/cli/missing.js",
      },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 500);
      assert.equal(result.error.code, "cli_missing");
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

interface SeedPathScenarioContext {
  rootDir: string;
  targetDir: string;
}

type GoalPathScenarioContext = SeedPathScenarioContext;

interface GoalPathScenario {
  name: string;
  goalFilePath: string;
  expected: RegExp;
  setup: (context: GoalPathScenarioContext) => Promise<void>;
}

interface SeedPathScenario {
  name: string;
  seedMajorPlanPath: string;
  expected: RegExp;
  setup: (context: SeedPathScenarioContext) => Promise<void>;
}

async function writeScenarioFile(
  targetDir: string,
  relativePath: string,
  content: string | Buffer,
): Promise<void> {
  const filePath = path.join(targetDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function createLauncherContext(): Promise<{ tempDir: string; cliPath: string }> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-launcher-"));
  const cliPath = path.join(tempDir, "stub-cli.mjs");
  await writeFile(
    cliPath,
    [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      'writeFileSync(path.join(process.cwd(), "stub-args.json"), JSON.stringify(args));',
      'const valueAfter = (flag) => {',
      "  const index = args.indexOf(flag);",
      "  return index === -1 ? undefined : args[index + 1];",
      "};",
      'const runId = valueAfter("--run-id");',
      'const artifactRoot = valueAfter("--artifact-root") ?? ".agent-work";',
      'const goalFilePath = valueAfter("--goal-file");',
      'const seedMajorPlanPath = valueAfter("--seed-major-plan");',
      "const runDir = path.resolve(process.cwd(), artifactRoot, runId);",
      'if (!args.includes("--dry-run")) {',
      "  mkdirSync(runDir, { recursive: true });",
      '  writeFileSync(path.join(runDir, "state.json"), "{}\\n");',
      "}",
      "console.log(JSON.stringify({",
      '  mode: "new",',
      "  allowed: true,",
      "  exitCode: 0,",
      '  nextAction: args.includes("--dry-run")',
      '    ? seedMajorPlanPath === undefined ? "run_full_goal" : "review_seeded_major_plan"',
      '    : "ready_for_milestone",',
      "  runId,",
      "  runDir,",
      "  details: {",
      "    runId,",
      "    runDir,",
      "    runner: valueAfter('--runner') ?? null,",
      "    goalSource: goalFilePath === undefined ? 'argv' : `file:${goalFilePath}`,",
      "    majorPlanSource: seedMajorPlanPath === undefined",
      "      ? { type: 'runner', path: null }",
      "      : { type: 'seed', path: seedMajorPlanPath }",
      "  }",
      "}));",
    ].join("\n"),
    "utf8",
  );
  return { tempDir, cliPath };
}

async function writeSlowOutputCli(cwd: string): Promise<string> {
  const cliPath = path.join(cwd, "slow-output-cli.mjs");
  await writeFile(
    cliPath,
    [
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      'const valueAfter = (flag) => args[args.indexOf(flag) + 1];',
      'const runId = valueAfter("--run-id");',
      'const artifactRoot = valueAfter("--artifact-root") ?? ".agent-work";',
      "const runDir = path.resolve(process.cwd(), artifactRoot, runId);",
      'process.stderr.write("early launcher stderr\\n");',
      "setTimeout(() => {",
      "  console.log(JSON.stringify({",
      '    mode: "new",',
      "    allowed: true,",
      "    exitCode: 0,",
      '    nextAction: "ready_for_milestone",',
      "    runId,",
      "    runDir,",
      "    details: { runId, runDir }",
      "  }));",
      "}, 800);",
    ].join("\n"),
    "utf8",
  );
  return cliPath;
}

async function writeBlockedDryRunCli(cwd: string): Promise<string> {
  const cliPath = path.join(cwd, "blocked-dry-run-cli.mjs");
  await writeFile(
    cliPath,
    [
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      'const valueAfter = (flag) => args[args.indexOf(flag) + 1];',
      'const runId = valueAfter("--run-id");',
      'const artifactRoot = valueAfter("--artifact-root") ?? ".agent-work";',
      "const runDir = path.resolve(process.cwd(), artifactRoot, runId);",
      "console.log(JSON.stringify({",
      '  mode: "new",',
      "  allowed: false,",
      "  exitCode: 1,",
      '  nextAction: "blocked_dirty_tree",',
      '  warnings: ["Working tree is dirty. Re-run with --allow-dirty only if intentional."],',
      "  runId,",
      "  runDir,",
      "  details: { runId, runDir, runner: valueAfter('--runner') ?? null, gitDirty: true }",
      "}));",
      "process.exitCode = 1;",
    ].join("\n"),
    "utf8",
  );
  return cliPath;
}

async function writeConcurrentStubCli(cwd: string): Promise<string> {
  const cliPath = path.join(cwd, "concurrent-stub-cli.mjs");
  await writeFile(
    cliPath,
    [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      'const valueAfter = (flag) => args[args.indexOf(flag) + 1];',
      'const runId = valueAfter("--run-id");',
      'const artifactRoot = valueAfter("--artifact-root") ?? ".agent-work";',
      "const runDir = path.resolve(process.cwd(), artifactRoot, runId);",
      "mkdirSync(runDir, { recursive: true });",
      'writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ runId }) + "\\n");',
      'writeFileSync(path.join(runDir, "stub-args.json"), JSON.stringify(args));',
      "setTimeout(() => {",
      "  console.log(JSON.stringify({",
      '    mode: "new",',
      "    allowed: true,",
      "    exitCode: 0,",
      '    nextAction: "ready_for_milestone",',
      "    runId,",
      "    runDir,",
      "    details: { runId, runDir }",
      "  }));",
      "}, 300);",
    ].join("\n"),
    "utf8",
  );
  return cliPath;
}

async function waitForDiagnostics(
  filePath: string,
  predicate: (diagnostics: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < 3000) {
    try {
      const diagnostics = JSON.parse(
        await readFile(filePath, "utf8"),
      ) as Record<string, unknown>;
      if (predicate(diagnostics)) return diagnostics;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.fail(`Timed out waiting for diagnostics ${filePath}: ${String(lastError)}`);
}

function valuesAfterRepeated(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && index + 1 < args.length) {
      values.push(args[index + 1] ?? "");
    }
  }
  return values;
}

async function waitForFile(filePath: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    try {
      await stat(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.fail(`Timed out waiting for ${filePath}`);
}
