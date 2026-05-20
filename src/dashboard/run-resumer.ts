import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { isSafeRunId } from "../artifacts/paths.js";
import type {
  DashboardError,
  DashboardMilestonePlanPolicy,
  DashboardMilestonePlanReviewPolicy,
  DashboardResumeDryRunResponse,
  DashboardResumeResponse,
} from "./api-types.js";
import {
  type DashboardCliDiagnostics,
  formatError,
  parseCliJsonReport,
  runDashboardCliToCompletion,
  spawnDashboardCliProcess,
  writeDashboardCliDiagnostics,
} from "./cli-process.js";
import {
  resolveDashboardTargetCwd,
  validateDashboardArtifactRootForRead,
  validateDashboardArtifactRootForWrite,
} from "./dashboard-safety.js";
import { readDashboardRun } from "./run-reader.js";

export interface DashboardRunResumerOptions {
  cwd: string;
  targetCwd?: string;
  artifactRoot: string;
  cliPath?: string;
  nodePath?: string;
  now?: () => Date;
}

export type DashboardResumeDryRunResult =
  | {
      ok: true;
      statusCode: 200;
      response: DashboardResumeDryRunResponse;
    }
  | {
      ok: false;
      statusCode: 400 | 404 | 409 | 500 | 502;
      error: DashboardError;
    };

export type DashboardResumeResult =
  | {
      ok: true;
      statusCode: 202;
      response: DashboardResumeResponse;
    }
  | {
      ok: false;
      statusCode: 400 | 404 | 409 | 500 | 502;
      error: DashboardError;
    };

interface NormalizedResumeOptions {
  allowDirty: boolean;
  allowNonGitPlanning: boolean;
  milestone?: number;
  milestonePlanPolicy?: DashboardMilestonePlanPolicy;
  milestonePlanReviewPolicy?: DashboardMilestonePlanReviewPolicy;
}

interface ResumeDryRunReportSummary {
  allowed: boolean;
  exitCode: number;
  nextAction: string;
  warnings: string[];
  report: unknown;
}

interface StoredResumeDryRun extends DashboardResumeDryRunResponse {
  artifactRoot: string;
  consumedAt: string | null;
  stateFingerprint: StateFingerprint;
}

interface NormalizedResumeRequest {
  resumeId: string;
  confirmationToken: string;
}

interface StateFingerprint {
  algorithm: "sha256";
  hash: string;
  sizeBytes: number;
}

const milestonePlanPolicies = new Set<DashboardMilestonePlanPolicy>([
  "always",
  "auto",
  "light",
]);
const milestonePlanReviewPolicies = new Set<DashboardMilestonePlanReviewPolicy>([
  "normal",
  "scrupulous",
]);
const resumeDryRunTtlMs = 5 * 60 * 1000;

