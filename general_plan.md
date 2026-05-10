# General Plan: Agent Milestone Orchestration Prototype

## Goal

Build a small, modular prototype that automates the manual agent-assisted development loop, with Codex Exec as the first real runner adapter:

```text
goal -> major plan -> plan review -> patched plan -> milestone plan -> implementation -> verification -> diff review -> fix loop -> milestone summary
```

The first version should prove the workflow end to end for one milestone before attempting full multi-milestone automation.

## Guiding Principles

- Keep the orchestrator in control of sequencing, retries, state, and gates.
- Keep agent calls narrow and task-specific.
- Store every important artifact on disk so runs are inspectable and resumable.
- Store machine-readable state and milestone metadata separately from human-readable Markdown.
- Prefer deterministic checks over model judgment wherever possible.
- Make the prototype useful locally before adding CI, GitHub, or cloud automation.
- Build the prototype as a local TypeScript CLI with modular runner interfaces, so fake runners and real agent runners can share the same orchestration logic.

## Milestone 1: Prototype Foundations

Establish the basic project structure and execution assumptions.

Primary outcomes:

- Create a clean directory layout for the prototype.
- Require the target project to be a Git repository for implementation runs, because diff capture and rollback safety depend on Git.
- Define the artifact directory format, such as `.agent-work/<run-id>/`.
- Define the core state model for a run.
- Define the initial config format for verification commands, runner options, and max fix attempts.
- Define the JSON schemas for state, milestones, and review verdicts.
- Add initial documentation for how the prototype is intended to work.

Key design decisions:

- Use a TypeScript CLI for the prototype. Shell scripts can be added later as thin wrappers only.
- Store agent prompt templates as separate files so they can be reviewed and tested independently.
- Make the tool run against the current working directory by default, with a later option to pass an explicit target repository path.

Acceptance criteria:

- The repo has a clear prototype structure.
- There is a documented run directory layout.
- There is a documented state shape for a goal and milestone run.
- There are documented schemas for milestone metadata and review verdicts.
- There is a documented minimal config file for checks and execution options.
- The prototype has a clear Git safety story.

## Milestone 2: Core Orchestrator Skeleton

Build the first executable controller without asking it to solve the full workflow yet.

Primary outcomes:

- Accept a user goal from the command line.
- Create a unique run directory.
- Write initial artifacts such as `goal.txt` and `state.json`.
- Load and validate the prototype config.
- Validate required tools such as `git` and the selected real runner command, initially `codex`.
- Refuse implementation runs in non-Git directories or dirty working trees unless explicitly overridden.
- Provide a small module for running shell commands.
- Provide an `AgentRunner` interface for invoking agent adapters non-interactively.
- Provide a fake runner implementation for deterministic tests.
- Add basic logging so each phase is visible.

Acceptance criteria:

- Running one command creates a complete run folder.
- The state file can be read and updated.
- Config validation succeeds or fails with clear messages.
- Git preflight checks run before any implementation-capable phase.
- Command failures are captured clearly.
- Unit tests cover artifact paths, state updates, config loading, and fake runner behavior.
- No coding work is performed yet beyond setup and planning calls.

## Milestone 3: Planning And Plan Review Loop

Automate the first planning part of the workflow.

Primary outcomes:

- Generate a major milestone plan from the goal.
- Review the major plan in a separate agent call.
- Produce a patched/final plan artifact.
- Produce machine-readable milestone metadata in a structured JSON format.

Artifacts:

- `00-goal.txt`
- `01-major-plan.md`
- `02-major-plan-review.md`
- `03-final-major-plan.md`
- `04-final-major-plan.json`
- `05-milestones.json`
- `state.json`

Acceptance criteria:

- A run produces a readable major plan.
- A separate review pass can identify plan gaps.
- The final plan is saved and becomes the source of truth for later milestones.
- The orchestrator can identify milestone 1 from `milestones.json` without parsing Markdown.
- Unit tests cover milestone schema validation and invalid milestone metadata.

## Milestone 4: One-Milestone Implementation Loop

Automate exactly one milestone end to end.

Primary outcomes:

- Generate a milestone-specific implementation plan.
- Ask the selected agent runner to implement only milestone 1.
- Capture the resulting diff.
- Run configured deterministic checks.
- Save a milestone summary.

Artifacts:

- `10-milestone-1-plan.md`
- `11-milestone-1-implementation.md`
- `12-milestone-1.diff`
- `13-milestone-1-checks.txt`
- `14-milestone-1-summary.md`

Acceptance criteria:

