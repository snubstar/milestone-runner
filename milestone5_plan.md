# Milestone 5 Plan: Review And Fix Gate

## Objective

Extend the one-milestone implementation loop with a quality gate for the active milestone.

Milestone 5 starts from `ready_for_review`, reviews the captured milestone artifacts, decides whether the milestone passes, needs human review, or needs fixes, and runs bounded fix attempts when the review returns blocking findings. It should still operate on exactly one active milestone and stop before multi-milestone progression.

## Current Starting Point

Milestone 4 already provides:

- a completed planning flow;
- a milestone-specific implementation plan;
- an implementation report;
- a captured Git diff that excludes orchestrator run artifacts;
- deterministic check output;
- a milestone summary;
- `state.currentPhase = "ready_for_review"`;
- `state.milestoneStatuses["<id>"] = "ready_for_review"`.

Milestone 5 should build on the Milestone 4 handoff. It should not re-run planning or implementation from scratch.

## In Scope

- Add a review workflow for the active milestone.
- Render the existing `review-milestone.md` prompt with the original goal, final major plan, milestone plan, implementation report, diff, checks output, and active milestone metadata.
- Require review output that validates against `schemas/review-verdict.schema.json`.
- Persist review verdict artifacts.
- Mark the milestone as `passed` when the review verdict passes.
- Mark the run as `needs_human_review` when the review verdict requests human review or returns malformed/unusable review output.
- Run bounded fix attempts for failed reviews with blocking findings.
- Re-run deterministic checks after each fix attempt.
- Capture a fresh post-fix diff after each fix attempt.
- Re-review after each fix attempt.
- Stop after `config.maxFixAttempts`.
- Persist state after each durable artifact or status transition.
- Add tests for pass, fail-with-fix, malformed review JSON, needs-human-review, and max-attempt outcomes.

## Out Of Scope

- Advancing to milestone 2.
- Full resume support.
- Multi-milestone iteration.
- Real `codex-exec` fix execution.
- Automatic commits.
- Rollback of failed fixes.
- Updating milestone metadata in `05-milestones.json`; Milestone 5 should use `state.milestoneStatuses` as the source of runtime status.

## Locked Decisions

- The active milestone is still `state.currentMilestoneId`; the workflow must not choose another milestone.
- The workflow starts only from `currentPhase = "ready_for_review"`.
- The active milestone status must be `ready_for_review`.
- Review output is data, not authority. The orchestrator decides state transitions after validating the verdict.
- A `pass` verdict is valid only when there are no blocking findings.
- A `fail` verdict with blocking findings may trigger fix attempts.
- A `fail` verdict without blocking findings is treated as `needs_human_review` because the orchestrator has no scoped fix target.
- A malformed review response is treated as `needs_human_review`, not as passed or failed.
- A `needs_human_review` verdict stops the workflow immediately.
- `maxFixAttempts = 0` means no fix attempts; a failed review stops as `needs_human_review`.
- Deterministic checks remain a hard gate. The active milestone cannot end as `passed` unless the latest check run passed.
- Check failures after a fix attempt are persisted and included in the next review context, but a passing review verdict with failed latest checks must not mark the milestone passed.
- Empty post-fix diffs are not automatically fatal if the fix runner reports it made no change; the next review/check result decides the outcome. This avoids hiding cases where the original diff already satisfies the review after a retry.
- Real implementation and fix runners remain fake-only for this milestone.

## Artifacts

For active milestone `<id>`, write:

- `reviews/20-milestone-<id>-review.json`
- `fixes/21-milestone-<id>-fix-attempt-<n>.md`
- `diffs/22-milestone-<id>-diff-after-fix-<n>.diff`
- `checks/23-milestone-<id>-checks-after-fix-<n>.txt`
- `reviews/24-milestone-<id>-review-after-fix-<n>.json`
- `milestones/25-milestone-<id>-review-summary.md`

State should record relative artifact paths under:

- `artifacts.reviews["<id>"]` for the latest review verdict;
- `artifacts.fixes["<id>-<n>"]` for each fix attempt report;
- `artifacts.diffs["<id>-fix-<n>"]` for each post-fix diff;
- `artifacts.checks["<id>-fix-<n>"]` for each post-fix check report;
- `artifacts.summaries["<id>-review"]` for the final review summary.

`fixAttempts["<id>"]` should track completed fix attempts for the active milestone.

Do not overload `recordMilestoneArtifact` with numeric milestone ids for fix-attempt artifacts. Milestone 5 should either:

- extend `MilestoneArtifactStateKey` to include `reviews` and `fixes`, and add a `recordArtifactByKey(state, key, artifactKey, artifactPath, now)` helper for string artifact keys; or
- replace `recordMilestoneArtifact` with a generic helper that still preserves the current numeric milestone behavior.

The implementation should use stable string keys:

