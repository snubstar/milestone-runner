import type {
  MilestoneStatus,
  OrchestratorPhase,
  RunState,
} from "./state-types.js";

export type PlanningArtifactStateKey =
  | "majorPlan"
  | "majorPlanReview"
  | "finalMajorPlanMarkdown"
  | "milestones";

export type MilestoneArtifactStateKey =
  | "milestonePlanDrafts"
  | "milestonePlanReviews"
  | "milestonePlans"
  | "implementations"
  | "diffs"
  | "checks"
  | "summaries";

export type ArtifactMapStateKey =
  | MilestoneArtifactStateKey
  | "checkFailures"
  | "reviews"
  | "fixes"
  | "logs";

export function setStatePhase(
  state: RunState,
  phase: OrchestratorPhase,
  now = new Date(),
): RunState {
  return {
    ...state,
    currentPhase: phase,
    status: phase,
    updatedAt: now.toISOString(),
  };
}

export function recordPlanningArtifact(
  state: RunState,
  key: PlanningArtifactStateKey,
  artifactPath: string,
  now = new Date(),
): RunState {
  return {
    ...state,
    artifacts: {
      ...state.artifacts,
      [key]: artifactPath,
    },
    updatedAt: now.toISOString(),
  };
}

export function recordMilestoneArtifact(
  state: RunState,
  key: MilestoneArtifactStateKey,
  milestoneId: number,
  artifactPath: string,
  now = new Date(),
): RunState {
  return recordArtifactByKey(state, key, String(milestoneId), artifactPath, now);
}

export function recordArtifactByKey(
  state: RunState,
  key: ArtifactMapStateKey,
  artifactKey: string,
  artifactPath: string,
  now = new Date(),
): RunState {
  const existingArtifacts = state.artifacts[key] ?? {};

  return {
    ...state,
    artifacts: {
      ...state.artifacts,
      [key]: {
        ...existingArtifacts,
        [artifactKey]: artifactPath,
      },
    },
    updatedAt: now.toISOString(),
  };
}

export function setMilestoneStatus(
  state: RunState,
  milestoneId: number,
  status: MilestoneStatus,
  now = new Date(),
): RunState {
  return {
    ...state,
    milestoneStatuses: {
      ...state.milestoneStatuses,
      [String(milestoneId)]: status,
    },
    updatedAt: now.toISOString(),
  };
}

export function recordMilestoneBaseline(
  state: RunState,
  milestoneId: number,
  baselineTree: string,
  now = new Date(),
): RunState {
  return {
    ...state,
    milestoneBaselines: {
      ...state.milestoneBaselines,
      [String(milestoneId)]: baselineTree,
    },
    updatedAt: now.toISOString(),
  };
}

export interface CompletePlanningOptions {
  milestoneStatuses: Record<string, MilestoneStatus>;
  currentMilestoneId: number;
  now?: Date;
}

export function completePlanningState(
  state: RunState,
  options: CompletePlanningOptions,
): RunState {
  const timestamp = (options.now ?? new Date()).toISOString();

  return {
    ...state,
    currentPhase: "ready_for_milestone",
    status: "ready_for_milestone",
    currentMilestoneId: options.currentMilestoneId,
    milestoneStatuses: options.milestoneStatuses,
    lastError: null,
    updatedAt: timestamp,
  };
}

export function advanceToMilestoneState(
  state: RunState,
  milestoneId: number,
  now = new Date(),
): RunState {
  return {
    ...state,
    currentPhase: "ready_for_milestone",
    status: "ready_for_milestone",
    currentMilestoneId: milestoneId,
    lastError: null,
    updatedAt: now.toISOString(),
  };
}

export function completeGoalState(
  state: RunState,
  now = new Date(),
): RunState {
  return {
    ...state,
    currentPhase: "passed",
    status: "passed",
    currentMilestoneId: null,
    lastError: null,
    updatedAt: now.toISOString(),
  };
}

export interface StopGoalForHumanReviewOptions {
  message: string;
  details?: string | object | unknown[] | null;
  currentMilestoneId?: number | null;
}

export function stopGoalForHumanReviewState(
  state: RunState,
  options: StopGoalForHumanReviewOptions,
  now = new Date(),
): RunState {
  const timestamp = now.toISOString();

  return {
    ...state,
    currentPhase: "needs_human_review",
    status: "needs_human_review",
    currentMilestoneId:
      options.currentMilestoneId === undefined
        ? state.currentMilestoneId
        : options.currentMilestoneId,
    lastError: {
      message: options.message,
      phase: "needs_human_review",
      occurredAt: timestamp,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
    updatedAt: timestamp,
  };
}

export interface FailStateOptions {
  phase: OrchestratorPhase;
  message: string;
  details?: string | object | unknown[] | null;
  now?: Date;
}

export function failState(state: RunState, options: FailStateOptions): RunState {
  const timestamp = (options.now ?? new Date()).toISOString();

  return {
    ...state,
    currentPhase: options.phase,
    status: "failed",
    lastError: {
      message: options.message,
      phase: options.phase,
      occurredAt: timestamp,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
    updatedAt: timestamp,
  };
}
