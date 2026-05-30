# Fully Autonomous Runs

## Purpose

Milestone Runner currently has a deliberate human-in-the-loop terminal state:
`needs_human_review`. That is useful for supervised local development, but it
does not fit runs where the next actor must always be the runner itself.

This document describes the implemented fully autonomous policy: the runner
repairs malformed intermediate output, resolves ambiguity with documented
assumptions, continues through normal checks/review/fix gates when safe, and
fails only after bounded autonomous attempts cannot produce a valid next action.

## Goals

- Add a supported mode where newly encountered review or resume ambiguity does
  not require human action.
- Preserve the current supervised behavior as the default.
- Keep review, check, fix, repair, resolution, and summary artifacts auditable.
- Let automation distinguish completed work from exhausted autonomous attempts
  with process exit codes.
- Continue to auto-fix actionable review findings up to `maxFixAttempts`.
- Repair malformed review output before failing.
- Resolve ambiguous review verdicts by choosing documented assumptions or
  actionable findings.
- Keep deterministic checks as hard gates.
- Keep the orchestration state machine explicit and testable.

## Non-Goals

- Do not remove review gates from the default workflow.
- Do not make `needs_human_review` mean `passed`.
- Do not bypass deterministic checks.
- Do not silently ignore failed checks, malformed output, unsafe resume state,
  or exhausted repair/resolution attempts.
- Do not add review-skipping in the first autonomous pass. Skipping review is a
  separate policy from resolving review ambiguity.

## Default Supervised Behavior

With the default `humanReviewPolicy: "stop"`, the workflow can reach
`needs_human_review` from review decisions when:

- the review verdict explicitly asks for human review;
- review output is malformed or cannot be validated;
- review fails without blocking findings that can be auto-fixed;
- `maxFixAttempts` is `0`;
- fix attempts are exhausted;
- checks fail after a review pass.

The workflow can also reach `needs_human_review` from resume safety when:

- resume safety cannot prove that a transient state is safe to continue.

These are represented as a successful orchestrator stop with status
`needs_human_review` only in supervised `stop` mode. That remains intentional
for local supervised operation, but it is not the fully autonomous contract.

## Policy

Use one config option:

```json
{
  "humanReviewPolicy": "stop"
}
```

Supported values:

- `stop`: supervised default. Human-review-equivalent situations stop the
  workflow with status `needs_human_review`.
- `fail`: fail-fast unattended mode. Human-review-equivalent situations become
  failed workflow results with non-zero CLI exits. This is useful for CI, but
  it does not repair malformed output or resolve ambiguity.
- `autonomous`: fully autonomous mode. Human-review-equivalent situations first
  route through bounded repair or resolution. The runner records assumptions
  and resolution artifacts, then continues when the result validates. If repair
  or resolution is exhausted, the workflow fails with diagnostics.

## Autonomous Semantics

With `humanReviewPolicy: "autonomous"`:

- malformed review output is preserved, then repaired through a JSON-only
  repair phase before the workflow gives up;
- explicit `needs_human_review` review verdicts route through an autonomous
  ambiguity-resolution phase;
- non-actionable review failures are converted into actionable findings when
  the resolver can justify them;
- review `pass` with failed checks cannot pass the milestone until checks pass;
- `maxFixAttempts` remains a real budget for code-changing fixes;
- malformed review repair, review ambiguity resolution, and resume-state
  resolution are each bounded to two autonomous attempts;
- ambiguous transient resume states route through a resume-state resolver that
  can continue, normalize to a safe state, or fail with diagnostics;
- exhausted autonomous repair/resolution fails with artifacts and a non-zero
  exit instead of asking for human review;
- already-terminal legacy `needs_human_review` resumes preserve the saved
  terminal state unless a future explicit migration policy is added.

The point is not to guarantee success. The point is that the runner, not a
human, is responsible for attempting the next safe action.

Autonomous artifacts are written in the same run directory as the ordinary
workflow artifacts:

- `reviews/*review-repair-<n>.json`: malformed review repair diagnostics.
- `reviews/*autonomous-resolution-<n>.json`: review ambiguity resolution
  diagnostics, including assumptions and rationale.
- `logs/resolve-resume-state-<n>.json`: resume-state resolution diagnostics.
- `milestones/25-milestone-<id>-review-summary.md`: review summary with
  autonomous assumptions when they affected the decision.
- `milestones/90-goal-summary.md`: goal summary with autonomous decisions and
  residual risks.

## Script Usage

An autonomous operator script should use a config like:

```json
{
  "checks": ["npm test"],
  "runner": {
    "type": "codex-exec",
    "command": "codex",
    "options": {
      "sandboxForPlanning": "danger-full-access",
      "sandboxForImplementation": "danger-full-access",
      "approvalPolicy": "never"
    }
  },
  "maxFixAttempts": 3,
  "artifactRoot": ".agent-work",
  "milestonePlanPolicy": "always",
  "milestonePlanReviewPolicy": "scrupulous",
  "humanReviewPolicy": "autonomous"
}
```

The script can then rely on:

- exit code `0`: requested workflow completed;
- non-zero exit: checks, runner execution, orchestration validation, or bounded
  autonomous repair/resolution failed.

Choose `humanReviewPolicy` before creating the run. It is saved in the run
state and used for resume; there is no resume-time CLI override that converts a
supervised run into an autonomous one.

## Implementation Plan

The implementation-ready plan lives in
[`fully-autonomous-runs_plan.md`](../fully-autonomous-runs_plan.md). The main
phases are:

1. Extend config/schema/reporting to include `autonomous`.
2. Update the human-review policy helper to route `autonomous` to resolution.
3. Add review output repair for malformed review JSON.
4. Add autonomous review ambiguity resolution with structured assumptions.
5. Apply policy-specific review workflow result semantics.
6. Add bounded autonomous resume safety resolution.
7. Update dashboards, summaries, and reports.
8. Update documentation and operator examples.
9. Run end-to-end verification.

## Acceptance Criteria

- Existing configs remain valid and default to `humanReviewPolicy: "stop"`.
- `humanReviewPolicy: "stop"` preserves existing supervised behavior.
- `humanReviewPolicy: "fail"` fails immediately for newly encountered
  human-review-equivalent conditions.
- `humanReviewPolicy: "autonomous"` does not newly end review or resume
  ambiguity as `needs_human_review`.
- Autonomous mode repairs malformed review output before failing.
- Autonomous mode resolves explicit `needs_human_review` review verdicts by
  choosing documented assumptions or actionable findings.
- Autonomous mode can pass a milestone after valid repair/resolution and
  passing checks.
- Deterministic checks are never ignored.
- Human-review-equivalent failures still write diagnostic artifacts.
- The CLI report and dry-run report show the effective `humanReviewPolicy`.
- Resume uses the saved policy snapshot; there is no resume-time CLI override.
