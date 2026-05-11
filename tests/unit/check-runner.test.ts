import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCheckRunReport,
  runChecks,
} from "../../src/checks/check-runner.js";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../../src/shell/command-runner.js";

test("runChecks reports success when no checks are configured", async () => {
  const result = await runChecks({
    checks: [],
    cwd: "/repo",
    commandRunner: scriptedRunner([]),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.results, []);
  assert.equal(result.report, "No configured checks.\n");
});

test("runChecks executes configured checks sequentially through the local shell", async () => {
  const runner = scriptedRunner([
    { exitCode: 0, stdout: "ok\n", stderr: "" },
    { exitCode: 2, stdout: "", stderr: "failed\n" },
  ]);

  const result = await runChecks({
    checks: ["npm run build", "npm test"],
    cwd: "/repo",
    commandRunner: runner,
    now: sequenceClock([1000, 1042, 2000, 2111]),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    runner.requests.map((request) => ({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
    })),
    [
      { ...shellRequest("npm run build"), cwd: "/repo" },
      { ...shellRequest("npm test"), cwd: "/repo" },
    ],
  );
  assert.deepEqual(result.results, [
    {
      command: "npm run build",
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      durationMs: 42,
    },
    {
      command: "npm test",
      exitCode: 2,
      stdout: "",
      stderr: "failed\n",
      durationMs: 111,
    },
  ]);
  assert.match(result.report, /Overall: failed/);
  assert.match(result.report, /## Check 1: npm run build/);
  assert.match(result.report, /Stdout:\nok/);
  assert.match(result.report, /## Check 2: npm test/);
  assert.match(result.report, /Stderr:\nfailed/);
});

test("runChecks includes command runner errors in structured results and report", async () => {
  const result = await runChecks({
    checks: ["missing-command"],
    cwd: "/repo",
    commandRunner: scriptedRunner([
      {
        exitCode: null,
        stdout: "",
        stderr: "",
        error: "spawn missing-command ENOENT",
      },
    ]),
    now: sequenceClock([500, 500]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.results[0]?.error, "spawn missing-command ENOENT");
  assert.match(result.report, /Exit code: null/);
  assert.match(result.report, /Error: spawn missing-command ENOENT/);
});

test("formatCheckRunReport formats all-passing checks", () => {
  const report = formatCheckRunReport([
    {
      command: "npm run typecheck",
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 7,
    },
  ]);

  assert.match(report, /Overall: passed/);
  assert.match(report, /Stdout:\n\(empty\)/);
  assert.match(report, /Stderr:\n\(empty\)/);
  assert.equal(report.endsWith("\n"), true);
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

function sequenceClock(values: number[]): () => number {
  return () => {
    const value = values.shift();
    assert.notEqual(value, undefined);
    return value ?? 0;
  };
}

function shellRequest(check: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: "cmd",
      args: ["/d", "/s", "/c", check],
    };
  }

  return {
    command: "sh",
    args: ["-lc", check],
  };
}
