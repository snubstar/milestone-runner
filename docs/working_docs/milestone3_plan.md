# Milestone 3 Plan: Planning And Plan Review Loop

## Objective

Build the first real workflow phase on top of the Milestone 2 skeleton.

Milestone 3 should take a user goal from an initialized run and produce the planning artifacts needed by later implementation milestones:

```text
goal
-> major plan
-> major plan review
-> final major plan
-> machine-readable milestone metadata
```

The orchestrator should still remain in control of sequencing, artifact paths, state transitions, and validation. The selected runner only produces phase-specific text or JSON when asked.

## Scope

Milestone 3 covers:

- Loading prompt templates from `src/prompts/`.
- Rendering planning prompts with the goal, config, and prior artifacts.
- Calling the selected `AgentRunner` for planning phases.
- Writing planning artifacts into the current run directory.
- Updating `state.json` after each completed planning artifact.
- Creating `plans/01-major-plan.md`.
- Creating `plans/02-major-plan-review.md`.
- Creating `plans/03-final-major-plan.md`.
- Creating `milestones/05-milestones.json`.
- Validating milestone metadata structurally and semantically.
- Extending the fake runner so tests can exercise the planning pipeline deterministically.
- Unit tests for prompt loading/rendering, planning artifact creation, state updates, and milestone validation.

Milestone 3 does not cover:

- Implementing a milestone.
- Running verification checks.
- Capturing Git diffs.
- Reviewing code changes.
- Fix loops.
- Resume support.
- Multi-milestone execution beyond producing metadata for future phases.
- Full JSON Schema validator integration unless implementation shows direct validation is not enough.

## Locked Decisions

- Keep the CLI entry at `src/cli/main.ts`.
- Keep the command name `agent-orchestrator`.
- Keep the default target repository as `process.cwd()`.
- Keep `.agent-work/<run-id>/` as the run artifact root.
- Keep artifact paths in state relative to the run directory.
- Continue to support the deterministic development path:

```bash
npm run build
node dist/cli/main.js --planning-only --runner fake "example goal"
```

- The fake runner path is the required Milestone 3 validation path.
- Milestone 3 implementation should execute through `--runner fake` only. Real `codex-exec` execution remains out of scope until a later milestone or explicit real-runner wiring step.
- Because the default example config still uses `codex-exec`, Milestone 3 validation commands must pass `--runner fake`.
- Milestone metadata validation should be implemented in code first, matching `schemas/milestones.schema.json` plus semantic checks.
- The orchestrator owns milestone status. Generated milestone metadata must not be allowed to mark work as already started, passed, failed, or needing review.

## Proposed Module Layout

Add focused modules while preserving the Milestone 2 boundaries:

```text
src/
  artifacts/
    planning-artifacts.ts
  planning/
    planning-workflow.ts
    planning-types.ts
  prompts/
    prompt-loader.ts
    prompt-renderer.ts
  milestones/
    milestone-types.ts
    milestone-validator.ts
  state/
    state-transitions.ts
tests/
  unit/
    planning-workflow.test.ts
    prompt-loader.test.ts
    milestone-validator.test.ts
```

If the implementation becomes smaller than this layout suggests, modules may be combined conservatively. Keep planning, milestone validation, prompt loading, and state transitions conceptually separate.

## Planning Pipeline

The CLI should still perform the Milestone 2 startup path first:

1. Parse CLI arguments.
2. Load config.
3. Apply CLI overrides.
4. Run Git preflight.
5. Instantiate the selected runner.
6. Create run id and run directory.
7. Write `00-goal.txt`.
8. Write initial `state.json`.

After initialization, Milestone 3 should run these planning phases:

1. Set state to `planning`.
2. Load and render `src/prompts/major-plan.md`.
3. Call the runner with phase `major_plan`.
4. Write `plans/01-major-plan.md`.
5. Update state with `artifacts.majorPlan`.
6. Set state to `plan_reviewing`.
7. Load and render `src/prompts/major-plan-review.md`.
8. Call the runner with phase `major_plan_review`.
9. Write `plans/02-major-plan-review.md`.
10. Update state with `artifacts.majorPlanReview`.
11. Set state back to `planning`.
12. Load and render the final-plan prompt.
13. Call the runner with phase `final_major_plan`.
14. Write `plans/03-final-major-plan.md`.
15. Update state with `artifacts.finalMajorPlanMarkdown`.
16. Load and render `src/prompts/final-plan-json.md`.
17. Call the runner with phase `final_plan_json`.
18. Parse and validate returned milestone metadata.
19. Write `milestones/05-milestones.json`.
20. Initialize `state.milestoneStatuses` from validated metadata, with every milestone status set to `pending`.
21. Set `currentMilestoneId` to the first pending milestone id.
22. Set `currentPhase` and `status` to `ready_for_milestone`.
23. Write final planning state.

