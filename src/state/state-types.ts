import type { OrchestratorConfig } from "../config/config-types.js";
import type { GitMetadata } from "../git/git-types.js";

export type OrchestratorPhase =
  | "initialized"
  | "planning"
  | "plan_reviewing"
  | "ready_for_milestone"
  | "ready_for_review"
  | "implementing"
  | "checking"
  | "reviewing"
  | "fixing"
  | "passed"
  | "failed"
  | "needs_human_review";

export type MilestoneStatus =
  | "pending"
  | "planned"
  | "ready_for_review"
  | "implementing"
  | "checking"
  | "reviewing"
  | "fixing"
  | "passed"
  | "failed"
  | "needs_human_review";

export interface StateError {
  message: string;
  phase: OrchestratorPhase;
  occurredAt: string;
  details?: string | object | unknown[] | null;
}

export interface StateArtifacts {
  goal?: string;
  majorPlan?: string;
  majorPlanReview?: string;
  finalMajorPlanMarkdown?: string;
  finalMajorPlanJson?: string;
  milestones?: string;
  milestonePlanDrafts?: Record<string, string>;
  milestonePlanReviews?: Record<string, string>;
  milestonePlans?: Record<string, string>;
  implementations?: Record<string, string>;
  diffs?: Record<string, string>;
  checks?: Record<string, string>;
  reviews?: Record<string, string>;
  summaries?: Record<string, string>;
  fixes?: Record<string, string>;
  logs?: Record<string, string>;
}

export interface RunState {
  runId: string;
  goal: string;
  currentPhase: OrchestratorPhase;
  status: OrchestratorPhase;
  currentMilestoneId: number | null;
  artifactRoot: string;
  runDir: string;
  git: GitMetadata;
  config: {
    path: string | null;
    snapshot: OrchestratorConfig | null;
  };
  milestoneStatuses: Record<string, MilestoneStatus>;
  fixAttempts: Record<string, number>;
  artifacts: StateArtifacts;
  lastError: StateError | null;
  createdAt: string;
  updatedAt: string;
}
