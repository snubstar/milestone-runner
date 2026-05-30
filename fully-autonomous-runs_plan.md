# Fully Autonomous Runs Implementation Plan

## Objective

Add a supported success-seeking autonomous mode where Milestone Runner does not
ask for human review for newly encountered review or resume ambiguity. In this
mode, the runner must try to repair malformed agent output, resolve ambiguity,
choose documented assumptions, and continue through the normal check/review/fix
loop when it can do so safely.

The mode is not a guarantee that every run passes. It is a guarantee that the
runner does not hand ambiguous or malformed intermediate state to a human as the
next required actor. If bounded autonomous repair and resolution cannot produce
a valid next action, the run fails with artifacts and a non-zero exit.

The default supervised behavior must remain unchanged.

## Target Behavior

Use one config field:

```json
{
  "humanReviewPolicy": "stop"
}
```

Supported values:

- `stop`: supervised default. Human-review-equivalent conditions stop as
  `needs_human_review`.
- `fail`: conservative unattended mode. Human-review-equivalent conditions fail
  immediately with diagnostics and a non-zero exit.
- `autonomous`: fully autonomous mode. Human-review-equivalent conditions first
  route through automated repair or resolution. The runner records assumptions
  and resolution artifacts, then continues when the result validates. It fails
  only after bounded autonomous attempts cannot produce a safe next action.

Deterministic checks remain real gates in every mode. `autonomous` may fix code
or resolve review ambiguity, but it must not ignore failed checks or mark work
passed without a valid review/check path.

## Current Implementation Status

Milestone 1, Milestone 2, Milestone 3, Milestone 4, Milestone 5, Milestone 6,
Milestone 7, Milestone 8, and Milestone 9 are implemented:

- config type/schema/loading/reporting include `humanReviewPolicy`;
- the enum accepts `stop`, `fail`, and `autonomous`;
- the policy helper routes `stop`, `fail`, and `autonomous`;
- malformed base and post-fix review verdict output is repaired automatically in
  `autonomous` mode with bounded attempts and preserved diagnostics.
- valid review verdicts that would otherwise request human review are resolved
  automatically in `autonomous` mode with bounded attempts, preserved
  resolution artifacts, and recorded assumptions.
- review workflow result semantics now map supervised stops, fail-fast failures,
  and exhausted autonomous failures consistently through review summaries, goal
  summaries, run state, and CLI exit codes.
- ambiguous resume states now route by `humanReviewPolicy`: `stop` preserves
  supervised human review, `fail` fails with a goal summary, and `autonomous`
  runs a bounded `resolve_resume_state` phase with schema validation,
  deterministic artifact-safety checks, and auditable log artifacts before
  continuing or failing.
- dashboard/run-report paths expose autonomous repair/resolution artifacts,
  goal summaries include autonomous diagnostics and assumptions, final reports
  distinguish supervised stops, fail-fast failures, autonomous continuation, and
  autonomous exhaustion, and resume dry-runs allow autonomous/fail policy resume
  handling instead of treating those states as supervised blocks.
- docs now describe `autonomous` as the fully autonomous success-seeking mode,
  keep `fail` documented as conservative unattended fail-fast behavior, show an
  autonomous operator config, document exit codes and artifact locations, and
  state that `humanReviewPolicy` is chosen at run creation rather than resume.
- end-to-end verification covers deterministic checks, ScenarioRunner-backed
  autonomous repair/resolution scenarios, CLI failure semantics, dry-run
  reporting for `humanReviewPolicy: "autonomous"`, and generated autonomous
  decision artifacts.

No implementation milestones remain in this plan.

## Milestone 1: Config Surface Extension

### Goal

Make `humanReviewPolicy: "autonomous"` a first-class config value while keeping
existing defaults and already-added reporting.

### Implementation Steps

1. Update `src/config/config-types.ts`.
   - Change `HumanReviewPolicy` to `"stop" | "fail" | "autonomous"`.

