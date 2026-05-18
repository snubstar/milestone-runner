import type {
  MilestoneStatus,
  OrchestratorPhase,
} from "../state/state-types.js";

export type TimingWarningCode =
  | "timeline_missing"
  | "timeline_incomplete"
  | "phase_interval_incomplete"
  | "runner_diagnostic_missing"
  | "runner_diagnostic_malformed"
  | "runner_duration_invalid"
  | "check_report_missing"
  | "check_report_malformed"
  | "timing_finalization_failed";

export type TimingWarningSource =
  | "timeline"
  | "runner"
  | "checks"
  | "finalization"
  | "workflow";

export interface TimingWarning {
  code: TimingWarningCode;
  message: string;
  source: TimingWarningSource;
  details?: string | number | boolean | null | object | unknown[];
}

export interface TimingWarningCollector {
  add(warning: TimingWarning): void;
  list(): TimingWarning[];
}

export function createTimingWarningCollector(
  initialWarnings: TimingWarning[] = [],
): TimingWarningCollector {
  const warnings = [...initialWarnings];
  return {
    add(warning) {
      warnings.push(warning);
    },
    list() {
      return [...warnings];
    },
  };
}

export type WorkflowTimelineEventName =
  | "state_initialized"
  | "phase_changed"
  | "status_changed"
  | "current_milestone_changed"
  | "milestone_status_changed"
  | "invocation_started"
  | "invocation_ended";

export interface ChangedMilestoneStatus {
  previous?: MilestoneStatus;
  next: MilestoneStatus;
}

export interface WorkflowTimelineEvent {
  timestamp: string;
  event: WorkflowTimelineEventName;
  invocationId?: string;
  phase: OrchestratorPhase;
  status: OrchestratorPhase;
  currentMilestoneId: number | null;
  previousPhase?: OrchestratorPhase;
  previousStatus?: OrchestratorPhase;
  previousCurrentMilestoneId?: number | null;
  changedMilestoneStatuses?: Record<string, ChangedMilestoneStatus>;
}

export interface WorkflowInvocationTiming {
  invocationId: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  startPhase: OrchestratorPhase;
  terminalPhase?: OrchestratorPhase;
  terminalStatus?: OrchestratorPhase;
}

export interface WorkflowPhaseTiming {
  phase: OrchestratorPhase;
  milestoneId: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface RunnerPhaseTiming {
  phase: string;
  milestoneId: number | null;
  startedAt: string;
  endedAt: string;
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  sourceArtifact: string;
}

export type CheckTimingSource = "structured" | "parsed_report";
export type CheckTimingConfidence = "high" | "medium" | "low";

export interface CheckTiming {
  stateKey: string;
  milestoneId: number;
  attempt: number | null;
  commandIndex: number;
  command?: string;
  durationMs: number;
  exitCode?: number | null;
  source: CheckTimingSource;
  confidence: CheckTimingConfidence;
  sourceArtifact: string;
}

export interface AggregateTimings {
  runnerDurationMs: number;
  checkDurationMs: number;
  knownWorkflowPhaseDurationMs: number;
  workflowDurationByPhaseMs?: Partial<Record<OrchestratorPhase, number>>;
  runnerDurationByPhaseMs?: Record<string, number>;
  checkDurationByMilestoneMs?: Record<string, number>;
}

export interface FinalTimingsDocument {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  runStartedAt: string;
  latestInvocationStartedAt: string;
  runEndedAt: string;
  finalizedAt: string;
  lifecycleDurationMs: number;
  activeWorkflowDurationMs: number;
  latestInvocationDurationMs: number;
  aggregates: AggregateTimings;
  invocations: WorkflowInvocationTiming[];
  workflowPhases: WorkflowPhaseTiming[];
  runnerPhases: RunnerPhaseTiming[];
  checks: CheckTiming[];
  warnings: TimingWarning[];
}
