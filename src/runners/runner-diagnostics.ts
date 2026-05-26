import type { RunPaths } from "../artifacts/paths.js";
import { writeRunnerDiagnosticArtifact } from "../artifacts/runner-diagnostics.js";
import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
} from "./agent-runner.js";

export interface AgentPhaseExecutionOptions {
  runner: AgentRunner;
  request: AgentRunRequest;
  paths: RunPaths;
  now?: () => Date;
}

export type AgentPhaseExecutionResult =
  | {
      ok: true;
      result: AgentRunResult;
      diagnosticArtifact?: string;
    }
  | {
      ok: false;
      error: string;
      diagnosticArtifact?: string;
    };

export async function runAgentPhaseWithDiagnostics(
  options: AgentPhaseExecutionOptions,
): Promise<AgentPhaseExecutionResult> {
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();

  try {
    const result = await options.runner.run(options.request);
    const endedAt = clock().toISOString();
    const diagnosticArtifact = await maybeWriteRunnerDiagnostic({
      paths: options.paths,
      runnerType: options.runner.type,
      request: options.request,
      result,
      startedAt,
      endedAt,
    });

    return {
      ok: true,
      result,
      ...(diagnosticArtifact === undefined ? {} : { diagnosticArtifact }),
    };
  } catch (error) {
    const endedAt = clock().toISOString();
    const errorMessage = formatError(error);
    const diagnosticArtifact = await maybeWriteRunnerDiagnostic({
      paths: options.paths,
      runnerType: options.runner.type,
      request: options.request,
      error: errorMessage,
      startedAt,
      endedAt,
    });

    return {
      ok: false,
      error: errorMessage,
      ...(diagnosticArtifact === undefined ? {} : { diagnosticArtifact }),
    };
  }
}

function shouldPersistRunnerDiagnostics(runnerType: string): boolean {
  return runnerType === "codex-exec";
}

async function maybeWriteRunnerDiagnostic(options: {
  paths: RunPaths;
  runnerType: string;
  request: AgentRunRequest;
  result?: AgentRunResult;
  error?: string;
  startedAt: string;
  endedAt: string;
}): Promise<string | undefined> {
  if (!shouldPersistRunnerDiagnostics(options.runnerType)) return undefined;

  const diagnostic = buildRunnerDiagnostic(options);
  const artifact = await writeRunnerDiagnosticArtifact(
    options.paths,
    options.request.phase,
    diagnostic,
  );
  return artifact.statePath;
}

function buildRunnerDiagnostic(options: {
  runnerType: string;
  request: AgentRunRequest;
  result?: AgentRunResult;
  error?: string;
  startedAt: string;
  endedAt: string;
}): Record<string, unknown> {
  const metadata = options.result?.metadata ?? {};
  const durationMs = durationBetweenIsoTimestamps(options.startedAt, options.endedAt);

  return omitUndefined({
    phase: options.request.phase,
    milestoneId: options.request.milestoneId,
    runner: stringField(metadata.runner) ?? options.runnerType,
    command: stringField(metadata.command),
    args: stringArrayField(metadata.args),
    cwd: stringField(metadata.cwd) ?? options.request.cwd,
    exitCode: options.result?.exitCode,
    timedOut: booleanField(metadata.timedOut),
    sandbox: stringField(metadata.sandbox),
    approvalPolicy: stringField(metadata.approvalPolicy),
    accountLabel: stringField(metadata.accountLabel),
    profile: stringField(metadata.profile),
    timeoutMs: numberField(metadata.timeoutMs),
    stdout: stringField(metadata.stdout),
    stderr: stringField(metadata.stderr),
    error: stringField(metadata.error) ?? options.error,
    outputLastMessageCaptured: booleanField(metadata.outputLastMessageCaptured),
    outputSchemaPath: options.request.outputSchemaPath,
    requestArtifacts: requestArtifactsField(options.request.artifacts),
    startedAt: options.startedAt,
    endedAt: options.endedAt,
    durationMs,
  });
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  );
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item): item is string => typeof item === "string")
    ? value
    : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requestArtifactsField(
  artifacts: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (artifacts === undefined || Object.keys(artifacts).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(artifacts).filter((entry): entry is [string, string] => {
      const [key, value] = entry;
      return key.length > 0 && typeof value === "string";
    }),
  );
}

function durationBetweenIsoTimestamps(
  startedAt: string,
  endedAt: string,
): number | undefined {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }

  return end - start;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
