# Milestone 4 Plan: One-Milestone Implementation Loop

## Objective

Extend the prototype from a completed planning run to a deterministic implementation pass for exactly one milestone.

Milestone 4 starts from `ready_for_milestone`, implements only `state.currentMilestoneId`, captures the resulting Git diff, runs configured checks, writes a milestone summary, and stops before the review/fix gate. Review, fix attempts, and multi-milestone progression remain Milestone 5+ work.

## Current Starting Point

Milestone 3 already provides:

- run directory creation;
- persisted `state.json`;
- planning artifacts in `plans/`;
- validated milestone metadata in `milestones/05-milestones.json`;
- `state.currentPhase = "ready_for_milestone"`;
- `state.currentMilestoneId`;
- `state.milestoneStatuses`;
- fake runner support for deterministic planning phases.

Milestone 4 should build on those pieces rather than adding a separate planning path.

## In Scope

- Generate a scoped plan for the active milestone.
- Call the runner to implement only that milestone.
- Capture a Git diff that includes tracked edits, deletions, and new untracked files.
- Run deterministic configured checks from `config.checks`.
- Persist all implementation artifacts.
- Update state after each durable step.
- Add tests around the fake implementation path using a temporary Git fixture repository.

## Out Of Scope

- Reviewing implementation quality.
- Fixing review findings.
- Advancing to milestone 2.
- General resume support.
- Real `codex-exec` implementation execution.
- Rollback or automatic cleanup of failed implementation changes.

## Locked Decisions

- The active milestone is `state.currentMilestoneId`; the workflow must not choose another milestone.
- A successful Milestone 4 run stops with the active milestone ready for review, not passed.
- `--planning-only` continues to stop after Milestone 3 planning.
- Non-planning implementation runs require Git, at least one commit, and a clean working tree.
- In Milestone 4, `--allow-dirty` is only valid for `--planning-only`; implementation runs must reject dirty starts even when `--allow-dirty` is present.
- The deterministic acceptance path uses `--runner fake`; real implementation runners remain blocked until a later milestone.
- Empty implementation diffs are failures for this prototype unless a future milestone explicitly supports no-op milestones.
- Check failures are recorded and cause the workflow to stop as failed; Milestone 5 can later decide how to route fix attempts.
- A successful Milestone 4 run ends in a new explicit `ready_for_review` phase/status; Milestone 5 will switch to `reviewing` when the review gate actually starts.

## Artifacts

For active milestone `<id>`, write:

- `milestones/10-milestone-<id>-plan.md`
- `milestones/11-milestone-<id>-implementation.md`
- `diffs/12-milestone-<id>.diff`
- `checks/13-milestone-<id>-checks.txt`
- `milestones/14-milestone-<id>-summary.md`

State should record relative artifact paths under:

- `artifacts.milestonePlans["<id>"]`
- `artifacts.implementations["<id>"]`
- `artifacts.diffs["<id>"]`
- `artifacts.checks["<id>"]`
- `artifacts.summaries["<id>"]`

`artifacts.implementations` does not exist yet and should be added to `StateArtifacts`.

`ready_for_review` does not exist yet and should be added to both `OrchestratorPhase` and `MilestoneStatus`.

## Proposed Module Layout

```text
src/
  implementation/
    implementation-types.ts
    implementation-workflow.ts
  artifacts/
    milestone-artifacts.ts
  checks/
    check-runner.ts
    check-types.ts
  git/
    git-diff.ts
  prompts/
    milestone-plan.md
    implement-milestone.md
```

Tests:

```text
tests/unit/
  check-runner.test.ts
  git-diff.test.ts
  milestone-artifacts.test.ts
  implementation-workflow.test.ts
```

## Runner Contract Changes

Extend `AgentRunRequest` without breaking existing planning callers:

```ts
export interface AgentRunRequest {
  phase: string;
  prompt: string;
  artifacts?: Record<string, string>;
  cwd?: string;
  milestoneId?: number;
}
```

Add runner phases:

- `milestone_plan`
- `implement_milestone`

The fake runner should:

- return deterministic markdown for `milestone_plan`;
- for `implement_milestone`, make a deterministic file change inside `request.cwd`;
- refuse implementation if `request.cwd` or `request.milestoneId` is missing;
- avoid modifying files outside the requested workspace.

The real `codex-exec` runner can keep returning an unsupported error for implementation until a later milestone.

## Workflow Design

Create `runImplementationWorkflow(options)` with inputs:

- `goal`;
- `config`;
- `paths`;
- `initialState`;
- `runner`;
- `cwd`;
- optional prompt directory;
- optional `now` clock;
- command runner.

The workflow should:

1. Require `initialState.currentPhase === "ready_for_milestone"`.
2. Require `initialState.currentMilestoneId !== null`.
3. Require `initialState.git.startSha !== null`.
4. Require `initialState.git.dirtyAtStart === false`.
5. Load `milestones/05-milestones.json` from the run directory.
6. Validate that the active milestone exists and has status `pending`.
7. Set global phase to `implementing`.
8. Render `src/prompts/milestone-plan.md` with:
   - original goal;
   - final major plan;
   - full milestone metadata;
   - active milestone metadata;
   - current state snapshot.
