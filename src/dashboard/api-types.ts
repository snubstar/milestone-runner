import type { ResumeRecoveryMode } from "../orchestration/resume-recovery.js";

export type DashboardArtifactGroup =
  | "goal"
  | "inputs"
  | "plans"
  | "milestones"
  | "diffs"
  | "checks"
  | "reviews"
  | "summaries"
  | "fixes"
  | "logs"
  | "runner";

export interface DashboardWarning {
  code: string;
  message: string;
  source: "state" | "timeline" | "artifact" | "server" | "launcher";
  details?: unknown;
}

export interface DashboardArtifactLink {
  id: string;
  group: DashboardArtifactGroup;
  label: string;
  relativePath: string;
  href: string;
  mediaType: string;
  exists: boolean;
  sizeBytes?: number;
  updatedAt?: string;
  milestoneId?: number | null;
  source: "state" | "known-path" | "derived";
}

export interface DashboardRunInputs {
  goalSource: {
    type: "argv" | "file";
    path: string | null;
  };
  majorPlanSource: {
    type: "runner" | "seed";
    path: string | null;
    sizeBytes?: number;
    sha256?: string;
  };
  context: Array<{
    path: string;
    artifactPath: string;
    artifact: DashboardArtifactLink | null;
    sizeBytes: number;
    sha256: string;
  }>;
  manifestArtifact?: DashboardArtifactLink;
}

export interface DashboardTimelineEvent {
  index: number;
  timestamp: string | null;
  event: string;
  phase?: string;
  status?: string;
  currentMilestoneId?: number | null;
  invocationId?: string;
  raw: unknown;
}

export interface DashboardRunSummary {
  runId: string;
  runDir: string;
  goal: string;
  status: string;
  currentPhase: string;
  currentMilestoneId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  active: boolean;
  warnings: DashboardWarning[];
}

export interface DashboardRunDetail extends DashboardRunSummary {
  milestoneStatuses: Record<string, string>;
  lastError: unknown | null;
  inputs?: DashboardRunInputs;
  artifacts: Record<DashboardArtifactGroup, DashboardArtifactLink[]>;
  timeline: DashboardTimelineEvent[];
  timingArtifacts: DashboardArtifactLink[];
  runnerDiagnostics: DashboardArtifactLink[];
  statePath: string;
}

export interface DashboardRunsResponse {
  runs: DashboardRunSummary[];
  warnings: DashboardWarning[];
}

export type DashboardLaunchRunner = "fake" | "codex-exec";
export type DashboardMilestonePlanPolicy = "always" | "auto" | "light";
export type DashboardMilestonePlanReviewPolicy = "normal" | "scrupulous";
export type DashboardResumeRecoveryMode = ResumeRecoveryMode;

export interface DashboardBootstrapResponse {
  dashboardToken: string;
}

export interface DashboardLaunchRequest {
  prompt?: string;
  goalFilePath?: string;
  runner?: DashboardLaunchRunner;
  dryRun?: boolean;
  milestone?: number;
  milestonePlanPolicy?: DashboardMilestonePlanPolicy;
  milestonePlanReviewPolicy?: DashboardMilestonePlanReviewPolicy;
  allowDirty?: boolean;
  allowNonGitPlanning?: boolean;
  artifactRoot?: string;
  contextPaths?: string[];
  seedMajorPlanPath?: string;
}

export interface DashboardLaunchResponse {
  launchId: string;
  runId: string;
  runDir: string;
  dryRun: boolean;
  started: boolean;
  exitCode: number | null;
  report: unknown | null;
  diagnosticsPath: string;
}

export interface DashboardResumeOptions {
  allowDirty?: boolean;
  allowNonGitPlanning?: boolean;
  milestone?: number;
  resumeRecoveryMode?: DashboardResumeRecoveryMode;
  milestonePlanPolicy?: DashboardMilestonePlanPolicy;
  milestonePlanReviewPolicy?: DashboardMilestonePlanReviewPolicy;
}

export type DashboardResumeDryRunRequest = DashboardResumeOptions;

export interface DashboardResumeDryRunResponse {
  resumeId: string;
  runId: string;
  runDir: string;
  allowed: boolean;
  exitCode: number;
  nextAction: string;
  warnings: string[];
  options: Required<
    Pick<
      DashboardResumeOptions,
      "allowDirty" | "allowNonGitPlanning" | "resumeRecoveryMode"
    >
  > &
    Pick<
      DashboardResumeOptions,
      "milestone" | "milestonePlanPolicy" | "milestonePlanReviewPolicy"
    >;
  report: unknown;
  confirmationToken: string;
  createdAt: string;
  expiresAt: string;
  diagnosticsPath: string;
}

export interface DashboardResumeRequest {
  resumeId: string;
  confirmationToken: string;
}

export interface DashboardResumeResponse {
  resumeId: string;
  launchId: string;
  runId: string;
  runDir: string;
  started: boolean;
  exitCode: number | null;
  diagnosticsPath: string;
}

export type DashboardStreamEventName =
  | "phase_changed"
  | "milestone_status_changed"
  | "artifact_written"
  | "runner_diagnostic_written"
  | "invocation_started"
  | "invocation_ended"
  | "timeline_event"
  | "launcher_output"
  | "launcher_completed"
  | "stream_error"
  | "heartbeat";

export interface DashboardLauncherEventDetails {
  launchId?: string;
  stream?: "stdout" | "stderr";
  text?: string;
  status?: "starting" | "running" | "completed" | "spawn_failed";
  exitCode?: number | null;
  signal?: string | null;
  diagnosticsPath?: string;
}

export interface DashboardStreamEvent {
  id: string;
  runId: string;
  event: DashboardStreamEventName;
  timestamp: string | null;
  message: string;
  phase?: string;
  status?: string;
  currentMilestoneId?: number | null;
  timeline?: DashboardTimelineEvent;
  artifact?: DashboardArtifactLink;
  runnerDiagnostic?: DashboardArtifactLink;
  launcher?: DashboardLauncherEventDetails;
  raw?: unknown;
}

export interface DashboardError {
  code: string;
  message: string;
  details?: unknown;
}

export interface DashboardErrorResponse {
  error: DashboardError;
}
