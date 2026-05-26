import type {
  ReviewFinding,
  ReviewFindingSeverity,
  ReviewResult,
  ReviewVerdict,
  ReviewVerdictDocument,
} from "./review-types.js";

const requiredRootFields = ["verdict", "summary", "findings", "reviewedArtifacts"] as const;
const allowedRootFields = new Set<string>(requiredRootFields);
const requiredFindingFields = [
  "severity",
  "file",
  "issue",
  "suggestedFix",
  "blocking",
] as const;
const allowedFindingFields = new Set<string>(requiredFindingFields);
const verdicts = new Set<ReviewVerdict>(["pass", "fail", "needs_human_review"]);
const severities = new Set<ReviewFindingSeverity>(["high", "medium", "low"]);

export function parseReviewVerdictJson(raw: string): ReviewResult<ReviewVerdictDocument> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid review verdict JSON: ${formatError(error)}`,
    };
  }

  return validateReviewVerdict(parsed);
}

export function validateReviewVerdict(value: unknown): ReviewResult<ReviewVerdictDocument> {
  if (!isRecord(value)) {
    return { ok: false, error: "Review verdict must be an object." };
  }

  const extra = extraFields(value, allowedRootFields);
  if (extra.length > 0) {
    return {
      ok: false,
      error: `Review verdict has unsupported fields: ${extra.join(", ")}.`,
    };
  }

  for (const field of requiredRootFields) {
    if (!(field in value)) {
      return { ok: false, error: `Review verdict ${field} is required.` };
    }
  }

  const verdict = validateVerdict(value.verdict);
  if (!verdict.ok) return verdict;

  const summary = validateNonEmptyString(value.summary, "Review verdict summary");
  if (!summary.ok) return summary;

  const findings = validateFindings(value.findings);
  if (!findings.ok) return findings;

  const reviewedArtifacts = validateUniqueStringList(
    value.reviewedArtifacts,
    "Review verdict reviewedArtifacts",
  );
  if (!reviewedArtifacts.ok) return reviewedArtifacts;

  if (
    verdict.value === "pass" &&
    findings.value.some((finding) => finding.blocking)
  ) {
    return {
      ok: false,
      error: "Review verdict cannot pass with blocking findings.",
    };
  }

  return {
    ok: true,
    value: {
      verdict: verdict.value,
      summary: summary.value,
      findings: findings.value,
      reviewedArtifacts: reviewedArtifacts.value,
    },
  };
}

function validateVerdict(value: unknown): ReviewResult<ReviewVerdict> {
  if (typeof value !== "string" || !verdicts.has(value as ReviewVerdict)) {
    return { ok: false, error: "Review verdict verdict must be pass, fail, or needs_human_review." };
  }

  return { ok: true, value: value as ReviewVerdict };
}

function validateFindings(value: unknown): ReviewResult<ReviewFinding[]> {
  if (!Array.isArray(value)) {
    return { ok: false, error: "Review verdict findings must be an array." };
  }

  const findings: ReviewFinding[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const result = validateFinding(value[index], index);
    if (!result.ok) return result;
    findings.push(result.value);
  }

  return { ok: true, value: findings };
}

function validateFinding(value: unknown, index: number): ReviewResult<ReviewFinding> {
  const path = `findings[${index}]`;
  if (!isRecord(value)) {
    return { ok: false, error: `${path} must be an object.` };
  }

  const extra = extraFields(value, allowedFindingFields);
  if (extra.length > 0) {
    return { ok: false, error: `${path} has unsupported fields: ${extra.join(", ")}.` };
  }

  for (const field of requiredFindingFields) {
    if (!(field in value)) {
      return { ok: false, error: `${path}.${field} is required.` };
    }
  }

  const severity = value.severity;
  if (typeof severity !== "string" || !severities.has(severity as ReviewFindingSeverity)) {
    return { ok: false, error: `${path}.severity must be high, medium, or low.` };
  }

  const file = value.file;
  if (file !== null && typeof file !== "string") {
    return { ok: false, error: `${path}.file must be a string or null.` };
  }

  const issue = validateNonEmptyString(value.issue, `${path}.issue`);
  if (!issue.ok) return issue;

  const suggestedFix = validateNonEmptyString(value.suggestedFix, `${path}.suggestedFix`);
  if (!suggestedFix.ok) return suggestedFix;

  if (typeof value.blocking !== "boolean") {
    return { ok: false, error: `${path}.blocking must be a boolean.` };
  }

  return {
    ok: true,
    value: {
      severity: severity as ReviewFindingSeverity,
      file,
      issue: issue.value,
      suggestedFix: suggestedFix.value,
      blocking: value.blocking,
    },
  };
}

function validateNonEmptyString(value: unknown, path: string): ReviewResult<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: `${path} must be a non-empty string.` };
  }

  return { ok: true, value };
}

function validateUniqueStringList(value: unknown, path: string): ReviewResult<string[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: `${path} must be a non-empty array of strings.` };
  }

  const values: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || item.trim().length === 0) {
      return {
        ok: false,
        error: `${path}[${index}] must be a non-empty string.`,
      };
    }

    if (seen.has(item)) {
      return { ok: false, error: `${path} must not contain duplicate values.` };
    }

    seen.add(item);
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