9. Run the runner phase `milestone_plan`.
10. Write `10-milestone-<id>-plan.md`.
11. Update `milestoneStatuses["<id>"] = "planned"`.
12. Render `src/prompts/implement-milestone.md` with the milestone plan and the same bounded context.
13. Update `milestoneStatuses["<id>"] = "implementing"` before calling the implementation runner.
14. Run the runner phase `implement_milestone`.
15. Write `11-milestone-<id>-implementation.md`.
16. Capture the post-implementation Git diff.
17. If the diff is empty, write failure state and set `milestoneStatuses["<id>"] = "failed"`.
18. Write `12-milestone-<id>.diff`.
19. Set phase to `checking` and `milestoneStatuses["<id>"] = "checking"`.
20. Run configured checks.
21. Write `13-milestone-<id>-checks.txt`.
22. If any check fails, write failure state and set `milestoneStatuses["<id>"] = "failed"`.
23. Write orchestrator-generated `14-milestone-<id>-summary.md`.
24. End with `currentPhase = "ready_for_review"` and `milestoneStatuses["<id>"] = "ready_for_review"`.
25. Keep `currentMilestoneId` unchanged and do not touch later milestones.

Any runner failure, prompt rendering failure, artifact write failure, diff capture failure, empty diff, or check failure should persist state with:

- `status = "failed"`;
- `currentPhase` set to the phase that failed;
- `milestoneStatuses["<id>"] = "failed"` when an active milestone has been selected;
- `lastError` containing a concise message and structured details where available.

## Prompt Requirements

Replace the Milestone 4 prompt placeholders with real templates.

`milestone-plan.md` should instruct the runner to produce a concise implementation plan for one active milestone only. It should require:

- files or areas likely to change;
- validation commands to expect;
- explicit non-goals;
- a stop condition after the active milestone.

`implement-milestone.md` should instruct the runner to implement the active milestone only. It should require:

- no work on later milestones;
- no unrelated refactors;
- no commit creation;
- no destructive Git operations;
- a short implementation report as output.

## Diff Capture

Add `src/git/git-diff.ts`.

Requirements:

- run in the target Git root;
- include tracked modifications;
- include deletions;
- include untracked new files;
- avoid mutating the user's real Git index.

Recommended implementation:

- create a temporary index file;
- copy the current index into it when present;
- run `git add -A` using `GIT_INDEX_FILE=<temp-index>`;
- run `git diff --cached --binary HEAD --` using that temporary index;
- delete the temporary index afterward.

This gives a reviewable patch without staging anything in the user's working tree.

Because Milestone 4 requires a clean implementation baseline, the captured diff represents only the current implementation run. Support for dirty-start diff isolation is intentionally deferred.

## Check Runner

Add `src/checks/check-runner.ts`.

Requirements:

- read commands from `config.checks`;
- run checks sequentially in the target workspace;
- capture command, exit code, stdout, stderr, and duration;
- write a single text artifact suitable for human reading;
- return structured pass/fail data to the implementation workflow.

For this prototype, configured check strings may be executed through the local shell because they are trusted local configuration, for example:

```ts
command: process.platform === "win32" ? "cmd" : "sh"
args: process.platform === "win32" ? ["/d", "/s", "/c", check] : ["-lc", check]
```

If `config.checks` is empty, write an explicit "No configured checks." artifact and treat checks as successful.

## CLI Behavior

Update `src/cli/main.ts` so:

- `--planning-only --runner fake` keeps the current behavior and stops at `ready_for_milestone`;
- `--runner fake` without `--planning-only` runs planning and then the Milestone 4 implementation workflow;
- `--allow-dirty` without `--planning-only` fails with a clear message for Milestone 4;
- non-fake runners are still rejected with a message that implementation execution is fake-only for Milestone 4;
- the final CLI summary prints the final phase, current milestone, diff artifact, checks artifact, and summary artifact when implementation runs.

Do not add broad resume support yet. The implementation workflow should be independently callable in tests with an already-ready state, but the CLI can still create a fresh run and execute planning plus one implementation pass.

## Test Plan

Unit and integration-style tests should cover:

- milestone artifact paths are generated correctly for arbitrary milestone ids;
- state records implementation artifacts without losing planning artifacts;
- `ready_for_review` is accepted by state types and persisted state;
- implementation workflow rejects states that are not `ready_for_milestone`;
- implementation workflow rejects dirty-start implementation states;
- implementation workflow rejects missing or non-pending active milestones;
- fake runner implementation creates a deterministic change in a temporary Git fixture repo;
- captured diff includes new files without mutating the real Git index;
- empty diff fails the workflow;
- passing checks lead to final phase `ready_for_review`;
- failing checks persist output and fail the workflow;
- failure paths set the active milestone status to `failed`;
- later milestone statuses remain `pending`;
- `--planning-only` still stops after planning.

Minimum verification commands:

```bash
npm run typecheck
npm run build
npm run test:build
```

## Acceptance Criteria

- The orchestrator can perform a full fake run from goal to one implemented milestone.
- Exactly the first pending milestone is implemented.
- No later milestone is started or marked non-pending.
- The implementation plan, implementation report, diff, checks output, and summary are persisted.
- The diff artifact includes new files and tracked edits.
- Configured checks are run and reported.
- Passing implementation runs end with `currentPhase = "ready_for_review"`.
- Failing implementation/check runs persist useful failure state.
- Failing implementation/check runs mark the active milestone as `failed`.
- Tests cover the success path and the main failure paths.

## Handoff To Milestone 5

Milestone 5 should start from a run whose active milestone has:

- `currentPhase = "ready_for_review"`;
- `milestoneStatuses["<id>"] = "ready_for_review"`;
- a milestone plan artifact;
- an implementation report artifact;
- a diff artifact;
- a checks artifact;
- a summary artifact.

Milestone 5 will add the review verdict schema, review runner call, fix loop, re-checking, re-review, and final pass/fail milestone advancement.
