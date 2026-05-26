import type { OrchestratorConfig } from "../config/config-types.js";
import type { CommandRunner } from "../shell/command-runner.js";

export type EnvironmentDiagnosticLevel = "error" | "warning";

export interface EnvironmentDiagnostic {
  level: EnvironmentDiagnosticLevel;
  code: string;
  message: string;
  command?: string;
  details?: string;
}

export interface EnvironmentValidationOptions {
  cwd: string;
  config: OrchestratorConfig;
  commandRunner: CommandRunner;
  requireGitCommand: boolean;
}

export interface EnvironmentValidationResult {
  ok: boolean;
  diagnostics: EnvironmentDiagnostic[];
}

export async function validateEnvironment(
  options: EnvironmentValidationOptions,
): Promise<EnvironmentValidationResult> {
  const diagnostics: EnvironmentDiagnostic[] = [];

  if (options.requireGitCommand) {
    diagnostics.push(
      ...(await validateCommandAvailability({
        cwd: options.cwd,
        command: "git",
        args: ["--version"],
        commandRunner: options.commandRunner,
        code: "git_command_unavailable",
        unavailableMessage:
          "Required command \"git\" is unavailable. Install Git or use planning-only with --allow-non-git-planning when Git metadata is not required.",
        failedMessage:
          "Required command \"git\" failed while checking availability. Verify Git is installed and usable.",
      })),
    );
  }

  if (options.config.runner.type === "codex-exec") {
    diagnostics.push(
      ...(await validateCommandAvailability({
        cwd: options.cwd,
        command: options.config.runner.command ?? "",
        args: ["--version"],
        commandRunner: options.commandRunner,
        code: "runner_command_unavailable",
        unavailableMessage: `Configured codex-exec runner command "${options.config.runner.command ?? ""}" is unavailable. Install the runner tool or update runner.command in config.`,
        failedMessage: `Configured codex-exec runner command "${options.config.runner.command ?? ""}" failed while checking availability. Verify runner.command points to a usable executable.`,
      })),
    );
  }

  if (options.config.checks.length === 0) {
    diagnostics.push({
      level: "warning",
      code: "checks_empty",
      message: "No deterministic checks are configured.",
    });
  } else {
    const shell = shellProbe();
    diagnostics.push(
      ...(await validateCommandAvailability({
        cwd: options.cwd,
        command: shell.command,
        args: shell.args,
        commandRunner: options.commandRunner,
        code: "check_shell_unavailable",
        unavailableMessage: `Required shell "${shell.command}" for configured checks is unavailable. Install the shell or remove/fix configured checks.`,
        failedMessage: `Required shell "${shell.command}" for configured checks failed while checking availability. Verify the local shell can run configured checks.`,
      })),
    );
  }

  return {
    ok: diagnostics.every((diagnostic) => diagnostic.level !== "error"),
    diagnostics,
  };
}

export function formatEnvironmentDiagnostics(
  diagnostics: EnvironmentDiagnostic[],
): string[] {
  return diagnostics.map((diagnostic) => {
    const prefix = diagnostic.level === "error" ? "Error" : "Warning";
    const command = diagnostic.command ? ` Command: ${diagnostic.command}.` : "";
    const details = diagnostic.details ? ` Details: ${diagnostic.details}` : "";
    return `${prefix}: ${diagnostic.message}${command}${details}`;
  });
}

function shellProbe(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/d", "/s", "/c", "exit 0"] };
  }

  return { command: "sh", args: ["-lc", ":"] };
}

async function validateCommandAvailability(options: {
  cwd: string;
  command: string;
  args: string[];
  commandRunner: CommandRunner;
  code: string;
  unavailableMessage: string;
  failedMessage: string;
}): Promise<EnvironmentDiagnostic[]> {
  if (options.command.trim().length === 0) {
    return [
      {
        level: "error",
        code: options.code,
        message: options.unavailableMessage,
      },
    ];
  }

  const result = await options.commandRunner.run({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
  });

  if (result.error || result.exitCode === null) {
    return [
      {
        level: "error",
        code: options.code,
        message: options.unavailableMessage,
        command: formatCommand(options.command, options.args),
        details: result.error ?? "Command did not produce an exit code.",
      },
    ];
  }

  if (result.exitCode !== 0) {
    const details = [result.stderr.trim(), result.stdout.trim()]
      .filter((value) => value.length > 0)
      .join("\n");
    return [
      {
        level: "error",
        code: options.code,
        message: options.failedMessage,
        command: formatCommand(options.command, options.args),
        details: `Exit code ${result.exitCode}.${details ? ` ${details}` : ""}`,
      },
    ];
  }

  return [];
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}
