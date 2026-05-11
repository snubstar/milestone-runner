import type { RunnerType } from "../runners/runner-types.js";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";

export interface CodexExecRunnerOptions {
  sandboxForPlanning: SandboxMode;
  sandboxForImplementation: SandboxMode;
  approvalPolicy: ApprovalPolicy;
}

export interface RunnerConfig {
  type: RunnerType;
  command?: string;
  options?: CodexExecRunnerOptions | Record<string, unknown>;
}

export interface OrchestratorConfig {
  checks: string[];
  runner: RunnerConfig;
  maxFixAttempts: number;
  artifactRoot: string;
}

export interface LoadedConfig {
  path: string;
  config: OrchestratorConfig;
}

export type ConfigResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