If any runner call fails or returns invalid required output, write `lastError`, set state to `failed`, and exit non-zero.

Runner phase names are runner-only labels and must not be written into state as orchestration phases.

Mapping:

- Runner phase `major_plan` maps to state phase `planning`.
- Runner phase `major_plan_review` maps to state phase `plan_reviewing`.
- Runner phase `final_major_plan` maps to state phase `planning`.
- Runner phase `final_plan_json` maps to state phase `planning`.

`lastError.phase` must always use the state phase value from this mapping.

## Prompt Loading And Rendering

Milestone 3 should replace the current placeholder planning prompts with usable templates:

- `src/prompts/major-plan.md`
- `src/prompts/major-plan-review.md`
- `src/prompts/final-plan-json.md`

Prompt rendering should support simple named variables only. Avoid a template engine dependency unless needed.

Minimum variables:

- `goal`
- `config`
- `majorPlan`
- `majorPlanReview`
- `finalMajorPlan`
- `milestonesSchema`

The prompt loader should:

- Read prompt files from disk.
- Fail clearly if a required prompt is missing.
- Keep prompt text separate from workflow code.
- Be testable without calling a runner.

## Artifact Contract

Milestone 3 should produce these artifacts:

```text
.agent-work/<run-id>/
  00-goal.txt
  state.json
  logs/
    run.log
  plans/
    01-major-plan.md
    02-major-plan-review.md
    03-final-major-plan.md
  milestones/
    05-milestones.json
```

Required for acceptance:

- `plans/01-major-plan.md`
- `plans/02-major-plan-review.md`
- `plans/03-final-major-plan.md`
- `milestones/05-milestones.json`

All artifact paths recorded in state must be relative paths from the run directory.

## State Expectations

State updates should be incremental and auditable.

Expected final planning state:

- `currentPhase`: `ready_for_milestone`
- `status`: `ready_for_milestone`
- `currentMilestoneId`: first pending milestone id, usually `1`
- `artifacts.majorPlan`: `plans/01-major-plan.md`
- `artifacts.majorPlanReview`: `plans/02-major-plan-review.md`
- `artifacts.finalMajorPlanMarkdown`: `plans/03-final-major-plan.md`
- `artifacts.milestones`: `milestones/05-milestones.json`
- `milestoneStatuses`: map from milestone id string to `pending`
- `lastError`: `null` on success
- `updatedAt`: refreshed after each state write

If planning fails:

- `status`: `failed`
- `currentPhase`: phase where the failure occurred
- `lastError.message`: clear failure summary
- `lastError.phase`: failed phase
- `lastError.occurredAt`: ISO timestamp
- already-written artifacts remain in state

## Milestone Metadata Validation

Create TypeScript types and validation for the `milestones/05-milestones.json` shape.

Structural validation should require:

- Root object with `milestones`.
- `milestones` is a non-empty array.
- Each milestone has:
  - `id`
  - `title`
  - `summary`
  - `scope`
  - `acceptanceCriteria`
  - `verification`
  - `dependencies`
  - `status`
- String fields are non-empty.
- List fields contain non-empty strings.
- `id` and dependency values are positive integers.
- `status` is one of the allowed milestone statuses.

Semantic validation should require:

- Milestone ids are unique.
- Dependencies reference existing milestone ids.
- A milestone cannot depend on itself.
- Dependencies point to earlier milestone ids for the prototype.
- Every generated milestone has status `pending`.
- At least one milestone exists after validation.

Invalid metadata should not be written as accepted state. If useful for debugging, save raw invalid runner output under `logs/` rather than `milestones/05-milestones.json`.

The validated `milestones/05-milestones.json` artifact should store normalized milestone metadata. If a runner returns a valid milestone object with a non-`pending` status, reject it rather than silently accepting agent-controlled progress.

## Fake Runner Plan

