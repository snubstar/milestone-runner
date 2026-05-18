# Scrupulous Milestone Plan Review

## Goal and Motivation

Add a scrupulous mode that reviews and corrects each per-milestone implementation plan before that plan is handed to the implementation agent.

The current workflow already applies a review-and-correction loop to the goal-level major plan:

1. Generate the major plan.
2. Review the major plan.
3. Generate the final major plan from the original plan and review.

Per-milestone plans do not currently receive the same treatment. A milestone plan is generated, written as the active milestone plan artifact, and passed directly into implementation. That is efficient, but it leaves a quality gap for runs where milestone-level precision matters: the generated subplan may be too broad, may omit verification, may preserve vague instructions from the major plan, or may delegate orchestration decisions to the implementation agent.

Scrupulous mode should close that gap without changing the default fast path. Normal runs should keep the current behavior. Scrupulous runs should add a milestone-plan review and correction step between subplan generation and implementation.

## Target Behavior

Default behavior remains unchanged:

```text
major_plan
-> major_plan_review
-> final_major_plan
-> final_plan_json
-> milestone_plan or light local milestone plan
-> implement_milestone
-> checks
-> review_milestone
```

Scrupulous behavior adds review and correction for every milestone plan:

```text
major_plan
-> major_plan_review
-> final_major_plan
-> final_plan_json
-> milestone_plan or light local milestone plan
-> milestone_plan_review
-> final_milestone_plan
-> implement_milestone
-> checks
-> review_milestone
```

The corrected final milestone plan is the plan consumed by `implement_milestone`.

## Design Principles

- Keep `milestonePlanPolicy` focused on how the initial per-milestone plan is produced: `always`, `auto`, or `light`.
- Add scrupulous behavior as a separate review policy, because it changes the lifecycle after plan generation.
- Keep existing artifact consumers stable by preserving `state.artifacts.milestonePlans[id]` as the final plan used for implementation.
- Preserve draft and review artifacts for auditability when scrupulous mode is enabled.
- Use the planning sandbox for milestone plan review and correction. These phases should not write to the target repository.
- Make fake-runner behavior deterministic so tests can validate the full scrupulous path offline.

## Proposed Config Surface

Add a new config field:

```ts
export type MilestonePlanReviewPolicy = "normal" | "scrupulous";

export interface OrchestratorConfig {
  checks: string[];
  runner: RunnerConfig;
  maxFixAttempts: number;
  artifactRoot: string;
  milestonePlanPolicy: MilestonePlanPolicy;
  milestonePlanReviewPolicy: MilestonePlanReviewPolicy;
}
```

Default value:

```json
"milestonePlanReviewPolicy": "normal"
```

CLI override:

```text
--milestone-plan-review-policy normal|scrupulous
```

A shorthand `--scrupulous` can be added later, but the explicit policy flag is better for the first implementation because it mirrors the existing `--milestone-plan-policy` shape.

## Artifact Model

Keep the existing final plan artifact path:

```text
milestones/10-milestone-<id>-plan.md
```

When scrupulous mode is enabled, add trace artifacts:

```text
milestones/10-milestone-<id>-plan-draft.md
milestones/10-milestone-<id>-plan-review.md
milestones/10-milestone-<id>-plan.md
```

State should continue to expose the final plan through:

```ts
state.artifacts.milestonePlans[id]
```

Add these state fields for discoverability and auditability:

```ts
milestonePlanDrafts?: Record<string, string>;
milestonePlanReviews?: Record<string, string>;
```

These fields are optional on the state shape so old state files remain valid, but the implementation should write them whenever scrupulous mode runs. Because the state schema is closed, `schemas/state.schema.json` must explicitly allow both maps.

## Resume Semantics

Scrupulous mode should not add new persisted orchestrator phases in the first implementation. The draft, review, and final-plan generation steps should remain internal to the existing `implementing` phase, and they should all happen before any target repository changes begin.

This means resume behavior stays conservative:

