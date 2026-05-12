import assert from "node:assert/strict";
import test from "node:test";

import { runGitPreflight } from "../../src/git/git-preflight.js";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../../src/shell/command-runner.js";

test("runGitPreflight succeeds for a clean Git repository", async () => {
  const result = await runGitPreflight({
    cwd: "/repo",
    planningOnly: false,
    allowDirty: false,
    allowNonGitPlanning: false,
    commandRunner: fakeGitRunner({
      root: "/repo\n",
      head: "abc123\n",
      status: "",
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.metadata.required, true);
  assert.equal(result.metadata.root, "/repo");
  assert.equal(result.metadata.startSha, "abc123");
  assert.equal(result.metadata.dirtyAtStart, false);
});

test("runGitPreflight fails outside Git for implementation-capable mode", async () => {
  const result = await runGitPreflight({
    cwd: "/repo",
    planningOnly: false,
    allowDirty: false,
    allowNonGitPlanning: false,
    commandRunner: fakeGitRunner({ rootExitCode: 128 }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "Not inside a Git repository.");
  }
  assert.equal(result.metadata.root, null);
});

test("runGitPreflight rejects non-Git planning-only mode without explicit override", async () => {
  const result = await runGitPreflight({
    cwd: "/repo",
    planningOnly: true,
    allowDirty: false,
    allowNonGitPlanning: false,
    commandRunner: fakeGitRunner({ rootExitCode: 128 }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /--allow-non-git-planning/);
  }
  assert.equal(result.metadata.required, false);
  assert.equal(result.metadata.planningOnly, true);
  assert.equal(result.metadata.root, null);
});

test("runGitPreflight allows non-Git planning-only mode with explicit override", async () => {
  const result = await runGitPreflight({
    cwd: "/repo",
    planningOnly: true,
    allowDirty: false,
    allowNonGitPlanning: true,
    commandRunner: fakeGitRunner({ rootExitCode: 128 }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.metadata.required, false);
  assert.equal(result.metadata.planningOnly, true);
  assert.equal(result.metadata.root, null);
  assert.equal(result.metadata.startSha, null);
});

test("runGitPreflight fails when repository has no commits", async () => {
  const result = await runGitPreflight({
    cwd: "/repo",
    planningOnly: false,
    allowDirty: false,
    allowNonGitPlanning: false,
    commandRunner: fakeGitRunner({
      root: "/repo\n",
      headExitCode: 128,
    }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "Git repository has no commits.");
  }
});

test("runGitPreflight fails on dirty tree without override", async () => {
  const result = await runGitPreflight({
    cwd: "/repo",
    planningOnly: false,
    allowDirty: false,
    allowNonGitPlanning: false,
    commandRunner: fakeGitRunner({
      root: "/repo\n",
      head: "abc123\n",
      status: " M src/file.ts\n",
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.metadata.dirtyAtStart, true);
  if (!result.ok) {
    assert.equal(
      result.error,
      "Git working tree is dirty. Commit changes or rerun with --allow-dirty.",
    );
  }
});

test("runGitPreflight allows dirty tree with override", async () => {
  const result = await runGitPreflight({
    cwd: "/repo",
    planningOnly: false,
    allowDirty: true,
    allowNonGitPlanning: false,
    commandRunner: fakeGitRunner({
      root: "/repo\n",
      head: "abc123\n",
      status: " M src/file.ts\n",
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.metadata.dirtyAtStart, true);
  assert.equal(result.metadata.dirtyOverride, true);
  assert.equal(result.metadata.statusPorcelain, " M src/file.ts\n");
});

interface FakeGitRunnerOptions {
  root?: string;
  rootExitCode?: number;
  head?: string;
  headExitCode?: number;
  status?: string;
  statusExitCode?: number;
}

function fakeGitRunner(options: FakeGitRunnerOptions): CommandRunner {
  return {
    async run(request) {
      const subcommand = request.args.join(" ");
      if (subcommand === "rev-parse --show-toplevel") {
        return commandResult(request, options.rootExitCode ?? 0, options.root ?? "");
      }

      if (subcommand === "rev-parse HEAD") {
        return commandResult(request, options.headExitCode ?? 0, options.head ?? "");
      }

      if (subcommand === "status --porcelain") {
        return commandResult(request, options.statusExitCode ?? 0, options.status ?? "");
      }

      return commandResult(request, 1, "", `Unexpected command: ${subcommand}`);
    },
  };
}

function commandResult(
  request: CommandRequest,
  exitCode: number,
  stdout = "",
  stderr = "",
): CommandResult {
  return {
    ...request,
    exitCode,
    stdout,
    stderr,
  };
}