2. Update `src/config/config-loader.ts`.
   - Accept `"autonomous"` in validation.
   - Keep missing values defaulting to `"stop"`.
   - Keep `applyConfigOverrides(...)` preserving the saved config value.
   - Do not add a CLI override for `humanReviewPolicy`.

3. Update `schemas/config.schema.json`.
   - Add `"autonomous"` to the optional `humanReviewPolicy` enum.

4. Update reporting and examples.
   - Existing dry-run/final-report fields should continue to show the effective
     policy.
   - Keep `orchestrator.config.example.json` at `"stop"` so the default is
     explicit.
   - Docs should show `"autonomous"` as the fully autonomous setting, and
     describe `"fail"` as fail-fast unattended behavior.

### Tests

Update or add tests for:

- config loader accepts `"autonomous"`;
- config schema permits old configs, `"fail"`, and `"autonomous"`;
- dry-run/run report assertions still include the policy;
- resume still uses the saved policy value and does not allow a resume-time
  policy override.

Likely files:

- `tests/unit/config-loader.test.ts`
- `tests/unit/run-report.test.ts`
- `tests/unit/cli-main.test.ts`

## Milestone 2: Human Review Policy Routing Helper

### Goal

Centralize the policy decision: stop, fail immediately, or attempt autonomous
resolution.

### Implementation Steps

1. Update `src/orchestration/human-review-policy.ts`.

2. Keep terminal helpers for `stop` and `fail`, but make `autonomous` route to
   resolution before any terminal mapping. Suggested helper surface:

```ts
humanReviewPolicyDisposition(policy): "stop" | "fail" | "resolve"
shouldAttemptAutonomousResolution(policy): boolean
isFailFastHumanReviewPolicy(policy): boolean
isSupervisedHumanReviewPolicy(policy): boolean
terminalPhaseForUnresolvedHumanReview(policy): "needs_human_review" | "failed"
lastErrorPhaseForUnresolvedHumanReview(policy, autonomousPhase): OrchestratorPhase
```

3. Define terminal fallback for exhausted autonomous attempts as `failed`, not
   `needs_human_review`.

4. Keep the helper pure and independent from runner/review implementation
   details.

### Tests

Update `tests/unit/human-review-policy.test.ts`.

Cover:

- `stop` maps to supervised stop;
- `fail` maps to fail-fast terminal failure;
- `autonomous` maps to resolution first;
- exhausted autonomous fallback maps to `failed`;
- helper behavior is deterministic and exhaustive over all policy values.

## Milestone 3: Review Output Repair

### Goal

In `humanReviewPolicy: "autonomous"`, malformed review output should be repaired
automatically instead of stopping or failing immediately.

### Implementation Steps

1. Add a review-output repair prompt:

```text
src/prompts/repair-review-verdict.md
```

2. Add a review runner phase type, for example:

```ts
"repair_review_verdict"
```

Update `src/review/review-types.ts`, `src/runners/output-schema.ts`, and any
runner tests so this phase uses the existing review verdict JSON schema.

3. In `src/review/review-workflow.ts`, when base or post-fix review output is
   malformed under `autonomous`:
   - write the raw malformed diagnostic artifact as today;
   - render the repair prompt with raw output, validation error, review evidence,
     reviewed artifacts, check summary, and the expected schema contract;
   - run the repair phase;
   - validate the repaired output with `parseReviewVerdictJson(...)`;
   - if valid, write a normal review artifact and continue through the existing
     review decision path;
   - if invalid after bounded attempts, fail with preserved diagnostics.

4. Use a small hard-coded first-pass budget to avoid new config surface:
   - base review repair attempts: `2`;
   - post-fix review repair attempts: `2`.

5. Add artifact paths in `src/artifacts/review-artifacts.ts` for repair
   diagnostics, for example:
   - `reviews/21-milestone-<id>-review-repair-<attempt>.json`;
   - `reviews/61-milestone-<id>-post-fix-review-repair-<attempt>.json`.

