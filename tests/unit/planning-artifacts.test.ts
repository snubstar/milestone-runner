import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRunPaths } from "../../src/artifacts/paths.js";
import {
  buildPlanningArtifactPaths,
  writeJsonArtifact,
  writeTextArtifact,
} from "../../src/artifacts/planning-artifacts.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";

test("buildPlanningArtifactPaths creates expected planning artifact paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  const planningPaths = buildPlanningArtifactPaths(runPaths);

  assert.equal(
    planningPaths.files.majorPlan,
    path.resolve("/repo", ".agent-work", "run-1", "plans", "01-major-plan.md"),
  );
  assert.equal(
    planningPaths.files.majorPlanReview,
    path.resolve("/repo", ".agent-work", "run-1", "plans", "02-major-plan-review.md"),
  );
  assert.equal(
    planningPaths.files.finalMajorPlanMarkdown,
    path.resolve("/repo", ".agent-work", "run-1", "plans", "03-final-major-plan.md"),
  );
  assert.equal(
    planningPaths.files.milestones,
    path.resolve("/repo", ".agent-work", "run-1", "milestones", "05-milestones.json"),
  );
  assert.deepEqual(planningPaths.statePaths, {
    majorPlan: path.join("plans", "01-major-plan.md"),
    majorPlanReview: path.join("plans", "02-major-plan-review.md"),
    finalMajorPlanMarkdown: path.join("plans", "03-final-major-plan.md"),
    milestones: path.join("milestones", "05-milestones.json"),
  });
});

test("writeTextArtifact and writeJsonArtifact write stable artifact content", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-planning-"));
  try {
    const runPaths = buildRunPaths({
      cwd: tempDir,
      artifactRoot: ".agent-work",
      runId: "run-1",
    });
    await createRunDirectory(runPaths, "Add feature X");
    const planningPaths = buildPlanningArtifactPaths(runPaths);

    await writeTextArtifact(planningPaths.files.majorPlan, "# Major Plan\n\n");
    await writeJsonArtifact(planningPaths.files.milestones, {
      milestones: [],
    });

    assert.equal(await readFile(planningPaths.files.majorPlan, "utf8"), "# Major Plan\n");
    assert.equal(
      await readFile(planningPaths.files.milestones, "utf8"),
      '{\n  "milestones": []\n}\n',
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
