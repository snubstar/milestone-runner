import { buildMilestoneArtifactPaths } from "../../src/artifacts/milestone-artifacts.js";
import { buildRunPaths, type RunPaths } from "../../src/artifacts/paths.js";
import {
  buildPlanningArtifactPaths,
  writeJsonArtifact,
  writeTextArtifact,
} from "../../src/artifacts/planning-artifacts.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import type { OrchestratorConfig } from "../../src/config/config-types.js";
import type { GitMetadata } from "../../src/git/git-types.js";
import type { MilestoneMetadata } from "../../src/milestones/milestone-types.js";
import { createInitialState } from "../../src/state/initial-state.js";
import { writeState } from "../../src/state/state-store.js";
import {
  completePlanningState,
  recordMilestoneArtifact,
  recordPlanningArtifact,
  setMilestoneStatus,
  setStatePhase,
} from "../../src/state/state-transitions.js";
import type { RunState } from "../../src/state/state-types.js";

export interface ReadyRunFixtureOptions {
  cwd: string;
  startSha: string;
  runId?: string;
  goal?: string;
  artifactRoot?: string;
  config?: OrchestratorConfig;
  configPath?: string;
}

export interface ReadyForReviewRunFixtureOptions extends ReadyRunFixtureOptions {
  checksOutput?: string;
}

export interface RunFixture {
  goal: string;
  config: OrchestratorConfig;
  paths: RunPaths;
  metadata: MilestoneMetadata;
  state: RunState;
}

export function defaultTestConfig(
  overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
  return {
    checks: [`${JSON.stringify(process.execPath)} -e "process.stdout.write('check ok')" `],
    runner: { type: "fake" },
    maxFixAttempts: 0,
    artifactRoot: ".agent-work",
    ...overrides,
  };
}

export async function createReadyForMilestoneRunFixture(
  options: ReadyRunFixtureOptions,
): Promise<RunFixture> {
  const runId = options.runId ?? "run-1";
  const goal = options.goal ?? "Add feature X";
  const config = options.config ?? defaultTestConfig();
  const metadata = testMilestoneMetadata();
  const paths = buildRunPaths({
    cwd: options.cwd,
    artifactRoot: options.artifactRoot ?? config.artifactRoot,
    runId,
  });

  await createRunDirectory(paths, goal);
  const planningPaths = buildPlanningArtifactPaths(paths);
  await writeTextArtifact(planningPaths.files.finalMajorPlanMarkdown, "# Final Major Plan");
  await writeJsonArtifact(planningPaths.files.milestones, metadata);

  const initialState = createInitialState({
    runId,
    goal,
    paths,
    git: cleanGitMetadata(options.cwd, options.startSha),
    configPath: options.configPath ?? "/repo/orchestrator.config.example.json",
    configSnapshot: config,
    now: new Date("2026-05-10T12:00:00.000Z"),
  });

  let state = recordPlanningArtifact(
    initialState,
    "finalMajorPlanMarkdown",
    planningPaths.statePaths.finalMajorPlanMarkdown,
    new Date("2026-05-10T12:00:01.000Z"),
  );
  state = recordPlanningArtifact(
    state,
    "milestones",
    planningPaths.statePaths.milestones,
    new Date("2026-05-10T12:00:02.000Z"),
  );
  state = completePlanningState(state, {
    currentMilestoneId: 1,
    milestoneStatuses: {
      "1": "pending",
      "2": "pending",
    },
    now: new Date("2026-05-10T12:00:03.000Z"),
  });
  await writeState(paths.files.state, state);

  return {
    goal,
    config,
    paths,
    metadata,
    state,
  };
}

export async function createReadyForReviewRunFixture(
  options: ReadyForReviewRunFixtureOptions,
): Promise<RunFixture> {
  const fixture = await createReadyForMilestoneRunFixture(options);
  const milestonePaths = buildMilestoneArtifactPaths(fixture.paths, 1);

  await writeTextArtifact(milestonePaths.files.milestonePlan, "# Milestone Plan");
  await writeTextArtifact(milestonePaths.files.implementation, "# Implementation Report");
  await writeTextArtifact(milestonePaths.files.diff, "diff --git a/file.txt b/file.txt\n");
  await writeTextArtifact(
    milestonePaths.files.checks,
    options.checksOutput ?? "Check results\n\nOverall: passed\n",
  );
  await writeTextArtifact(milestonePaths.files.summary, "# Milestone 1 Summary");

  let state = recordMilestoneArtifact(
    fixture.state,
    "milestonePlans",
    1,
    milestonePaths.statePaths.milestonePlan,
    new Date("2026-05-10T12:00:04.000Z"),
  );
  state = recordMilestoneArtifact(
    state,
    "implementations",
    1,
    milestonePaths.statePaths.implementation,
    new Date("2026-05-10T12:00:05.000Z"),
  );
  state = recordMilestoneArtifact(
    state,
    "diffs",
    1,
    milestonePaths.statePaths.diff,
    new Date("2026-05-10T12:00:06.000Z"),
  );
  state = recordMilestoneArtifact(
    state,
    "checks",
    1,
    milestonePaths.statePaths.checks,
    new Date("2026-05-10T12:00:07.000Z"),
  );
  state = recordMilestoneArtifact(
    state,
    "summaries",
    1,
    milestonePaths.statePaths.summary,
    new Date("2026-05-10T12:00:08.000Z"),
  );
  state = setStatePhase(
    state,
    "ready_for_review",
    new Date("2026-05-10T12:00:09.000Z"),
  );
  state = setMilestoneStatus(
    state,
    1,
    "ready_for_review",
    new Date("2026-05-10T12:00:10.000Z"),
  );
  await writeState(fixture.paths.files.state, state);

  return {
    ...fixture,
    state,
  };
}

export function testMilestoneMetadata(): MilestoneMetadata {
  return {
    milestones: [
      {
        id: 1,
        title: "First milestone",
        summary: "Implement the first milestone.",
        scope: ["Create a fixture output file"],
        acceptanceCriteria: ["A fixture output file exists"],
        verification: ["Configured checks pass"],
        dependencies: [],
        status: "pending",
      },
      {
        id: 2,
        title: "Second milestone",
        summary: "A later milestone that must not start.",
        scope: ["Remain pending"],
        acceptanceCriteria: ["Status remains pending"],
        verification: ["State inspection"],
        dependencies: [1],
        status: "pending",
      },
    ],
  };
}

export function sequenceClock(startIso: string): () => Date {
  let offset = 0;
  const start = new Date(startIso).getTime();

  return () => {
    const date = new Date(start + offset);
    offset += 1000;
    return date;
  };
}

function cleanGitMetadata(cwd: string, startSha: string): GitMetadata {
  return {
    required: true,
    planningOnly: false,
    root: cwd,
    startSha,
    dirtyAtStart: false,
    dirtyOverride: false,
    statusPorcelain: "",
  };
}
