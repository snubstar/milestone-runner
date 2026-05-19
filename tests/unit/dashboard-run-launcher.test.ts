import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { launchDashboardRun } from "../../src/dashboard/run-launcher.js";

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
      'const valueAfter = (flag) => args[args.indexOf(flag) + 1];',
      'const runId = valueAfter("--run-id");',
      'const artifactRoot = valueAfter("--artifact-root") ?? ".agent-work";',
      "const runDir = path.resolve(process.cwd(), artifactRoot, runId);",
      'if (!args.includes("--dry-run")) {',
      "  mkdirSync(runDir, { recursive: true });",
      '  writeFileSync(path.join(runDir, "state.json"), "{}\\n");',
      "}",
      "console.log(JSON.stringify({",
      '  mode: "new",',
      "  allowed: true,",
      "  exitCode: 0,",
      '  nextAction: args.includes("--dry-run") ? "run_full_goal" : "ready_for_milestone",',
      "  runId,",
      "  runDir,",
      "  details: { runId, runDir, runner: valueAfter('--runner') ?? null }",
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
