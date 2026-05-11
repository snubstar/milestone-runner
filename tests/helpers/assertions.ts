import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import type { MilestoneMetadata } from "../../src/milestones/milestone-types.js";
import { parseMilestoneMetadataJson } from "../../src/milestones/milestone-validator.js";
import type { ReviewVerdictDocument } from "../../src/review/review-types.js";
import { parseReviewVerdictJson } from "../../src/review/review-verdict-validator.js";
import type { RunState } from "../../src/state/state-types.js";

const phases = new Set([
  "initialized",
  "planning",
  "plan_reviewing",
  "ready_for_milestone",
  "ready_for_review",
  "implementing",
  "checking",
  "reviewing",
  "fixing",
  "passed",
  "failed",
  "needs_human_review",
]);

const milestoneStatuses = new Set([
  "pending",
  "planned",
  "ready_for_review",
  "implementing",
  "checking",
  "reviewing",
  "fixing",
  "passed",
  "failed",
  "needs_human_review",
]);

const topLevelStateFields = [
  "runId",
  "goal",
  "currentPhase",
  "status",
  "currentMilestoneId",
  "artifactRoot",
  "runDir",
  "git",
  "config",
  "milestoneStatuses",
  "fixAttempts",
  "artifacts",
  "lastError",
  "createdAt",
  "updatedAt",
];

const scalarArtifactFields = [
  "goal",
  "majorPlan",
  "majorPlanReview",
  "finalMajorPlanMarkdown",
  "finalMajorPlanJson",
  "milestones",
];

const mapArtifactFields = [
  "milestonePlans",
  "implementations",
  "diffs",
  "checks",
  "reviews",
  "summaries",
  "fixes",
  "logs",
];

export function assertRunStateShape(value: unknown): asserts value is RunState {
  assertRecord(value, "RunState");
  assertFields(value, topLevelStateFields, "RunState");

  assertNonEmptyString(value.runId, "RunState.runId");
  assertNonEmptyString(value.goal, "RunState.goal");
  assertPhase(value.currentPhase, "RunState.currentPhase");
  assertPhase(value.status, "RunState.status");
  assertNullOrPositiveInteger(value.currentMilestoneId, "RunState.currentMilestoneId");
  assertNonEmptyString(value.artifactRoot, "RunState.artifactRoot");
  assertNonEmptyString(value.runDir, "RunState.runDir");
  assertGitShape(value.git);
  assertConfigShape(value.config);
  assertMilestoneStatusRecord(value.milestoneStatuses, "RunState.milestoneStatuses");
  assertFixAttemptRecord(value.fixAttempts, "RunState.fixAttempts");
  assertArtifactsShape(value.artifacts);
  assertStateErrorShape(value.lastError);
  assertIsoTimestamp(value.createdAt, "RunState.createdAt");
  assertIsoTimestamp(value.updatedAt, "RunState.updatedAt");
}

export async function assertMilestoneMetadataArtifact(
  artifactPath: string,
): Promise<MilestoneMetadata> {
  const result = parseMilestoneMetadataJson(await readFile(artifactPath, "utf8"));
  if (!result.ok) {
    assert.fail(`Invalid milestone metadata artifact at ${artifactPath}: ${result.error}`);
  }

  return result.value;
}

export async function assertReviewVerdictArtifact(
  artifactPath: string,
): Promise<ReviewVerdictDocument> {
  const result = parseReviewVerdictJson(await readFile(artifactPath, "utf8"));
  if (!result.ok) {
    assert.fail(`Invalid review verdict artifact at ${artifactPath}: ${result.error}`);
  }

  return result.value;
}

function assertGitShape(value: unknown): void {
  assertRecord(value, "RunState.git");
  assertFields(value, [
    "required",
    "planningOnly",
    "root",
    "startSha",
    "dirtyAtStart",
    "dirtyOverride",
    "statusPorcelain",
  ], "RunState.git");

  assertBoolean(value.required, "RunState.git.required");
  assertBoolean(value.planningOnly, "RunState.git.planningOnly");
  assertNullOrString(value.root, "RunState.git.root");
  assertNullOrString(value.startSha, "RunState.git.startSha");
  assertBoolean(value.dirtyAtStart, "RunState.git.dirtyAtStart");
  assertBoolean(value.dirtyOverride, "RunState.git.dirtyOverride");
  assertString(value.statusPorcelain, "RunState.git.statusPorcelain");
}

function assertConfigShape(value: unknown): void {
  assertRecord(value, "RunState.config");
  assertFields(value, ["path", "snapshot"], "RunState.config");
  assertNullOrString(value.path, "RunState.config.path");

  if (value.snapshot === null) return;

  assertRecord(value.snapshot, "RunState.config.snapshot");
  assertRequiredFields(
    value.snapshot,
    ["checks", "runner", "maxFixAttempts", "artifactRoot"],
    "RunState.config.snapshot",
  );
  assertStringArray(value.snapshot.checks, "RunState.config.snapshot.checks");
  assertRecord(value.snapshot.runner, "RunState.config.snapshot.runner");
  assertNonEmptyString(value.snapshot.runner.type, "RunState.config.snapshot.runner.type");
  assertNonNegativeInteger(
    value.snapshot.maxFixAttempts,
    "RunState.config.snapshot.maxFixAttempts",
  );
  assertNonEmptyString(value.snapshot.artifactRoot, "RunState.config.snapshot.artifactRoot");
}

