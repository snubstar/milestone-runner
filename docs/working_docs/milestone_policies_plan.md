# Milestone Plan Policies Plan

## Goals

- Keep the general plan mandatory. Normal runs still produce the major plan, major plan review, final major plan, and milestone metadata.
- Make only the per-milestone implementation plan configurable.
- Support a milestone plan policy of `always`, `auto`, or `light`.
- Preserve the existing artifact contract: every implemented milestone still records a milestone plan artifact at `milestones/10-milestone-<id>-plan.md`.
- Reduce unnecessary milestone-planning agent calls for simple milestones without weakening implementation, checks, review, diagnostics, or durable artifacts.
- Keep default behavior backward-compatible: missing config means `milestonePlanPolicy: "always"`.

## Implementation Decisions

- External policy values are `always`, `auto`, and `light`.
- Internal selected plan modes are `full` and `light`.
- `always` always selects `full`.
- `light` always selects `light`.
- `auto` selects `full` or `light` per active milestone using deterministic local rules.
- `full` mode calls the existing `milestone_plan` runner phase.
- `light` mode does not call the `milestone_plan` runner phase.
- Both modes write the same milestone plan artifact path and record `state.artifacts.milestonePlans[<id>]`.
- Do not add per-milestone policy state in the first implementation. The active config is already snapshotted in `state.config.snapshot`; for `light` and `auto`, the selected mode and reason should be visible in the milestone plan artifact.
- Preserve the raw runner-generated milestone plan artifact for default `always` runs to keep the historical artifact shape backward-compatible.
- Resume behavior remains intentionally conservative. This feature does not add partial implementation resume from a state where only the milestone plan exists. Existing transient `implementing` or `checking` resume behavior may still stop for human review if required artifacts are missing.
- `--milestone-plan-policy` is allowed on new runs and resume runs. On resume, it affects only milestones that have not yet produced a milestone plan artifact; it must not rewrite existing milestone artifacts.

## Policy Semantics

`always`

- Use the current runner-backed behavior.
- Before implementation, call the `milestone_plan` phase.
- Write the resulting full plan to the milestone plan artifact without adding policy metadata.

`light`

- Skip the `milestone_plan` phase.
- Generate a deterministic Markdown plan from active milestone metadata.
- The light plan must include milestone id, title, summary, scope, acceptance criteria, verification, dependencies, selected mode, and decision reason.

`auto`

- Select `full` or `light` for each milestone.
- Use deterministic rules only. Do not introduce a routing agent in the first implementation.
- Be conservative: if the classifier is unsure, select `full`.

## Auto Classifier Rules

Implement `auto` as a local classifier, for example in `src/implementation/milestone-plan-policy.ts`.

Inputs:

- active milestone
- full milestone metadata
- current run state
- configured policy

Return:

```ts
export type MilestonePlanMode = "full" | "light";

export interface MilestonePlanDecision {
  policy: "always" | "auto" | "light";
  mode: MilestonePlanMode;
  reason: string;
}
```

Deterministic rules:

1. If policy is `always`, return `full` with reason `policy=always`.
2. If policy is `light`, return `light` with reason `policy=light`.
3. If policy is `auto` and `dependencies.length > 0`, return `full`.
4. If policy is `auto` and `scope.length === 0`, return `full`.
5. If policy is `auto` and `scope.length > 2`, return `full`.
6. If policy is `auto` and `acceptanceCriteria.length === 0`, return `full`.
7. If policy is `auto` and `verification.length === 0`, return `full`.
8. If policy is `auto` and `verification.length > 2`, return `full`.
9. If policy is `auto` and the title, summary, scope, acceptance criteria, or verification contains broad/risky terms, return `full`.
10. Otherwise return `light`.

Initial broad/risky terms:

```txt
architecture
auth
authentication
authorization
oauth
login
database
schema
migration
security
state
resume
orchestration
runner
workflow
integration
refactor
across
multiple modules
end-to-end
diagnostics
```

Initial vague verification values:

```txt
verify
test
run tests
manual test
ensure it works
n/a
none
tbd
```

Treat vague verification as a `full` trigger when the normalized verification list has only vague values.

## Milestone 1: Configuration And CLI Surface

Implementation steps:

