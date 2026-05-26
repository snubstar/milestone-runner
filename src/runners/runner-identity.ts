import type { OrchestratorConfig, RunnerConfig } from "../config/config-types.js";

export interface RunnerIdentityDetails {
  runnerProfile: string | null;
  runnerAccountLabel: string | null;
  runnerAuthentication: string;
}

export function runnerIdentityDetails(
  config: OrchestratorConfig | RunnerConfig,
): RunnerIdentityDetails {
  const runner = "runner" in config ? config.runner : config;
  if (runner.type !== "codex-exec") {
    return {
      runnerProfile: null,
      runnerAccountLabel: runner.accountLabel ?? null,
      runnerAuthentication: "fake runner",
    };
  }

  const profile = profileFromOptions(runner.options);
  const accountLabel = runner.accountLabel ?? null;
  return {
    runnerProfile: profile,
    runnerAccountLabel: accountLabel,
    runnerAuthentication: authenticationDescription({ profile, accountLabel }),
  };
}

function authenticationDescription(options: {
  profile: string | null;
  accountLabel: string | null;
}): string {
  if (options.accountLabel && options.profile) {
    return `account label "${options.accountLabel}" using Codex profile "${options.profile}"`;
  }

  if (options.accountLabel) {
    return `account label "${options.accountLabel}" using ambient Codex CLI authentication`;
  }

  if (options.profile) {
    return `Codex profile "${options.profile}"`;
  }

  return "ambient Codex CLI authentication";
}

function profileFromOptions(options: RunnerConfig["options"]): string | null {
  if (!isRecord(options)) return null;
  return typeof options.profile === "string" && options.profile.length > 0
    ? options.profile
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
