import type { CommandRunner } from "../shell/command-runner.js";

export interface CheckRunnerOptions {
  checks: string[];
  cwd: string;
  commandRunner: CommandRunner;
  now?: () => number;
}

export interface CheckCommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

export interface CheckRunResult {
  ok: boolean;
  results: CheckCommandResult[];
  report: string;
}