1. Add `MilestonePlanPolicy = "always" | "auto" | "light"` in `src/config/config-types.ts`.
2. Add `milestonePlanPolicy` to `OrchestratorConfig`.
3. In `src/config/config-loader.ts`, accept missing `milestonePlanPolicy` and default it to `"always"`.
4. Reject invalid policy values with a clear validation error.
5. Update `applyConfigOverrides` to accept `milestonePlanPolicy`.
6. Add `milestonePlanPolicy?: MilestonePlanPolicy` to `CliOptions`.
7. Parse `--milestone-plan-policy <always|auto|light>` in `src/cli/args.ts`.
8. Allow `--milestone-plan-policy` with `--resume`.
9. Pass the override in both new-run and resume-run config override paths in `src/cli/main.ts`.
10. Update CLI usage text.
11. Update `orchestrator.config.example.json`.

Acceptance criteria:

- Existing configs without `milestonePlanPolicy` load and behave as `always`.
- Invalid config values fail validation.
- Invalid CLI values fail argument parsing.
- CLI override wins over config for new runs.
- CLI override wins over saved config for future unplanned milestones during resume.

Verification:

- Unit tests for config defaulting.
- Unit tests for invalid config values.
- Unit tests for CLI parsing and invalid CLI values.
- Unit test or integration test proving resume accepts the CLI override.

## Milestone 2: Add Policy Decision And Light Plan Helpers

Implementation steps:

1. Add `src/implementation/milestone-plan-policy.ts`.
2. Implement `selectMilestonePlanDecision`.
3. Implement `formatLightMilestonePlan`.
4. Add a shared Markdown metadata block format used by policy-selected full and light plans:

```md
## Plan Metadata

- Policy: auto
- Mode: light
- Decision: no dependencies, small scope, clear verification
```

5. For light plans, include:
   - milestone id and title
   - summary
   - scope
   - acceptance criteria
   - verification
   - dependencies
   - instruction that implementation must produce concrete code/file changes for the active milestone
6. Export helper types needed by tests and `runImplementationWorkflow`.

Acceptance criteria:

- Helper has no runner dependency.
- Helper output is deterministic.
- Light plan output is useful enough for the existing implementation prompt and review prompt.

Verification:

- Unit tests for `always`, `light`, and representative `auto` decisions.
- Unit tests for broad/risky term detection.
- Unit tests for vague verification detection.
- Unit test for light plan formatting.

## Milestone 3: Extract Milestone Plan Production

Implementation steps:

1. In `src/implementation/implementation-workflow.ts`, extract the existing milestone-plan generation into a helper, for example `produceMilestonePlan`.
2. The helper should accept:
   - goal
   - config
   - final major plan content
   - full milestone metadata
   - active milestone
   - state
   - runner dependencies already available in `runImplementationWorkflow`
3. The helper should return:

```ts
interface ProducedMilestonePlan {
  content: string;
  decision: MilestonePlanDecision;
}
```

4. For `full`, preserve the existing prompt rendering and `runPhase("milestone_plan", ...)` behavior.
5. For `light`, call `formatLightMilestonePlan` and skip `runPhase("milestone_plan", ...)`.
6. Keep artifact writing outside the helper unless moving it clearly reduces complexity.
7. Preserve these existing workflow steps after production:
   - write milestone plan artifact
   - record `milestonePlans[<id>]`
   - set milestone status to `planned`
   - pass `milestonePlan.content` into `implement-milestone`

Acceptance criteria:

- With default policy, behavior is equivalent to current `always` behavior.
- Review workflow still reads the same artifact path.
- The implementation prompt receives plan content regardless of selected mode.

Verification:

- Existing implementation workflow tests still pass after extraction.
- Add a focused test proving `always` invokes `milestone_plan`.

## Milestone 4: Wire Light Mode Into Implementation

Implementation steps:

1. Use `selectMilestonePlanDecision` inside milestone plan production.
2. If decision mode is `light`, do not render the `milestone-plan` prompt.
3. If decision mode is `light`, do not call the runner for phase `milestone_plan`.
4. Write the light Markdown plan to `milestones/10-milestone-<id>-plan.md`.
5. Ensure the rest of implementation is unchanged:
   - implementation runner still runs
   - Git diff is still captured
   - empty diff still fails
   - checks still run
   - review still runs

Acceptance criteria:

- `milestonePlanPolicy: "light"` skips exactly one agent call per milestone: `milestone_plan`.
- `light` mode still produces all normal milestone artifacts.
- A light milestone plan is visible in run artifacts and state references it.