The fake runner needs to become scenario-aware enough to support planning tests.

Acceptable approaches:

- Extend `FakeRunner` with deterministic built-in responses for known phases.
- Add a `ScriptedFakeRunner` test helper that returns configured output per phase.

Required fake responses:

- `major_plan`: readable Markdown plan.
- `major_plan_review`: readable Markdown review.
- `final_major_plan`: readable Markdown final plan.
- `final_plan_json`: valid milestone metadata JSON.

Tests should also simulate:

- Runner failure.
- Invalid JSON from `final_plan_json`.
- Structurally invalid milestone metadata.
- Semantically invalid milestone dependencies.

## CLI Behavior

After Milestone 3, the existing development command should initialize and complete planning:

```bash
node dist/cli/main.js --planning-only --runner fake "Add feature X"
```

Expected result:

- Exit code `0`.
- Run directory created.
- Goal, plan, review, final plan, and milestone metadata artifacts written.
- `state.json` ends at `ready_for_milestone`.
- No implementation, checks, diffs, reviews, or fixes are attempted.

Failure behavior:

- Missing prompts fail with a clear message.
- Runner failure exits non-zero.
- Invalid milestone metadata exits non-zero.
- Failed runs still write a useful `state.json` when initialization succeeded.

## Test Plan

Add focused unit tests:

- Prompt loader reads required prompt files.
- Prompt renderer replaces known variables.
- Prompt renderer rejects missing variables or leaves no unresolved placeholders.
- Planning workflow writes major plan artifact.
- Planning workflow writes review artifact.
- Planning workflow writes final plan artifact.
- Planning workflow writes `05-milestones.json`.
- Planning workflow updates state to `ready_for_milestone`.
- Planning workflow records first pending milestone id.
- Planning workflow records failure state on runner failure.
- Milestone validator accepts valid metadata.
- Milestone validator rejects missing required fields.
- Milestone validator rejects duplicate milestone ids.
- Milestone validator rejects dependencies pointing to missing ids.
- Milestone validator rejects self-dependencies.
- Milestone validator rejects future dependencies for the prototype.
- CLI smoke with `--planning-only --runner fake` creates planning artifacts.

Keep all tests runnable without Codex, network access, or model calls.

## Validation For This Milestone

Milestone 3 should be considered complete when:

- `npm run typecheck` passes.
- `npm run build` passes.
- `npm run test:build` passes.
- `node dist/cli/main.js --planning-only --runner fake "example goal"` creates:
  - `00-goal.txt`
  - `plans/01-major-plan.md`
  - `plans/02-major-plan-review.md`
  - `plans/03-final-major-plan.md`
  - `milestones/05-milestones.json`
  - `state.json`
- `state.json` records all planning artifacts as run-relative paths.
- `state.json` ends with `ready_for_milestone`.
- `state.currentMilestoneId` points to the first pending milestone.
- `milestones/05-milestones.json` passes structural and semantic validation.
- Invalid milestone metadata is rejected with a clear error.
- No implementation, check, diff, review, or fix artifacts are produced.

## Risks And Mitigations

- Risk: The workflow starts implementing milestones too early.
  Mitigation: Stop at `ready_for_milestone`; Milestone 4 owns implementation.

- Risk: Agent output is hard to parse.
  Mitigation: Require JSON-only output for `final_plan_json`; validate directly and fail clearly.

- Risk: Prompt rendering becomes overly clever.
  Mitigation: Use simple named placeholders and explicit input objects.

- Risk: Fake-runner behavior hides real-runner problems.
  Mitigation: Keep fake tests deterministic, but preserve runner interface boundaries so real runner smoke tests can be added later.

- Risk: Milestone metadata matches schema but is not usable.
  Mitigation: Add semantic validation for ids, dependencies, and pending milestone availability.

## Handoff To Milestone 4

Milestone 4 should start from a run whose planning phase has completed and implement exactly the first pending milestone.

Inputs available to Milestone 4:

- `00-goal.txt`
- `plans/03-final-major-plan.md`
- `milestones/05-milestones.json`
- `state.currentMilestoneId`
- `state.milestoneStatuses`

Milestone 4 should add:

- milestone-specific implementation plan generation;
- implementation runner call for one milestone only;
- Git diff capture;
- configured deterministic checks;
- milestone summary artifact;
- tests using fake runner and a tiny fixture repository.