6. Preserve raw and repaired outputs. Do not overwrite the raw malformed output.

7. Under `stop`, keep existing malformed-output behavior.

8. Under `fail`, keep fail-fast behavior once that mode is applied.

### Tests

Extend `tests/unit/review-workflow.test.ts`.

Cover:

- base malformed review repaired into `pass` with passing checks;
- post-fix malformed review repaired into `pass` with passing checks;
- malformed review repaired into `fail` with blocking findings enters the
  existing fix loop;
- repair attempts exhausted ends as `failed`, not `needs_human_review`;
- raw malformed and repaired artifacts are both recorded.

Use `ScenarioRunner` for controlled malformed and repaired outputs.

## Milestone 4: Autonomous Review Ambiguity Resolution

### Goal

In `humanReviewPolicy: "autonomous"`, review verdicts that currently require a
human should be converted into an autonomous decision when possible.

### Implementation Steps

1. Add an ambiguity-resolution prompt:

```text
src/prompts/resolve-review-ambiguity.md
```

2. Add a review runner phase type, for example:

```ts
"resolve_review_ambiguity"
```

3. Add a dedicated resolution schema:

```text
schemas/review-resolution.schema.json
```

The schema should wrap a normal review verdict object with resolution metadata
rather than extending the strict review verdict schema. Suggested shape:

```ts
{
  resolution: {
    summary: string;
    rationale: string;
    assumptions: string[];
    sourceCondition: string;
  };
  verdict: ReviewVerdictJson;
}
```

Validate the wrapper first, then validate `verdict` with the existing
`parseReviewVerdictJson(...)` path. Do not add resolver-only fields to
`review-verdict.schema.json`.

4. Update `src/runners/output-schema.ts` so `resolve_review_ambiguity` uses
   `schemas/review-resolution.schema.json`.

5. The embedded `verdict` must be one of:
   - `pass`, only when checks pass and reviewed artifacts justify it;
   - `fail` with at least one blocking finding that the fixer can act on;
   - `needs_human_review`, which is treated as unresolved and retried/fails
     under `autonomous`.

6. In `src/review/review-workflow.ts`, route these review-driven unresolved
   cases through the resolver under `autonomous`:
   - explicit `needs_human_review` verdict;
   - `fail` verdict without blocking findings;
   - reviewer `pass` while latest checks failed;
   - post-fix explicit `needs_human_review`;
   - post-fix `fail` without blocking findings.

7. For `pass` with failed checks, first synthesize an actionable blocking
   finding from the failed check report before asking the agent. This keeps
   deterministic checks authoritative and lets the existing fix loop work.

8. For `maxFixAttempts === 0`, do not ask for human review. Respect the
   operator's zero-fix budget:
   - if the autonomous resolver can safely produce `pass` and checks pass,
     continue;
   - if fixes are needed, fail with diagnostics explaining that fixes are
     disabled.

9. For exhausted fix attempts, do not ask for human review. Fail with the full
   fix/review history unless a valid resolver output can mark the work passed
   with passing checks. Do not perform code changes beyond the configured fix
   budget in this first pass.

10. Add resolution artifacts in `src/artifacts/review-artifacts.ts`, for example:
   - `reviews/22-milestone-<id>-autonomous-resolution-<attempt>.json`;
   - `reviews/62-milestone-<id>-post-fix-autonomous-resolution-<attempt>.json`.
   These artifacts should store the full resolution wrapper, including
   assumptions and rationale.

11. Add an assumptions section to the review summary when autonomous resolution
   chooses assumptions or converts ambiguity into a decision.

12. Under `stop`, preserve current `needs_human_review` behavior.

13. Under `fail`, fail fast instead of resolving.

### Tests

Extend `tests/unit/review-workflow.test.ts` and `tests/unit/goal-workflow.test.ts`.

