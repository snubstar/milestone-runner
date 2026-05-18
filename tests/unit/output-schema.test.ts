import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  outputSchemaRelativePathForPhase,
  resolveOutputSchemaPathForPhase,
} from "../../src/runners/output-schema.js";

test("outputSchemaRelativePathForPhase maps schema-constrained phases", () => {
  assert.equal(
    outputSchemaRelativePathForPhase("final_plan_json"),
    path.join("schemas", "milestones.schema.json"),
  );
  assert.equal(
    outputSchemaRelativePathForPhase("review_milestone"),
    path.join("schemas", "review-verdict.schema.json"),
  );
});

test("outputSchemaRelativePathForPhase leaves Markdown phases unconstrained", () => {
  assert.equal(outputSchemaRelativePathForPhase("major_plan"), null);
  assert.equal(outputSchemaRelativePathForPhase("major_plan_review"), null);
  assert.equal(outputSchemaRelativePathForPhase("final_major_plan"), null);
  assert.equal(outputSchemaRelativePathForPhase("milestone_plan"), null);
  assert.equal(outputSchemaRelativePathForPhase("milestone_plan_review"), null);
  assert.equal(outputSchemaRelativePathForPhase("final_milestone_plan"), null);
  assert.equal(outputSchemaRelativePathForPhase("implement_milestone"), null);
  assert.equal(outputSchemaRelativePathForPhase("fix_review_findings"), null);
});

test("resolveOutputSchemaPathForPhase resolves existing schema paths", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-schema-"));
  try {
    const schemaDir = path.join(tempDir, "schemas");
    await mkdir(schemaDir);
    await writeFile(path.join(schemaDir, "milestones.schema.json"), "{}", "utf8");

    const result = await resolveOutputSchemaPathForPhase({
      phase: "final_plan_json",
      cwd: tempDir,
    });

    assert.deepEqual(result, {
      ok: true,
      path: path.join(tempDir, "schemas", "milestones.schema.json"),
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveOutputSchemaPathForPhase reports missing required schemas", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-schema-"));
  try {
    const result = await resolveOutputSchemaPathForPhase({
      phase: "review_milestone",
      cwd: tempDir,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /Required output schema for phase review_milestone/);
      assert.match(result.error, /review-verdict\.schema\.json/);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
