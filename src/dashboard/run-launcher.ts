import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { buildRunPaths, createRunId, isSafeRunId } from "../artifacts/paths.js";
import type {
  DashboardError,
  DashboardLaunchResponse,
  DashboardLaunchRunner,
  DashboardMilestonePlanPolicy,
  DashboardMilestonePlanReviewPolicy,
} from "./api-types.js";
import {
  type DashboardCliDiagnostics,
  formatError,
  parseCliJsonReport,
  runDashboardCliToCompletion,
  spawnDashboardCliProcess,
  writeDashboardCliDiagnostics,
} from "./cli-process.js";

export interface DashboardRunLauncherOptions {
  cwd: string;
  artifactRoot: string;
  cliPath?: string;
  nodePath?: string;
  now?: () => Date;
}

export type DashboardRunLauncherResult =
  | {
      ok: true;
      statusCode: 200 | 202;
      response: DashboardLaunchResponse;
    }
  | {
      ok: false;
      statusCode: 400 | 500 | 502;
      error: DashboardError;
    };

interface NormalizedLaunchRequest {
  prompt: string;
  runner?: DashboardLaunchRunner;
  dryRun: boolean;
  milestone?: number;
  milestonePlanPolicy?: DashboardMilestonePlanPolicy;
  milestonePlanReviewPolicy?: DashboardMilestonePlanReviewPolicy;
  allowDirty: boolean;
  allowNonGitPlanning: boolean;
  artifactRoot: string;
}

const runners = new Set<DashboardLaunchRunner>(["fake", "codex-exec"]);
const milestonePlanPolicies = new Set<DashboardMilestonePlanPolicy>([
  "always",
  "auto",
  "light",
]);
const milestonePlanReviewPolicies = new Set<DashboardMilestonePlanReviewPolicy>([
  "normal",
  "scrupulous",
]);

export async function launchDashboardRun(
  input: unknown,
  options: DashboardRunLauncherOptions,
): Promise<DashboardRunLauncherResult> {
  const request = normalizeLaunchRequest(input, options.artifactRoot);
  if (!request.ok) return request;

  const cliPath = path.resolve(options.cwd, options.cliPath ?? "dist/cli/main.js");
  if (!(await fileExists(cliPath))) {
    return {
      ok: false,
      statusCode: 500,
      error: {
        code: "cli_missing",
        message: "Built CLI entrypoint was not found. Run npm run build before launching tasks.",
        details: { cliPath },
      },
    };
  }

  const runId = await createUniqueRunId({
    cwd: options.cwd,
    artifactRoot: request.value.artifactRoot,
    now: options.now,
  });
  const paths = buildRunPaths({
    cwd: options.cwd,
    artifactRoot: request.value.artifactRoot,
    runId,
  });
  const launchId = createLaunchId(options.now?.() ?? new Date());
  const diagnosticsPath = path.join("dashboard-launches", `${launchId}.json`);
  const diagnosticsFile = path.resolve(
    options.cwd,
    request.value.artifactRoot,
    diagnosticsPath,
  );
  const command = options.nodePath ?? process.execPath;
  const cliArgs = buildCliArgs(request.value, runId);
  const args = [cliPath, ...cliArgs];
  const diagnostics: DashboardCliDiagnostics = {
    launchId,
    runId,
    runDir: paths.runDir,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dryRun: request.value.dryRun,
    status: request.value.dryRun ? "starting" : "running",
    command,
    args,
    cwd: options.cwd,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
  };

  await writeDashboardCliDiagnostics(diagnosticsFile, diagnostics);

  if (request.value.dryRun) {
    return runDryLaunch({
      command,
      args,
      cwd: options.cwd,
      diagnostics,
      diagnosticsFile,
      diagnosticsPath,
    });
  }

  const spawnResult = await spawnDashboardCliProcess({
    command,
    args,
    cwd: options.cwd,
    diagnostics,
    diagnosticsFile,
    diagnosticsPath,
  });
  if (!spawnResult.ok) {
    return {
      ok: false,
      statusCode: 502,
      error: {
        code: "launch_spawn_failed",
        message: "Failed to start the CLI process.",
        details: spawnResult.error,
      },
    };
  }

  return {
    ok: true,
    statusCode: 202,
    response: {
      launchId,
      runId,
      runDir: paths.runDir,
      dryRun: false,
      started: true,
      exitCode: null,
      report: null,
      diagnosticsPath,
    },
  };
}

function normalizeLaunchRequest(
  input: unknown,
  defaultArtifactRoot: string,
):
  | { ok: true; value: NormalizedLaunchRequest }
  | { ok: false; statusCode: 400; error: DashboardError } {
  if (!isRecord(input)) {
    return invalidLaunch("Launch request must be a JSON object.");
  }

  const prompt = stringField(input.prompt)?.trim();
  if (!prompt) return invalidLaunch("Launch prompt is required.");
  if (prompt.length > 20_000) {
    return invalidLaunch("Launch prompt is too long.", { maxLength: 20_000 });
  }

  const runner = optionalEnum(input.runner, runners, "runner");
  if (!runner.ok) return invalidLaunch(runner.error);

  const milestone = optionalPositiveInteger(input.milestone, "milestone");
  if (!milestone.ok) return invalidLaunch(milestone.error);

  const milestonePlanPolicy = optionalEnum(
    input.milestonePlanPolicy,
    milestonePlanPolicies,
    "milestonePlanPolicy",
  );
  if (!milestonePlanPolicy.ok) return invalidLaunch(milestonePlanPolicy.error);

  const milestonePlanReviewPolicy = optionalEnum(
    input.milestonePlanReviewPolicy,
    milestonePlanReviewPolicies,
    "milestonePlanReviewPolicy",
  );
  if (!milestonePlanReviewPolicy.ok) {
    return invalidLaunch(milestonePlanReviewPolicy.error);
  }

  const artifactRootResult = normalizeArtifactRoot(
    stringField(input.artifactRoot) ?? defaultArtifactRoot,
  );
  if (!artifactRootResult.ok) return invalidLaunch(artifactRootResult.error);

  return {
    ok: true,
    value: {
      prompt,
      runner: runner.value,
      dryRun: booleanField(input.dryRun, false),
      milestone: milestone.value,
      milestonePlanPolicy: milestonePlanPolicy.value,
      milestonePlanReviewPolicy: milestonePlanReviewPolicy.value,
      allowDirty: booleanField(input.allowDirty, false),
      allowNonGitPlanning: booleanField(input.allowNonGitPlanning, false),
      artifactRoot: artifactRootResult.value,
    },
  };
}