Cover under `humanReviewPolicy: "autonomous"`:

- explicit `needs_human_review` resolves to `pass` with passing checks;
- explicit `needs_human_review` resolves to `fail` with blocking findings, then
  enters the fix loop and passes after re-review;
- `fail` without blocking findings resolves to actionable blocking findings;
- `pass` with failing checks creates/uses a check-failure finding and does not
  pass until checks pass;
- resolver repeatedly returns `needs_human_review`, and the run fails rather
  than stopping for human review;
- `maxFixAttempts === 0` fails when fixes are required;
- exhausted fix attempts fail with artifacts and non-zero CLI result.

Assertions should verify:

- no newly encountered autonomous review path ends with state
  `needs_human_review`;
- successful autonomous resolutions can still produce a passed milestone;
- failed autonomous resolutions return unsuccessful workflow/CLI results;
- raw review, repair, resolution, check, fix, and summary artifacts remain
  auditable.

## Milestone 5: Review Workflow Result Semantics

### Goal

Ensure autonomous repair/resolution affects both state and CLI exit semantics.

### Implementation Steps

1. Update the local human-review handling in `src/review/review-workflow.ts`.
   A useful shape is:

```ts
handleHumanReviewEquivalent(reason, details, context)
```

2. Behavior by policy:
   - `stop`: write summary, mark `needs_human_review`, return
     `ok: true` with `verdict: "needs_human_review"` as today.
   - `fail`: write summary, mark `failed`, return `ok: false`.
   - `autonomous`: attempt the relevant repair/resolution path. If it produces
     a valid next verdict, continue. If exhausted, write summary, mark `failed`,
     return `ok: false`.

3. Preserve artifact order:
   - raw review or diagnostic artifact;
   - repair/resolution artifacts when applicable;
   - review summary;
   - terminal state mapping only if no valid autonomous next action exists.

4. Preserve review artifact semantics:
   - raw artifacts may still contain `verdict: "needs_human_review"`;
   - resolution artifacts record why the agent chose assumptions or converted
     the verdict;
   - run state/report/summary distinguish supervised stops, fail-fast failures,
     and exhausted autonomous failures.

5. Update `src/orchestration/goal-workflow.ts`.
   - Existing `!result.ok` must finalize with `finishTerminal(... ok: false)`.
   - Existing `result.verdict === "needs_human_review"` remains only for
     supervised `stop`.
   - Ensure goal summary writes before any failed result.

### Tests

Extend:

- `tests/unit/review-workflow.test.ts`
- `tests/unit/goal-workflow.test.ts`
- `tests/unit/cli-main.test.ts`

Assertions:

- `stop` behavior is unchanged;
- `fail` behavior is immediate failed terminal result;
- `autonomous` behavior tries repair/resolution first;
- exhausted autonomous attempts produce `failed`, active milestone `failed`,
  non-zero CLI exit, and preserved artifacts.

## Milestone 6: Autonomous Resume Safety Resolution

### Goal

Avoid human review on ambiguous resume states while still preventing unsafe
state corruption.

### Implementation Steps

1. Keep `normalizeStateForGoalResume(...)` in
   `src/orchestration/resume-state.ts` policy-neutral if possible.

2. In `src/orchestration/goal-workflow.ts`, when
   `decision.kind === "needs_human_review"`:
   - `stop`: existing supervised stop;
   - `fail`: failed terminal result;
   - `autonomous`: run a bounded resume-resolution path.

3. Add a resume-resolution prompt, runner phase, schema, and validator:

```text
src/prompts/resolve-resume-state.md
schemas/resume-resolution.schema.json
src/orchestration/resume-resolution-validator.ts
```

The runner phase should be named:

```ts
"resolve_resume_state"
```

Update `src/runners/output-schema.ts` and runner tests so this phase uses
`schemas/resume-resolution.schema.json`.

