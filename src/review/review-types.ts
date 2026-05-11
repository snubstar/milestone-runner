import type { RunPaths } from "../artifacts/paths.js";
import type { OrchestratorConfig } from "../config/config-types.js";
import type { MilestoneMetadata } from "../milestones/milestone-types.js";
import type { AgentRunner } from "../runners/agent-runner.js";
import type { CommandRunner } from "../shell/command-runner.js";
import type { RunState } from "../state/state-types.js";

export type ReviewVerdict = "pass" | "fail" | "needs_human_review";

export type ReviewFindingSeverity = "high" | "medium" | "low";

export interface ReviewFinding {
  severity: ReviewFindingSeverity;
  file: string | null;
  issue: string;
  suggestedFix: string;
  blocking: boolean;
}

export interface ReviewVerdictDocument {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  reviewedArtifacts: string[];
}

export type ReviewResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type ReviewRunnerPhase = "review_milestone" | "fix_review_findings";

export interface ReviewWorkflowOptions {
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

export type ReviewWorkflowResult =
  | {
      ok: true;
      state: RunState;
      metadata: MilestoneMetadata;
      milestoneId: number;
      verdict: ReviewVerdict;
    }
  | {
      ok: false;
      state: RunState;
      error: string;
    };
