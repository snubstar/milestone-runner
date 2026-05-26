import { spawn } from "node:child_process";

export interface CommandRequest {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
}

export interface CommandResult extends CommandRequest {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
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
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let spawnError: string | undefined;
    let stdinError: string | undefined;
    let timeoutError: string | undefined;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.setDefaultEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      spawnError = error.message;
    });

    child.stdin.on("error", (error) => {
      stdinError = error.message;
    });

    if (request.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        timeoutError = `Command timed out after ${request.timeoutMs}ms.`;
        child.kill("SIGTERM");
        forceKillTimeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, 1000);
      }, request.timeoutMs);
    }

    child.stdin.end(request.stdin ?? "");

    child.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);

      const error = [spawnError, stdinError, timeoutError]
        .filter((message): message is string => Boolean(message))
        .join("; ");

      resolve({
        ...request,
        exitCode,
        stdout,
        stderr,
        ...(error ? { error } : {}),
        ...(timedOut ? { timedOut } : {}),
      });
    });
  });
}