4. The resolver can only choose from validated actions:
   - continue from the current phase;
   - normalize to `ready_for_review`;
   - normalize to `passed`;
   - fail with diagnostics.

Suggested schema shape:

```ts
{
  action:
    | "continue"
    | "normalize_to_ready_for_review"
    | "normalize_to_passed"
    | "fail";
  summary: string;
  rationale: string;
  assumptions: string[];
  currentMilestoneId?: number | null;
}
```

5. Validate resolver output deterministically before applying it in
   `resume-resolution-validator.ts`.
   - Do not allow invented artifact paths.
   - Do not allow skipping required implementation, diff, check, or review
     artifacts.
   - Require `currentMilestoneId` to match state/metadata when an action is
     milestone-specific.
   - Reuse existing resume normalization checks where possible instead of
     duplicating artifact-safety logic.
   - If the suggested action fails validation, retry once and then fail.

6. Render the resolver prompt with:
   - current state;
   - milestone metadata;
   - the original resume safety decision message/details;
   - artifact existence and path summary;
   - allowed actions and validation rules.

7. Apply only validated actions:
   - `continue`: leave state unchanged and resume the existing loop;
   - `normalize_to_ready_for_review`: apply the same state transition currently
     used for validated resume normalization;
   - `normalize_to_passed`: apply the same state transition currently used for
     validated resume normalization;
   - `fail`: persist a failed state with resolver diagnostics.

8. Preserve behavior for runs already terminal `needs_human_review`.
   Recommended first behavior:
   - preserve the saved terminal state when resuming a run already terminal
     `needs_human_review`;
   - report it as already stopped;
   - do not retroactively convert legacy terminal state unless a future explicit
     migration/override is added.

9. Record resume-resolution artifacts under logs, for example:
   - `logs/resolve-resume-state-<attempt>.json`.
   Record them in `state.artifacts.logs` with stable keys such as
   `resume-resolution-<attempt>` so the dashboard and goal summary can link
   them.

### Tests

Update:

- `tests/unit/resume-state.test.ts`
- `tests/unit/goal-workflow.test.ts`
- `tests/unit/cli-main.test.ts`

Cover:

- unsafe transient resume under `stop` produces `needs_human_review`;
- unsafe transient resume under `fail` produces failed workflow result;
- unsafe transient resume under `autonomous` applies a validated resolution and
  continues;
- invalid autonomous resume resolution fails rather than asking for human
  review;
- already-terminal `needs_human_review` resume behavior matches documented
  semantics.

## Milestone 7: Dashboard, Summaries, And Run Reader Compatibility

### Goal

Make autonomous decisions visible and auditable.

### Implementation Steps

1. Review `src/dashboard/run-reader.ts`.
   - No new terminal status should be needed.
   - Ensure autonomous repair/resolution artifacts appear in dashboard artifact
     groups.

2. Review `src/orchestration/goal-summary.ts`.
   - Add autonomous-resolution diagnostics and assumptions to failed and passed
     summaries.
   - Avoid assuming every review-equivalent unresolved condition appears under
     `needs_human_review`.

3. Review report text in `src/cli/run-report.ts`.
   - Make final reports distinguish:
     - supervised stop;
     - fail-fast unattended failure;
     - autonomous resolved continuation;
     - autonomous exhausted failure.

### Tests

Update as needed:

- `tests/unit/dashboard-run-reader.test.ts`
- `tests/unit/goal-summary.test.ts`
- `tests/unit/run-report.test.ts`

Assertions should confirm summaries/reports reference repair/resolution
artifacts and assumptions.

## Milestone 8: Documentation And Operator Examples

### Goal

Make the stronger autonomous mode discoverable and accurately described.

### Implementation Steps

1. Update `docs/fully-autonomous-runs.md`.
   - Replace fail-only language with the implemented `autonomous` behavior.
   - Explain that `fail` is a conservative unattended mode, not the full
     autonomous mode.
   - Document bounded repair/resolution behavior.

