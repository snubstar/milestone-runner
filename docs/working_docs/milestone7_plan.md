# Milestone 7 Plan: Multi-Milestone State Machine

## Objective

Extend the one-milestone workflow into a goal-level runner that can complete every milestone from the validated final major plan.

Milestone 7 should keep the existing planning, implementation, review, fix, and check workflows as the phase-level building blocks. The new work is the state machine above them: selecting the next runnable milestone, looping until the goal is complete or blocked, resuming from persisted state, and writing a final goal summary.

The main outcome is a deterministic full-goal path that is proven with fake/scenario runners before any real `codex-exec` implementation path is broadened.

## Current Starting Point

Milestones 1 through 6 already provide:

- a TypeScript CLI with config loading, Git preflight, artifact directories, and state persistence;
- separate planning, implementation, and review workflows;
- bounded fix attempts for failed reviews with blocking findings;
- deterministic check execution and Git diff capture;
- validated milestone metadata and review verdict parsing;
- reusable fixture repositories, run fixtures, scenario runners, and state/artifact assertions;
- CLI integration-style coverage for planning-only runs, one fake milestone, dirty-tree gating, and runner gating.

The current CLI still wires the phase workflows once:

```text
planning -> milestone 1 implementation -> milestone 1 review -> stop
```

Milestone 7 should replace that one-shot wiring with a goal-level workflow:

```text
planning -> milestone N implementation -> milestone N review -> advance -> repeat -> final summary
```

## In Scope

- Add a goal-level orchestration workflow that owns milestone iteration.
- Select the next runnable milestone from `milestones/05-milestones.json` and `state.milestoneStatuses`.
- Advance from a passed milestone to the next pending milestone.
- Stop without advancing when implementation, checks, review, fix attempts, or human-review gates block progress.
- Produce or update a final goal summary artifact for every terminal goal outcome: passed, failed, or needs human review.
- Add resume-capable core logic that can continue from persisted stable states in `state.json`.
- Update the CLI full-run path to use the goal-level workflow.
- Update CLI output to report multi-milestone status and final summary location.
- Add fake/scenario tests for multi-milestone success, stop conditions, and resume behavior.
- Keep planning-only behavior working.

## Out Of Scope

- Real `codex-exec` implementation or review execution.
- Polished CLI flags such as `--resume`, `--dry-run`, `--milestone`, and `--max-fix-attempts`; Milestone 8 owns those user-facing options.
- Automatic commits, rollback, branch management, or patch application.
- Updating milestone statuses inside `05-milestones.json`; runtime status remains in `state.json`.
- Running multiple milestones concurrently.
- Continuing past failed checks, failed reviews with unresolved blocking findings, or `needs_human_review`.
- CI or GitHub integration.

## Locked Decisions

- `milestones/05-milestones.json` remains the source of milestone definitions. `state.milestoneStatuses` remains the source of runtime status.
- The orchestrator must not parse Markdown plans to decide milestone progression.
- Existing runner phases stay unchanged: `milestone_plan`, `implement_milestone`, `review_milestone`, and `fix_review_findings`.
- The production `FakeRunner` may support multiple milestone ids, but complex failure scenarios should stay in test helpers.
- Deterministic checks remain a hard gate. A milestone cannot be accepted unless its latest checks passed.
- A milestone with unresolved blocking findings prevents advancement.
- A `needs_human_review` milestone stops the goal workflow immediately.
- The final successful goal state is `currentPhase = "passed"`, `status = "passed"`, and `currentMilestoneId = null` after every milestone has passed and the final summary has been written.
- A terminal failed or human-review stop should also attempt to write the final goal summary before returning to the CLI.
- A transient `passed` state with pending milestones is resumable: it means the last active milestone passed and the goal workflow still needs to advance.
- Resume support in Milestone 7 is a core orchestration capability. The polished CLI `--resume` flag belongs to Milestone 8.

## Artifacts

Existing per-milestone artifacts remain unchanged:

- `milestones/10-milestone-<id>-plan.md`
- `milestones/11-milestone-<id>-implementation.md`
- `diffs/12-milestone-<id>.diff`
- `checks/13-milestone-<id>-checks.txt`
- `milestones/14-milestone-<id>-summary.md`
- `reviews/20-milestone-<id>-review.json`
- `fixes/21-milestone-<id>-fix-attempt-<n>.md`
- `diffs/22-milestone-<id>-diff-after-fix-<n>.diff`
- `checks/23-milestone-<id>-checks-after-fix-<n>.txt`
- `reviews/24-milestone-<id>-review-after-fix-<n>.json`
- `milestones/25-milestone-<id>-review-summary.md`