- If a run stops during scrupulous plan review or final-plan generation, the state is still `implementing`.
- Existing resume normalization may stop for human review when implementation-ready artifacts are incomplete.
- Any interruption before implementation begins requires human review rather than automatic continuation.
- A CLI policy override on resume is per-invocation only. It affects the effective config for that resume command, but it does not rewrite the saved config snapshot unless a later change explicitly adds persisted override support.
- A CLI policy override on resume affects only future milestone planning work reached during that invocation. It does not regenerate draft, review, or final-plan artifacts for a milestone already in a transient `implementing` state.

Adding explicit persisted phases such as `milestone_plan_reviewing` can be considered later, but it is not required for the initial scrupulous mode.

## Milestone 1: Config and CLI Surface

### Objective

Introduce a validated scrupulous mode setting without changing runtime behavior yet.

### Implementation Steps

1. Add `MilestonePlanReviewPolicy` to `src/config/config-types.ts`.
2. Add `milestonePlanReviewPolicy` to `OrchestratorConfig`.
3. Update `src/config/config-loader.ts`:
   - accept `"normal"` and `"scrupulous"`;
   - default missing values to `"normal"`;
   - include the value in validated config output;
   - support config overrides.
4. Update `src/cli/args.ts`:
   - parse `--milestone-plan-review-policy`;
   - validate `normal|scrupulous`;
   - include the option in usage output.
5. Update `src/cli/main.ts` so new runs and resume runs pass the CLI override into `applyConfigOverrides`.
6. Update `src/cli/dry-run.ts` and `src/cli/run-report.ts` so dry-runs and run summaries show:
   - effective milestone plan review policy;
   - saved milestone plan review policy on resume when it differs.
7. Update `schemas/config.schema.json`.
8. Update `orchestrator.config.example.json`.
9. Update README and `docs/how-to.md` with the new option.

### Acceptance Criteria

- Existing config files without `milestonePlanReviewPolicy` still validate.
- Invalid policy values fail with a clear error.
- CLI overrides can switch the policy to `scrupulous`.
- Existing tests continue to pass with the default `normal` policy.

### Verification

```text
npm run test:build
```

## Milestone 2: Prompts for Subplan Review and Correction

### Objective

Add prompt templates that review and correct a single active milestone plan.

### Implementation Steps

1. Create `src/prompts/milestone-plan-review.md`.
2. Create `src/prompts/final-milestone-plan.md`.
3. Update `src/prompts/prompt-loader.ts`:
   - add both names to the closed `PromptName` union;
   - add both files to the `promptFiles` map.
4. Update prompt loader tests to include both prompt files.
5. Ensure the review prompt receives:
   - original user goal;
   - final major plan;
   - all milestone metadata;
   - active milestone metadata;
   - current run state;
   - generated milestone plan draft.
6. Ensure the final prompt receives:
   - all review prompt inputs;
   - milestone plan review output.
7. Instruct the review prompt to check for:
   - missing implementation steps;
   - vague or oversized scope;
   - missing validation commands;
   - risky assumptions;
   - conflicts with final major plan or active milestone metadata;
   - attempts to plan work for other milestones;
   - wording that gives implementation agents orchestration authority.
8. Instruct the final prompt to produce the corrected milestone plan only, not commentary.

### Acceptance Criteria

- Both prompts render with all required variables.
- The final milestone plan prompt preserves the active milestone boundary.
- The prompts explicitly prohibit implementation, command execution, commits, status decisions, and acceptance decisions.

### Verification

```text
npm run test:build
```

## Milestone 3: Artifact and State Support

### Objective

Record draft and review artifacts in scrupulous mode while keeping the final milestone plan path stable.

### Implementation Steps

1. Extend `src/artifacts/milestone-artifacts.ts` with optional paths:
   - `milestonePlanDraft`;
   - `milestonePlanReview`;
   - existing `milestonePlan` remains final.
2. Extend `StateArtifacts` in `src/state/state-types.ts` with optional maps:
   - `milestonePlanDrafts`;
   - `milestonePlanReviews`.
3. Extend `MilestoneArtifactStateKey` or `ArtifactMapStateKey` in `src/state/state-transitions.ts` so both maps can be recorded through the existing artifact helper path.
4. Update `schemas/state.schema.json` to allow `milestonePlanDrafts` and `milestonePlanReviews`; the schema currently rejects unknown artifact keys.
5. Update state schema tests if they assert the exact artifact shape.
6. Update artifact tests to assert the new paths.
7. Avoid writing draft/review artifacts during normal mode.

