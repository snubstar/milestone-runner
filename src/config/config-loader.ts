import { access, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  ApprovalPolicy,
  ConfigResult,
  LoadedConfig,
  OrchestratorConfig,
  SandboxMode,
} from "./config-types.js";

const localConfigName = "orchestrator.config.json";
const exampleConfigName = "orchestrator.config.example.json";

const runnerTypes = new Set(["fake", "codex-exec"]);
const sandboxModes = new Set(["read-only", "workspace-write", "danger-full-access"]);
const approvalPolicies = new Set(["never", "on-request", "on-failure", "untrusted"]);

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

  const checks = value.checks;
  if (!Array.isArray(checks) || !checks.every((item) => isNonEmptyString(item))) {
    return { ok: false, error: "`checks` must be an array of non-empty strings." };
  }

  const runner = value.runner;
  if (!isRecord(runner)) {
    return { ok: false, error: "`runner` must be an object." };
  }

  if (!isNonEmptyString(runner.type) || !runnerTypes.has(runner.type)) {
    return { ok: false, error: '`runner.type` must be "fake" or "codex-exec".' };
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
    if (!isApprovalPolicy(approvalPolicy)) {
      return {
        ok: false,
        error: "`runner.options.approvalPolicy` is required for codex-exec.",
      };
    }

    runnerConfig = {
      type: "codex-exec",
      command,
      options: {
        sandboxForPlanning,
        sandboxForImplementation,
        approvalPolicy,
      },
    };
  } else {
    runnerConfig = {
      type: "fake",
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

  if (!isNonEmptyString(value.artifactRoot)) {
    return { ok: false, error: "`artifactRoot` must be a non-empty string." };
  }

  return {
    ok: true,
    value: {
      checks,
      runner: runnerConfig,
      maxFixAttempts,
      artifactRoot: value.artifactRoot,
    },
  };
}

export function applyConfigOverrides(
  config: OrchestratorConfig,
  overrides: {
    artifactRoot?: string;
    runnerType?: string;
  },
): OrchestratorConfig {
  return {
    ...config,
    artifactRoot: overrides.artifactRoot ?? config.artifactRoot,
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

function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && sandboxModes.has(value);
}

function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return typeof value === "string" && approvalPolicies.has(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