- base review: `"<id>"`;
- fix attempt report: `"<id>-fix-<n>"`;
- post-fix diff: `"<id>-fix-<n>"`;
- post-fix checks: `"<id>-fix-<n>"`;
- post-fix review: `"<id>-fix-<n>"`;
- final review summary: `"<id>-review"`.

## Proposed Module Layout

```text
src/
  review/
    review-types.ts
    review-verdict-validator.ts
    review-workflow.ts
  artifacts/
    review-artifacts.ts
  prompts/
    review-milestone.md
    fix-review-findings.md
```

Tests:

```text
tests/unit/
  review-artifacts.test.ts
  review-verdict-validator.test.ts
  review-workflow.test.ts
```

## Review Verdict Model

Use `schemas/review-verdict.schema.json` as the external contract and mirror it in TypeScript:

```ts
export type ReviewVerdict = "pass" | "fail" | "needs_human_review";

export interface ReviewFinding {
  severity: "high" | "medium" | "low";
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
```

Validation rules:

- reject invalid JSON;
- reject unknown top-level fields;
- require a non-empty `summary`;
- require `reviewedArtifacts` to include at least one artifact;
- require every finding to include severity, file, issue, suggestedFix, and blocking;
- reject `pass` if any finding has `blocking = true`;
- treat schema-valid `fail` with no blocking findings as `needs_human_review` at workflow level.

## Runner Contract Changes

Add runner phases:

- `review_milestone`
- `fix_review_findings`

The fake runner should support deterministic scenarios for tests:

- passing review;
- failing review with one blocking finding;
- passing review after a fix attempt;
- needs-human-review verdict;
- malformed review JSON;
- fix runner failure.

For workflow tests, prefer local scripted runners over expanding production-only fake runner knobs. A scripted review/fix runner can return a queue of deterministic `AgentRunResult` objects by phase. The production `FakeRunner` only needs the happy path required by the CLI fake end-to-end test.

The real `codex-exec` runner can remain unsupported for review/fix execution until a later milestone.

## Workflow Design

Create `runReviewWorkflow(options)` with inputs:

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

1. Require `initialState.currentPhase === "ready_for_review"`.
2. Require `initialState.currentMilestoneId !== null`.
3. Require `milestoneStatuses["<id>"] === "ready_for_review"`.
4. Load `milestones/05-milestones.json`.
5. Load required artifacts for the active milestone:
   - final major plan;
   - milestone plan;
   - implementation report;
   - latest diff;
   - latest checks output.
6. Set global phase to `reviewing` and milestone status to `reviewing`.
7. Render `review-milestone.md`.
8. Run runner phase `review_milestone`.
9. Validate and normalize the review verdict.
10. Write `20-milestone-<id>-review.json`.
11. If verdict is `pass`, write final review summary and end with:
    - `currentPhase = "passed"`;
    - `milestoneStatuses["<id>"] = "passed"`;
    - `lastError = null`.
12. If verdict is `needs_human_review`, write final review summary and end with:
    - `currentPhase = "needs_human_review"`;
    - `milestoneStatuses["<id>"] = "needs_human_review"`;
    - `lastError` explaining why human review is needed.
13. If verdict is malformed or schema-invalid, persist the raw response as a diagnostic review artifact if possible, then stop as `needs_human_review`.
14. If verdict is `fail` with blocking findings and `maxFixAttempts = 0`, stop as `needs_human_review`.
15. If verdict is `fail` with blocking findings and attempts remain:
    - set phase and milestone status to `fixing`;
    - render `fix-review-findings.md` with only the blocking findings plus the active milestone context;
    - run runner phase `fix_review_findings`;
    - write `21-milestone-<id>-fix-attempt-<n>.md`;
    - increment `fixAttempts["<id>"]` only after the fix attempt report artifact is successfully written;
    - capture a fresh cumulative diff from `HEAD` excluding the run directory;
    - write `22-milestone-<id>-diff-after-fix-<n>.diff`;
    - set phase and milestone status to `checking`;
    - run configured checks;
    - write `23-milestone-<id>-checks-after-fix-<n>.txt`;
    - set phase and milestone status back to `reviewing`;
    - render and run another `review_milestone` pass using the latest diff and latest checks output;
    - write `24-milestone-<id>-review-after-fix-<n>.json`;
    - repeat until pass, human-review, malformed review, fix runner failure, or max attempts.
16. If max fix attempts are exhausted with blocking findings remaining, end with:
    - `currentPhase = "needs_human_review"`;
    - `milestoneStatuses["<id>"] = "needs_human_review"`;
    - `lastError` containing the final blocking findings and attempt count.

Any runner failure, prompt rendering failure, artifact write failure, diff capture failure, check runner failure, or required artifact read failure should persist state with:

- `status = "failed"` for infrastructure/runtime failures;
- `currentPhase` set to the phase that failed;
- `milestoneStatuses["<id>"] = "failed"` for runtime failures that prevent review completion;
- `lastError` containing a concise message and structured details where available.

