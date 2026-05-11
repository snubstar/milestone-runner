import { spawn } from "node:child_process";

export interface CommandRequest {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult extends CommandRequest {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

export const nodeCommandRunner: CommandRunner = {
  run(request) {
    return runCommand(request);
  },
};

export function runCommand(request: CommandRequest): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env ? { ...process.env, ...request.env } : process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let spawnError: string | undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      spawnError = error.message;
    });

    child.on("close", (exitCode) => {
      resolve({
        ...request,
        exitCode,
        stdout,
        stderr,
        ...(spawnError ? { error: spawnError } : {}),
      });
    });
  });
}