2. Update `docs/how-to.md`.
   - Add an “Autonomous Runs” section.
   - Show a config using `humanReviewPolicy: "autonomous"`.
   - Recommend `maxFixAttempts > 0` for autonomous runs that are expected to fix
     code.
   - Explain exit codes and artifact locations.

3. Update `README.md` config reference.
   - Mention the default remains supervised.
   - Mention `autonomous` repairs/resolves before failing.
   - Mention `fail` fails immediately on human-review-equivalent conditions.

4. Keep `orchestrator.config.example.json` at `"humanReviewPolicy": "stop"`.

5. Document that `humanReviewPolicy` is not a resume-time CLI override in this
   implementation. Operators choose it when creating the run.

### Tests

Docs-only verification:

```bash
git diff --check
```

## Milestone 9: End-To-End Verification

### Goal

Verify the feature through unit tests, type checks, and orchestrated fake-run
scenarios.

### Implementation Steps

1. Run deterministic project checks:

```bash
npm run typecheck
npm run build
npm run test:build
```

2. Add `ScenarioRunner`-backed tests rather than changing the built-in
   `FakeRunner`.

3. Required scenarios:
   - `humanReviewPolicy: "autonomous"` repairs malformed review JSON and passes;
   - `humanReviewPolicy: "autonomous"` resolves `needs_human_review` into
     blocking findings, fixes them, and passes;
   - `humanReviewPolicy: "autonomous"` exhausts repair/resolution attempts and
     exits non-zero without `needs_human_review`;
   - `humanReviewPolicy: "fail"` fails immediately for the same ambiguous
     verdict;
   - `humanReviewPolicy: "stop"` preserves current supervised behavior.

4. Run a dry-run with a config containing `humanReviewPolicy: "autonomous"` and
   confirm reports show the policy.

5. Inspect generated artifacts from autonomous scenarios:
   - `state.json`;
   - raw review artifact;
   - repair artifact;
   - resolution artifact;
   - check/fix artifacts;
   - `milestones/25-milestone-<id>-review-summary.md`;
   - `milestones/90-goal-summary.md`.

## Acceptance Criteria

- Existing configs remain valid.
- Missing `humanReviewPolicy` defaults to `"stop"`.
- `humanReviewPolicy: "stop"` preserves existing behavior.
- `humanReviewPolicy: "fail"` fails immediately instead of stopping for newly
  encountered human-review-equivalent conditions.
- `humanReviewPolicy: "autonomous"` never newly ends a review/resume ambiguity
  as `needs_human_review`.
- `autonomous` repairs malformed review output before failing.
- `autonomous` resolves explicit `needs_human_review` review verdicts by
  choosing documented assumptions or actionable findings.
- `autonomous` can pass a milestone after valid repair/resolution and passing
  checks.
- `autonomous` fails only after bounded repair/resolution attempts cannot
  produce a valid safe next action.
- Deterministic checks are never ignored.
- Review fail with blocking findings still auto-fixes up to `maxFixAttempts`.
- Resume safety behavior is documented and tested.
- Run and dry-run reports show the effective policy.
- `npm run typecheck`, `npm run build`, and `npm run test:build` pass.

## Risks And Notes

- The fully autonomous policy is success-seeking, not fail-only. Do not implement
  it by simply mapping `needs_human_review` to `failed`.
- The existing `fail` mode is still useful for CI, but it is not sufficient for
  the user's intended fully autonomous workflow.
- Output repair can hide model formatting problems unless raw outputs are
  preserved. Always keep raw malformed output and validation errors.
- Autonomous resolution can create false confidence if it treats uncertainty as
  success. Require passing deterministic checks and valid review verdict schema.
- Avoid infinite loops. Repair and resolution attempts must be bounded.
- Be careful not to regress supervised local workflows. Most tests should prove
  default `stop` behavior first, then add policy-specific assertions.
