import type { MilestonePlanPolicy } from "../config/config-types.js";
import type { Milestone, MilestoneMetadata } from "../milestones/milestone-types.js";
import type { RunState } from "../state/state-types.js";

export type MilestonePlanMode = "full" | "light";

export interface MilestonePlanDecision {
  policy: MilestonePlanPolicy;
  mode: MilestonePlanMode;
  reason: string;
}

export interface SelectMilestonePlanDecisionOptions {
  policy: MilestonePlanPolicy;
  activeMilestone: Milestone;
  metadata: MilestoneMetadata;
  state: RunState;
}

export interface FormatLightMilestonePlanOptions {
  activeMilestone: Milestone;
  metadata: MilestoneMetadata;
  decision: MilestonePlanDecision;
}

export interface FormatFullMilestonePlanOptions {
  generatedPlan: string;
  decision: MilestonePlanDecision;
}

const broadRiskyTerms = [
  "architecture",
  "auth",
  "authentication",
  "authorization",
  "oauth",
  "login",
  "database",
  "schema",
  "migration",
  "security",
  "state",
  "resume",
  "orchestration",
  "runner",
  "workflow",
  "integration",
  "refactor",
  "across",
  "multiple modules",
  "end-to-end",
  "diagnostics",
];

const vagueVerificationValues = new Set([
  "verify",
  "test",
  "run tests",
  "manual test",
  "ensure it works",
  "n/a",
  "none",
  "tbd",
]);

export function selectMilestonePlanDecision(
  options: SelectMilestonePlanDecisionOptions,
): MilestonePlanDecision {
  const { activeMilestone, policy } = options;

  if (policy === "always") {
    return { policy, mode: "full", reason: "policy=always" };
  }

  if (policy === "light") {
    return { policy, mode: "light", reason: "policy=light" };
  }

  if (activeMilestone.dependencies.length > 0) {
    return {
      policy,
      mode: "full",
      reason: "auto: milestone has dependencies",
    };
  }

  if (activeMilestone.scope.length === 0) {
    return { policy, mode: "full", reason: "auto: scope is empty" };
  }

  if (activeMilestone.scope.length > 2) {
    return {
      policy,
      mode: "full",
      reason: "auto: scope has more than two items",
    };
  }

  if (activeMilestone.acceptanceCriteria.length === 0) {
    return {
      policy,
      mode: "full",
      reason: "auto: acceptance criteria are empty",
    };
  }

  if (activeMilestone.verification.length === 0) {
    return { policy, mode: "full", reason: "auto: verification is empty" };
  }

  if (activeMilestone.verification.length > 2) {
    return {
      policy,
      mode: "full",
      reason: "auto: verification has more than two items",
    };
  }

  if (verificationIsOnlyVague(activeMilestone.verification)) {
    return {
      policy,
      mode: "full",
      reason: "auto: verification is vague",
    };
  }

  const riskyTerm = firstBroadRiskyTerm(activeMilestone);
  if (riskyTerm) {
    return {
      policy,
      mode: "full",
      reason: `auto: broad/risky term "${riskyTerm}" detected`,
    };
  }

  return {
    policy,
    mode: "light",
    reason: "auto: no dependencies, small scope, clear verification",
  };
}

export function formatLightMilestonePlan(
  options: FormatLightMilestonePlanOptions,
): string {
  const { activeMilestone, decision, metadata } = options;

  return [
    `# Milestone ${activeMilestone.id} Plan: ${activeMilestone.title}`,
    "",
    formatMilestonePlanMetadataBlock(decision),
    "",
    "## Milestone Summary",
    "",
    activeMilestone.summary,
    "",
    "## Scope",
    "",
    formatList(activeMilestone.scope, "No scope items provided."),
    "",
    "## Acceptance Criteria",
    "",
    formatList(activeMilestone.acceptanceCriteria, "No acceptance criteria provided."),
    "",
    "## Verification",
    "",
    formatList(activeMilestone.verification, "No verification steps provided."),
    "",
    "## Dependencies",
    "",
    formatDependencies(activeMilestone, metadata),
    "",
    "## Implementation Direction",
    "",
    "Implementation must produce concrete code or file changes for this active milestone.",
    "",
  ].join("\n");
}

export function formatFullMilestonePlan(
  options: FormatFullMilestonePlanOptions,
): string {
  return [
    formatMilestonePlanMetadataBlock(options.decision),
    "",
    "## Runner Plan",
    "",
    options.generatedPlan,
    "",
  ].join("\n");
}

export function formatMilestonePlanMetadataBlock(
  decision: MilestonePlanDecision,
): string {
  return [
    "## Plan Metadata",
    "",
    `- Policy: ${decision.policy}`,
    `- Mode: ${decision.mode}`,
    `- Decision: ${decision.reason}`,
  ].join("\n");
}

function verificationIsOnlyVague(verification: string[]): boolean {
  const normalized = verification.map(normalizeText).filter((value) => value.length > 0);
  return (
    normalized.length > 0 &&
    normalized.every((value) => vagueVerificationValues.has(value))
  );
}

function firstBroadRiskyTerm(milestone: Milestone): string | null {
  const searchableText = normalizeText(
    [
      milestone.title,
      milestone.summary,
      ...milestone.scope,
      ...milestone.acceptanceCriteria,
      ...milestone.verification,
    ].join(" "),
  );

  return broadRiskyTerms.find((term) => containsNormalizedTerm(searchableText, term)) ?? null;
}

function containsNormalizedTerm(searchableText: string, term: string): boolean {
  const normalizedTerm = normalizeText(term);
  if (normalizedTerm.includes(" ") || normalizedTerm.includes("-")) {
    return searchableText.includes(normalizedTerm);
  }

  const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(searchableText);
}

function formatDependencies(
  milestone: Milestone,
  metadata: MilestoneMetadata,
): string {
  if (milestone.dependencies.length === 0) return "No dependencies.";

  return milestone.dependencies
    .map((dependencyId) => {
      const dependency = metadata.milestones.find(
        (candidate) => candidate.id === dependencyId,
      );
      const title = dependency ? `: ${dependency.title}` : "";
      return `- Milestone ${dependencyId}${title}`;
    })
    .join("\n");
}

function formatList(items: string[], emptyText: string): string {
  if (items.length === 0) return emptyText;
  return items.map((item) => `- ${item}`).join("\n");
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
