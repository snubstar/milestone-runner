import { toRunRelativePath, type RunPaths } from "../artifacts/paths.js";
import type { OrchestratorConfig } from "../config/config-types.js";
import type { GitMetadata } from "../git/git-types.js";
import type {
  InitialInputArtifactsState,
  InitialInputsState,
} from "../inputs/initial-inputs.js";
import type { RunState } from "./state-types.js";

export interface CreateInitialStateOptions {
  runId: string;
  goal: string;
  paths: RunPaths;
  git: GitMetadata;
  configPath: string | null;
  configSnapshot: OrchestratorConfig | null;
  workspace?: {
    invocationCwd: string;
    targetCwd: string;
  };
  inputs?: InitialInputsState;
  inputArtifacts?: InitialInputArtifactsState;
  now?: Date;
}

export function createInitialState(options: CreateInitialStateOptions): RunState {
  const timestamp = (options.now ?? new Date()).toISOString();

  return {
    runId: options.runId,
    goal: options.goal,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
    currentPhase: "initialized",
    status: "initialized",
    currentMilestoneId: null,
    artifactRoot: options.paths.artifactRoot,
    runDir: options.paths.runDir,
    git: options.git,
    config: {
      path: options.configPath,
      snapshot: options.configSnapshot,
    },
    milestoneStatuses: {},
    fixAttempts: {},
    checkFixAttempts: {},
    milestoneBaselines: {},
    artifacts: {
      goal: toRunRelativePath(options.paths.runDir, options.paths.files.goal),
      ...(options.inputArtifacts === undefined ? {} : { inputs: options.inputArtifacts }),
      logs: {
        run: toRunRelativePath(options.paths.runDir, options.paths.files.runLog),
      },
    },
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
