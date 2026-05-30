# Fully Autonomous Runs

## Purpose

Milestone Runner currently has a deliberate human-in-the-loop terminal state:
`needs_human_review`. That is useful for supervised local development, but it
does not fit unattended operator scripts that need the process to either finish
or fail without requiring a person to inspect state before the run can end.

This document describes the goals for fully autonomous behavior and a
recommended implementation approach.

## Goals

- Add a supported mode for unattended runs where the CLI never stops in a
  human-review state.
- Preserve the current supervised behavior as the default.
- Keep review, check, fix, and summary artifacts auditable in every mode.
- Let automation distinguish success from unresolved uncertainty with process
  exit codes.
- Continue to auto-fix actionable review findings up to `maxFixAttempts`.
- Avoid silently treating uncertain or unsafe states as passed work.
- Keep the orchestration state machine explicit and testable.

## Non-Goals

- Do not remove review gates from the default workflow.
- Do not make `needs_human_review` mean `passed`.
- Do not bypass deterministic checks.
- Do not add a mode that skips model review entirely in the first autonomous
  pass. Skipping review is a separate policy decision from making unresolved
  review outcomes fail non-interactively.
- Do not let an implementation continue after malformed review output, unsafe
  resume state, exhausted fixes, or failed checks unless an explicit future
  policy is designed for that risk.

## Current Behavior

The workflow can reach `needs_human_review` from review decisions when:

- the review verdict explicitly asks for human review;
- review output is malformed or cannot be validated;
- review fails without blocking findings that can be auto-fixed;
- `maxFixAttempts` is `0`;
- fix attempts are exhausted;
- checks fail after a review pass.

The workflow can also reach `needs_human_review` from resume safety when:

- resume safety cannot prove that a transient state is safe to continue.

Today these are represented as a successful orchestrator stop with status
`needs_human_review`. That is intentional for local supervised operation, but
it is ambiguous for scripts that expect a clean success/failure contract.

## Recommended Approach

Add a config option that changes the terminal handling of human-review states,
without changing review quality or default safety:

```json
{
  "humanReviewPolicy": "stop"
}
```

Supported values:

- `stop`: current behavior. Human-review situations stop the workflow with
  status `needs_human_review` and a report explaining what to inspect.
- `fail`: autonomous behavior. Human-review situations are converted into a
  failed workflow with a non-zero CLI exit. The artifacts and diagnostics are
  still written, but automation does not need a human to decide that the run is
  unresolved.

The recommended first autonomous mode is `fail`, not `continue`. It gives
operators a fully unattended contract while avoiding false green runs.

## Why Not Continue Automatically?

Continuing after `needs_human_review` would mean accepting one of these
conditions:

- the reviewer could not produce valid machine-readable output;
- the reviewer found uncertainty it was not confident fixing;
- configured checks contradicted a pass verdict;
- fix attempts were exhausted;
- resume state was ambiguous.

Those conditions should not become successful milestone progression by
default. If a future use case requires risky continuation, it should be a
separate policy with clear naming, loud reporting, and likely a narrower scope
than all human-review cases.

## Proposed Semantics

With `humanReviewPolicy: "stop"`:

- review verdict `pass` with passing checks marks the milestone `passed`;
- review verdict `fail` with blocking findings enters the existing fix loop;
- unresolved review conditions mark the milestone and run
  `needs_human_review`;
- CLI exits according to the existing behavior.

With `humanReviewPolicy: "fail"`:

- review verdict `pass` with passing checks marks the milestone `passed`;
- review verdict `fail` with blocking findings enters the existing fix loop;
- unresolved review conditions write the same review and summary artifacts,
  then mark the milestone and run `failed`;
- the goal workflow returns an unsuccessful result and the CLI exits non-zero;
- the final report should identify the original unresolved condition and
  reference the review/check artifacts.

## Implementation Plan

1. Extend config types, schema, loader validation, and defaults with
   `humanReviewPolicy: "stop" | "fail"`.
2. Add the policy to config snapshots and run reports so resume behavior is
   auditable.
3. Introduce a small helper in the orchestration or review layer, for example
   `terminalHumanReviewState(...)`, that maps human-review terminal decisions
   to either `needs_human_review` or `failed` based on policy.
4. Replace direct terminal human-review state transitions in review and resume
   normalization paths with that helper.
5. Ensure `humanReviewPolicy: "fail"` also changes the workflow result path:
   the final `GoalWorkflowResult` must be unsuccessful so the CLI exits
   non-zero. Updating state alone is not sufficient.
6. Preserve all existing artifact writes before applying the policy mapping.
7. Add CLI/report wording that distinguishes:
   - `needs_human_review`: supervised stop;
   - `failed`: autonomous unresolved condition.
8. Add focused tests for both policies across:
   - explicit `needs_human_review` review verdict;
   - malformed review JSON;
   - exhausted fix attempts;
   - failed checks after a pass verdict;
   - unsafe resume normalization.

## Script Usage

An unattended operator script should use a config like:

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
  "humanReviewPolicy": "fail"
}
```

The script can then rely on:

- exit code `0`: requested workflow completed;
- non-zero exit: checks, runner execution, orchestration validation, or an
  autonomous human-review-equivalent condition failed.

## Acceptance Criteria

- Existing tests pass without config changes.
- Existing configs remain valid and default to `humanReviewPolicy: "stop"`.
- A new unresolved condition encountered under `humanReviewPolicy: "fail"`
  cannot finish with status `needs_human_review`.
- Resuming a legacy run that is already terminal `needs_human_review` has
  explicit documented behavior, either preserving the saved terminal state or
  normalizing it to failed according to the saved policy snapshot.
- Human-review-equivalent failures still write the same diagnostic artifacts as
  supervised mode.
- The CLI report and dry-run report show the effective `humanReviewPolicy`.
- Resume uses the saved policy snapshot unless an explicit resume override is
  added and documented.