### Acceptance Criteria

- Normal mode still writes `10-milestone-<id>-plan.md` only for the milestone plan.
- Scrupulous mode writes draft, review, and final plan artifacts.
- `state.artifacts.milestonePlans[id]` always points to the final implementation plan.
- Old run state remains valid when the new optional artifact maps are absent.

### Verification

```text
npm run test:build
```

## Milestone 4: Implementation Workflow Integration

### Objective

Insert milestone plan review and correction into `runImplementationWorkflow` when scrupulous mode is enabled.

### Implementation Steps

1. Extend `ImplementationRunnerPhase` in `src/implementation/implementation-types.ts`:

   ```ts
   export type ImplementationRunnerPhase =
     | "milestone_plan"
     | "milestone_plan_review"
     | "final_milestone_plan"
     | "implement_milestone";
   ```

2. Refactor `produceMilestonePlan` in `src/implementation/implementation-workflow.ts` into smaller pieces:
   - produce initial plan from runner or light policy;
   - optionally review initial plan;
   - optionally produce corrected final plan.
3. In normal mode, keep the current return behavior.
4. In scrupulous mode:
   - write the initial plan to `milestonePlanDraft`;
   - run `milestone_plan_review`;
   - write the review to `milestonePlanReview`;
   - run `final_milestone_plan`;
   - write the corrected output to the existing `milestonePlan` artifact path;
   - pass the corrected plan into `implement_milestone`.
5. Ensure light milestone plans are also reviewed in scrupulous mode.
6. Do not add automatic resume-from-final-plan behavior in the initial implementation. If a run is interrupted during scrupulous draft/review/final-plan generation, current conservative resume behavior should stop for human review.
7. Ensure failure in either review or correction phase fails the implementation workflow before repository changes begin.
8. Keep diagnostics and timing behavior consistent by routing both new runner phases through `runAgentPhaseWithDiagnostics`.

### Acceptance Criteria

- Normal mode runner phase sequence remains:

  ```text
  milestone_plan -> implement_milestone
  ```

- Light normal mode sequence remains:

  ```text
  implement_milestone
  ```

- Scrupulous full mode sequence becomes:

  ```text
  milestone_plan -> milestone_plan_review -> final_milestone_plan -> implement_milestone
  ```

- Scrupulous light mode sequence becomes:

  ```text
  milestone_plan_review -> final_milestone_plan -> implement_milestone
  ```

- Implementation prompt receives the corrected final milestone plan.
- No target repository diff is captured or required until after the corrected plan exists.
- Interrupted scrupulous planning does not silently continue from `implementing`; it remains conservative and requires human review unless a future milestone adds an explicit capable resume path.

### Verification

```text
npm run test:build
```

## Milestone 5: Runner Support

### Objective

Teach runners and diagnostics about the new phases.

### Implementation Steps

1. Update `src/runners/fake/fake-runner.ts`:
   - return deterministic Markdown for `milestone_plan_review`;
   - return deterministic corrected Markdown for `final_milestone_plan`.
2. Keep `src/runners/codex-exec/codex-exec-runner.ts` sandbox behavior unchanged unless tests prove otherwise:
   - the new phases should use `sandboxForPlanning`;
   - only `implement_milestone` and `fix_review_findings` use implementation sandbox.
3. Decide whether either new phase needs an output schema.
   - Initial recommendation: no schema, because both outputs are Markdown planning artifacts.
4. Update runner tests to assert the new phases work under fake and codex-exec runners.
5. Update timing summary expectations if tests use exact phase lists.

### Acceptance Criteria

- Fake runner can complete a full scrupulous fake workflow.
- Codex-exec passes the new prompts through the planning sandbox.
- Runner diagnostics are written for both new phases.
- No output schema is required for the new Markdown phases.

### Verification

```text
npm run test:build
```

## Milestone 6: Resume, Reporting, and Documentation

### Objective

Make scrupulous mode visible and resume-safe.

### Implementation Steps

