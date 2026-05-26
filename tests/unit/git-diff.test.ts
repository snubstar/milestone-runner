import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureGitDiff, captureGitTree } from "../../src/git/git-diff.js";
import { nodeCommandRunner } from "../../src/shell/command-runner.js";

test("captureGitDiff includes tracked edits and untracked files without staging them", async () => {
  const repo = await createCommittedRepo();
  try {
    await writeFile(path.join(repo, "tracked.txt"), "after\n", "utf8");
    await writeFile(path.join(repo, "created.txt"), "created\n", "utf8");

    const result = await captureGitDiff({
      cwd: repo,
      commandRunner: nodeCommandRunner,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.match(result.diff, /diff --git a\/tracked\.txt b\/tracked\.txt/);
    assert.match(result.diff, /-before/);
    assert.match(result.diff, /\+after/);
    assert.match(result.diff, /diff --git a\/created\.txt b\/created\.txt/);
    assert.match(result.diff, /new file mode/);
    assert.match(result.diff, /\+created/);

    const staged = await runGit(repo, ["diff", "--cached", "--name-only"]);
    assert.equal(staged.stdout, "");

    const status = await runGit(repo, ["status", "--porcelain"]);
    assert.match(status.stdout, / M tracked\.txt/);
    assert.match(status.stdout, /\?\? created\.txt/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("captureGitDiff excludes requested paths even when they are unignored", async () => {
  const repo = await createCommittedRepo();
  try {
    await writeFile(path.join(repo, "created.txt"), "created\n", "utf8");
    await mkdir(path.join(repo, ".agent-work", "run-1"), { recursive: true });
    await writeFile(path.join(repo, ".agent-work", "run-1", "state.json"), "{}\n", "utf8");

    const result = await captureGitDiff({
      cwd: repo,
      commandRunner: nodeCommandRunner,
      excludedPaths: [path.join(repo, ".agent-work", "run-1")],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.match(result.diff, /diff --git a\/created\.txt b\/created\.txt/);
    assert.match(result.diff, /\+created/);
    assert.doesNotMatch(result.diff, /\.agent-work\/run-1/);
    assert.doesNotMatch(result.diff, /state\.json/);

    const staged = await runGit(repo, ["diff", "--cached", "--name-only"]);
    assert.equal(staged.stdout, "");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("captureGitDiff can compare against a captured working tree baseline", async () => {
  const repo = await createCommittedRepo();
  try {
    await writeFile(path.join(repo, "prior-milestone.txt"), "accepted\n", "utf8");

    const baseline = await captureGitTree({
      cwd: repo,
      commandRunner: nodeCommandRunner,
    });
    assert.equal(baseline.ok, true);
    if (!baseline.ok) return;

    await writeFile(path.join(repo, "current-milestone.txt"), "current\n", "utf8");

    const result = await captureGitDiff({
      cwd: repo,
      commandRunner: nodeCommandRunner,
      baseTree: baseline.tree,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.match(result.diff, /diff --git a\/current-milestone\.txt b\/current-milestone\.txt/);
    assert.match(result.diff, /\+current/);
    assert.doesNotMatch(result.diff, /prior-milestone\.txt/);
    assert.doesNotMatch(result.diff, /\+accepted/);

    const staged = await runGit(repo, ["diff", "--cached", "--name-only"]);
    assert.equal(staged.stdout, "");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("captureGitDiff reports a clear error outside a Git repository", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-git-diff-"));
  try {
    const result = await captureGitDiff({
      cwd: tempDir,
      commandRunner: nodeCommandRunner,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "Failed to find Git root for diff capture.");
      assert.notEqual(result.details?.exitCode, 0);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function createCommittedRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-git-diff-"));
  await runGit(repo, ["init"]);
  await writeFile(path.join(repo, "tracked.txt"), "before\n", "utf8");
  await runGit(repo, ["add", "tracked.txt"]);
  await runGit(repo, [
    "-c",
    "user.name=Agent Orchestrator Test",
    "-c",
    "user.email=milestone-runner@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  assert.equal(await readFile(path.join(repo, "tracked.txt"), "utf8"), "before\n");
  return repo;
}

async function runGit(repo: string, args: string[]) {
  const result = await nodeCommandRunner.run({
    command: "git",
    args,
    cwd: repo,
  });

  assert.equal(
    result.exitCode,
    0,
    `git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}
