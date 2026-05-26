import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CodexExecRunnerOptions } from "../../config/config-types.js";
import {
  nodeCommandRunner,
  type CommandResult,
  type CommandRunner,
} from "../../shell/command-runner.js";
import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
} from "../agent-runner.js";

export interface CodexExecRunnerConfig {
  command: string;
  options: CodexExecRunnerOptions;
  accountLabel?: string;
  commandRunner?: CommandRunner;
}

export class CodexExecRunner implements AgentRunner {
  readonly type = "codex-exec";
  readonly command: string;
  readonly options: CodexExecRunnerOptions;
  readonly accountLabel?: string;
  private readonly commandRunner: CommandRunner;

  constructor(config: CodexExecRunnerConfig) {
    this.command = config.command;
    this.options = config.options;
    this.accountLabel = config.accountLabel;
    this.commandRunner = config.commandRunner ?? nodeCommandRunner;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const cwd = request.cwd ?? process.cwd();
    const sandbox = sandboxForPhase(request.phase, this.options);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-codex-"));
    const outputLastMessagePath = path.join(tempDir, "last-message.txt");
    const args = buildCodexExecArgs({
      cwd,
      sandbox,
      outputLastMessagePath,
      options: this.options,
      outputSchemaPath: request.outputSchemaPath,
    });

    let commandResult: CommandResult | undefined;
    let finalMessage = "";
    let outputLastMessageCaptured = false;
    let outputLastMessageError: string | undefined;

    try {
      commandResult = await this.commandRunner.run({
        command: this.command,
        args,
        cwd,
        stdin: request.prompt,
        timeoutMs: this.options.timeoutMs,
      });

      try {
        finalMessage = await readFile(outputLastMessagePath, "utf8");
        outputLastMessageCaptured = finalMessage.trim().length > 0;
      } catch (error) {
        outputLastMessageError = formatError(error);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    const exitCode = normalizeExitCode({
      commandExitCode: commandResult.exitCode,
      outputLastMessageCaptured,
    });

    return {
      text: outputLastMessageCaptured
        ? finalMessage
        : formatMissingFinalMessage(commandResult, outputLastMessageError),
      exitCode,
      metadata: {
        runner: this.type,
        command: this.command,
        args: sanitizeArgs(args),
        cwd,
        phase: request.phase,
        sandbox,
        approvalPolicy: this.options.approvalPolicy,
        accountLabel: this.accountLabel,
        profile: this.options.profile,
        timeoutMs: this.options.timeoutMs,
        timedOut: Boolean(commandResult.timedOut),
        stdout: commandResult.stdout,
        stderr: commandResult.stderr,
        error: commandResult.error,
        outputLastMessageCaptured,
      },
    };
  }
}

function buildCodexExecArgs(options: {
  cwd: string;
  sandbox: string;
  outputLastMessagePath: string;
  options: CodexExecRunnerOptions;
  outputSchemaPath?: string;
}): string[] {
  const args = [
    "exec",
    "--cd",
    options.cwd,
    "--sandbox",
    options.sandbox,
    "--color",
    "never",
    "--output-last-message",
    options.outputLastMessagePath,
    "-c",
    `approval_policy="${options.options.approvalPolicy}"`,
  ];

  if (options.options.model !== undefined) {
    args.push("--model", options.options.model);
  }

  if (options.options.profile !== undefined) {
    args.push("--profile", options.options.profile);
  }

  if (options.options.jsonEvents === true) {
    args.push("--json");
  }

  if (options.outputSchemaPath !== undefined) {
    args.push("--output-schema", options.outputSchemaPath);
  }

  args.push("-");
  return args;
}

function sandboxForPhase(
  phase: string,
  options: CodexExecRunnerOptions,
): CodexExecRunnerOptions["sandboxForPlanning"] {
  switch (phase) {
    case "implement_milestone":
    case "fix_review_findings":
      return options.sandboxForImplementation;
    default:
      return options.sandboxForPlanning;
  }
}

function normalizeExitCode(options: {
  commandExitCode: number | null;
  outputLastMessageCaptured: boolean;
}): number {
  if (options.commandExitCode === 0 && !options.outputLastMessageCaptured) {
    return 1;
  }

  return options.commandExitCode ?? 1;
}

function formatMissingFinalMessage(
  commandResult: CommandResult,
  outputLastMessageError: string | undefined,
): string {
  const details = [
    "Codex exec did not produce a non-empty final message.",
    commandResult.error ? `Command error: ${commandResult.error}` : undefined,
    outputLastMessageError ? `Output file error: ${outputLastMessageError}` : undefined,
  ].filter((message): message is string => Boolean(message));

  return details.join("\n");
}

function sanitizeArgs(args: string[]): string[] {
  const sanitized = [...args];
  const outputLastMessageIndex = sanitized.indexOf("--output-last-message");
  if (outputLastMessageIndex >= 0 && outputLastMessageIndex + 1 < sanitized.length) {
    sanitized[outputLastMessageIndex + 1] = "<temporary-output-last-message>";
  }

  return sanitized;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
