import type { RunnerType } from "../runners/runner-types.js";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "never" | "on-request" | "untrusted";
export type MilestonePlanPolicy = "always" | "auto" | "light";
export type MilestonePlanReviewPolicy = "normal" | "scrupulous";

export interface CodexExecRunnerOptions {
  sandboxForPlanning: SandboxMode;
  sandboxForImplementation: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  timeoutMs?: number;
  model?: string;
  profile?: string;
  jsonEvents?: boolean;
}

export interface RunnerConfig {
  type: RunnerType;
  command?: string;
  accountLabel?: string;
  options?: CodexExecRunnerOptions | Record<string, unknown>;
}

export interface OrchestratorConfig {
  checks: string[];
  runner: RunnerConfig;
  maxFixAttempts: number;
  artifactRoot: string;
  milestonePlanPolicy: MilestonePlanPolicy;
  milestonePlanReviewPolicy: MilestonePlanReviewPolicy;
}

export interface LoadedConfig {
  path: string;
  config: OrchestratorConfig;
}

export type ConfigResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