Review verdicts that ask for human judgment are not infrastructure failures; they should end in `needs_human_review`, not `failed`.

## Check Gate Rules

Track the latest check result in workflow memory:

- before any fix attempt, the latest check result is the Milestone 4 check artifact;
- after each fix attempt, the latest check result is the post-fix check artifact.

Passing requires both:

- a validated review verdict with `verdict = "pass"` and no blocking findings;
- the latest check result passed.

If the review verdict passes but the latest checks failed:

- if fix attempts remain, continue through another fix attempt using a synthetic blocking finding that points to failed checks;
- if no attempts remain, end as `needs_human_review` with `lastError` explaining that review passed but deterministic checks failed.

Failed checks alone should not be marked as an infrastructure failure unless the check runner itself cannot execute or persist output.

## Diff Semantics

All diff artifacts captured in Milestone 5 are cumulative diffs from `HEAD` to the current working tree, excluding the orchestrator run directory.

This matches the Milestone 4 `captureGitDiff` behavior and avoids adding temporary baseline snapshot logic. The post-fix diff filenames indicate when the diff was captured, not that they contain only that attempt's delta.

## Prompt Requirements

Replace the Milestone 5 placeholder prompts.

`review-milestone.md` should require:

- review only the active milestone;
- compare the diff against the original goal, final major plan, active milestone metadata, and milestone plan;
- consider deterministic check output;
- produce only JSON matching `schemas/review-verdict.schema.json`;
- mark findings as blocking only when they prevent accepting the active milestone;
- use `needs_human_review` for ambiguity, missing context, unsafe behavior, or unverifiable claims.

`fix-review-findings.md` should require:

- fix only blocking findings from the latest review;
- do not work on later milestones;
- do not rewrite unrelated code;
- do not commit changes;
- do not use destructive Git operations;
- return a concise Markdown fix report listing changed areas and unresolved findings.

## CLI Behavior

Update `src/cli/main.ts` so:

- `--planning-only --runner fake` still stops after planning;
- `--runner fake` without `--planning-only` runs planning, one implementation pass, then the Milestone 5 review gate;
- non-fake runners are still rejected for implementation/review execution with a clear message;
- the final CLI summary prints final phase, current milestone, review artifact, fix attempt count, latest checks artifact, latest diff artifact, and final review summary when present.

Do not add broad resume support. The review workflow should be independently callable in tests with an already-ready state, but the CLI can still create a fresh run and execute planning plus one implementation plus one review gate.

## Test Plan

Unit and integration-style tests should cover:

- review artifact paths for arbitrary milestone ids and fix attempt numbers;
- review verdict validator accepts valid pass, fail, and needs-human-review documents;
- review verdict validator rejects malformed JSON, unknown fields, missing required fields, invalid severities, and pass-with-blocking-findings;
- review workflow rejects states that are not `ready_for_review`;
- review workflow rejects missing required implementation artifacts;
- pass review ends with `currentPhase = "passed"` and milestone status `passed`;
- pass review with failed latest checks does not end as passed;
- needs-human-review verdict ends with `currentPhase = "needs_human_review"`;
- malformed review JSON ends with `needs_human_review` and records useful diagnostics;
- failed review with `maxFixAttempts = 0` ends with `needs_human_review`;
- failed review with one successful fix attempt re-runs checks, re-reviews, and ends passed;
- `fixAttempts["<id>"]` increments only after a fix report artifact is written;
- fix runner failure persists failed state;
- check failure after a fix attempt is persisted and included in the next review context;
- max-attempt exhaustion ends with `needs_human_review`;
- later milestone statuses remain unchanged;
- CLI fake end-to-end path reaches `passed` for the happy path.

Minimum verification commands:

```bash
npm run typecheck
npm run build
npm run test:build
```

## Acceptance Criteria

- The orchestrator can review the active milestone after Milestone 4.
- Review verdicts are parsed and validated before state transitions.
- A passing review marks the active milestone as `passed`.
- A milestone is marked `passed` only when the latest deterministic checks also passed.
- Human-review verdicts and ambiguous/malformed review outputs stop as `needs_human_review`.
- Failed reviews trigger scoped fix attempts only when attempts remain.
- Fix attempts are capped by `config.maxFixAttempts`.
- Checks are re-run after fixes and persisted.
- Post-fix cumulative diffs are captured without including orchestrator artifacts.
- Final state is one of `passed`, `failed`, or `needs_human_review`.
- Tests cover pass, fail, retry, malformed review JSON, and max-attempt outcomes.

## Handoff To Milestone 6

Milestone 6 should expand the test harness and fake-runner scenario coverage after the review/fix gate works.

Milestone 7 should be responsible for advancing from a passed active milestone to the next pending milestone and adding general resume behavior.
