import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  outputSchemaRelativePathForPhase,
  resolveOutputSchemaPathForPhase,
} from "../../src/runners/output-schema.js";

const schemaConstrainedPhases = [
  "final_plan_json",
  "review_milestone",
  "repair_review_verdict",
  "resolve_review_ambiguity",
  "resolve_resume_state",
];

const unsupportedCodexOutputSchemaKeywords = new Set(["uniqueItems"]);

test("outputSchemaRelativePathForPhase maps schema-constrained phases", () => {
  assert.equal(
    outputSchemaRelativePathForPhase("final_plan_json"),
    path.join("schemas", "milestones.schema.json"),
  );
  assert.equal(
    outputSchemaRelativePathForPhase("review_milestone"),
    path.join("schemas", "review-verdict.schema.json"),
  );
  assert.equal(
    outputSchemaRelativePathForPhase("repair_review_verdict"),
    path.join("schemas", "review-verdict.schema.json"),
  );
  assert.equal(
    outputSchemaRelativePathForPhase("resolve_review_ambiguity"),
    path.join("schemas", "review-resolution.schema.json"),
  );
  assert.equal(
    outputSchemaRelativePathForPhase("resolve_resume_state"),
    path.join("schemas", "resume-resolution.schema.json"),
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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-schema-"));
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

test("resolveOutputSchemaPathForPhase resolves schemas from schemaRoot, not runner cwd", async () => {
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-target-"));
  const resourceDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-resource-"));
  try {
    const schemaRoot = path.join(resourceDir, "schemas");
    await mkdir(schemaRoot);
    await writeFile(path.join(schemaRoot, "milestones.schema.json"), "{}", "utf8");

    const result = await resolveOutputSchemaPathForPhase({
      phase: "final_plan_json",
      cwd: targetDir,
      schemaRoot,
    } as Parameters<typeof resolveOutputSchemaPathForPhase>[0] & {
      schemaRoot: string;
    });

    assert.deepEqual(result, {
      ok: true,
      path: path.join(schemaRoot, "milestones.schema.json"),
    });
  } finally {
    await rm(targetDir, { recursive: true, force: true });
    await rm(resourceDir, { recursive: true, force: true });
  }
});

test("resolveOutputSchemaPathForPhase reports missing required schemas", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "milestone-runner-schema-"));
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

test("Codex output schemas do not use known unsupported JSON Schema keywords", async () => {
  const schemaPaths = new Set(
    schemaConstrainedPhases
      .map((phase) => outputSchemaRelativePathForPhase(phase))
      .filter((schemaPath): schemaPath is string => schemaPath !== null),
  );
  const violations: string[] = [];

  for (const relativeSchemaPath of schemaPaths) {
    const schemaPath = path.resolve(process.cwd(), relativeSchemaPath);
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as unknown;
    collectUnsupportedSchemaKeywords(schema, relativeSchemaPath, violations);
  }

  assert.deepEqual(violations, []);
});

function collectUnsupportedSchemaKeywords(
  value: unknown,
  jsonPath: string,
  violations: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectUnsupportedSchemaKeywords(item, `${jsonPath}[${index}]`, violations);
    });
    return;
  }

  if (value === null || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${jsonPath}.${key}`;
    if (unsupportedCodexOutputSchemaKeywords.has(key)) {
      violations.push(`${childPath} is not supported by Codex output schemas.`);
    }
    collectUnsupportedSchemaKeywords(child, childPath, violations);
  }
}
