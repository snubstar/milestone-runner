import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildDashboardLauncherCompletionEvent,
  buildDashboardLauncherOutputEvent,
  publishDashboardProcessEvent,
} from "./event-stream.js";

export interface DashboardCliDiagnostics {
  launchId: string;
  runId: string;
  runDir: string;
  createdAt: string;
  updatedAt: string;
  dryRun: boolean;
  status: "starting" | "running" | "completed" | "spawn_failed";
  command: string;
  args: string[];
  cwd: string;
  targetCwd?: string;
  requestedGoalFilePath?: string;
  requestedContextPaths?: string[];
  requestedSeedMajorPlanPath?: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  report?: unknown;
  error?: string;
}

export type DashboardCliProcessResult =
  | {
      ok: true;
      exitCode: number;
      signal: string | null;
      stdout: string;
      stderr: string;
    }
  | { ok: false; error: string };

const maxCapturedOutputBytes = 64 * 1024;
const diagnosticsPersistDelayMs = 100;

export function spawnDashboardCliProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  diagnostics: DashboardCliDiagnostics;
  diagnosticsFile: string;
  diagnosticsPath: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: { ok: true } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let spawnErrored = false;
      let pendingDiagnosticsWrite: ReturnType<typeof setTimeout> | null = null;
      let diagnosticsWriteInFlight = false;
      let diagnosticsWriteAgain = false;
      let spawned = false;

      const persistDiagnosticsNow = async () => {
        if (diagnosticsWriteInFlight) {
          diagnosticsWriteAgain = true;
          return;
        }

        diagnosticsWriteInFlight = true;
        try {
          await writeDashboardCliDiagnostics(
            options.diagnosticsFile,
            options.diagnostics,
          );
        } finally {
          diagnosticsWriteInFlight = false;
          if (diagnosticsWriteAgain) {
            diagnosticsWriteAgain = false;
            void persistDiagnosticsNow();
          }
        }
      };
      const persistDiagnosticsSoon = () => {
        if (pendingDiagnosticsWrite !== null) return;
        pendingDiagnosticsWrite = setTimeout(() => {
          pendingDiagnosticsWrite = null;
          void persistDiagnosticsNow();
        }, diagnosticsPersistDelayMs);
      };
      const cancelPendingDiagnosticsWrite = () => {
        if (pendingDiagnosticsWrite === null) return;
        clearTimeout(pendingDiagnosticsWrite);
        pendingDiagnosticsWrite = null;
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout = appendBounded(stdout, text);
        options.diagnostics.updatedAt = new Date().toISOString();
        options.diagnostics.stdout = stdout;
        options.diagnostics.stderr = stderr;
        persistDiagnosticsSoon();
        publishDashboardProcessEvent(
          buildDashboardLauncherOutputEvent({
            runId: options.diagnostics.runId,
            launchId: options.diagnostics.launchId,
            stream: "stdout",
            text,
          }),
        );
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr = appendBounded(stderr, text);
        options.diagnostics.updatedAt = new Date().toISOString();
        options.diagnostics.stdout = stdout;
        options.diagnostics.stderr = stderr;
        persistDiagnosticsSoon();
        publishDashboardProcessEvent(
          buildDashboardLauncherOutputEvent({
            runId: options.diagnostics.runId,
            launchId: options.diagnostics.launchId,
            stream: "stderr",
            text,
          }),
        );
      });
      child.on("spawn", () => {
        spawned = true;
        settle({ ok: true });
      });
      child.on("error", (error) => {
        spawnErrored = true;
        cancelPendingDiagnosticsWrite();
        options.diagnostics.status = "spawn_failed";
        options.diagnostics.updatedAt = new Date().toISOString();
        options.diagnostics.stdout = stdout;
        options.diagnostics.stderr = stderr;
        options.diagnostics.error = formatError(error);
        void persistDiagnosticsNow();
        publishDashboardProcessEvent(
          buildDashboardLauncherCompletionEvent({
            runId: options.diagnostics.runId,
            launchId: options.diagnostics.launchId,
            status: "spawn_failed",
            exitCode: null,
            signal: null,
            diagnosticsPath: options.diagnosticsPath,
            timestamp: options.diagnostics.updatedAt,
          }),
        );
        if (!spawned) {
          settle({ ok: false, error: formatError(error) });
        }
      });
      child.on("close", (exitCode, signal) => {
        cancelPendingDiagnosticsWrite();
        const report = parseCliJsonReport(stdout);
        const completionStatus = spawnErrored ? "spawn_failed" : "completed";
        options.diagnostics.status = completionStatus;
        options.diagnostics.updatedAt = new Date().toISOString();
        options.diagnostics.exitCode = exitCode;
        options.diagnostics.signal = signal;
        options.diagnostics.stdout = stdout;
        options.diagnostics.stderr = stderr;
        if (report.ok) {
          options.diagnostics.report = report.value;
        } else {
          options.diagnostics.error = report.error;
        }
        void persistDiagnosticsNow();
        publishDashboardProcessEvent(
          buildDashboardLauncherCompletionEvent({
            runId: options.diagnostics.runId,
            launchId: options.diagnostics.launchId,
            status: completionStatus,
            exitCode,
            signal,
            diagnosticsPath: options.diagnosticsPath,
            timestamp: options.diagnostics.updatedAt,
          }),
        );
      });
    } catch (error) {
      settle({ ok: false, error: formatError(error) });
    }
  });
}

export function runDashboardCliToCompletion(options: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<DashboardCliProcessResult> {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const settle = (result: DashboardCliProcessResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle({ ok: false, error: formatError(error) });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      settle({ ok: false, error: formatError(error) });
    });
    child.on("close", (exitCode, signal) => {
      settle({
        ok: true,
        exitCode: exitCode ?? 1,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

export async function writeDashboardCliDiagnostics(
  filePath: string,
  diagnostics: DashboardCliDiagnostics,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
}

export function parseCliJsonReport(
  stdout: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(stdout) as unknown };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= maxCapturedOutputBytes) {
    return combined;
  }
  return combined.slice(-maxCapturedOutputBytes);
}