Add one final goal artifact:

- `milestones/90-goal-summary.md`

Record it in state with:

```text
artifacts.summaries["goal"] = "milestones/90-goal-summary.md"
```

The workflow should attempt to write this artifact whenever it reaches a terminal goal outcome:

- `passed` after all milestones pass;
- `failed` after a phase workflow returns `ok: false`;
- `needs_human_review` after dependency blockage, invalid runtime state, unsafe resume, exhausted fixes, malformed review output, or explicit human-review verdicts.

For successful goal completion, the summary write is part of completion and must succeed before `completeGoalState` is persisted. For already blocked states, summary writing is best effort: if it fails, keep the original blocking state and return an error that names both the original stop reason and the summary write failure.

The final summary should include:

- overall status;
- accepted milestones;
- failed or human-review milestones, if any;
- changed files since the run's starting Git SHA, excluding the run directory;
- latest check artifacts for each attempted milestone;
- latest review artifacts for each reviewed milestone;
- fix attempt counts;
- residual risks from nonblocking findings or human-review stops.

## Proposed Module Layout

```text
src/
  orchestration/
    goal-workflow.ts
    goal-workflow-types.ts
    goal-summary.ts
    milestone-selector.ts
    resume-state.ts
  artifacts/
    goal-artifacts.ts
```

Tests:

```text
tests/unit/
  goal-workflow.test.ts
  goal-summary.test.ts
  milestone-selector.test.ts
  resume-state.test.ts
```

Keep CLI integration-style tests in `tests/unit/cli-main.test.ts` unless the package test scripts are expanded to discover additional required folders.

## Goal Workflow API

Add a top-level workflow around the existing phase workflows:

```ts
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
  now?: () => Date;
}

export interface GoalWorkflowResult {
  ok: boolean;
  state: RunState;
  error?: string;
}
```

The workflow should:

1. Run planning when state is `initialized`, `planning`, or `plan_reviewing`.
2. Stop after planning when `planningOnly` is true.
3. Require milestone metadata after planning.
4. Run implementation when state is `ready_for_milestone`.
5. Run review when state is `ready_for_review`.
6. If review passes, ask the milestone selector whether to advance, complete, or stop for a diagnostic reason.
7. If review returns `needs_human_review`, write the terminal goal summary if possible and stop without advancing.
8. If any phase returns `ok: false`, write the terminal goal summary if possible and return that failed state.
9. Persist state after every advancement and after writing the final summary.

The CLI should call this workflow instead of manually chaining planning, implementation, and review once.

## Milestone Selection

Add a selector that uses metadata plus runtime state:

```ts
export type MilestoneSelectionDecision =
  | { kind: "runnable"; milestone: Milestone }
  | { kind: "complete" }
  | { kind: "blocked"; message: string; details?: unknown }
  | { kind: "invalid_state"; message: string; details?: unknown };

selectNextRunnableMilestone(
  metadata: MilestoneMetadata,
  state: Pick<RunState, "currentMilestoneId" | "milestoneStatuses">,
): MilestoneSelectionDecision
```

Selection rules:

- Every metadata milestone id must exist in `state.milestoneStatuses`.
- `state.milestoneStatuses` must not contain ids that are missing from metadata.
- A milestone is runnable only when its status is `pending`.
- All declared dependencies must have status `passed`.
- Pick the lowest milestone id among runnable milestones.
- If no pending milestones remain and every metadata milestone is `passed`, return `complete`.
- If no pending milestones remain but at least one milestone is failed or needs human review, return `blocked`.
- If pending milestones remain but none are runnable, return `blocked` with a dependency/status diagnostic.
- Unknown milestone ids in state, missing milestone ids in state, duplicate metadata ids that escaped validation, or nonterminal statuses without a matching `state.currentMilestoneId` should return `invalid_state`.
- Metadata milestone statuses are not mutated; generated metadata should still validate as pending-only input.

The goal workflow should map selector decisions as follows:

- `runnable`: persist `advanceToMilestoneState` and continue.
- `complete`: write the final goal summary, then persist `completeGoalState`.
- `blocked`: persist `needs_human_review` with selector diagnostics, write the final goal summary if possible, and stop.
- `invalid_state`: persist `needs_human_review` with selector diagnostics, write the final goal summary if possible, and stop.

Add state helpers:

```ts
advanceToMilestoneState(state, milestoneId, now)
completeGoalState(state, now)
```

`advanceToMilestoneState` should set:

- `currentPhase = "ready_for_milestone"`;
- `status = "ready_for_milestone"`;
- `currentMilestoneId = milestoneId`;
- `lastError = null`.

