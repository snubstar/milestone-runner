import { access, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  ApprovalPolicy,
  ConfigResult,
  HumanReviewPolicy,
  LoadedConfig,
  MilestonePlanPolicy,
  MilestonePlanReviewPolicy,
  OrchestratorConfig,
  SandboxMode,
} from "./config-types.js";

const localConfigName = "orchestrator.config.json";
const exampleConfigName = "orchestrator.config.example.json";

const runnerTypes = new Set(["fake", "codex-exec"]);
const milestonePlanPolicies = new Set(["always", "auto", "light"]);
const milestonePlanReviewPolicies = new Set(["normal", "scrupulous"]);
const humanReviewPolicies = new Set(["stop", "fail", "autonomous"]);
const sandboxModes = new Set(["read-only", "workspace-write", "danger-full-access"]);
const approvalPolicies = new Set(["never", "on-request", "untrusted"]);
const configKeys = new Set([
  "checks",
  "runner",
  "maxFixAttempts",
  "maxCheckFixAttempts",
  "artifactRoot",
  "milestonePlanPolicy",
  "milestonePlanReviewPolicy",
  "humanReviewPolicy",
]);
const runnerKeys = new Set(["type", "command", "accountLabel", "options"]);
const codexExecOptionKeys = new Set([
  "sandboxForPlanning",
  "sandboxForImplementation",
  "approvalPolicy",
  "timeoutMs",
  "model",
  "profile",
  "jsonEvents",
]);

export interface LoadConfigOptions {
  cwd: string;
  configPath?: string;
}

