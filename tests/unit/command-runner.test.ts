import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import test from "node:test";

import { runGitPreflight } from "../../src/git/git-preflight.js";
import { nodeCommandRunner } from "../../src/shell/command-runner.js";

test("nodeCommandRunner executes a command and captures stdout", async () => {
  const result = await nodeCommandRunner.run({
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.cwd())"],
    cwd: process.cwd(),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(await realpath(result.stdout), await realpath(process.cwd()));
});

test("nodeCommandRunner sends stdin to the child process", async () => {
  const result = await nodeCommandRunner.run({
    command: process.execPath,
    args: [
      "-e",
      [
        "process.stdin.setEncoding('utf8');",
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => { process.stdout.write(input.toUpperCase()); });",
      ].join(""),
    ],
    cwd: process.cwd(),
    stdin: "hello from stdin",
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "HELLO FROM STDIN");
  assert.equal(result.stderr, "");
});

test("nodeCommandRunner captures stderr and non-zero exit codes", async () => {
  const result = await nodeCommandRunner.run({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(7);",
    ],
    cwd: process.cwd(),
  });

  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.error, undefined);
});

test("nodeCommandRunner records spawn failures", async () => {
  const result = await nodeCommandRunner.run({
    command: "agent-orchestrator-command-that-should-not-exist",
    args: [],
    cwd: process.cwd(),
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.error ?? "", /ENOENT/);
});

test("nodeCommandRunner times out long-running commands", async () => {
  const result = await nodeCommandRunner.run({
    command: process.execPath,
    args: ["-e", "setTimeout(() => process.stdout.write('late'), 10_000);"],
    cwd: process.cwd(),
    timeoutMs: 50,
  });

  assert.equal(result.timedOut, true);
  assert.match(result.error ?? "", /timed out after 50ms/);
  assert.equal(result.stdout, "");
});

test("nodeCommandRunner merges request environment variables", async () => {
  const result = await nodeCommandRunner.run({
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.AGENT_ORCHESTRATOR_ENV_TEST ?? '')"],
    cwd: process.cwd(),
    env: {
      AGENT_ORCHESTRATOR_ENV_TEST: "available",
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "available");
});

test("runGitPreflight succeeds against the current repository with dirty override", async () => {
  const cwd = process.cwd();
  const result = await runGitPreflight({
    cwd,
    planningOnly: false,
    allowDirty: true,
    allowNonGitPlanning: false,
    commandRunner: nodeCommandRunner,
  });

  assert.equal(result.ok, true);
  assert.equal(result.metadata.required, true);
  assert.equal(result.metadata.planningOnly, false);
  assert.equal(await realpath(result.metadata.root ?? ""), await realpath(cwd));
  assert.match(result.metadata.startSha ?? "", /^[0-9a-f]{40}$/);
  assert.equal(typeof result.metadata.dirtyAtStart, "boolean");
  assert.equal(result.metadata.dirtyOverride, result.metadata.dirtyAtStart);
});
