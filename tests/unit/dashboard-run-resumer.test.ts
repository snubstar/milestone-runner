import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRunPaths, type RunPaths } from "../../src/artifacts/paths.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import {
  dryRunDashboardResume,
  resumeDashboardRun,
} from "../../src/dashboard/run-resumer.js";
import { createInitialState } from "../../src/state/initial-state.js";
import { writeState } from "../../src/state/state-store.js";
import type { RunState } from "../../src/state/state-types.js";
import { defaultTestConfig } from "../helpers/run-fixture.js";

test("dryRunDashboardResume stores an allowed resume dry-run confirmation", async () => {
  const context = await createResumerContext();
  try {
    await createResumeRun(context.tempDir, "run-1");
    const result = await dryRunDashboardResume(
      "run-1",
      {
        allowDirty: true,
        milestonePlanPolicy: "auto",
        milestonePlanReviewPolicy: "scrupulous",
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
      assert.equal(result.response.allowed, true);
      assert.equal(result.response.nextAction, "continue_milestone");
      assert.equal(typeof result.response.confirmationToken, "string");
      assert.equal(result.response.options.allowDirty, true);
      assert.equal(result.response.options.milestonePlanPolicy, "auto");

      const record = JSON.parse(
        await readFile(
          path.join(
            context.tempDir,
            ".agent-work",
            "dashboard-resumes",
            `${result.response.resumeId}.json`,
          ),
          "utf8",
        ),
      ) as { runId: string; consumedAt: string | null; expiresAt: string };
      assert.equal(record.runId, "run-1");
      assert.equal(record.consumedAt, null);
      assert.equal(Date.parse(record.expiresAt) > Date.now(), true);

      const args = JSON.parse(
        await readFile(path.join(context.tempDir, "resume-dry-run-args.json"), "utf8"),
      ) as string[];
      assert.equal(args.includes("--json"), true);
      assert.equal(args.includes("--dry-run"), true);
      assert.equal(args.includes("--resume"), true);
      assert.equal(args.includes("run-1"), true);
      assert.equal(args.includes("--run-id"), false);
      assert.equal(args.includes("--allow-dirty"), true);
      assert.equal(args.includes("--milestone-plan-policy"), true);
      assert.equal(args.includes("--milestone-plan-review-policy"), true);
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dryRunDashboardResume reads runs from target repo and forwards --repo", async () => {
  const context = await createResumerContext();
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-target-"));
  try {
    await createResumeRun(targetDir, "run-1");
    const canonicalTargetDir = await realpath(targetDir);
    const result = await dryRunDashboardResume(
      "run-1",
      { allowDirty: true },
      {
        cwd: context.tempDir,
        targetCwd: targetDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      } as Parameters<typeof dryRunDashboardResume>[2] & { targetCwd: string },
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      const args = JSON.parse(
        await readFile(path.join(context.tempDir, "resume-dry-run-args.json"), "utf8"),
      ) as string[];
      assert.equal(args.includes("--repo"), true);
      assert.equal(args[args.indexOf("--repo") + 1], canonicalTargetDir);
      assert.equal(args.includes("--resume"), true);
      assert.equal(args.includes("run-1"), true);

      const diagnostics = JSON.parse(
        await readFile(
          path.join(targetDir, ".agent-work", result.response.diagnosticsPath),
          "utf8",
        ),
      ) as { cwd?: string; targetCwd?: string };
      assert.equal(diagnostics.cwd, context.tempDir);
      assert.equal(diagnostics.targetCwd, canonicalTargetDir);
    }
  } finally {
    await rm(targetDir, { recursive: true, force: true });
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("resumeDashboardRun consumes one allowed dry-run confirmation", async () => {
  const context = await createResumerContext();
  try {
    await createResumeRun(context.tempDir, "run-1");
    const dryRun = await dryRunDashboardResume(
      "run-1",
      {
        allowDirty: true,
        milestone: 2,
        milestonePlanPolicy: "light",
      },
      {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      },
    );
    assert.equal(dryRun.ok, true);
    if (!dryRun.ok) return;

    const result = await resumeDashboardRun(
      "run-1",
      {
        resumeId: dryRun.response.resumeId,
        confirmationToken: dryRun.response.confirmationToken,
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
      assert.equal(result.response.runId, "run-1");
    }

    const resumeArgsPath = path.join(context.tempDir, "resume-args.json");
    await waitForFile(resumeArgsPath);
    const args = JSON.parse(await readFile(resumeArgsPath, "utf8")) as string[];
    assert.equal(args.includes("--dry-run"), false);
    assert.equal(args.includes("--resume"), true);
    assert.equal(args.includes("run-1"), true);
    assert.equal(args.includes("--allow-dirty"), true);
    assert.equal(args.includes("--milestone"), true);
    assert.equal(args.includes("2"), true);

    if (result.ok) {
      await waitForDiagnostics(
        path.join(context.tempDir, ".agent-work", result.response.diagnosticsPath),
        (diagnostics) => diagnostics.status === "completed",
      );
    }

    const second = await resumeDashboardRun(
      "run-1",
      {
        resumeId: dryRun.response.resumeId,
        confirmationToken: dryRun.response.confirmationToken,
      },
      {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      },
    );
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.statusCode, 409);
      assert.equal(second.error.code, "resume_confirmation_rejected");
    }

    const record = JSON.parse(
      await readFile(
        path.join(
          context.tempDir,
          ".agent-work",
          "dashboard-resumes",
          `${dryRun.response.resumeId}.json`,
        ),
        "utf8",
      ),
    ) as { consumedAt: string | null };
    assert.equal(typeof record.consumedAt, "string");
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("resumeDashboardRun rejects calls without a matching dry-run record", async () => {
  const context = await createResumerContext();
  try {
    await createResumeRun(context.tempDir, "run-1");
    const result = await resumeDashboardRun(
      "run-1",
      {
        resumeId: "resume-20260510120000000-missing",
        confirmationToken: "token",
      },
      {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 404);
      assert.equal(result.error.code, "resume_dry_run_not_found");
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("resumeDashboardRun rejects a dry-run token after run state changes", async () => {
  const context = await createResumerContext();
  try {
    const paths = await createResumeRun(context.tempDir, "run-1");
    const dryRun = await dryRunDashboardResume(
      "run-1",
      { allowDirty: true },
      {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      },
    );
    assert.equal(dryRun.ok, true);
    if (!dryRun.ok) return;

    const rawState = JSON.parse(await readFile(paths.files.state, "utf8")) as RunState;
    await writeState(paths.files.state, {
      ...rawState,
      currentPhase: "needs_human_review",
      status: "needs_human_review",
      updatedAt: new Date("2026-05-10T12:01:00.000Z").toISOString(),
    });

    const result = await resumeDashboardRun(
      "run-1",
      {
        resumeId: dryRun.response.resumeId,
        confirmationToken: dryRun.response.confirmationToken,
      },
      {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 409);
      assert.equal(result.error.code, "resume_state_mismatch");
      assert.match(result.error.message, /state has changed/i);
    }
    assert.equal(
      await fileExists(path.join(context.tempDir, "resume-args.json")),
      false,
    );
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("resumeDashboardRun atomically allows only one concurrent token use", async () => {
  const context = await createResumerContext();
  try {
    await createResumeRun(context.tempDir, "run-1");
    const dryRun = await dryRunDashboardResume(
      "run-1",
      { allowDirty: true },
      {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      },
    );
    assert.equal(dryRun.ok, true);
    if (!dryRun.ok) return;

    const requests = await Promise.all([
      resumeDashboardRun(
        "run-1",
        {
          resumeId: dryRun.response.resumeId,
          confirmationToken: dryRun.response.confirmationToken,
        },
        {
          cwd: context.tempDir,
          artifactRoot: ".agent-work",
          cliPath: context.cliPath,
        },
      ),
      resumeDashboardRun(
        "run-1",
        {
          resumeId: dryRun.response.resumeId,
          confirmationToken: dryRun.response.confirmationToken,
        },
        {
          cwd: context.tempDir,
          artifactRoot: ".agent-work",
          cliPath: context.cliPath,
        },
      ),
    ]);

    const started = requests.filter((result) => result.ok);
    const rejected = requests.filter((result) => !result.ok);
    assert.equal(started.length, 1);
    assert.equal(rejected.length, 1);
    const rejectedResult = rejected[0];
    assert.equal(rejectedResult?.ok, false);
    if (rejectedResult && !rejectedResult.ok) {
      assert.equal(rejectedResult.statusCode, 409);
      assert.equal(rejectedResult.error.code, "resume_confirmation_rejected");
    }

    const startedResult = started[0];
    assert.equal(startedResult?.ok, true);
    if (startedResult?.ok) {
      await waitForDiagnostics(
        path.join(context.tempDir, ".agent-work", startedResult.response.diagnosticsPath),
        (diagnostics) => diagnostics.status === "completed",
      );
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("resumeDashboardRun reports immediate process spawn failures", async () => {
  const context = await createResumerContext();
  try {
    await createResumeRun(context.tempDir, "run-1");
    const dryRun = await dryRunDashboardResume(
      "run-1",
      { allowDirty: true },
      {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
      },
    );
    assert.equal(dryRun.ok, true);
    if (!dryRun.ok) return;

    const result = await resumeDashboardRun(
      "run-1",
      {
        resumeId: dryRun.response.resumeId,
        confirmationToken: dryRun.response.confirmationToken,
      },
      {
        cwd: context.tempDir,
        artifactRoot: ".agent-work",
        cliPath: context.cliPath,
        nodePath: path.join(context.tempDir, "missing-node"),
      },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 502);
      assert.equal(result.error.code, "resume_spawn_failed");
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

async function createResumerContext(): Promise<{ tempDir: string; cliPath: string }> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-resumer-"));
  const cliPath = await writeResumeStubCli(tempDir);
  return { tempDir, cliPath };
}

async function createResumeRun(cwd: string, runId: string): Promise<RunPaths> {
  const paths = buildRunPaths({
    cwd,
    artifactRoot: ".agent-work",
    runId,
  });
  await createRunDirectory(paths, "Resume dashboard run");
  const state = createInitialState({
    runId,
    goal: "Resume dashboard run",
    paths,
    git: {
      required: false,
      planningOnly: true,
      root: null,
      startSha: null,
      dirtyAtStart: false,
      dirtyOverride: false,
      statusPorcelain: "",
    },
    configPath: null,
    configSnapshot: defaultTestConfig(),
    now: new Date("2026-05-10T12:00:00.000Z"),
  });
  const resumeState: RunState = {
    ...state,
    currentPhase: "ready_for_milestone",
    status: "ready_for_milestone",
    currentMilestoneId: 1,
    milestoneStatuses: { "1": "planned", "2": "pending" },
  };
  await writeState(paths.files.state, resumeState);
  return paths;
}

async function writeResumeStubCli(cwd: string): Promise<string> {
  const cliPath = path.join(cwd, "resume-stub-cli.mjs");
  await writeFile(
    cliPath,
    [
      'import { writeFileSync } from "node:fs";',
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      'const valueAfter = (flag) => args[args.indexOf(flag) + 1];',
      'const dryRun = args.includes("--dry-run");',
      'const runId = valueAfter("--resume");',
      'const artifactRoot = valueAfter("--artifact-root") ?? ".agent-work";',
      "const runDir = path.resolve(process.cwd(), artifactRoot, runId);",
      'writeFileSync(path.join(process.cwd(), dryRun ? "resume-dry-run-args.json" : "resume-args.json"), JSON.stringify(args));',
      'const planPolicy = valueAfter("--milestone-plan-policy") ?? "always";',
      'const reviewPolicy = valueAfter("--milestone-plan-review-policy") ?? "normal";',
      "console.log(JSON.stringify({",
      '  mode: "resume",',
      "  allowed: true,",
      "  exitCode: 0,",
      '  nextAction: "continue_milestone",',
      '  warnings: ["dry warning"],',
      "  runId,",
      "  runDir,",
      "  details: {",
      "    runId,",
      "    runDir,",
      "    allowDirty: args.includes('--allow-dirty'),",
      "    targetMilestone: valueAfter('--milestone') ? Number(valueAfter('--milestone')) : null,",
      "    milestonePlanPolicy: planPolicy,",
      '    savedMilestonePlanPolicy: "always",',
      "    milestonePlanReviewPolicy: reviewPolicy,",
      '    savedMilestonePlanReviewPolicy: "normal"',
      "  }",
      "}));",
    ].join("\n"),
    "utf8",
  );
  return cliPath;
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
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
