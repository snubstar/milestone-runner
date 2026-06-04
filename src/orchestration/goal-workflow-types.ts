import type { RunPaths } from "../artifacts/paths.js";
import type { OrchestratorConfig } from "../config/config-types.js";
import type { ResolvedSeedMajorPlan } from "../inputs/initial-inputs.js";
import type { AgentRunner } from "../runners/agent-runner.js";
import type { CommandRunner } from "../shell/command-runner.js";
import type { RunState } from "../state/state-types.js";
import type { TimingWarning } from "../timings/timing-types.js";
import type { ResumeRecoveryMode } from "./resume-recovery.js";

export interface GoalWorkflowOptions {
  goal: string;
  config: OrchestratorConfig;
  paths: RunPaths;
  initialState: RunState;
  runner: AgentRunner;
  commandRunner: CommandRunner;
  cwd: string;
  planningOnly?: boolean;
  promptDir?: string;
  schemaRoot?: string;
  milestonesSchema?: string | object;
  resolvedSeedMajorPlan?: ResolvedSeedMajorPlan;
  executionLimits?: GoalWorkflowExecutionLimits;
  resumeRecoveryMode?: ResumeRecoveryMode;
  invocationId?: string;
  timingWarnings?: TimingWarning[];
  now?: () => Date;
}

export interface GoalWorkflowExecutionLimits {
  targetMilestoneId?: number;
  stopAfterTargetMilestone?: boolean;
}

export interface GoalWorkflowResult {
  ok: boolean;
  state: RunState;
  error?: string;
  nextAction?: string;
  timingWarnings?: TimingWarning[];
}
