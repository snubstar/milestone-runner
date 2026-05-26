import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRunPaths } from "../../src/artifacts/paths.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import {
  contextFileMaxBytes,
  resolveInitialInputs,
  seedMajorPlanMaxBytes,
  writeInitialInputArtifacts,
} from "../../src/inputs/initial-inputs.js";

test("resolveInitialInputs reads goal files and snapshots context artifacts", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-inputs-"));
  try {
    await mkdir(path.join(repo, "docs"), { recursive: true });
    const seedPath = path.join(repo, "docs", "major-plan.md");
    await writeFile(path.join(repo, "docs", "task.md"), "Goal from file\n", "utf8");
    await writeFile(seedPath, "# Seeded Plan\n", "utf8");
    const canonicalSeedPath = await realpath(seedPath);
    await writeFile(path.join(repo, "docs", "context.md"), "Context from file\n", "utf8");

    const inputsResult = await resolveInitialInputs({
      targetCwd: repo,
      argvGoal: null,
      goalFile: "docs/task.md",
      seedMajorPlanFile: "docs/major-plan.md",
      contextPaths: ["docs/context.md"],
    });

    assert.equal(inputsResult.ok, true);
    if (!inputsResult.ok) return;
    assert.equal(inputsResult.value.goal, "Goal from file\n");
    assert.equal(inputsResult.value.goalSource.path, "docs/task.md");
    assert.deepEqual(inputsResult.value.seedMajorPlan, {
      text: "# Seeded Plan\n",
      path: "docs/major-plan.md",
      canonicalPath: canonicalSeedPath,
      sizeBytes: Buffer.byteLength("# Seeded Plan\n"),
      sha256: sha256("# Seeded Plan\n"),
    });
    assert.deepEqual(inputsResult.value.context.map((entry) => entry.path), [
      "docs/context.md",
    ]);

    const paths = buildRunPaths({
      cwd: repo,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(paths, inputsResult.value.goal, {
      goalArtifactText: inputsResult.value.goalArtifactText,
    });
    const artifacts = await writeInitialInputArtifacts({
      paths,
      inputs: inputsResult.value,
      now: new Date("2026-05-20T10:00:00.000Z"),
    });

    assert.equal(artifacts.stateArtifacts.manifest, path.join("inputs", "01-inputs.json"));
    assert.deepEqual(artifacts.stateInputs.context.map((entry) => entry.path), [
      "docs/context.md",
    ]);
    assert.deepEqual(artifacts.stateInputs.majorPlanSource, {
      type: "seed",
      path: "docs/major-plan.md",
      sizeBytes: Buffer.byteLength("# Seeded Plan\n"),
      sha256: sha256("# Seeded Plan\n"),
    });
    assert.equal(await readFile(paths.files.goal, "utf8"), "Goal from file\n");

    const manifest = JSON.parse(
      await readFile(path.join(paths.runDir, artifacts.stateArtifacts.manifest), "utf8"),
    ) as {
      createdAt: string;
      majorPlanSource?: unknown;
      context: Array<{ path: string; artifactPath: string }>;
    };
    assert.equal(manifest.createdAt, "2026-05-20T10:00:00.000Z");
    assert.deepEqual(manifest.majorPlanSource, artifacts.stateInputs.majorPlanSource);
    assert.equal(manifest.context[0]?.path, "docs/context.md");
    assert.equal(
      await readFile(path.join(paths.runDir, manifest.context[0]?.artifactPath ?? ""), "utf8"),
      "Context from file\n",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("resolveInitialInputs accepts absolute seed paths inside target and seed/context overlap", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-inputs-"));
  try {
    await mkdir(path.join(repo, "docs"), { recursive: true });
    const seedPath = path.join(repo, "docs", "major-plan.md");
    await writeFile(seedPath, "# Seeded Plan\n", "utf8");
    const canonicalSeedPath = await realpath(seedPath);

    const result = await resolveInitialInputs({
      targetCwd: repo,
      argvGoal: "Goal",
      seedMajorPlanFile: seedPath,
      contextPaths: ["docs/major-plan.md"],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.seedMajorPlan?.path, "docs/major-plan.md");
    assert.equal(result.value.seedMajorPlan?.canonicalPath, canonicalSeedPath);
    assert.deepEqual(result.value.context.map((entry) => entry.path), [
      "docs/major-plan.md",
    ]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("resolveInitialInputs rejects invalid repository input files", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-inputs-"));
  const sibling = `${repo}-other`;
  try {
    await mkdir(path.join(repo, "docs"), { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(repo, "docs", "task.md"), "Goal\n", "utf8");
    await writeFile(path.join(repo, "docs", "context.md"), "Context\n", "utf8");
    await writeFile(path.join(repo, "docs", "invalid-utf8.md"), Buffer.from([0xff]));
    await writeFile(path.join(sibling, "secret.md"), "Outside\n", "utf8");
    await symlink(path.join(sibling, "secret.md"), path.join(repo, "docs", "outside-link.md"));
    await symlink("context.md", path.join(repo, "docs", "context-link.md"));
    await writeFile(
      path.join(repo, "docs", "large.md"),
      Buffer.alloc(contextFileMaxBytes + 1, "a"),
    );

    const cases: Array<{
      name: string;
      goalFile?: string;
      contextPaths?: string[];
      pattern: RegExp;
    }> = [
      {
        name: "missing goal",
        goalFile: "docs/missing.md",
        pattern: /unavailable/i,
      },
      {
        name: "directory goal",
        goalFile: "docs",
        pattern: /regular file/i,
      },
      {
        name: "invalid UTF-8 goal",
        goalFile: "docs/invalid-utf8.md",
        pattern: /valid UTF-8/i,
      },
      {
        name: "sibling context",
        contextPaths: [path.relative(repo, path.join(sibling, "secret.md"))],
        pattern: /inside the target/i,
      },
      {
        name: "symlink escape",
        contextPaths: ["docs/outside-link.md"],
        pattern: /inside the target/i,
      },
      {
        name: "duplicate context",
        contextPaths: ["docs/context.md", "docs/context-link.md"],
        pattern: /duplicate context/i,
      },
      {
        name: "oversized context",
        contextPaths: ["docs/large.md"],
        pattern: /size limit/i,
      },
    ];

    for (const testCase of cases) {
      const result = await resolveInitialInputs({
        targetCwd: repo,
        argvGoal: testCase.goalFile === undefined ? "Goal" : null,
        goalFile: testCase.goalFile,
        contextPaths: testCase.contextPaths,
      });
      assert.equal(result.ok, false, testCase.name);
      if (!result.ok) {
        assert.match(result.error, testCase.pattern, testCase.name);
      }
    }
  } finally {
    await rm(sibling, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("resolveInitialInputs rejects invalid seed major plan files", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-inputs-"));
  const sibling = `${repo}-other`;
  try {
    await mkdir(path.join(repo, "docs"), { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(repo, "docs", "valid.md"), "# Valid Seed\n", "utf8");
    await writeFile(path.join(repo, "docs", "empty.md"), "", "utf8");
    await writeFile(path.join(repo, "docs", "whitespace.md"), " \n\t", "utf8");
    await writeFile(path.join(repo, "docs", "invalid-utf8.md"), Buffer.from([0xff]));
    await writeFile(
      path.join(repo, "docs", "large.md"),
      Buffer.alloc(seedMajorPlanMaxBytes + 1, "a"),
    );
    await writeFile(path.join(sibling, "secret.md"), "# Outside\n", "utf8");
    await symlink(path.join(sibling, "secret.md"), path.join(repo, "docs", "outside-link.md"));

    const cases: Array<{
      name: string;
      seedMajorPlanFile: string;
      pattern: RegExp;
    }> = [
      {
        name: "missing",
        seedMajorPlanFile: "docs/missing.md",
        pattern: /unavailable/i,
      },
      {
        name: "directory",
        seedMajorPlanFile: "docs",
        pattern: /regular file/i,
      },
      {
        name: "empty",
        seedMajorPlanFile: "docs/empty.md",
        pattern: /empty or whitespace-only/i,
      },
      {
        name: "whitespace-only",
        seedMajorPlanFile: "docs/whitespace.md",
        pattern: /empty or whitespace-only/i,
      },
      {
        name: "invalid UTF-8",
        seedMajorPlanFile: "docs/invalid-utf8.md",
        pattern: /valid UTF-8/i,
      },
      {
        name: "oversized",
        seedMajorPlanFile: "docs/large.md",
        pattern: /size limit/i,
      },
      {
        name: "outside-target",
        seedMajorPlanFile: path.relative(repo, path.join(sibling, "secret.md")),
        pattern: /inside the target/i,
      },
      {
        name: "sibling-prefix absolute",
        seedMajorPlanFile: path.join(sibling, "secret.md"),
        pattern: /inside the target/i,
      },
      {
        name: "symlink escape",
        seedMajorPlanFile: "docs/outside-link.md",
        pattern: /inside the target/i,
      },
    ];

    for (const testCase of cases) {
      const result = await resolveInitialInputs({
        targetCwd: repo,
        argvGoal: "Goal",
        seedMajorPlanFile: testCase.seedMajorPlanFile,
      });
      assert.equal(result.ok, false, testCase.name);
      if (!result.ok) {
        assert.match(result.error, testCase.pattern, testCase.name);
      }
    }
  } finally {
    await rm(sibling, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