function assertArtifactsShape(value: unknown): void {
  assertRecord(value, "RunState.artifacts");
  assertAllowedFields(
    value,
    [...scalarArtifactFields, ...mapArtifactFields],
    "RunState.artifacts",
  );

  for (const field of scalarArtifactFields) {
    if (field in value) {
      assertNonEmptyString(value[field], `RunState.artifacts.${field}`);
    }
  }

  for (const field of mapArtifactFields) {
    if (field in value) {
      assertStringRecord(value[field], `RunState.artifacts.${field}`);
    }
  }
}

function assertStateErrorShape(value: unknown): void {
  if (value === null) return;

  assertRecord(value, "RunState.lastError");
  assertRequiredFields(value, ["message", "phase", "occurredAt"], "RunState.lastError");
  assertAllowedFields(value, ["message", "phase", "occurredAt", "details"], "RunState.lastError");
  assertNonEmptyString(value.message, "RunState.lastError.message");
  assertPhase(value.phase, "RunState.lastError.phase");
  assertIsoTimestamp(value.occurredAt, "RunState.lastError.occurredAt");

  if ("details" in value) {
    assert.ok(
      value.details === null ||
        typeof value.details === "string" ||
        Array.isArray(value.details) ||
        isRecord(value.details),
      "RunState.lastError.details must be a string, object, array, or null.",
    );
  }
}

function assertFields(
  value: Record<string, unknown>,
  fields: string[],
  path: string,
): void {
  assertRequiredFields(value, fields, path);
  assertAllowedFields(value, fields, path);
}

function assertRequiredFields(
  value: Record<string, unknown>,
  fields: string[],
  path: string,
): void {
  for (const field of fields) {
    assert.ok(field in value, `${path}.${field} is required.`);
  }
}

function assertAllowedFields(
  value: Record<string, unknown>,
  fields: string[],
  path: string,
): void {
  const allowed = new Set(fields);
  const extraFields = Object.keys(value).filter((field) => !allowed.has(field));
  assert.deepEqual(extraFields, [], `${path} has unsupported fields.`);
}

function assertMilestoneStatusRecord(value: unknown, path: string): void {
  assertRecord(value, path);
  for (const [key, status] of Object.entries(value)) {
    assertNonEmptyString(key, `${path} key`);
    assert.equal(typeof status, "string", `${path}.${key} must be a string.`);
    assert.ok(milestoneStatuses.has(status as string), `${path}.${key} must be a valid status.`);
  }
}

function assertFixAttemptRecord(value: unknown, path: string): void {
  assertRecord(value, path);
  for (const [key, attemptCount] of Object.entries(value)) {
    assertNonEmptyString(key, `${path} key`);
    assertNonNegativeInteger(attemptCount, `${path}.${key}`);
  }
}

function assertStringRecord(value: unknown, path: string): void {
  assertRecord(value, path);
  for (const [key, item] of Object.entries(value)) {
    assertNonEmptyString(key, `${path} key`);
    assertNonEmptyString(item, `${path}.${key}`);
  }
}

function assertStringArray(value: unknown, path: string): void {
  assert.ok(Array.isArray(value), `${path} must be an array.`);
  for (let index = 0; index < value.length; index += 1) {
    assertString(value[index], `${path}[${index}]`);
  }
}

function assertPhase(value: unknown, path: string): void {
  assert.equal(typeof value, "string", `${path} must be a string.`);
  assert.ok(phases.has(value as string), `${path} must be a valid phase.`);
}

function assertNullOrPositiveInteger(value: unknown, path: string): void {
  assert.ok(
    value === null || (Number.isInteger(value) && Number(value) > 0),
    `${path} must be a positive integer or null.`,
  );
}

function assertNonNegativeInteger(value: unknown, path: string): void {
  assert.ok(
    Number.isInteger(value) && Number(value) >= 0,
    `${path} must be a non-negative integer.`,
  );
}

function assertBoolean(value: unknown, path: string): void {
  assert.equal(typeof value, "boolean", `${path} must be a boolean.`);
}

function assertNullOrString(value: unknown, path: string): void {
  assert.ok(value === null || typeof value === "string", `${path} must be a string or null.`);
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  assert.equal(typeof value, "string", `${path} must be a string.`);
  assert.ok((value as string).trim().length > 0, `${path} must not be empty.`);
}

function assertString(value: unknown, path: string): asserts value is string {
  assert.equal(typeof value, "string", `${path} must be a string.`);
}

function assertIsoTimestamp(value: unknown, path: string): void {
  assertNonEmptyString(value, path);
  const timestamp = Date.parse(value);
  assert.ok(!Number.isNaN(timestamp), `${path} must be an ISO timestamp.`);
  assert.equal(new Date(timestamp).toISOString(), value, `${path} must be a precise ISO timestamp.`);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  assert.ok(isRecord(value), `${path} must be an object.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
