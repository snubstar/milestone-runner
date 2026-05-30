import type { MilestoneMetadata } from "../milestones/milestone-types.js";
import type { RunState } from "../state/state-types.js";
import {
  normalizeStateForGoalResume,
  type ResumeDecision,
} from "./resume-state.js";

export type ResumeResolutionAction =
  | "continue"
  | "normalize_to_ready_for_review"
  | "normalize_to_passed"
  | "fail";

export interface ResumeResolutionDocument {
  action: ResumeResolutionAction;
  summary: string;
  rationale: string;
  assumptions: string[];
  currentMilestoneId?: number | null;
}

export type ResumeResolutionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface ResumeResolutionValidationContext {
  state: RunState;
  metadata: MilestoneMetadata;
  originalDecision: Extract<ResumeDecision, { kind: "needs_human_review" }>;
  existingArtifacts?: ReadonlySet<string>;
}

const allowedActions = new Set<ResumeResolutionAction>([
  "continue",
  "normalize_to_ready_for_review",
  "normalize_to_passed",
  "fail",
]);
const requiredRootFields = [
  "action",
  "summary",
  "rationale",
  "assumptions",
] as const;
const allowedRootFields = new Set<string>([
  ...requiredRootFields,
  "currentMilestoneId",
]);

export function parseResumeResolutionJson(
  raw: string,
): ResumeResolutionResult<ResumeResolutionDocument> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid resume resolution JSON: ${formatError(error)}`,
    };
  }

  return validateResumeResolution(parsed);
}

export function validateResumeResolution(
  value: unknown,
): ResumeResolutionResult<ResumeResolutionDocument> {
  if (!isRecord(value)) {
    return { ok: false, error: "Resume resolution must be an object." };
  }

  const extra = extraFields(value, allowedRootFields);
  if (extra.length > 0) {
    return {
      ok: false,
      error: `Resume resolution has unsupported fields: ${extra.join(", ")}.`,
    };
  }

  for (const field of requiredRootFields) {
    if (!(field in value)) {
      return { ok: false, error: `Resume resolution ${field} is required.` };
    }
  }

  const action = validateAction(value.action);
  if (!action.ok) return action;

  const summary = validateNonEmptyString(value.summary, "Resume resolution summary");
  if (!summary.ok) return summary;

  const rationale = validateNonEmptyString(
    value.rationale,
    "Resume resolution rationale",
  );
  if (!rationale.ok) return rationale;

  const assumptions = validateStringList(
    value.assumptions,
    "Resume resolution assumptions",
  );
  if (!assumptions.ok) return assumptions;

  const currentMilestoneId = validateOptionalMilestoneId(value.currentMilestoneId);
  if (!currentMilestoneId.ok) return currentMilestoneId;

  return {
    ok: true,
    value: {
      action: action.value,
      summary: summary.value,
      rationale: rationale.value,
      assumptions: assumptions.value,
      ...(currentMilestoneId.value === undefined
        ? {}
        : { currentMilestoneId: currentMilestoneId.value }),
    },
  };
}

export function validateResumeResolutionAction(
  resolution: ResumeResolutionDocument,
  context: ResumeResolutionValidationContext,
): string | null {
  const idError = validateDocumentMilestoneId(resolution, context);
  if (idError) return idError;

  if (resolution.action === "fail") return null;

  if (resolution.action === "continue") {
    const deterministicDecision = normalizeStateForGoalResume(
      context.state,
      context.metadata,
    );
    return deterministicDecision.kind === "continue"
      ? null
      : "Resolution action continue is only valid when deterministic resume normalization can continue safely.";
  }

  const milestoneId = resolution.currentMilestoneId;
  if (milestoneId === undefined || milestoneId === null) {
    return `Resolution action ${resolution.action} requires currentMilestoneId.`;
  }

  if (resolution.action === "normalize_to_ready_for_review") {
    const missing = missingReadyForReviewArtifacts(context, milestoneId);
    return missing.length === 0
      ? null
      : `Resolution action normalize_to_ready_for_review is missing required artifacts: ${missing.join(", ")}.`;
  }

  if (resolution.action === "normalize_to_passed") {
    const milestoneStatus = context.state.milestoneStatuses[String(milestoneId)];
    if (milestoneStatus !== "passed") {
      return `Resolution action normalize_to_passed requires milestone ${milestoneId} to already be passed, got ${milestoneStatus ?? "missing"}.`;
    }

    const missing = [
      ...missingReadyForReviewArtifacts(context, milestoneId),
      ...missingReviewArtifacts(context, milestoneId),
    ];
    return missing.length === 0
      ? null
      : `Resolution action normalize_to_passed is missing required artifacts: ${missing.join(", ")}.`;
  }

  return `Unsupported resume resolution action: ${resolution.action}.`;
}

function validateDocumentMilestoneId(
  resolution: ResumeResolutionDocument,
  context: ResumeResolutionValidationContext,
): string | null {
  if (resolution.currentMilestoneId === undefined) return null;

  if (resolution.currentMilestoneId !== context.state.currentMilestoneId) {
    return `Resolution currentMilestoneId must match state currentMilestoneId ${context.state.currentMilestoneId ?? "null"}.`;
  }

  if (
    resolution.currentMilestoneId !== null &&
    !context.metadata.milestones.some(
      (milestone) => milestone.id === resolution.currentMilestoneId,
    )
  ) {
    return `Resolution currentMilestoneId ${resolution.currentMilestoneId} is missing from milestone metadata.`;
  }

  return null;
}

function missingReadyForReviewArtifacts(
  context: ResumeResolutionValidationContext,
  milestoneId: number,
): string[] {
  const key = String(milestoneId);
  const required = [
    ["milestonePlans", context.state.artifacts.milestonePlans?.[key]],
    ["implementations", context.state.artifacts.implementations?.[key]],
    ["diffs", context.state.artifacts.diffs?.[key]],
    ["checks", context.state.artifacts.checks?.[key]],
    ["summaries", context.state.artifacts.summaries?.[key]],
  ] as const;

  return required
    .filter(([, artifactPath]) => !artifactPathExists(context, artifactPath))
    .map(([label]) => label);
}

function missingReviewArtifacts(
  context: ResumeResolutionValidationContext,
  milestoneId: number,
): string[] {
  const missing: string[] = [];
  const summaryPath = context.state.artifacts.summaries?.[`${milestoneId}-review`];
  if (!artifactPathExists(context, summaryPath)) {
    missing.push("reviewSummary");
  }

  const reviewPath = latestReviewArtifactPath(context.state, milestoneId);
  if (!artifactPathExists(context, reviewPath)) {
    missing.push("review");
  }

  return missing;
}

function latestReviewArtifactPath(
  state: RunState,
  milestoneId: number,
): string | undefined {
  const reviews = state.artifacts.reviews;
  if (!reviews) return undefined;

  const baseKey = String(milestoneId);
  let selected = reviews[baseKey];
  let selectedAttempt = selected === undefined ? -1 : 0;
  const fixKeyPattern = new RegExp(`^${milestoneId}-fix-(\\d+)$`);

  for (const [stateKey, artifactPath] of Object.entries(reviews)) {
    const match = fixKeyPattern.exec(stateKey);
    if (!match) continue;

    const attempt = Number(match[1]);
    if (attempt > selectedAttempt) {
      selected = artifactPath;
      selectedAttempt = attempt;
    }
  }

  return selected;
}

function artifactPathExists(
  context: ResumeResolutionValidationContext,
  artifactPath: string | undefined,
): boolean {
  if (artifactPath === undefined || artifactPath.trim().length === 0) {
    return false;
  }

  return context.existingArtifacts === undefined
    ? true
    : context.existingArtifacts.has(artifactPath);
}

function validateAction(value: unknown): ResumeResolutionResult<ResumeResolutionAction> {
  if (typeof value !== "string" || !allowedActions.has(value as ResumeResolutionAction)) {
    return {
      ok: false,
      error: "Resume resolution action must be one of continue, normalize_to_ready_for_review, normalize_to_passed, or fail.",
    };
  }

  return { ok: true, value: value as ResumeResolutionAction };
}

function validateOptionalMilestoneId(
  value: unknown,
): ResumeResolutionResult<number | null | undefined> {
  if (value === undefined || value === null) {
    return { ok: true, value };
  }

  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    return {
      ok: false,
      error: "Resume resolution currentMilestoneId must be a positive integer or null.",
    };
  }

  return { ok: true, value };
}

function validateNonEmptyString(
  value: unknown,
  path: string,
): ResumeResolutionResult<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: `${path} must be a non-empty string.` };
  }

  return { ok: true, value };
}

function validateStringList(
  value: unknown,
  path: string,
): ResumeResolutionResult<string[]> {
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