- The orchestrator can complete milestone 1 without starting milestone 2.
- The diff is captured reliably.
- Verification commands are run or explicitly reported as unavailable.
- The summary explains what changed and what remains.
- Integration-style tests cover a fake milestone implementation against a tiny fixture repository.

## Milestone 5: Review And Fix Gate

Add the quality gate that decides whether milestone 1 is accepted or needs fixes.

Primary outcomes:

- Review the milestone diff with the original goal, final major plan, milestone plan, checks output, and diff.
- Require structured review output, preferably using a JSON schema.
- If review fails, run a scoped fix pass.
- Re-run checks and re-review.
- Stop after a configured maximum number of fix attempts.

Artifacts:

- `20-milestone-1-review.json`
- `21-milestone-1-fix-attempt-<n>.md`
- `22-milestone-1-checks-after-fix-<n>.txt`
- `23-milestone-1-review-after-fix-<n>.json`

Acceptance criteria:

- The orchestrator, not the agent, decides pass/fail based on explicit review output.
- Failed reviews trigger scoped fixes.
- Retry count is capped.
- Final state is one of `passed`, `failed`, or `needs-human-review`.
- Unit tests cover pass, fail, retry, malformed review JSON, and max-attempt outcomes.

## Milestone 6: Test Harness

Expand the test suite beyond the foundational tests added in earlier milestones.

Primary outcomes:

- Add broader unit tests for edge cases in state handling, artifact paths, retry logic, and review verdict parsing.
- Expand fake runner scenarios for successful plans, failed reviews, malformed output, and command failures.
- Add integration-style tests against tiny sample repositories or fixtures.
- Add a smoke test for the real runner path, initially `codex exec`, guarded so it can be skipped when the selected runner is unavailable.

Acceptance criteria:

- Core orchestration logic remains testable without network or model calls.
- Tests cover pass, fail, retry, and max-attempt outcomes.
- A smoke command proves the real path is wired correctly.
- The README explains how to run tests.

## Milestone 7: Multi-Milestone State Machine

Extend the working one-milestone loop into a full goal runner.

Primary outcomes:

- Iterate through milestones from the final major plan.
- Track per-milestone status.
- Resume from an interrupted run.
- Stop cleanly on failed checks, failed review, or human-review-needed state.
- Produce a final goal summary.

Acceptance criteria:

- The runner can complete multiple milestones in order.
- It never advances while a milestone has unresolved blocking findings.
- A stopped run can be resumed from `state.json`.
- Multi-milestone behavior is tested with the fake runner before using real agent calls.
- The final summary includes changed files, checks, accepted milestones, failed milestones, and residual risks.

## Milestone 8: Hardening And Developer Experience

Make the prototype pleasant and safe enough for real local use.

Primary outcomes:

- Add `--dry-run`, `--resume`, `--max-fix-attempts`, and `--milestone` options.
- Improve logging and terminal output.
- Improve validation messages for required tools such as `git`, the selected runner command, and test commands.
- Add controlled override flags for dirty working trees and non-Git planning-only runs.

Acceptance criteria:

- Common failure modes produce clear messages.
- The user can run, resume, or inspect a workflow without reading internal code.
- The tool refuses unsafe situations unless explicitly overridden.
- Documentation includes examples and recommended workflows.

## Milestone 9: Optional CI And Provider Integrations

Only after the local prototype works, add repository automation around pull requests and provider-specific integrations.

Primary outcomes:

- Create a GitHub Action for agent review on PRs, initially using Codex GitHub Action or `codex exec`.
- Store prompts under a dedicated CI prompt directory.
- Limit workflow permissions and trusted triggers.
- Optionally add a CI-failure autofix workflow.

Acceptance criteria:

- PR review automation runs with narrow permissions.
- Findings are posted as comments or artifacts.
- The CI workflow does not run unsafe prompts from untrusted contributors.
- Local orchestration remains usable without GitHub integration.

## Recommended First Build Shape

Start with a local TypeScript CLI:

```text
package.json
tsconfig.json
scripts/
  ai-run-goal.ts
src/
  cli/
  config/
  git/
  prompts/
  state/
  schemas/
  artifacts/
  checks/
  review/
  runners/
    codex-exec/
    fake/
tests/
  fixtures/
  unit/
  smoke/
.agent-work/
orchestrator.config.json
```

Use shell only for optional convenience wrappers. The orchestration logic should live in TypeScript modules from the start so it can be tested with fake runners.

## First Prototype Scope

The first prototype should stop at one milestone:

```text
goal
-> major plan
-> plan review
-> final major plan
-> milestone 1 plan
-> implement milestone 1
-> run checks
-> review diff
-> fix if needed
-> summarize
-> stop
```

Do not automate all milestones until this loop is reliable, testable, and inspectable.
