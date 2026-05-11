import type { CodexExecRunnerOptions } from "../../config/config-types.js";
import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
} from "../agent-runner.js";

export interface CodexExecRunnerConfig {
  command: string;
  options: CodexExecRunnerOptions;
}

export class CodexExecRunner implements AgentRunner {
  readonly type = "codex-exec";
  readonly command: string;
  readonly options: CodexExecRunnerOptions;

  constructor(config: CodexExecRunnerConfig) {
    this.command = config.command;
    this.options = config.options;
  }

  async run(_request: AgentRunRequest): Promise<AgentRunResult> {
    return {
      text: "CodexExecRunner execution is not implemented in Milestone 2.",
      exitCode: 1,
      metadata: {
        runner: this.type,
        command: this.command,
        implemented: false,
      },
    };
  }
}