`completeGoalState` should set:

- `currentPhase = "passed"`;
- `status = "passed"`;
- `currentMilestoneId = null`;
- `lastError = null`.

Add a helper for selector/resume diagnostics:

```ts
stopGoalForHumanReviewState(
  state: RunState,
  options: {
    message: string;
    details?: unknown;
    currentMilestoneId?: number | null;
  },
  now: Date,
)
```

It should set:

- `currentPhase = "needs_human_review"`;
- `status = "needs_human_review"`;
- `lastError.message = options.message`;
- `lastError.phase = "needs_human_review"`;
- `lastError.details = options.details` when provided;
- `currentMilestoneId = options.currentMilestoneId` when provided, otherwise keep the existing value.

## Resume Design

Milestone 7 resume should be conservative and deterministic.

Add a core resume normalizer:

```ts
normalizeStateForGoalResume(state, metadata): ResumeDecision
```

Supported stable resume points:

- `initialized`, `planning`, `plan_reviewing`: planning can be rerun because it has not edited the target repository.
- `ready_for_milestone`: continue with implementation for `currentMilestoneId`.
- `ready_for_review`: continue with review for `currentMilestoneId`.
- `passed` with pending runnable milestones: advance to the next milestone.
- `passed` with no pending milestones and no final summary: write the final summary, then complete the goal.
- `passed` with no pending milestones and a final summary: persist `completeGoalState` if `currentMilestoneId` is still set, then return success without rerunning work.
- `failed` and `needs_human_review`: return the stopped state; do not auto-resume.

Transient states need explicit recovery:

- `implementing` or `checking`: continue only if required milestone artifacts and passing checks are already present, then normalize to `ready_for_review`.
- `reviewing` or `fixing`: continue only if the latest review summary/status already proves a terminal milestone outcome; otherwise stop as `needs_human_review`.

If the workflow cannot prove a safe resume point from artifacts and state, it should persist `needs_human_review` with a clear `lastError`, write the final goal summary if possible, and stop instead of rerunning an implementation or fix phase blindly.

Milestone 7 tests should exercise the core resume function directly. Milestone 8 should expose it through a user-facing `--resume` option.

## Final Goal Summary

Add a formatter and artifact writer for `milestones/90-goal-summary.md`.

The summary should be generated from state and local artifacts, not from a new agent call. It should include:

- the original goal;
- final status;
- accepted milestone ids and titles;
- failed or human-review milestone ids and titles;
- changed files from Git;
- latest checks and reviews per milestone;
- fix attempt counts;
- residual risks:
  - nonblocking review findings from passed milestones;
  - the stop reason from `lastError`, if the goal did not pass;
  - missing artifacts that prevented full confidence.

Use deterministic Git data for changed files. Prefer a small helper around:

```text
git diff --name-only <startSha>
```

Exclude paths under the run directory. If changed-file capture fails, still write the summary and include the capture error as a residual risk.

The summary writer should accept the terminal or soon-to-be-terminal state plus selector/workflow diagnostics:

```ts
writeGoalSummary({
  paths,
  state,
  metadata,
  cwd,
  commandRunner,
  diagnostics,
})
```

It should return the recorded state path on success and a structured error on failure. The goal workflow is responsible for deciding whether a summary write failure is fatal for the current terminal outcome.

## CLI Behavior

Update `main` so that non-planning runs use the goal workflow.

Expected CLI behavior after Milestone 7:

- `--planning-only --runner fake` still stops at `ready_for_milestone`.
- `--runner fake` completes all fake milestones from `05-milestones.json`.
- The full fake run ends with `State: passed` and `Current milestone: none`.
- Output includes a compact milestone status list.
- Output includes `Final summary artifact: milestones/90-goal-summary.md` when available, including failed and human-review stops where summary writing succeeded.
- Dirty-tree rejection still happens before creating a run directory.
- Non-fake runners remain rejected for implementation/review execution until real execution support is implemented.

Do not add the polished `--resume` CLI flag in this milestone unless it becomes necessary to test the core behavior. If a minimal temporary hook is added, document it as internal and replace it in Milestone 8.

## Test Coverage

Add or strengthen tests for:

