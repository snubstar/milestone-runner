import type { MilestoneStatus } from "../state/state-types.js";
import type { Milestone, MilestoneMetadata, MilestoneResult } from "./milestone-types.js";

const allowedRootFields = new Set(["milestones"]);
const requiredMilestoneFields = [
  "id",
  "title",
  "summary",
  "scope",
  "acceptanceCriteria",
  "verification",
  "dependencies",
  "status",
] as const;
const allowedMilestoneFields = new Set<string>(requiredMilestoneFields);
const milestoneStatuses = new Set<MilestoneStatus>([
  "pending",
  "planned",
  "ready_for_review",
  "implementing",
  "checking",
  "checks_failed",
  "repairing_checks",
  "rechecking",
  "reviewing",
  "fixing",
  "passed",
  "failed",
  "needs_human_review",
]);

export function parseMilestoneMetadataJson(raw: string): MilestoneResult<MilestoneMetadata> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid milestone metadata JSON: ${formatError(error)}`,
    };
  }

  return validateMilestoneMetadata(parsed);
}

export function validateMilestoneMetadata(value: unknown): MilestoneResult<MilestoneMetadata> {
  if (!isRecord(value)) {
    return { ok: false, error: "Milestone metadata must be an object." };
  }

  const rootExtraFields = extraFields(value, allowedRootFields);
  if (rootExtraFields.length > 0) {
    return {
      ok: false,
      error: `Milestone metadata has unsupported fields: ${rootExtraFields.join(", ")}.`,
    };
  }

  if (!Array.isArray(value.milestones) || value.milestones.length === 0) {
    return { ok: false, error: "`milestones` must be a non-empty array." };
  }

  const milestones: Milestone[] = [];
  for (let index = 0; index < value.milestones.length; index += 1) {
    const result = validateMilestone(value.milestones[index], index);
    if (!result.ok) return result;
    milestones.push(result.value);
  }

  const semanticResult = validateMilestoneSemantics(milestones);
  if (!semanticResult.ok) return semanticResult;

  return { ok: true, value: { milestones } };
}

export function toMilestoneStatusMap(
  metadata: MilestoneMetadata,
): Record<string, MilestoneStatus> {
  return Object.fromEntries(
    metadata.milestones.map((milestone) => [String(milestone.id), "pending"]),
  );
}

export function firstPendingMilestoneId(metadata: MilestoneMetadata): number | null {
  const pendingIds = metadata.milestones
    .filter((milestone) => milestone.status === "pending")
    .map((milestone) => milestone.id);

  return pendingIds.length > 0 ? Math.min(...pendingIds) : null;
}

function validateMilestone(value: unknown, index: number): MilestoneResult<Milestone> {
  const path = `milestones[${index}]`;
  if (!isRecord(value)) {
    return { ok: false, error: `${path} must be an object.` };
  }

  const extra = extraFields(value, allowedMilestoneFields);
  if (extra.length > 0) {
    return { ok: false, error: `${path} has unsupported fields: ${extra.join(", ")}.` };
  }

  for (const field of requiredMilestoneFields) {
    if (!(field in value)) {
      return { ok: false, error: `${path}.${field} is required.` };
    }
  }

  const id = value.id;
  if (!isPositiveInteger(id)) {
    return { ok: false, error: `${path}.id must be a positive integer.` };
  }

  const title = validateNonEmptyString(value.title, `${path}.title`);
  if (!title.ok) return title;

  const summary = validateNonEmptyString(value.summary, `${path}.summary`);
  if (!summary.ok) return summary;

  const scope = validateStringList(value.scope, `${path}.scope`);
  if (!scope.ok) return scope;

  const acceptanceCriteria = validateStringList(
    value.acceptanceCriteria,
    `${path}.acceptanceCriteria`,
  );
  if (!acceptanceCriteria.ok) return acceptanceCriteria;

  const verification = validateStringList(value.verification, `${path}.verification`);
  if (!verification.ok) return verification;

  const dependencies = validateDependencies(value.dependencies, `${path}.dependencies`);
  if (!dependencies.ok) return dependencies;

  const status = value.status;
  if (typeof status !== "string" || !milestoneStatuses.has(status as MilestoneStatus)) {
    return { ok: false, error: `${path}.status must be a valid milestone status.` };
  }

  if (status !== "pending") {
    return { ok: false, error: `${path}.status must be pending for generated metadata.` };
  }

  return {
    ok: true,
    value: {
      id,
      title: title.value,
      summary: summary.value,
      scope: scope.value,
      acceptanceCriteria: acceptanceCriteria.value,
      verification: verification.value,
      dependencies: dependencies.value,
      status,
    },
  };
}

function validateMilestoneSemantics(milestones: Milestone[]): MilestoneResult<null> {
  const ids = new Set<number>();

  for (const milestone of milestones) {
    if (ids.has(milestone.id)) {
      return { ok: false, error: `Duplicate milestone id: ${milestone.id}.` };
    }
    ids.add(milestone.id);
  }

  for (const milestone of milestones) {
    for (const dependency of milestone.dependencies) {
      if (!ids.has(dependency)) {
        return {
          ok: false,
          error: `Milestone ${milestone.id} depends on missing milestone ${dependency}.`,
        };
      }

      if (dependency === milestone.id) {
        return {
          ok: false,
          error: `Milestone ${milestone.id} cannot depend on itself.`,
        };
      }

      if (dependency > milestone.id) {
        return {
          ok: false,
          error: `Milestone ${milestone.id} depends on future milestone ${dependency}.`,
        };
      }
    }
  }

  return { ok: true, value: null };
}

function validateNonEmptyString(value: unknown, path: string): MilestoneResult<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: `${path} must be a non-empty string.` };
  }

  return { ok: true, value };
}

function validateStringList(value: unknown, path: string): MilestoneResult<string[]> {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${path} must be an array of non-empty strings.` };
  }

  const values: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || item.trim().length === 0) {
      return {
        ok: false,
        error: `${path}[${index}] must be a non-empty string.`,
      };
    }
    values.push(item);
  }

  return { ok: true, value: values };
}

function validateDependencies(value: unknown, path: string): MilestoneResult<number[]> {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${path} must be an array of positive integers.` };
  }

  const dependencies: number[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < value.length; index += 1) {
    const dependency = value[index];
    if (!isPositiveInteger(dependency)) {
      return { ok: false, error: `${path}[${index}] must be a positive integer.` };
    }

    if (seen.has(dependency)) {
      return { ok: false, error: `${path} must not contain duplicate values.` };
    }

    seen.add(dependency);
    dependencies.push(dependency);
  }

  return { ok: true, value: dependencies };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extraFields(value: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(value)
    .filter((field) => !allowed.has(field))
    .sort();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
