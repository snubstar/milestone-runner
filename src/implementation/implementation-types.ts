import type { OrchestratorConfig } from "../config/config-types.js";
import type { CommandRunner } from "../shell/command-runner.js";
import type { MilestoneMetadata } from "../milestones/milestone-types.js";
import type { AgentRunner } from "../runners/agent-runner.js";
import type { RunPaths } from "../artifacts/paths.js";
import type { RunState } from "../state/state-types.js";

export type ImplementationRunnerPhase = "milestone_plan" | "implement_milestone";

export interface ImplementationWorkflowOptions {
  goal: string;
  config: OrchestratorConfig;
  paths: RunPaths;
  initialState: RunState;
  runner: AgentRunner;
  commandRunner: CommandRunner;
  cwd: string;
  promptDir?: string;
  now?: () => Date;
}

export type ImplementationWorkflowResult =
  | {
      ok: true;
      state: RunState;
      metadata: MilestoneMetadata;
      milestoneId: number;
    }
  | {
      ok: false;
      state: RunState;
      error: string;
    };
