import type { OrchestratorConfig } from "../config/config-types.js";
import type { MilestoneMetadata } from "../milestones/milestone-types.js";
import type { AgentRunner } from "../runners/agent-runner.js";
import type { RunPaths } from "../artifacts/paths.js";
import type { ResolvedSeedMajorPlan } from "../inputs/initial-inputs.js";
import type { OrchestratorPhase, RunState } from "../state/state-types.js";
import type { TimingWarningCollector } from "../timings/timing-types.js";

export type PlanningRunnerPhase =
  | "major_plan"
  | "major_plan_review"
  | "final_major_plan"
  | "final_plan_json";

export interface PlanningWorkflowOptions {
  goal: string;
  config: OrchestratorConfig;
  paths: RunPaths;
  initialState: RunState;
  runner: AgentRunner;
  cwd?: string;
  promptDir?: string;
  schemaRoot?: string;
  milestonesSchema?: string | object;
  resolvedSeedMajorPlan?: ResolvedSeedMajorPlan;
  timingWarnings?: TimingWarningCollector;
  now?: () => Date;
}

export type PlanningWorkflowResult =
  | {
      ok: true;
      state: RunState;
      metadata: MilestoneMetadata;
    }
  | {
      ok: false;
      state: RunState;
      error: string;
    };

export function statePhaseForPlanningRunnerPhase(
  phase: PlanningRunnerPhase,
): OrchestratorPhase {
  if (phase === "major_plan_review") {
    return "plan_reviewing";
  }

  return "planning";
}