function buildCliArgs(request: NormalizedLaunchRequest, runId: string): string[] {
  const args = [
    "--json",
    "--run-id",
    runId,
    "--artifact-root",
    request.artifactRoot,
  ];

  if (request.dryRun) args.push("--dry-run");
  if (request.allowDirty) args.push("--allow-dirty");
  if (request.allowNonGitPlanning) args.push("--allow-non-git-planning");
  if (request.runner) args.push("--runner", request.runner);
  if (request.milestone !== undefined) args.push("--milestone", String(request.milestone));
  if (request.milestonePlanPolicy) {
    args.push("--milestone-plan-policy", request.milestonePlanPolicy);
  }
  if (request.milestonePlanReviewPolicy) {
    args.push("--milestone-plan-review-policy", request.milestonePlanReviewPolicy);
  }

  args.push("--", request.prompt);
  return args;
}

async function runDryLaunch(options: {
  command: string;
  args: string[];
  cwd: string;
  diagnostics: DashboardCliDiagnostics;
  diagnosticsFile: string;
  diagnosticsPath: string;
}): Promise<DashboardRunLauncherResult> {
  const result = await runDashboardCliToCompletion({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
  });

  if (!result.ok) {
    options.diagnostics.status = "spawn_failed";
    options.diagnostics.updatedAt = new Date().toISOString();
    options.diagnostics.error = result.error;
    await writeDashboardCliDiagnostics(
      options.diagnosticsFile,
      options.diagnostics,
    );
    return {
      ok: false,
      statusCode: 502,
      error: {
        code: "launch_spawn_failed",
        message: "Failed to start the CLI process.",
        details: result.error,
      },
    };
  }

  const report = parseCliJsonReport(result.stdout);
  options.diagnostics.status = "completed";
  options.diagnostics.updatedAt = new Date().toISOString();
  options.diagnostics.exitCode = result.exitCode;
  options.diagnostics.signal = result.signal;
  options.diagnostics.stdout = result.stdout;
  options.diagnostics.stderr = result.stderr;
  if (report.ok) {
    options.diagnostics.report = report.value;
  } else {
    options.diagnostics.error = report.error;
  }
  await writeDashboardCliDiagnostics(options.diagnosticsFile, options.diagnostics);

  if (!report.ok) {
    return {
      ok: false,
      statusCode: 502,
      error: {
        code: "launch_report_malformed",
        message: "CLI dry-run JSON report was missing or malformed.",
        details: {
          error: report.error,
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      },
    };
  }

  return {
    ok: true,
    statusCode: 200,
    response: {
      launchId: options.diagnostics.launchId,
      runId: options.diagnostics.runId,
      runDir: options.diagnostics.runDir,
      dryRun: true,
      started: false,
      exitCode: result.exitCode,
      report: report.value,
      diagnosticsPath: options.diagnosticsPath,
    },
  };
}

async function createUniqueRunId(options: {
  cwd: string;
  artifactRoot: string;
  now?: () => Date;
}): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const runId = createRunId(options.now?.() ?? new Date());
    if (!isSafeRunId(runId)) continue;
    const paths = buildRunPaths({
      cwd: options.cwd,
      artifactRoot: options.artifactRoot,
      runId,
    });
    if (!(await fileExists(paths.runDir))) return runId;
  }

  throw new Error("Failed to create a unique dashboard run id.");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNoEntryError(error)) return false;
    throw error;
  }
}

function createLaunchId(date: Date): string {
  return `launch-${date.toISOString().replace(/\D/g, "")}-${randomBytes(4).toString("hex")}`;
}

function normalizeArtifactRoot(
  artifactRoot: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = artifactRoot.trim();
  if (!trimmed) return { ok: false, error: "artifactRoot must not be empty." };
  if (path.isAbsolute(trimmed)) {
    return { ok: false, error: "artifactRoot must be a relative path." };
  }

  const normalized = path.normalize(trimmed).replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    segments.some((segment) => segment === ".." || segment.length === 0)
  ) {
    return {
      ok: false,
      error: "artifactRoot must stay inside the dashboard working directory.",
    };
  }

  return { ok: true, value: normalized };
}

function invalidLaunch(
  message: string,
  details?: unknown,
): { ok: false; statusCode: 400; error: DashboardError } {
  return {
    ok: false,
    statusCode: 400,
    error: {
      code: "invalid_launch_request",
      message,
      details,
    },
  };
}

function optionalEnum<T extends string>(
  value: unknown,
  values: Set<T>,
  fieldName: string,
): { ok: true; value?: T } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || !values.has(value as T)) {
    return {
      ok: false,
      error: `${fieldName} has an unsupported value.`,
    };
  }
  return { ok: true, value: value as T };
}

function optionalPositiveInteger(
  value: unknown,
  fieldName: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true };
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    return {
      ok: false,
      error: `${fieldName} must be a positive integer.`,
    };
  }
  return { ok: true, value };
}

function booleanField(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNoEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
