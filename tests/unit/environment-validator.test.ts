import assert from "node:assert/strict";
import test from "node:test";

import {
  formatEnvironmentDiagnostics,
  validateEnvironment,
} from "../../src/diagnostics/environment-validator.js";
import type { OrchestratorConfig } from "../../src/config/config-types.js";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../../src/shell/command-runner.js";

test("validateEnvironment checks git and configured check shell", async () => {
  const runner = scriptedRunner([
    { exitCode: 0, stdout: "git version 2\n", stderr: "" },
    { exitCode: 0, stdout: "", stderr: "" },
  ]);

  const result = await validateEnvironment({
    cwd: "/repo",
    config: fakeConfig({ checks: ["npm test"] }),
    requireGitCommand: true,
    commandRunner: runner,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    runner.requests.map((request) => ({
      command: request.command,
      args: request.args,
    })),
    [
      { command: "git", args: ["--version"] },
      shellProbeRequest(),
    ],
  );
});

test("validateEnvironment skips git when Git metadata is explicitly not required", async () => {
  const runner = scriptedRunner([
    { exitCode: 0, stdout: "", stderr: "" },
  ]);

  const result = await validateEnvironment({
    cwd: "/repo",
    config: fakeConfig({ checks: ["npm test"] }),
    requireGitCommand: false,
    commandRunner: runner,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    runner.requests.map((request) => request.command),
    [shellProbeRequest().command],
  );
});

test("validateEnvironment reports missing git as an actionable error", async () => {
  const result = await validateEnvironment({
    cwd: "/repo",
    config: fakeConfig({ checks: [] }),
    requireGitCommand: true,
    commandRunner: scriptedRunner([
      {
        exitCode: null,
        stdout: "",
        stderr: "",
        error: "spawn git ENOENT",
      },
    ]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.level, "error");
  assert.equal(result.diagnostics[0]?.code, "git_command_unavailable");
  assert.match(result.diagnostics[0]?.message ?? "", /Install Git/);
});

test("validateEnvironment checks codex-exec runner command separately", async () => {
  const result = await validateEnvironment({
    cwd: "/repo",
    config: codexConfig({ command: "missing-codex" }),
    requireGitCommand: false,
    commandRunner: scriptedRunner([
      {
        exitCode: null,
        stdout: "",
        stderr: "",
        error: "spawn missing-codex ENOENT",
      },
      { exitCode: 0, stdout: "", stderr: "" },
    ]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "runner_command_unavailable");
  assert.match(result.diagnostics[0]?.message ?? "", /runner.command/);
  assert.equal(result.diagnostics[0]?.command, "missing-codex --version");
});

test("validateEnvironment warns instead of failing when checks are empty", async () => {
  const result = await validateEnvironment({
    cwd: "/repo",
    config: fakeConfig({ checks: [] }),
    requireGitCommand: false,
    commandRunner: scriptedRunner([]),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, [
    {
      level: "warning",
      code: "checks_empty",
      message: "No deterministic checks are configured.",
    },
  ]);
  assert.deepEqual(formatEnvironmentDiagnostics(result.diagnostics), [
    "Warning: No deterministic checks are configured.",
  ]);
});

test("validateEnvironment reports missing check shell without running checks", async () => {
  const result = await validateEnvironment({
    cwd: "/repo",
    config: fakeConfig({ checks: ["npm test"] }),
    requireGitCommand: false,
    commandRunner: scriptedRunner([
      {
        exitCode: null,
        stdout: "",
        stderr: "",
        error: "spawn sh ENOENT",
      },
    ]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "check_shell_unavailable");
  assert.match(result.diagnostics[0]?.message ?? "", /configured checks/);
  assert.doesNotMatch(result.diagnostics[0]?.command ?? "", /npm test/);
});

interface ScriptedCommand {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

interface ScriptedRunner extends CommandRunner {
  requests: CommandRequest[];
}

function scriptedRunner(commands: ScriptedCommand[]): ScriptedRunner {
  const requests: CommandRequest[] = [];

  return {
    requests,
    async run(request) {
      requests.push(request);
      const response = commands.shift() ?? {
        exitCode: 1,
        stdout: "",
        stderr: "Unexpected command",
      };
      return commandResult(request, response);
    },
  };
}

function commandResult(
  request: CommandRequest,
  response: ScriptedCommand,
): CommandResult {
  return {
    ...request,
    exitCode: response.exitCode,
    stdout: response.stdout,
    stderr: response.stderr,
    ...(response.error ? { error: response.error } : {}),
  };
}

function fakeConfig(options: { checks: string[] }): OrchestratorConfig {
  return {
    checks: options.checks,
    runner: { type: "fake" },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    milestonePlanPolicy: "always",
    milestonePlanReviewPolicy: "normal",
  };
}

function codexConfig(options: { command: string }): OrchestratorConfig {
  return {
    checks: ["npm test"],
    runner: {
      type: "codex-exec",
      command: options.command,
      options: {
        sandboxForPlanning: "read-only",
        sandboxForImplementation: "workspace-write",
        approvalPolicy: "never",
      },
    },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    milestonePlanPolicy: "always",
    milestonePlanReviewPolicy: "normal",
  };
}

function shellProbeRequest(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/d", "/s", "/c", "exit 0"] };
  }

  return { command: "sh", args: ["-lc", ":"] };
}