export async function dryRunDashboardResume(
  runId: string,
  input: unknown,
  options: DashboardRunResumerOptions,
): Promise<DashboardResumeDryRunResult> {
  const targetResult = await resolveDashboardTargetCwd(options);
  if (!targetResult.ok) return resumeServerError("target_unavailable", targetResult.error);
  const targetCwd = targetResult.value;
  const safeRunId = normalizeRunId(runId);
  if (!safeRunId.ok) return safeRunId;

  const request = normalizeResumeOptions(input);
  if (!request.ok) return request;
  const artifactRootSafety = await validateDashboardArtifactRootForWrite({
    targetCwd,
    artifactRoot: options.artifactRoot,
    allowDirty: request.value.allowDirty,
  });
  if (!artifactRootSafety.ok) return invalidResumeRequest(artifactRootSafety.error);
  const artifactRoot = artifactRootSafety.value;

  const run = await readDashboardRun({
    cwd: targetCwd,
    artifactRoot,
    runId: safeRunId.value,
  });
  if (!run.ok) {
    return { ok: false, statusCode: 404, error: run.error };
  }
  const stateFingerprintBefore = await readStateFingerprint(run.run.statePath);

  const cliPath = path.resolve(options.cwd, options.cliPath ?? "dist/cli/main.js");
  if (!(await fileExists(cliPath))) {
    return {
      ok: false,
      statusCode: 500,
      error: {
        code: "cli_missing",
        message: "Built CLI entrypoint was not found. Run npm run build before resuming tasks.",
        details: { cliPath },
      },
    };
  }

  const now = options.now?.() ?? new Date();
  const resumeId = createResumeId(now);
  const diagnosticsPath = path.join("dashboard-resumes", `${resumeId}-diagnostics.json`);
  const diagnosticsFile = path.resolve(targetCwd, artifactRoot, diagnosticsPath);
  const command = options.nodePath ?? process.execPath;
  const args = [
    cliPath,
    ...buildResumeCliArgs({
      runId: safeRunId.value,
      targetCwd,
      artifactRoot,
      dryRun: true,
      options: request.value,
    }),
  ];
  const diagnostics: DashboardCliDiagnostics = {
    launchId: resumeId,
    runId: safeRunId.value,
    runDir: run.run.runDir,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    dryRun: true,
    status: "starting",
    command,
    args,
    cwd: options.cwd,
    targetCwd,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
  };

  await writeDashboardCliDiagnostics(diagnosticsFile, diagnostics);

  const result = await runDashboardCliToCompletion({
    command,
    args,
    cwd: options.cwd,
  });

  if (!result.ok) {
    diagnostics.status = "spawn_failed";
    diagnostics.updatedAt = new Date().toISOString();
    diagnostics.error = result.error;
    await writeDashboardCliDiagnostics(diagnosticsFile, diagnostics);
    return {
      ok: false,
      statusCode: 502,
      error: {
        code: "resume_spawn_failed",
        message: "Failed to start the CLI resume dry run.",
        details: result.error,
      },
    };
  }

  const report = parseResumeDryRunReport(result.stdout);
  diagnostics.status = "completed";
  diagnostics.updatedAt = new Date().toISOString();
  diagnostics.exitCode = result.exitCode;
  diagnostics.signal = result.signal;
  diagnostics.stdout = result.stdout;
  diagnostics.stderr = result.stderr;
  if (report.ok) {
    diagnostics.report = report.value.report;
  } else {
    diagnostics.error = report.error;
  }
  await writeDashboardCliDiagnostics(diagnosticsFile, diagnostics);

  if (!report.ok) {
    return {
      ok: false,
      statusCode: 502,
      error: {
        code: "resume_report_malformed",
        message: "CLI resume dry-run JSON report was missing or malformed.",
        details: {
          error: report.error,
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      },
    };
  }

  const stateFingerprintAfter = await readStateFingerprint(run.run.statePath);
  if (!sameStateFingerprint(stateFingerprintBefore, stateFingerprintAfter)) {
    return invalidResumeState(
      "Run state changed while the resume dry run was being evaluated. Run the dry run again.",
    );
  }

  const expiresAt = new Date(now.getTime() + resumeDryRunTtlMs).toISOString();
  const record: StoredResumeDryRun = {
    resumeId,
    runId: safeRunId.value,
    runDir: run.run.runDir,
    allowed: report.value.allowed,
    exitCode: report.value.exitCode,
    nextAction: report.value.nextAction,
    warnings: report.value.warnings,
    options: request.value,
    report: report.value.report,
    confirmationToken: createConfirmationToken(),
    createdAt: now.toISOString(),
    expiresAt,
    diagnosticsPath,
    artifactRoot,
    consumedAt: null,
    stateFingerprint: stateFingerprintAfter,
  };
  await writeResumeDryRunRecord({ ...options, targetCwd, artifactRoot }, record);

  return {
    ok: true,
    statusCode: 200,
    response: responseFromRecord(record),
  };
}

export async function resumeDashboardRun(
  runId: string,
  input: unknown,
  options: DashboardRunResumerOptions,
): Promise<DashboardResumeResult> {
  const targetResult = await resolveDashboardTargetCwd(options);
  if (!targetResult.ok) return resumeServerError("target_unavailable", targetResult.error);
  const targetCwd = targetResult.value;
  const safeRunId = normalizeRunId(runId);
  if (!safeRunId.ok) return safeRunId;

  const request = normalizeResumeRequest(input);
  if (!request.ok) return request;
  const readSafety = await validateDashboardArtifactRootForRead({
    targetCwd,
    artifactRoot: options.artifactRoot,
  });
  if (!readSafety.ok) return invalidResumeState(readSafety.error);
  const artifactRoot = readSafety.value;

  const recordResult = await readResumeDryRunRecord(
    { ...options, targetCwd, artifactRoot },
    request.value.resumeId,
  );
  if (!recordResult.ok) return recordResult;
  let record = recordResult.record;

  if (record.runId !== safeRunId.value || record.artifactRoot !== artifactRoot) {
    return invalidResumeState("Resume dry-run record does not match this run.");
  }
  const writeSafety = await validateDashboardArtifactRootForWrite({
    targetCwd,
    artifactRoot,
    allowDirty: record.options.allowDirty,
  });
  if (!writeSafety.ok) return invalidResumeState(writeSafety.error);

  const claim = await acquireResumeDryRunClaim(
    { ...options, targetCwd, artifactRoot },
    record.resumeId,
  );
  if (!claim.ok) return claim;

  let consumed = false;
  try {
    const latestRecordResult = await readResumeDryRunRecord(
      { ...options, targetCwd, artifactRoot },
      request.value.resumeId,
    );
    if (!latestRecordResult.ok) return latestRecordResult;
    record = latestRecordResult.record;

    if (record.runId !== safeRunId.value || record.artifactRoot !== artifactRoot) {
      return invalidResumeState("Resume dry-run record does not match this run.");
    }
    if (record.consumedAt !== null) {
      consumed = true;
      return resumeConflict("Resume confirmation token has already been used.");
    }
    if (Date.parse(record.expiresAt) <= (options.now?.() ?? new Date()).getTime()) {
      return resumeConflict("Resume confirmation token has expired.");
    }
    if (record.confirmationToken !== request.value.confirmationToken) {
      return resumeConflict("Resume confirmation token is invalid.");
    }
    if (!record.allowed) {
      return resumeConflict("Resume dry run did not allow a real resume.");
    }

    const run = await readDashboardRun({
      cwd: targetCwd,
      artifactRoot,
      runId: safeRunId.value,
    });
    if (!run.ok) {
      return { ok: false, statusCode: 404, error: run.error };
    }

    const stateFingerprint = await readStateFingerprint(run.run.statePath);
    if (!sameStateFingerprint(record.stateFingerprint, stateFingerprint)) {
      return invalidResumeState(
        "Run state has changed since the resume dry run. Run the dry run again.",
      );
    }

    const cliPath = path.resolve(options.cwd, options.cliPath ?? "dist/cli/main.js");
    if (!(await fileExists(cliPath))) {
      return {
        ok: false,
        statusCode: 500,
        error: {
          code: "cli_missing",
          message: "Built CLI entrypoint was not found. Run npm run build before resuming tasks.",
          details: { cliPath },
        },
      };
    }

    const now = options.now?.() ?? new Date();
    const command = options.nodePath ?? process.execPath;
    const launchId = createResumeLaunchId(now);
    const diagnosticsPath = path.join("dashboard-launches", `${launchId}.json`);
    const diagnosticsFile = path.resolve(targetCwd, artifactRoot, diagnosticsPath);
    const args = [
      cliPath,
      ...buildResumeCliArgs({
        runId: safeRunId.value,
        targetCwd,
        artifactRoot,
        dryRun: false,
        options: record.options,
      }),
    ];
    const diagnostics: DashboardCliDiagnostics = {
      launchId,
      runId: safeRunId.value,
      runDir: run.run.runDir,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      dryRun: false,
      status: "running",
      command,
      args,
      cwd: options.cwd,
      targetCwd,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
    };

    await writeDashboardCliDiagnostics(diagnosticsFile, diagnostics);
    record.consumedAt = now.toISOString();
    await writeResumeDryRunRecord({ ...options, targetCwd, artifactRoot }, record);
    consumed = true;

    const spawnResult = await spawnDashboardCliProcess({
      command,
      args,
      cwd: options.cwd,
      diagnostics,
      diagnosticsFile,
      diagnosticsPath,
    });
    if (!spawnResult.ok) {
      diagnostics.status = "spawn_failed";
      diagnostics.updatedAt = new Date().toISOString();
      diagnostics.error = spawnResult.error;
      await writeDashboardCliDiagnostics(diagnosticsFile, diagnostics);
      return {
        ok: false,
        statusCode: 502,
        error: {
          code: "resume_spawn_failed",
          message: "Failed to start the CLI resume process.",
          details: spawnResult.error,
        },
      };
    }

    return {
      ok: true,
      statusCode: 202,
      response: {
        resumeId: record.resumeId,
        launchId,
        runId: safeRunId.value,
        runDir: run.run.runDir,
        started: true,
        exitCode: null,
        diagnosticsPath,
      },
    };
  } finally {
    if (!consumed) {
      await releaseResumeDryRunClaim(claim.claimPath);
    }
  }
}

function buildResumeCliArgs(options: {
  runId: string;
  targetCwd: string;
  artifactRoot: string;
  dryRun: boolean;
  options: NormalizedResumeOptions;
}): string[] {
  const args = [
    "--json",
    "--repo",
    options.targetCwd,
    "--artifact-root",
    options.artifactRoot,
  ];
  if (options.dryRun) args.push("--dry-run");
  if (options.options.allowDirty) args.push("--allow-dirty");
  if (options.options.allowNonGitPlanning) args.push("--allow-non-git-planning");
  if (options.options.milestone !== undefined) {
    args.push("--milestone", String(options.options.milestone));
  }
  if (options.options.milestonePlanPolicy) {
    args.push("--milestone-plan-policy", options.options.milestonePlanPolicy);
  }
  if (options.options.milestonePlanReviewPolicy) {
    args.push(
      "--milestone-plan-review-policy",
      options.options.milestonePlanReviewPolicy,
    );
  }
  args.push("--resume", options.runId);
  return args;
}

function parseResumeDryRunReport(
  stdout: string,
):
  | { ok: true; value: ResumeDryRunReportSummary }
  | { ok: false; error: string } {
  const parsed = parseCliJsonReport(stdout);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  if (!isRecord(report)) {
    return { ok: false, error: "Report is not a JSON object." };
  }
  if (report.mode !== "resume") {
    return { ok: false, error: "Report mode is not resume." };
  }
  if (typeof report.allowed !== "boolean") {
    return { ok: false, error: "Report allowed field is missing." };
  }
  if (typeof report.exitCode !== "number" || !Number.isFinite(report.exitCode)) {
    return { ok: false, error: "Report exitCode field is missing." };
  }
  if (typeof report.nextAction !== "string" || report.nextAction.length === 0) {
    return { ok: false, error: "Report nextAction field is missing." };
  }
  if (!Array.isArray(report.warnings)) {
    return { ok: false, error: "Report warnings field is missing." };
  }

  return {
    ok: true,
    value: {
      allowed: report.allowed,
      exitCode: report.exitCode,
      nextAction: report.nextAction,
      warnings: report.warnings.filter((warning): warning is string => {
        return typeof warning === "string";
      }),
      report,
    },
  };
}

function normalizeResumeOptions(
  input: unknown,
):
  | { ok: true; value: NormalizedResumeOptions }
  | { ok: false; statusCode: 400; error: DashboardError } {
  const body = input === undefined ? {} : input;
  if (!isRecord(body)) {
    return invalidResumeRequest("Resume request must be a JSON object.");
  }

  const milestone = optionalPositiveInteger(body.milestone, "milestone");
  if (!milestone.ok) return invalidResumeRequest(milestone.error);

  const milestonePlanPolicy = optionalEnum(
    body.milestonePlanPolicy,
    milestonePlanPolicies,
    "milestonePlanPolicy",
  );
  if (!milestonePlanPolicy.ok) {
    return invalidResumeRequest(milestonePlanPolicy.error);
  }

  const milestonePlanReviewPolicy = optionalEnum(
    body.milestonePlanReviewPolicy,
    milestonePlanReviewPolicies,
    "milestonePlanReviewPolicy",
  );
  if (!milestonePlanReviewPolicy.ok) {
    return invalidResumeRequest(milestonePlanReviewPolicy.error);
  }

  return {
    ok: true,
    value: {
      allowDirty: booleanField(body.allowDirty, false),
      allowNonGitPlanning: booleanField(body.allowNonGitPlanning, false),
      milestone: milestone.value,
      milestonePlanPolicy: milestonePlanPolicy.value,
      milestonePlanReviewPolicy: milestonePlanReviewPolicy.value,
    },
  };
}

function normalizeResumeRequest(
  input: unknown,
):
  | { ok: true; value: NormalizedResumeRequest }
  | { ok: false; statusCode: 400; error: DashboardError } {
  if (!isRecord(input)) {
    return invalidResumeRequest("Resume confirmation request must be a JSON object.");
  }
  const resumeId = stringField(input.resumeId)?.trim();
  const confirmationToken = stringField(input.confirmationToken)?.trim();
  if (!resumeId || !/^resume-[A-Za-z0-9-]+$/.test(resumeId)) {
    return invalidResumeRequest("resumeId is missing or invalid.");
  }
  if (!confirmationToken) {
    return invalidResumeRequest("confirmationToken is required.");
  }
  return { ok: true, value: { resumeId, confirmationToken } };
}

function normalizeRunId(
  runId: string,
):
  | { ok: true; value: string }
  | { ok: false; statusCode: 400; error: DashboardError } {
  if (!isSafeRunId(runId)) {
    return {
      ok: false,
      statusCode: 400,
      error: {
        code: "invalid_run_id",
        message: "Run id is invalid.",
      },
    };
  }
  return { ok: true, value: runId };
}

async function readResumeDryRunRecord(
  options: DashboardRunResumerOptions,
  resumeId: string,
): Promise<
  | { ok: true; record: StoredResumeDryRun }
  | { ok: false; statusCode: 404 | 409 | 500; error: DashboardError }
> {
  const filePath = resumeDryRunRecordPath(options, resumeId);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNoEntryError(error)) {
      return {
        ok: false,
        statusCode: 404,
        error: {
          code: "resume_dry_run_not_found",
          message: "Resume dry-run record was not found.",
        },
      };
    }
    return {
      ok: false,
      statusCode: 500,
      error: {
        code: "resume_dry_run_read_failed",
        message: "Failed to read resume dry-run record.",
        details: formatError(error),
      },
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredResumeDryRun(parsed)) {
      return {
        ok: false,
        statusCode: 409,
        error: {
          code: "resume_dry_run_invalid",
          message: "Resume dry-run record is invalid.",
        },
      };
    }
    return { ok: true, record: parsed };
  } catch (error) {
    return {
      ok: false,
      statusCode: 409,
      error: {
        code: "resume_dry_run_invalid",
        message: "Resume dry-run record is malformed.",
        details: formatError(error),
      },
    };
  }
}

