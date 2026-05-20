import type { CodexExecRunnerOptions, RunnerConfig } from "../config/config-types.js";
import { CodexExecRunner } from "./codex-exec/codex-exec-runner.js";
import { FakeRunner } from "./fake/fake-runner.js";
import type { AgentRunner } from "./agent-runner.js";

export type CreateRunnerResult =
  | { ok: true; runner: AgentRunner }
  | { ok: false; error: string };

export function createAgentRunner(config: RunnerConfig): CreateRunnerResult {
  if (config.type === "fake") {
    return { ok: true, runner: new FakeRunner() };
  }

  if (config.type === "codex-exec") {
    if (!config.command) {
      return { ok: false, error: "CodexExecRunner requires a command." };
    }

    const options = config.options;
    if (!isCodexExecRunnerOptions(options)) {
      return { ok: false, error: "CodexExecRunner requires Codex exec options." };
    }

    return {
      ok: true,
      runner: new CodexExecRunner({
        command: config.command,
        accountLabel: config.accountLabel,
        options,
      }),
    };
  }

  return { ok: false, error: `Unsupported runner type: ${config.type}` };
}

function isCodexExecRunnerOptions(value: unknown): value is CodexExecRunnerOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    "sandboxForPlanning" in value &&
    "sandboxForImplementation" in value &&
    "approvalPolicy" in value
  );
}
