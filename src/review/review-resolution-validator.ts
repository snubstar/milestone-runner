import type {
  ReviewResolutionDocument,
  ReviewResolutionMetadata,
  ReviewResult,
} from "./review-types.js";
import { validateReviewVerdict } from "./review-verdict-validator.js";

const requiredRootFields = ["resolution", "verdict"] as const;
const allowedRootFields = new Set<string>(requiredRootFields);
const requiredResolutionFields = [
  "summary",
  "rationale",
  "assumptions",
  "sourceCondition",
] as const;
const allowedResolutionFields = new Set<string>(requiredResolutionFields);

export function parseReviewResolutionJson(raw: string): ReviewResult<ReviewResolutionDocument> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid review resolution JSON: ${formatError(error)}`,
    };
  }

  return validateReviewResolution(parsed);
}

export function validateReviewResolution(value: unknown): ReviewResult<ReviewResolutionDocument> {
  if (!isRecord(value)) {
    return { ok: false, error: "Review resolution must be an object." };
  }

  const extra = extraFields(value, allowedRootFields);
  if (extra.length > 0) {
    return {
      ok: false,
      error: `Review resolution has unsupported fields: ${extra.join(", ")}.`,
    };
  }

  for (const field of requiredRootFields) {
    if (!(field in value)) {
      return { ok: false, error: `Review resolution ${field} is required.` };
    }
  }

  const resolution = validateResolutionMetadata(value.resolution);
  if (!resolution.ok) return resolution;

  const verdict = validateReviewVerdict(value.verdict);
  if (!verdict.ok) return verdict;

  return {
    ok: true,
    value: {
      resolution: resolution.value,
      verdict: verdict.value,
    },
  };
}

function validateResolutionMetadata(value: unknown): ReviewResult<ReviewResolutionMetadata> {
  if (!isRecord(value)) {
    return { ok: false, error: "Review resolution metadata must be an object." };
  }

  const extra = extraFields(value, allowedResolutionFields);
  if (extra.length > 0) {
    return {
      ok: false,
      error: `Review resolution metadata has unsupported fields: ${extra.join(", ")}.`,
    };
  }

  for (const field of requiredResolutionFields) {
    if (!(field in value)) {
      return { ok: false, error: `Review resolution metadata ${field} is required.` };
    }
  }

  const summary = validateNonEmptyString(value.summary, "Review resolution summary");
  if (!summary.ok) return summary;

  const rationale = validateNonEmptyString(value.rationale, "Review resolution rationale");
  if (!rationale.ok) return rationale;

  const assumptions = validateStringList(value.assumptions, "Review resolution assumptions");
  if (!assumptions.ok) return assumptions;

  const sourceCondition = validateNonEmptyString(
    value.sourceCondition,
    "Review resolution sourceCondition",
  );
  if (!sourceCondition.ok) return sourceCondition;

  return {
    ok: true,
    value: {
      summary: summary.value,
      rationale: rationale.value,
      assumptions: assumptions.value,
      sourceCondition: sourceCondition.value,
    },
  };
}

function validateNonEmptyString(value: unknown, path: string): ReviewResult<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: `${path} must be a non-empty string.` };
  }

  return { ok: true, value };
}

function validateStringList(value: unknown, path: string): ReviewResult<string[]> {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${path} must be an array of strings.` };
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