1. Ensure saved config snapshots include `milestonePlanReviewPolicy`.
2. On resume, preserve the saved policy unless the CLI explicitly overrides it for that invocation.
3. Do not persist resume-time CLI overrides back into the saved state snapshot in the initial implementation.
4. Document that a policy override affects only future milestone planning work reached during that resume invocation.
5. Document that the initial implementation keeps scrupulous draft/review/final-plan generation inside the existing `implementing` phase.
6. Document that interruption during scrupulous plan review or correction requires human review on resume because implementation-ready artifacts may be incomplete and `planned` milestones are not currently accepted by `runImplementationWorkflow`.
7. Update run reports and dry-run output to show:
   - saved review policy;
   - effective review policy;
   - whether scrupulous review will run for the next milestone.
8. Update README workflow diagrams to include the optional phases.
9. Update `docs/how-to.md` with examples:

   ```text
   node dist/cli/main.js --milestone-plan-review-policy scrupulous "goal"
   node dist/cli/main.js --resume .agent-work/run-1 --milestone-plan-review-policy scrupulous
   ```

### Acceptance Criteria

- Resume behavior is explicit and test-covered.
- Users can tell from CLI output whether scrupulous mode is active.
- Documentation explains interaction with `milestonePlanPolicy`.
- Documentation explains the conservative resume behavior for interruptions during scrupulous plan review.
- Documentation explains that resume-time review-policy overrides are per-invocation and not persisted to the saved config snapshot.

### Verification

```text
npm run test:build
```

## Milestone 7: End-to-End Validation

### Objective

Prove that scrupulous mode works through the full goal workflow.

### Implementation Steps

1. Add a goal workflow test with fake runner and `milestonePlanReviewPolicy: "scrupulous"`.
2. Assert the per-milestone phase order includes the new review/correction phases.
3. Assert every completed milestone has:
   - draft plan artifact;
   - milestone plan review artifact;
   - final plan artifact;
   - implementation artifact;
   - checks artifact;
   - implementation review artifact;
   - summary artifact.
4. Add a failure test where `milestone_plan_review` fails.
5. Add a failure test where `final_milestone_plan` returns empty output.
6. Confirm failure occurs before implementation writes target repository changes.
7. Add conservative resume edge-case tests:
   - draft plan exists only;
   - draft and milestone plan review exist only;
   - final milestone plan exists and milestone status is `planned`;
   - current phase is `implementing` with missing implementation, diff, or check artifacts.
8. Assert each conservative resume edge case stops for human review rather than continuing implementation.

### Acceptance Criteria

- Full fake workflow completes with scrupulous mode enabled.
- Failures in plan review or correction stop before implementation.
- Existing non-scrupulous workflows remain unchanged.
- Interrupted scrupulous planning states do not resume automatically.

### Verification

```text
npm run typecheck
npm run test:build
```

## Risks and Decisions

### Risk: More Runner Calls

Scrupulous mode adds two runner calls per milestone. This can make real runs slower and more expensive.

Mitigation: keep the default policy as `normal`; make scrupulous mode opt-in and visible in run output.

### Risk: Artifact Confusion

Users may confuse draft and final milestone plans.

Mitigation: keep `10-milestone-<id>-plan.md` as the final implementation plan and name draft/review artifacts explicitly.

### Risk: Prompt Drift

The new milestone correction prompts may drift from the major-plan correction prompts.

Mitigation: structure the prompts similarly and add prompt-loader tests that check for key constraints.

### Risk: Resume Semantics

Changing review policy mid-run can be ambiguous after some milestones already have plans.

Mitigation: make resume-time policy overrides per-invocation, report saved and effective policies clearly, and apply the effective policy only to future milestone planning work reached during that invocation. In the initial implementation, interruption during scrupulous draft/review/final-plan generation remains conservative and requires human review on resume.

## Final Acceptance Criteria

- Users can enable scrupulous mode from config or CLI.
- Normal mode behavior is unchanged.
- Scrupulous mode reviews and corrects every generated per-milestone plan before implementation.
- The implementation agent receives only the corrected final milestone plan.
- Draft and review artifacts are retained for inspection.
- Fake and codex-exec runner paths support the new phases.
- Config, CLI, workflow, resume, artifact, and docs tests cover the new behavior.