export async function loadConfig(options: LoadConfigOptions): Promise<ConfigResult<LoadedConfig>> {
  const pathResult = await resolveConfigPath(options);
  if (!pathResult.ok) return pathResult;

  let raw: string;
  try {
    raw = await readFile(pathResult.value, "utf8");
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read config at ${pathResult.value}: ${formatError(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON in config at ${pathResult.value}: ${formatError(error)}`,
    };
  }

  const validation = validateConfig(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      error: `Invalid config at ${pathResult.value}: ${validation.error}`,
    };
  }

  return {
    ok: true,
    value: {
      path: pathResult.value,
      config: validation.value,
    },
  };
}

export async function resolveConfigPath(
  options: LoadConfigOptions,
): Promise<ConfigResult<string>> {
  if (options.configPath) {
    return { ok: true, value: path.resolve(options.cwd, options.configPath) };
  }

  const localPath = path.resolve(options.cwd, localConfigName);
  if (await exists(localPath)) {
    return { ok: true, value: localPath };
  }

  const examplePath = path.resolve(options.cwd, exampleConfigName);
  if (await exists(examplePath)) {
    return { ok: true, value: examplePath };
  }

  return {
    ok: false,
    error: `No config found. Expected ${localConfigName} or ${exampleConfigName} in ${options.cwd}.`,
  };
}

export function validateConfig(value: unknown): ConfigResult<OrchestratorConfig> {
  if (!isRecord(value)) {
    return { ok: false, error: "Config must be an object." };
  }

  const unsupportedConfigKeys = unsupportedKeys(value, configKeys);
  if (unsupportedConfigKeys.length > 0) {
    return {
      ok: false,
      error: `Unsupported config field(s): ${unsupportedConfigKeys.join(", ")}.`,
    };
  }

  const checks = value.checks;
  if (!Array.isArray(checks) || !checks.every((item) => isNonEmptyString(item))) {
    return { ok: false, error: "`checks` must be an array of non-empty strings." };
  }

  const runner = value.runner;
  if (!isRecord(runner)) {
    return { ok: false, error: "`runner` must be an object." };
  }

  const unsupportedRunnerKeys = unsupportedKeys(runner, runnerKeys);
  if (unsupportedRunnerKeys.length > 0) {
    return {
      ok: false,
      error: `Unsupported runner field(s): ${unsupportedRunnerKeys.join(", ")}.`,
    };
  }

  if (!isNonEmptyString(runner.type) || !runnerTypes.has(runner.type)) {
    return { ok: false, error: '`runner.type` must be "fake" or "codex-exec".' };
  }

  const accountLabel = runner.accountLabel;
  if (accountLabel !== undefined && !isNonBlankString(accountLabel)) {
    return {
      ok: false,
      error: "`runner.accountLabel` must be a non-empty string when provided.",
    };
  }

  let runnerConfig: OrchestratorConfig["runner"];
  if (runner.type === "codex-exec") {
    const command = runner.command;
    if (!isNonEmptyString(command)) {
      return { ok: false, error: "`runner.command` is required for codex-exec." };
    }

    const options = runner.options;
    if (!isRecord(options)) {
      return { ok: false, error: "`runner.options` is required for codex-exec." };
    }

    const unsupportedOptions = Object.keys(options).filter(
      (key) => !codexExecOptionKeys.has(key),
    );
    if (unsupportedOptions.length > 0) {
      return {
        ok: false,
        error: `Unsupported codex-exec runner option(s): ${unsupportedOptions.join(", ")}.`,
      };
    }

    const sandboxForPlanning = options.sandboxForPlanning;
    if (!isSandboxMode(sandboxForPlanning)) {
      return {
        ok: false,
        error: "`runner.options.sandboxForPlanning` is required for codex-exec.",
      };
    }

    const sandboxForImplementation = options.sandboxForImplementation;
    if (!isSandboxMode(sandboxForImplementation)) {
      return {
        ok: false,
        error: "`runner.options.sandboxForImplementation` is required for codex-exec.",
      };
    }

    const approvalPolicy = options.approvalPolicy;
    if (approvalPolicy === "on-failure") {
      return {
        ok: false,
        error:
          '`runner.options.approvalPolicy` value "on-failure" is deprecated. Use "on-request" for interactive runs or "never" for non-interactive runs.',
      };
    }

    if (!isApprovalPolicy(approvalPolicy)) {
      return {
        ok: false,
        error: '`runner.options.approvalPolicy` must be "never", "on-request", or "untrusted".',
      };
    }

    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && !isPositiveInteger(timeoutMs)) {
      return {
        ok: false,
        error: "`runner.options.timeoutMs` must be a positive integer when provided.",
      };
    }

    const model = options.model;
    if (model !== undefined && !isNonEmptyString(model)) {
      return {
        ok: false,
        error: "`runner.options.model` must be a non-empty string when provided.",
      };
    }

    const profile = options.profile;
    if (profile !== undefined && !isNonEmptyString(profile)) {
      return {
        ok: false,
        error: "`runner.options.profile` must be a non-empty string when provided.",
      };
    }

    const jsonEvents = options.jsonEvents;
    if (jsonEvents !== undefined && typeof jsonEvents !== "boolean") {
      return {
        ok: false,
        error: "`runner.options.jsonEvents` must be a boolean when provided.",
      };
    }

    runnerConfig = {
      type: "codex-exec",
      command,
      ...(accountLabel === undefined ? {} : { accountLabel }),
      options: {
        sandboxForPlanning,
        sandboxForImplementation,
        approvalPolicy,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(model === undefined ? {} : { model }),
        ...(profile === undefined ? {} : { profile }),
        ...(jsonEvents === undefined ? {} : { jsonEvents }),
      },
    };
  } else {
    runnerConfig = {
      type: "fake",
      ...(accountLabel === undefined ? {} : { accountLabel }),
    };
  }

  const maxFixAttempts = value.maxFixAttempts;
  if (
    typeof maxFixAttempts !== "number" ||
    !Number.isInteger(maxFixAttempts) ||
    maxFixAttempts < 0
  ) {
    return { ok: false, error: "`maxFixAttempts` must be a non-negative integer." };
  }

  const maxCheckFixAttempts = value.maxCheckFixAttempts;
  if (
    maxCheckFixAttempts !== undefined &&
    (typeof maxCheckFixAttempts !== "number" ||
      !Number.isInteger(maxCheckFixAttempts) ||
      maxCheckFixAttempts < 0)
  ) {
    return { ok: false, error: "`maxCheckFixAttempts` must be a non-negative integer when provided." };
  }

  if (!isNonEmptyString(value.artifactRoot)) {
    return { ok: false, error: "`artifactRoot` must be a non-empty string." };
  }

  const milestonePlanPolicy =
    value.milestonePlanPolicy === undefined ? "always" : value.milestonePlanPolicy;
  if (!isMilestonePlanPolicy(milestonePlanPolicy)) {
    return {
      ok: false,
      error: '`milestonePlanPolicy` must be "always", "auto", or "light".',
    };
  }

  const milestonePlanReviewPolicy =
    value.milestonePlanReviewPolicy === undefined
      ? "normal"
      : value.milestonePlanReviewPolicy;
  if (!isMilestonePlanReviewPolicy(milestonePlanReviewPolicy)) {
    return {
      ok: false,
      error: '`milestonePlanReviewPolicy` must be "normal" or "scrupulous".',
    };
  }

  const humanReviewPolicy =
    value.humanReviewPolicy === undefined ? "stop" : value.humanReviewPolicy;
  if (!isHumanReviewPolicy(humanReviewPolicy)) {
    return {
      ok: false,
      error: '`humanReviewPolicy` must be "stop", "fail", or "autonomous".',
    };
  }

  return {
    ok: true,
    value: {
      checks,
      runner: runnerConfig,
      maxFixAttempts,
      ...(maxCheckFixAttempts === undefined ? {} : { maxCheckFixAttempts }),
      artifactRoot: value.artifactRoot,
      milestonePlanPolicy,
      milestonePlanReviewPolicy,
      humanReviewPolicy,
    },
  };
}

export function applyConfigOverrides(
  config: OrchestratorConfig,
  overrides: {
    artifactRoot?: string;
    runnerType?: string;
    maxFixAttempts?: number;
    maxCheckFixAttempts?: number;
    milestonePlanPolicy?: MilestonePlanPolicy;
    milestonePlanReviewPolicy?: MilestonePlanReviewPolicy;
  },
): OrchestratorConfig {
  return {
    ...config,
    artifactRoot: overrides.artifactRoot ?? config.artifactRoot,
    maxFixAttempts: overrides.maxFixAttempts ?? config.maxFixAttempts,
    maxCheckFixAttempts:
      overrides.maxCheckFixAttempts ?? config.maxCheckFixAttempts,
    milestonePlanPolicy: overrides.milestonePlanPolicy ?? config.milestonePlanPolicy,
    milestonePlanReviewPolicy:
      overrides.milestonePlanReviewPolicy ?? config.milestonePlanReviewPolicy,
    runner: {
      ...config.runner,
      type: (overrides.runnerType ?? config.runner.type) as OrchestratorConfig["runner"]["type"],
    },
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && sandboxModes.has(value);
}

function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return typeof value === "string" && approvalPolicies.has(value);
}

function isMilestonePlanPolicy(value: unknown): value is MilestonePlanPolicy {
  return typeof value === "string" && milestonePlanPolicies.has(value);
}

function isMilestonePlanReviewPolicy(
  value: unknown,
): value is MilestonePlanReviewPolicy {
  return typeof value === "string" && milestonePlanReviewPolicies.has(value);
}

function isHumanReviewPolicy(value: unknown): value is HumanReviewPolicy {
  return typeof value === "string" && humanReviewPolicies.has(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function unsupportedKeys(
  value: Record<string, unknown>,
  allowedKeys: Set<string>,
): string[] {
  return Object.keys(value).filter((key) => !allowedKeys.has(key));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
