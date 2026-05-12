import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRunPaths, buildRunPathsFromRunDir } from "../../src/artifacts/paths.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import { loadResumeRun } from "../../src/cli/run-loader.js";
import { createInitialState } from "../../src/state/initial-state.js";
import { writeState } from "../../src/state/state-store.js";
import { nodeCommandRunner } from "../../src/shell/command-runner.js";
import { createFixtureRepo } from "../helpers/fixture-repo.js";
import { defaultTestConfig } from "../helpers/run-fixture.js";

test("loadResumeRun resolves a direct run directory", async () => {
  const repo = await createFixtureRepo();
  try {
    const fixture = await createResumeFixture(repo.path);

    const result = await loadResumeRun({
      cwd: repo.path,
      artifactRoot: ".agent-work",
      resumeValue: fixture.paths.runDir,
      commandRunner: nodeCommandRunner,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const expectedRunDir = await canonicalPath(fixture.paths.runDir);
      assert.equal(result.state.runId, "run-1");
      assert.equal(result.runDir, expectedRunDir);
      assert.equal(result.paths.runDir, expectedRunDir);
      assert.equal(result.paths.files.state, path.join(expectedRunDir, "state.json"));
      assert.equal(result.config.maxFixAttempts, 0);
      assert.equal(result.targetCwd, await canonicalPath(repo.path));
      assert.deepEqual(result.warnings, []);
    }
  } finally {
    await repo.cleanup();
  }
});

test("loadResumeRun resolves a direct state.json path", async () => {
  const repo = await createFixtureRepo();
  try {
    const fixture = await createResumeFixture(repo.path);

    const result = await loadResumeRun({
      cwd: repo.path,
      artifactRoot: ".agent-work",
      resumeValue: fixture.paths.files.state,
      commandRunner: nodeCommandRunner,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.statePath, await canonicalPath(fixture.paths.files.state));
      assert.equal(result.runDir, await canonicalPath(fixture.paths.runDir));
    }
  } finally {
    await repo.cleanup();
  }
});

test("loadResumeRun resolves a run id under artifact root", async () => {
  const repo = await createFixtureRepo();
  try {
    const fixture = await createResumeFixture(repo.path);

    const result = await loadResumeRun({
      cwd: repo.path,
      artifactRoot: ".agent-work",
      resumeValue: "run-1",
      commandRunner: nodeCommandRunner,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.statePath, await canonicalPath(fixture.paths.files.state));
      assert.equal(result.paths.artifactRoot, await canonicalPath(fixture.paths.artifactRoot));
    }
  } finally {
    await repo.cleanup();
  }
});

test("loadResumeRun rejects missing resume state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-loader-"));
  try {
    const result = await loadResumeRun({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      resumeValue: "run-missing",
      commandRunner: nodeCommandRunner,
    });

    assert.deepEqual(result, {
      ok: false,
      error: 'Could not find resume state for "run-missing".',
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadResumeRun rejects state without a valid config snapshot", async () => {
  const repo = await createFixtureRepo();
  try {
    const fixture = await createResumeFixture(repo.path);
    await writeState(fixture.paths.files.state, {
      ...fixture.state,
      config: {
        ...fixture.state.config,
        snapshot: null,
      },
    });

    const result = await loadResumeRun({
      cwd: repo.path,
      artifactRoot: ".agent-work",
      resumeValue: fixture.paths.runDir,
      commandRunner: nodeCommandRunner,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /Resume state is missing a valid config snapshot/);
    }
  } finally {
    await repo.cleanup();
  }
});

test("loadResumeRun rejects resume from a different Git repository", async () => {
  const repo = await createFixtureRepo();
  const otherRepo = await createFixtureRepo();
  try {
    const fixture = await createResumeFixture(repo.path);

    const result = await loadResumeRun({
      cwd: otherRepo.path,
      artifactRoot: fixture.paths.artifactRoot,
      resumeValue: fixture.paths.runDir,
      commandRunner: nodeCommandRunner,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /does not match saved Git root/);
    }
  } finally {
    await otherRepo.cleanup();
    await repo.cleanup();
  }
});

test("loadResumeRun allows planning-only state without Git root", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-loader-"));
  try {
    const paths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    const config = defaultTestConfig();
    await createRunDirectory(paths, "Add feature X");
    const state = createInitialState({
      runId: "run-1",
      goal: "Add feature X",
      paths,
      git: {
        required: false,
        planningOnly: true,
        root: null,
        startSha: null,
        dirtyAtStart: false,
        dirtyOverride: false,
        statusPorcelain: "",
      },
      configPath: null,
      configSnapshot: config,
    });
    await writeState(paths.files.state, state);

    const result = await loadResumeRun({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      resumeValue: "run-1",
      commandRunner: nodeCommandRunner,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.targetCwd, path.resolve(tempDir));
      assert.equal(result.state.git.root, null);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadResumeRun allows direct moved run directories with run-relative artifacts", async () => {
  const repo = await createFixtureRepo();
  try {
    const runDir = path.join(repo.path, ".agent-work", "moved-run");
    const paths = buildRunPathsFromRunDir({ runDir, runId: "run-1" });
    const config = defaultTestConfig();
    await createRunDirectory(paths, "Add feature X");
    const state = createInitialState({
      runId: "run-1",
      goal: "Add feature X",
      paths,
      git: {
        required: true,
        planningOnly: false,
        root: repo.path,
        startSha: await repo.git(["rev-parse", "HEAD"]),
        dirtyAtStart: false,
        dirtyOverride: false,
        statusPorcelain: "",
      },
      configPath: null,
      configSnapshot: config,
    });
    await writeState(paths.files.state, {
      ...state,
      runDir: path.join(repo.path, ".agent-work", "run-1"),
    });

    const result = await loadResumeRun({
      cwd: repo.path,
      artifactRoot: ".agent-work",
      resumeValue: runDir,
      commandRunner: nodeCommandRunner,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.paths.runId, "run-1");
      assert.equal(result.paths.runDir, await canonicalPath(runDir));
      assert.match(result.warnings.join("\n"), /differs from state run id/);
      assert.match(result.warnings.join("\n"), /differs from resolved run directory/);
    }
  } finally {
    await repo.cleanup();
  }
});

async function createResumeFixture(cwd: string): Promise<{
  paths: ReturnType<typeof buildRunPaths>;
  state: ReturnType<typeof createInitialState>;
}> {
  const paths = buildRunPaths({
    cwd,
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const config = defaultTestConfig();
  await createRunDirectory(paths, "Add feature X");
  const state = createInitialState({
    runId: "run-1",
    goal: "Add feature X",
    paths,
    git: {
      required: true,
      planningOnly: false,
      root: cwd,
      startSha: await gitHead(cwd),
      dirtyAtStart: false,
      dirtyOverride: false,
      statusPorcelain: "",
    },
    configPath: null,
    configSnapshot: config,
  });
  await writeState(paths.files.state, state);
  return { paths, state };
}

async function gitHead(cwd: string): Promise<string> {
  const result = await nodeCommandRunner.run({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd,
  });
  assert.equal(result.exitCode, 0);
  return result.stdout.trim();
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}