Verification:

- Unit or integration test that `light` mode does not call `milestone_plan`.
- Fake runner end-to-end test with `milestonePlanPolicy: "light"`.
- Assert the generated artifact includes `Mode: light`.

## Milestone 5: Wire Auto Mode Into Implementation

Implementation steps:

1. Enable `auto` to use the classifier rules from this plan.
2. For `auto` plus selected `full`, call the existing `milestone_plan` runner phase.
3. For `auto` plus selected `light`, skip the `milestone_plan` runner phase.
4. Include the classifier reason in the milestone plan metadata block.
5. Keep the classifier conservative. If a rule cannot classify cleanly, choose `full`.

Acceptance criteria:

- `auto` chooses per milestone, not per run.
- A selected `full` milestone behaves like `always`.
- A selected `light` milestone behaves like `light`.
- The artifact clearly shows both configured policy and selected mode.

Verification:

- Tests for simple localized milestone selecting `light`.
- Tests for dependency-bearing milestone selecting `full`.
- Tests for broad/risky term selecting `full`.
- Tests for vague verification selecting `full`.
- Fake runner end-to-end test where `auto` selects `light` and skips `milestone_plan`.

## Milestone 6: Reporting, Dry Run, And Resume Semantics

Implementation steps:

1. Update dry-run report data and output to show active `milestonePlanPolicy`.
2. Update normal run report output to show active `milestonePlanPolicy`.
3. On resume, if CLI override differs from saved config, report both saved and active policy.
4. Do not change `RunState` shape for per-milestone selected mode in this milestone.
5. Ensure ready-for-review resume validation treats full and light plan artifacts identically, because both are recorded under `milestonePlans`.
6. Do not attempt to regenerate a milestone plan when resuming a state that already passed milestone implementation/review boundaries.
7. Keep existing conservative behavior for transient partial implementation states.

Acceptance criteria:

- Users can see the configured policy before work starts in dry-run output.
- Users can see the policy used for the run in final run output.
- Resume output is clear when an override is active.
- Existing resume safety behavior is not loosened accidentally.

Verification:

- Dry-run tests for default, explicit `light`, and explicit `auto`.
- Resume report test with saved policy and active override, if the existing test structure supports it.
- Existing resume tests continue to pass.

## Milestone 7: Documentation

Implementation steps:

1. Update README workflow documentation.
2. Document that the general plan is still always produced.
3. Document that the policy applies only to per-milestone implementation plans.
4. Document all policies:
   - `always`: safest/default/current behavior
   - `light`: deterministic lightweight plans, fewer agent calls
   - `auto`: conservative per-milestone selection
5. Add config example.
6. Add CLI examples:

```bash
node dist/cli/main.js --milestone-plan-policy light "update docs"
node dist/cli/main.js --resume .agent-work/<run-id> --milestone-plan-policy auto
```

7. Update artifact documentation to say milestone plan artifacts may be full or light.
8. Add troubleshooting note: if `light` is too thin, rerun remaining work with `--milestone-plan-policy always`.

Acceptance criteria:

- A user can choose a policy without reading source code.
- Docs make the artifact behavior clear.
- Docs do not imply that `auto` skips the general plan.

Verification:

- Review README and docs for consistency with CLI usage and config validation.

## Milestone 8: Final Validation

Implementation steps:

1. Run unit tests.
2. Run fake-runner end-to-end tests for:
   - default `always`
   - explicit `light`
   - explicit `auto`
3. Run dry-run commands for all three policies.
4. If practical, run one real Codex execution on a small safe task with `--milestone-plan-policy light`.
5. Inspect artifacts manually:
   - `plans/03-final-major-plan.md` exists
   - `milestones/05-milestones.json` exists
   - `milestones/10-milestone-<id>-plan.md` exists
   - milestone plan artifact shows policy, selected mode, and reason

Acceptance criteria:

- Default behavior remains backward-compatible.
- `light` skips only milestone planning, not implementation or review.
- `auto` is conservative and deterministic.
- All implemented behavior is documented.

## Recommended Implementation Order

1. Configuration and CLI surface.
2. Policy decision and light plan helpers.
3. Milestone plan production extraction.
4. Light mode integration.
5. Auto mode integration.
6. Reporting, dry-run, and resume semantics.
7. Documentation.
8. Final validation.