- selecting the next runnable pending milestone;
- completing when every milestone passed;
- dependency-blocked pending milestones stopping as `needs_human_review`;
- missing metadata milestone statuses stopping as `needs_human_review`;
- unknown state milestone ids stopping as `needs_human_review`;
- selector decisions distinguishing runnable, complete, blocked, and invalid state;
- full fake run completing both fake milestones in order;
- runner requests carrying the correct milestone ids for each iteration;
- not requesting milestone 2 when milestone 1 implementation fails;
- not requesting milestone 2 when milestone 1 checks fail;
- not requesting milestone 2 when milestone 1 review needs human review;
- not requesting milestone 2 when milestone 1 review has blocking findings and max fix attempts are exhausted;
- final summary content and state artifact recording;
- final summary writing on failed and human-review terminal stops;
- summary write failure preserving the original blocking state for failed and human-review stops;
- resume from `ready_for_milestone`;
- resume from `ready_for_review`;
- resume from `passed` with pending milestones;
- resume from `passed` with all milestones passed but missing final summary;
- refusing unsafe resume from ambiguous transient states;
- CLI full fake path now completing all milestones;
- CLI planning-only behavior remaining unchanged;
- state shape validation after multi-milestone success and stop paths.

Use the Milestone 6 helpers where practical:

- `createFixtureRepo`;
- `createReadyForMilestoneRunFixture`;
- `createReadyForReviewRunFixture`;
- `ScenarioRunner`;
- `assertRunStateShape`;
- `assertMilestoneMetadataArtifact`;
- `assertReviewVerdictArtifact`.

## Implementation Steps

1. Add goal artifact path helpers for `milestones/90-goal-summary.md`.
2. Add milestone selection helpers with a `MilestoneSelectionDecision` union and focused unit tests.
3. Add state transition helpers for advancing to the next milestone and completing the goal.
4. Add a human-review stop transition helper for selector, resume, and dependency diagnostics.
5. Add the final goal summary formatter/writer and unit tests, including blocked-run summaries.
6. Add the goal-level workflow loop around planning, implementation, review, selection, terminal summary writing, and completion.
7. Add conservative resume normalization for stable persisted states.
8. Update the CLI to call the goal workflow and print multi-milestone output.
9. Update fake/scenario tests so a full fake run completes both generated fake milestones.
10. Add blocked-progress tests for failed implementation, failed checks, failed review, human review, exhausted fixes, blocked selection, and invalid state.
11. Add resume tests for stable and unsafe states.
12. Update README documentation where the current one-milestone scope is no longer accurate.
13. Run the full verification sequence and fix regressions.

## Acceptance Criteria

- A fake full run completes multiple milestones in order.
- The runner never advances while the active milestone has failed checks, failed implementation, unresolved blocking review findings, or a human-review verdict.
- The goal workflow can resume from persisted stable states in `state.json`.
- Unsafe transient resume states stop with a clear human-review diagnostic.
- The final goal summary is written for successful runs and attempted for failed or human-review terminal stops.
- The final goal summary includes changed files, checks, accepted milestones, failed or human-review milestones, fix attempts, and residual risks.
- The milestone selector distinguishes runnable, complete, blocked, and invalid state outcomes with diagnostics.
- Planning-only runs still stop at `ready_for_milestone`.
- Non-fake implementation/review execution remains gated.
- Existing Milestone 1 through 6 tests are updated only where the expected one-milestone stop intentionally changes.
- All default tests remain deterministic and offline.
- Verification passes with:

```bash
npm run typecheck
npm run build
npm run test:build
```

## Risks And Mitigations

- Risk: `passed` is overloaded as both milestone-passed and goal-passed.
  Mitigation: complete-goal state must set `currentMilestoneId = null`; `passed` with a non-null current milestone and pending milestones is treated as a resumable advancement point.

- Risk: resume reruns unsafe agent work after a partial implementation or fix.
  Mitigation: resume only from stable states or from transient states whose required artifacts prove the next safe state; otherwise stop as `needs_human_review`.

- Risk: final summary implies stronger confidence than the artifacts support.
  Mitigation: the summary must list missing artifacts and changed-file capture failures as residual risks.

- Risk: broad CLI changes obscure the state-machine work.
  Mitigation: keep CLI updates limited to calling the goal workflow and printing resulting state/artifact information. Defer polished controls to Milestone 8.

- Risk: multi-milestone iteration breaks one-milestone assumptions in tests.
  Mitigation: update assertions deliberately around the changed behavior and keep phase-level workflow tests focused on one active milestone.

## Handoff To Milestone 8

After Milestone 7, Milestone 8 should make the multi-milestone runner comfortable for real local use:

- add the user-facing `--resume` flag;
- add `--dry-run`, `--max-fix-attempts`, and `--milestone`;
- improve terminal output for long multi-milestone runs;
- improve validation messages for resume and tool availability;
- add explicit dirty-tree and planning-only override ergonomics;
- document recommended local workflows for starting, resuming, inspecting, and stopping runs.
