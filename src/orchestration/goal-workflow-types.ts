import type { RunPaths } from "../artifacts/paths.js";
import type { OrchestratorConfig } from "../config/config-types.js";
import type { AgentRunner } from "../runners/agent-runner.js";
import type { CommandRunner } from "../shell/command-runner.js";
import type { RunState } from "../state/state-types.js";
import type { TimingWarning } from "../timings/timing-types.js";

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
  milestonesSchema?: string | object;
  executionLimits?: GoalWorkflowExecutionLimits;
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