async function writeResumeDryRunRecord(
  options: DashboardRunResumerOptions,
  record: StoredResumeDryRun,
): Promise<void> {
  const filePath = resumeDryRunRecordPath(options, record.resumeId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function acquireResumeDryRunClaim(
  options: DashboardRunResumerOptions,
  resumeId: string,
): Promise<
  | { ok: true; claimPath: string }
  | { ok: false; statusCode: 409 | 500; error: DashboardError }
> {
  const claimPath = resumeDryRunClaimPath(options, resumeId);
  try {
    await mkdir(path.dirname(claimPath), { recursive: true });
    const handle = await open(claimPath, "wx");
    try {
      await handle.writeFile(`${new Date().toISOString()}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return { ok: true, claimPath };
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return resumeConflict("Resume confirmation token is already being used.");
    }
    return {
      ok: false,
      statusCode: 500,
      error: {
        code: "resume_claim_failed",
        message: "Failed to claim resume confirmation token.",
        details: formatError(error),
      },
    };
  }
}

async function releaseResumeDryRunClaim(claimPath: string): Promise<void> {
  try {
    await unlink(claimPath);
  } catch {
    // A failed release should not mask the resume validation result.
  }
}

function resumeDryRunRecordPath(
  options: DashboardRunResumerOptions,
  resumeId: string,
): string {
  const targetCwd = resolveTargetCwd(options);
  return path.resolve(
    targetCwd,
    options.artifactRoot,
    "dashboard-resumes",
    `${resumeId}.json`,
  );
}

function resumeDryRunClaimPath(
  options: DashboardRunResumerOptions,
  resumeId: string,
): string {
  const targetCwd = resolveTargetCwd(options);
  return path.resolve(
    targetCwd,
    options.artifactRoot,
    "dashboard-resumes",
    `${resumeId}.claim`,
  );
}

function responseFromRecord(
  record: StoredResumeDryRun,
): DashboardResumeDryRunResponse {
  return {
    resumeId: record.resumeId,
    runId: record.runId,
    runDir: record.runDir,
    allowed: record.allowed,
    exitCode: record.exitCode,
    nextAction: record.nextAction,
    warnings: record.warnings,
    options: record.options,
    report: record.report,
    confirmationToken: record.confirmationToken,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    diagnosticsPath: record.diagnosticsPath,
  };
}

async function readStateFingerprint(statePath: string): Promise<StateFingerprint> {
  const contents = await readFile(statePath);
  return {
    algorithm: "sha256",
    hash: createHash("sha256").update(contents).digest("hex"),
    sizeBytes: contents.byteLength,
  };
}

function sameStateFingerprint(
  left: StateFingerprint,
  right: StateFingerprint,
): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.hash === right.hash &&
    left.sizeBytes === right.sizeBytes
  );
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

function createResumeId(date: Date): string {
  return `resume-${date.toISOString().replace(/\D/g, "")}-${randomBytes(4).toString("hex")}`;
}

function createResumeLaunchId(date: Date): string {
  return `resume-launch-${date.toISOString().replace(/\D/g, "")}-${randomBytes(4).toString("hex")}`;
}

function createConfirmationToken(): string {
  return randomBytes(24).toString("base64url");
}

function invalidResumeRequest(
  message: string,
  details?: unknown,
): { ok: false; statusCode: 400; error: DashboardError } {
  return {
    ok: false,
    statusCode: 400,
    error: {
      code: "invalid_resume_request",
      message,
      details,
    },
  };
}

function invalidResumeState(message: string): {
  ok: false;
  statusCode: 409;
  error: DashboardError;
} {
  return {
    ok: false,
    statusCode: 409,
    error: {
      code: "resume_state_mismatch",
      message,
    },
  };
}

function resumeServerError(
  code: string,
  message: string,
): { ok: false; statusCode: 500; error: DashboardError } {
  return {
    ok: false,
    statusCode: 500,
    error: {
      code,
      message,
    },
  };
}

function resumeConflict(message: string): {
  ok: false;
  statusCode: 409;
  error: DashboardError;
} {
  return {
    ok: false,
    statusCode: 409,
    error: {
      code: "resume_confirmation_rejected",
      message,
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

function resolveTargetCwd(options: DashboardRunResumerOptions): string {
  return options.targetCwd === undefined
    ? path.resolve(options.cwd)
    : path.resolve(options.cwd, options.targetCwd);
}

function isStoredResumeDryRun(value: unknown): value is StoredResumeDryRun {
  if (!isRecord(value)) return false;
  return (
    typeof value.resumeId === "string" &&
    typeof value.runId === "string" &&
    typeof value.runDir === "string" &&
    typeof value.allowed === "boolean" &&
    typeof value.exitCode === "number" &&
    typeof value.nextAction === "string" &&
    Array.isArray(value.warnings) &&
    isRecord(value.options) &&
    typeof value.confirmationToken === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.expiresAt === "string" &&
    typeof value.diagnosticsPath === "string" &&
    typeof value.artifactRoot === "string" &&
    (typeof value.consumedAt === "string" || value.consumedAt === null) &&
    isStateFingerprint(value.stateFingerprint)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStateFingerprint(value: unknown): value is StateFingerprint {
  return (
    isRecord(value) &&
    value.algorithm === "sha256" &&
    typeof value.hash === "string" &&
    typeof value.sizeBytes === "number" &&
    Number.isFinite(value.sizeBytes)
  );
}

function isNoEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
