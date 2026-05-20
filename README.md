# Agent Milestone Orchestrator

Agent Milestone Orchestrator is a local TypeScript CLI prototype for automating a structured agent-assisted development loop.

The first real runner adapter uses Codex Exec, but the orchestration core is intended to stay runner-agnostic. Codex, fake test runners, and future agent providers should all plug into the same workflow through a shared runner interface.

## Problem

Manual agent-assisted coding often repeats the same coordination loop:

```text
goal -> major plan -> plan review -> patched plan -> milestone plan -> implementation -> verification -> diff review -> fix loop -> milestone summary
```

This project turns that repeated meta-work into explicit local infrastructure. The orchestrator owns state, artifacts, retries, verification gates, and milestone progression. The selected agent runner handles narrow tasks inside that larger workflow.

## Orchestration Contract

The orchestrator, not the agent, controls:

- Which phase runs next.
- Where artifacts are written.
- Which milestone is active.
- Whether deterministic checks passed.
- Whether a review verdict blocks progress.
- How many fix attempts are allowed.
- When a run stops for human review.

Agent runners are expected to do scoped work only:

- Generate a plan.
- Review a plan.
- Implement one milestone.
- Review a diff.
- Fix specific findings.

They should not decide when the whole workflow is complete.

## Current Prototype Scope

The current prototype is a deterministic multi-milestone local workflow:

```text
goal
-> major plan
-> plan review
-> final major plan
-> milestone 1 plan
-> optional milestone 1 plan review
-> optional final milestone 1 plan
-> implement milestone 1
-> run checks
-> review diff
-> fix if needed
-> summarize
-> advance to the next runnable milestone
-> repeat milestone work until complete or blocked
-> final goal summary
```

The fake runner path can complete all generated fake milestones offline. The `codex-exec` runner path can now execute real planning, implementation, review, and fix phases through `codex exec` when the Codex CLI is installed and authenticated.

Goal-level planning is always produced. The major plan, plan review, final major plan, and milestone metadata remain the source of truth for the workflow. `milestonePlanPolicy` only controls how the initial per-milestone implementation plan is created immediately before a milestone is implemented. `milestonePlanReviewPolicy` controls whether that per-milestone plan is reviewed and corrected before implementation. In `scrupulous` mode, the corrected final milestone plan is the plan handed to the implementation agent.

## Git Safety

Implementation-capable runs require a Git repository because the tool depends on Git for diff capture and safety checks.

The intended safety model is strict by default:

- Planning-only phases can run outside Git only with `--allow-non-git-planning`.
- Implementation, diff capture, and fix loops require Git.
- Implementation-capable phases require a clean working tree by default.
- The orchestrator records the starting commit SHA when available.
- Diff capture uses `git diff`.
- Overrides for dirty trees or non-Git planning must be explicit and visible in output and run state where applicable.

Implementation-capable phases must run these preflight checks before an agent can edit files:

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
git status --porcelain
```

Expected behavior:

- If `git rev-parse --show-toplevel` fails, the run may continue only in planning-only mode with `--allow-non-git-planning`.
- If `git status --porcelain` returns any tracked or untracked changes, implementation must stop unless `--allow-dirty` is set.
- If `--allow-dirty` is set, the run state records that override and the dirty status observed at startup.
- If `git rev-parse HEAD` fails because the repository has no commits, implementation must stop until an initial commit exists.
- Diffs for review and summaries must be captured from Git, not inferred from agent output.

The `state.json` schema includes Git safety fields equivalent to:

```json
{
  "git": {
    "required": true,
    "planningOnly": false,
    "root": "/absolute/path/to/repo",
    "startSha": "commit-sha",
    "dirtyAtStart": false,
    "dirtyOverride": false,
    "statusPorcelain": ""
  }
}
```

These fields make safety decisions auditable after the run completes or stops.

## Artifacts

Run output belongs under `.agent-work/<run-id>/` by default. The artifact root
is always resolved relative to the selected target repository, and absolute or
escaping artifact roots are rejected so generated run files stay inside that
target.

The run id should be unique and stable for the life of a workflow. A timestamp-based id is acceptable for the prototype.

Initial run layout:

```text
.agent-work/<run-id>/
  00-goal.txt
  state.json
  inputs/
    01-inputs.json
    context/
      01-<source-basename>
  logs/
    run.log
    timeline.jsonl
    80-timings.json
    81-timings.md
  plans/
    01-major-plan.md
    02-major-plan-review.md
    03-final-major-plan.md
    04-final-major-plan.json
  milestones/
    05-milestones.json
    10-milestone-<id>-plan.md
    11-milestone-<id>-implementation.md
    14-milestone-<id>-summary.md
    25-milestone-<id>-review-summary.md
    90-goal-summary.md
  reviews/
    20-milestone-<id>-review.json
    24-milestone-<id>-review-after-fix-<n>.json
  checks/
    13-milestone-<id>-checks.txt
    23-milestone-<id>-checks-after-fix-<n>.txt
  diffs/
    12-milestone-<id>.diff
    22-milestone-<id>-diff-after-fix-<n>.diff
  fixes/
    21-milestone-<id>-fix-attempt-<n>.md
```

`.agent-work/` is generated runtime output. It is ignored by Git and should be created by runner code only when a workflow executes.

Human-readable Markdown artifacts are for review. Machine-readable JSON artifacts are for orchestration decisions.

Timing artifacts live under `logs/`. `timeline.jsonl` is an append-only timeline of workflow state transitions and invocation boundaries. `80-timings.json` is the machine-readable timing summary, and `81-timings.md` is the human-readable summary. Runner and check durations are nested inside workflow phase duration, so they should not be added to lifecycle or active workflow duration as if they were separate runtime.

Milestone plan artifacts always use `milestones/10-milestone-<id>-plan.md` and are recorded under `state.artifacts.milestonePlans`. Depending on `milestonePlanPolicy`, that file may contain either a full runner-generated milestone plan or a deterministic lightweight plan. Plans produced by `light` and `auto` include a metadata block showing the configured policy, selected mode, and decision reason. The default `always` policy preserves the raw runner-generated artifact for backward compatibility.

Artifact filenames should keep their numeric prefixes stable so a run can be inspected in workflow order. When the same phase repeats, such as fix attempts, use `<n>` starting at `1`.

The `state.json` schema tracks artifact paths as relative paths from the run directory. The shape is equivalent to:

```json
{
  "artifacts": {
    "goal": "00-goal.txt",
    "majorPlan": "plans/01-major-plan.md",
    "majorPlanReview": "plans/02-major-plan-review.md",
    "finalMajorPlanMarkdown": "plans/03-final-major-plan.md",
    "finalMajorPlanJson": "plans/04-final-major-plan.json",
    "milestones": "milestones/05-milestones.json",
    "logs": {
      "run": "logs/run.log",
      "timingsJson": "logs/80-timings.json",
      "timingsMarkdown": "logs/81-timings.md"
    },
    "milestonePlans": {
      "1": "milestones/10-milestone-1-plan.md"
    },
    "implementations": {
      "1": "milestones/11-milestone-1-implementation.md"
    },
    "diffs": {
      "1": "diffs/12-milestone-1.diff"
    },
    "checks": {
      "1": "checks/13-milestone-1-checks.txt"
    },
    "reviews": {
      "1": "reviews/20-milestone-1-review.json"
    },
    "summaries": {
      "1": "milestones/14-milestone-1-summary.md",
      "1-review": "milestones/25-milestone-1-review-summary.md",
      "goal": "milestones/90-goal-summary.md"
    }
  }
}
```

The orchestrator should write artifact paths to state when each artifact is produced. Missing paths mean the phase has not completed.

## State

Each run writes a `state.json` file in its run directory. This file is the source of truth for resuming, auditing, and deciding whether the next phase is allowed to run.

The state schema lives in [schemas/state.schema.json](./schemas/state.schema.json).

Conceptually, state contains:

- `runId`: stable id for the workflow run.
- `goal`: original user goal.
- `currentPhase`: current orchestration phase.
- `status`: current overall status.
- `currentMilestoneId`: active milestone id, or `null` before milestone work begins.
- `artifactRoot` and `runDir`: generated artifact locations.
- `git`: safety metadata, including root, starting commit SHA, dirty-tree status, and override flags.
- `config`: resolved config path and optional config snapshot.
- `milestoneStatuses`: map of milestone id to status.
- `fixAttempts`: map of milestone id to completed fix attempts.
- `artifacts`: run-relative artifact path map.
- `lastError`: structured failure information, or `null`.
- `createdAt` and `updatedAt`: ISO 8601 timestamps.

Initial status and phase values are:

```text
initialized
planning
plan_reviewing
ready_for_milestone
ready_for_review
implementing
checking
reviewing
fixing
passed
failed
needs_human_review
```

State should reference artifact paths as strings only. The schema must not require `.agent-work/` to exist before a run creates it.

The goal workflow uses `milestoneStatuses` and `currentMilestoneId` to choose work. After one milestone passes, the selector advances to the lowest pending milestone whose dependencies passed. The run stops instead of advancing when implementation fails, checks fail, review needs human input, fix attempts are exhausted, dependencies are blocked, or persisted state is inconsistent.

Resume behavior in the core workflow is conservative. Stable states such as `ready_for_milestone`, `ready_for_review`, and `passed` with pending work can continue from `state.json`. Ambiguous transient states such as partial implementation or review work stop as `needs_human_review` unless existing artifacts prove the next safe state.

## Milestone Metadata

Markdown plans are for humans. Machine-readable milestone metadata is stored in `milestones/05-milestones.json` and is the source of truth for orchestration.

The milestone metadata schema lives in [schemas/milestones.schema.json](./schemas/milestones.schema.json).

Initial shape:

```json
{
  "milestones": [
    {
      "id": 1,
      "title": "Prototype foundations",
      "summary": "Create the project scaffold and contracts.",
      "scope": ["Create TypeScript scaffold", "Define schemas"],
      "acceptanceCriteria": ["Scaffold exists", "Schemas are valid JSON"],
      "verification": ["npm run typecheck"],
      "dependencies": [],
      "status": "pending"
    }
  ]
}
```

Milestone fields:

- `id`: stable positive integer used by state and artifact maps.
- `title`: short human-readable milestone name.
- `summary`: concise purpose of the milestone.
- `scope`: list of included work items.
- `acceptanceCriteria`: list of conditions required to accept the milestone.
- `verification`: list of expected check commands or manual verification notes.
- `dependencies`: milestone ids that must complete first.
- `status`: orchestration status for the milestone.

Milestone metadata needs semantic validation in addition to JSON Schema validation:

- `id` values must be unique.
- `dependencies` must reference existing milestone ids.
- A milestone cannot depend on itself.
- Dependencies should point to earlier milestones unless a future planner explicitly supports a dependency graph.

Milestone status values are:

```text
pending
planned
ready_for_review
implementing
checking
reviewing
fixing
passed
failed
needs_human_review
```

## Review Verdicts

Review artifacts are machine-readable JSON files. The orchestrator must decide whether to proceed from the JSON verdict, not from free-form prose.

The review verdict schema lives in [schemas/review-verdict.schema.json](./schemas/review-verdict.schema.json).

Initial shape:

```json
{
  "verdict": "fail",
  "summary": "The milestone implementation is close, but one blocking issue remains.",
  "findings": [
    {
      "severity": "high",
      "file": "src/example.ts",
      "issue": "The implementation does not handle the empty input case.",
      "suggestedFix": "Add an explicit empty-input branch and a focused test.",
      "blocking": true
    }
  ],
  "reviewedArtifacts": [
    "milestones/10-milestone-1-plan.md",
    "diffs/12-milestone-1.diff",
    "checks/13-milestone-1-checks.txt"
  ]
}
```

Verdict behavior:

- `pass`: the milestone may be accepted if deterministic checks also passed or were explicitly unavailable.
- `fail`: the orchestrator should run a scoped fix attempt when fix attempts remain.
- `needs_human_review`: the orchestrator must stop and report the review summary.

Finding fields:

- `severity`: `high`, `medium`, or `low`.
- `file`: repository-relative file path, or `null` for cross-cutting findings.
- `issue`: concrete problem.
- `suggestedFix`: actionable fix guidance.
- `blocking`: whether the finding blocks milestone acceptance.

## Configuration

The example configuration lives in [orchestrator.config.example.json](./orchestrator.config.example.json). Local runtime configuration should use `orchestrator.config.json`, which is ignored by Git.

Configuration is loaded from the target repository, not necessarily from the
directory where the CLI was invoked. By default the loader looks for
`orchestrator.config.json` in the target repository and then falls back to
`orchestrator.config.example.json` in that same target. A relative `--config`
path is also resolved inside the target repository; an absolute `--config` path
is allowed for operators who intentionally keep a central config file. Resume
runs use the config snapshot saved in state and do not accept `--config`.

Initial config shape:

```json
{
  "checks": [],
  "runner": {
    "type": "codex-exec",
    "command": "codex",
    "options": {
      "sandboxForPlanning": "read-only",
      "sandboxForImplementation": "workspace-write",
      "approvalPolicy": "never",
      "timeoutMs": 1800000,
      "jsonEvents": false
    }
  },
  "maxFixAttempts": 2,
  "artifactRoot": ".agent-work",
  "milestonePlanPolicy": "always",
  "milestonePlanReviewPolicy": "normal"
}
```

Config fields:

- `checks`: deterministic shell commands to run during verification phases. An empty array is valid for early prototypes, but later workflow output must report that no checks were configured.
- `runner.type`: selected agent runner adapter. Initial supported values are `codex-exec` and `fake`.
- `runner.command`: executable command for real subprocess-backed runners. For `codex-exec`, this is required; the example config sets it to `codex`.
- `runner.accountLabel`: optional human label for the Codex account you intend this config to use. It is reported in dry-run, final reports, and diagnostics, but it does not authenticate or switch accounts by itself.
- `runner.options`: adapter-specific options. Codex-specific sandbox, approval, timeout, model/profile, and JSON event settings belong here rather than at the top level.
- `maxFixAttempts`: maximum number of review/fix retries before stopping.
- `artifactRoot`: root directory for generated run artifacts, relative to the target repository. Absolute paths, `..` escapes, and malformed relative paths are rejected.
- `milestonePlanPolicy`: per-milestone implementation plan policy. Missing values default to `always`.
- `milestonePlanReviewPolicy`: per-milestone implementation plan review policy. Missing values default to `normal`.

The config schema lives in [schemas/config.schema.json](./schemas/config.schema.json).

Milestone plan policies:

- `always`: default and safest behavior. Every milestone calls the runner-backed `milestone_plan` phase before implementation and writes the raw runner-generated plan.
- `auto`: conservative local selection per milestone. Simple, self-contained milestones use a lightweight plan; milestones with dependencies, broad scope, risky terms, or vague verification use a full runner-backed plan.
- `light`: always skip the runner-backed `milestone_plan` phase and write a deterministic lightweight milestone plan from milestone metadata.

The policy does not skip major planning, plan review, final plan generation, implementation, checks, review, fix attempts, summaries, or artifact writing. It only controls the plan artifact created for each individual milestone.

Milestone plan review policies:

- `normal`: default behavior. Per-milestone plans proceed directly to implementation after they are generated.
- `scrupulous`: after the initial per-milestone plan is produced by `milestonePlanPolicy`, run `milestone_plan_review`, then `final_milestone_plan`, and hand the corrected final milestone plan to implementation.

Scrupulous mode works with every milestone plan policy. With `always` or `auto` full-plan decisions, the draft comes from the runner-backed `milestone_plan` phase. With `light`, the deterministic lightweight plan becomes the draft that is reviewed and corrected.

## Runners

The core abstraction is an `AgentRunner`.

Available runner adapters:

- `FakeRunner`: deterministic test runner for unit and fixture tests.
- `CodexExecRunner`: real runner adapter implemented by shelling out to `codex exec`.

The fake runner keeps the state machine, artifact handling, and review gates testable without model calls. The `codex-exec` runner passes rendered prompts to Codex through stdin, sets the target repository with `--cd`, applies read-only or workspace-write sandboxing by phase, uses schema-constrained output for JSON phases, and persists runner diagnostics under each run directory.

## Prompt Templates

Agent prompt templates live under `src/prompts/`. They are versioned files so workflow prompts can be reviewed, tested, and changed independently from orchestration code.

Initial prompt template files:

```text
src/prompts/major-plan.md
src/prompts/major-plan-review.md
src/prompts/final-plan-json.md
src/prompts/milestone-plan.md
src/prompts/implement-milestone.md
src/prompts/review-milestone.md
src/prompts/fix-review-findings.md
```

Current templates declare required inputs, expected outputs, orchestration boundaries, and referenced schemas. Planning and review prompts keep the agent read-only by default, while implementation and fix prompts scope edits to the active milestone.

## Milestone Sequence

The project plan is tracked in [general_plan.md](./general_plan.md).

Real runner implementation detail is tracked in [real_run_plan.md](./real_run_plan.md).

High-level sequence:

1. Prototype foundations.
2. Core orchestrator skeleton.
3. Planning and plan review loop.
4. One-milestone implementation loop.
5. Review and fix gate.
6. Test harness.
7. Multi-milestone state machine.
8. Hardening and developer experience.
9. Optional CI and provider integrations.

## Development

Install dependencies:

```bash
npm install
```

Run type checking:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

Run the CLI after building:

```bash
node dist/cli/main.js --runner fake "example goal"
```

CLI usage:

```bash
node dist/cli/main.js [options] "goal"
node dist/cli/main.js --resume <run-dir-or-id> [options]
```

Common options:

- `--config <path>`: load a config file for a new run.
- `--repo <path>`: select the target repository/workspace. Defaults to the current directory.
- `--artifact-root <path>`: set the generated artifact root relative to the target repository.
- `--goal-file <path>`: read the initial goal from a file in the target repository instead of from argv.
- `--context <path>`: attach a file in the target repository as initial context. Repeat for multiple files.
- `--seed-major-plan <path>`: use a target-repository file as the draft major plan and start runner planning at plan review.
- `--runner fake|codex-exec`: override the configured runner for a new run.
- `--planning-only`: stop after planning and milestone metadata generation.
- `--dry-run`: validate and report the next action without writing workflow artifacts or calling runners.
- `--resume <run-dir-or-id>`: resume from an existing `state.json` by run directory, `state.json` path, or run id under the artifact root.
- `--milestone <id>`: run only one runnable milestone and stop before advancing to remaining pending milestones.
- `--max-fix-attempts <n>`: override fix attempts for this invocation.
- `--milestone-plan-policy always|auto|light`: override the per-milestone implementation plan policy for this invocation.
- `--milestone-plan-review-policy normal|scrupulous`: override the per-milestone implementation plan review policy for this invocation.
- `--allow-dirty`: allow implementation-capable runs or resumes from a dirty working tree.
- `--allow-non-git-planning`: allow planning-only operation outside a Git repository.

### Target Repositories

By default, the target repository is the current directory. Existing commands
still work when you run the built CLI from the repository you want the agent to
inspect or edit:

```bash
cd /path/to/target-repo
node /path/to/orchestrator/dist/cli/main.js --runner fake "example goal"
```

You can also run from the orchestrator checkout and point at a separate target:

```bash
node dist/cli/main.js --repo /path/to/target-repo --runner fake "example goal"
```

Runner work, Git preflight checks, configured checks, fake-runner output,
artifacts, and relative `--config`, `--goal-file`, `--context`,
`--seed-major-plan`, and `--artifact-root` paths all operate inside the selected
target repository.
Bundled prompts and JSON schemas still come from the orchestrator checkout or
installed package, so the target repository does not need a copy of
`src/prompts/` or `schemas/`.

Resume by run id looks under `<target-repo>/<artifactRoot>/<run-id>/state.json`.
Direct-path resume uses the saved `workspace.targetCwd` when present, and an
explicit `--repo` must match the saved target or saved Git root.

### Initial Inputs

Use `--goal-file` when the prompt is large or should be versioned in the target
repository:

```bash
node dist/cli/main.js --goal-file tasks/goal.md --runner fake
```

Use repeated `--context` flags to attach repository files that should be shown
to planning:

```bash
node dist/cli/main.js --runner fake \
  --context README.md \
  --context docs/architecture.md \
  "Update the documented architecture"
```

`--goal-file` cannot be combined with an argv goal, and `--goal-file` and
`--context` are for new runs only. Goal and context paths may be relative or
absolute, but after `realpath` they must resolve inside the target repository;
symlinks that escape the target are rejected. The goal file limit is 1 MiB,
each context file is limited to 512 KiB, and all context files together are
limited to 2 MiB. Non-dry runs write an input manifest to
`inputs/01-inputs.json`, copy context snapshots under `inputs/context/`, and
record input sizes and hashes in state.

### Seeded Major Plans

Use `--seed-major-plan` when the first draft of the major plan already exists
in the target repository:

```bash
node dist/cli/main.js --runner fake \
  --goal-file tasks/goal.md \
  --seed-major-plan tasks/major-plan.md
```

The seed file must resolve inside the target repository after symlink
resolution. It must be valid non-empty UTF-8 text and is limited to 1 MiB. A
seed file may also be passed as `--context` when you want it listed with the
other operator-provided context.

Seeded mode treats the file as the draft `major_plan` output. Non-dry runs copy
it to the canonical plan artifact, `plans/01-major-plan.md`, record source
metadata in `inputs/01-inputs.json` and `state.json`, and make the source
visible in dry-run and final reports. Seeded mode skips only the
runner-generated `major_plan` phase. The seeded draft still goes through
`major_plan_review`, final major-plan generation, milestone JSON generation,
and the normal milestone workflow.

Resume does not accept a new `--seed-major-plan` value. Seeded runs resume from
saved state: if `plans/01-major-plan.md` exists, it is reused; otherwise the
saved source path and hash are checked before recreating the artifact. Changed
or missing seed inputs fail the resume instead of silently generating a new
major plan.

The dashboard launch form exposes the same intake model for new runs: prompt or
repository-relative goal file, optional repository-relative context paths, and
an optional repository-relative seeded major-plan path. Use the dry-run preview
before a live dashboard launch to confirm the target repository, artifact root,
goal source, context inputs, major-plan source, runner profile/account label,
and next action.

### Local Dashboard

Start the localhost dashboard from this checkout:

```bash
npm run dashboard
```

To serve the dashboard from this checkout while operating on a separate target
repository, pass `--repo`:

```bash
npm run dashboard -- --repo /path/to/target-repo --artifact-root .agent-work
```

The dashboard still uses the built CLI for launch and resume actions. Browser
launch paths are target-repository-relative only:

- choose `Prompt` and enter prompt text, or choose `Goal file` and enter a path
  such as `tasks/goal.md`;
- enter context paths one per line, such as `README.md` and
  `docs/architecture.md`;
- enter a seed plan path such as `tasks/major-plan.md` when the first draft
  major plan already exists;
- leave `Dry run` checked to preview the resolved launch before unchecking it
  for a live run.

Run detail includes an `Inputs` section showing the saved goal source, context
snapshot links, seeded major-plan metadata, and input manifest link. If the
dashboard fails to start or a browser action fails, run the equivalent CLI
command directly; the dashboard is an operator surface over the same CLI
contract, not a separate execution engine.

### Deterministic Fake Runs

Inspect a full fake run without creating `.agent-work/`:

```bash
node dist/cli/main.js --dry-run --runner fake "example goal"
```

Start a full fake run:

```bash
node dist/cli/main.js --runner fake "example goal"
```

The full fake path plans, implements, checks, reviews, and advances through every generated fake milestone. It prints the final state, sorted milestone statuses, and the final goal summary artifact when one is available:

```text
State: passed
Current milestone: none
Milestones:
  1: passed
  2: passed
Final summary artifact: milestones/90-goal-summary.md
```

Planning-only operation remains available:

```bash
node dist/cli/main.js --planning-only --runner fake "example goal"
```

Planning-only outside Git requires an explicit override:

```bash
node dist/cli/main.js --planning-only --allow-non-git-planning --runner fake "example goal"
```

Resume an existing run:

```bash
node dist/cli/main.js --resume .agent-work/<run-id>
node dist/cli/main.js --resume <run-id> --dry-run
```

Run exactly one runnable milestone:

```bash
node dist/cli/main.js --runner fake --milestone 1 "example goal"
```

Override fix attempts for the current invocation:

```bash
node dist/cli/main.js --runner fake --max-fix-attempts 1 "example goal"
```

Choose a milestone plan policy:

```bash
node dist/cli/main.js --runner fake --milestone-plan-policy light "example goal"
node dist/cli/main.js --runner fake --milestone-plan-policy auto "example goal"
```

Allow a dirty working tree only when that starting state is deliberate:

```bash
node dist/cli/main.js --allow-dirty --runner fake "example goal"
```

### Real Codex Runs

Prerequisites for `codex-exec`:

- `codex` is installed and available on `PATH`.
- The Codex CLI is authenticated in the shell where you run the orchestrator.
- The target directory is a Git repository.
- Implementation-capable runs have at least one commit.
- The working tree is clean unless you pass `--allow-dirty`.
- `orchestrator.config.json` exists in the target repository, an absolute
  `--config` is supplied, or the target repository's example config is acceptable.
- Configured checks are recommended so acceptance is not based only on review output.

Create a local config when you want to customize checks, timeouts, model/profile, or artifact root:

```bash
cp orchestrator.config.example.json orchestrator.config.json
```

Run a read-only real planning pass:

```bash
npm run build

node dist/cli/main.js --planning-only --runner codex-exec \
  "Plan a small README documentation update"
```

Planning-only runs call `codex exec`, but planning and review phases use the read-only sandbox by default and stop after writing plan artifacts and milestone metadata.

Run a real one-milestone task from a clean working tree:

```bash
npm run build
git status --short

node dist/cli/main.js --runner codex-exec --milestone 1 \
  "Add a short manual testing section to README.md"
```

Use a lightweight per-milestone plan when the task is simple and the general plan is already clear:

```bash
node dist/cli/main.js --runner codex-exec --milestone 1 \
  --milestone-plan-policy light \
  "Add a short manual testing section to README.md"
```

Expected result:

- Codex actually edits the working tree.
- The orchestrator captures the real diff under `.agent-work/<run-id>/diffs/`.
- Configured checks run and write reports under `.agent-work/<run-id>/checks/`.
- Review verdict JSON is written under `.agent-work/<run-id>/reviews/`.
- Runner diagnostics are written under `.agent-work/<run-id>/runner/`.
- `state.json` records final status and every produced artifact path.
- In scrupulous mode, milestone plan draft and plan-review trace artifacts are also written under `.agent-work/<run-id>/milestones/`.

If the starting dirty tree is deliberate, make that explicit:

```bash
node dist/cli/main.js --allow-dirty --runner codex-exec --milestone 1 \
  "Add a short manual testing section to README.md"
```

The run state records both `dirtyAtStart` and `dirtyOverride`, and the CLI prints a dirty-tree warning before execution.

Codex authentication is controlled by the Codex CLI environment, not by the
orchestrator. `runner.options.profile` is passed as the Codex profile when set,
and `runner.accountLabel` is an operator-facing label that appears in dry-run
output, final JSON, and diagnostics. The pipeline reports the configured
profile and label, but it cannot prove which remote Codex account the CLI will
use beyond the local Codex CLI behavior.

Inspect the newest run:

```bash
RUN_DIR=$(ls -td .agent-work/run-* | head -1)

find "$RUN_DIR" -maxdepth 3 -type f | sort
cat "$RUN_DIR/state.json"
cat "$RUN_DIR/logs/81-timings.md"
ls "$RUN_DIR/runner"
```

Resume a stopped or constrained run:

```bash
node dist/cli/main.js --resume "$RUN_DIR" --dry-run
node dist/cli/main.js --resume "$RUN_DIR"
node dist/cli/main.js --resume "$RUN_DIR" --milestone-plan-policy auto
node dist/cli/main.js --resume "$RUN_DIR" --milestone-plan-review-policy scrupulous
```

If the previous milestone left real file changes in the working tree and you intend to continue from that state, add `--allow-dirty` to the resume command. Resume policy overrides are per-invocation and affect only future milestone planning work reached during that invocation.

Scrupulous draft, review, and final-plan generation currently stay inside the existing `implementing` phase and run before target repository edits begin. If a process is interrupted during those internal steps, resume remains conservative: incomplete implementation-ready artifacts stop as `needs_human_review` instead of automatically reusing a partial draft, partial review, or final plan. A resume-time `--milestone-plan-review-policy` override does not rewrite the saved config snapshot and does not regenerate artifacts for a milestone already stopped in a transient `implementing` state.

Interpret final states:

- `passed`: the current requested workflow completed. If `--milestone` was used, remaining milestones may still be pending and the next action will say to resume without `--milestone`.
- `failed`: deterministic checks, runner execution, or orchestration validation failed. Inspect `Last error`, milestone statuses, and generated artifacts.
- `needs_human_review`: the workflow stopped conservatively because review or resume safety requires human input.

Troubleshooting real runs:

- Missing `codex`: install the Codex CLI or set `runner.command` in `orchestrator.config.json`.
- Dirty tree: commit or stash changes, or rerun with `--allow-dirty` when the dirty start is intentional.
- Timeout: increase `runner.options.timeoutMs`.
- Codex non-zero exit: inspect `Last error` and `.agent-work/<run-id>/runner/*.json`.
- Malformed milestone JSON: inspect `plans/04-final-major-plan.json` and the `final_plan_json` runner diagnostic.
- Malformed review JSON: inspect `reviews/20-milestone-<id>-review.json` and the `review_milestone` runner diagnostic.
- Empty diff: check whether the implementation changed only ignored files, only `.agent-work/`, or made no working-tree changes.
- Lightweight plan too thin: resume remaining work with `--milestone-plan-policy always` so future milestones use full runner-backed milestone plans.

## Testing

Normal local verification before handing off changes:

```bash
npm run typecheck
npm run build
npm run test:build
```

Command matrix:

- `npm run typecheck`: checks production TypeScript without writing build output.
- `npm run build`: compiles the CLI and production modules into `dist/`.
- `npm run test:build`: compiles `src/` and `tests/` into `dist-test/`, then runs every required deterministic test.
- `npm test`: runs the already-compiled unit test suite from `dist-test/tests/unit/*.test.js`.
- `npm run test:real-codex`: builds, compiles tests, and runs the opt-in real Codex smoke test file. Without `RUN_REAL_CODEX=1`, the smoke test is skipped.

Required deterministic tests currently live under `tests/unit`, so the default test command intentionally discovers that compiled path. If required tests move under another folder such as `tests/integration`, update `package.json` so `npm run test:build` runs them too.

Test helpers live under `tests/helpers`:

- `fixture-repo.ts`: temporary Git repositories with committed fixture files.
- `run-fixture.ts`: ready-state run directories, configs, and state setup.
- `scenario-runner.ts`: scripted runner phases, file mutations, failures, thrown errors, and prompt/artifact capture.
- `assertions.ts`: generated `state.json` shape checks plus milestone metadata and review verdict validator helpers.

Default tests are deterministic and offline. `FakeRunner` covers the CLI happy path, `ScenarioRunner` is used by workflow tests for precise success and failure cases, and the deterministic fake-`codex` integration test proves the real adapter command shape without model calls.

Run the live Codex smoke test only when you want to exercise a real authenticated Codex CLI:

```bash
RUN_REAL_CODEX=1 npm run test:real-codex
```

The smoke test creates a temporary Git repository, installs a small config and prompt/schema harness, runs the built CLI with `--runner codex-exec --milestone 1`, expects Codex to create one text file, verifies the captured diff/check/review artifacts, and writes runner diagnostics under the fixture `.agent-work/<run-id>/runner/`. It cleans up successful fixtures by default and leaves failed fixtures in place for inspection.

Optional smoke-test environment variables:

- `REAL_CODEX_COMMAND`: override the executable command, default `codex`.
- `REAL_CODEX_MODEL`: pass a Codex model override.
- `REAL_CODEX_PROFILE`: pass a Codex profile override.
- `REAL_CODEX_PHASE_TIMEOUT_MS`: per-phase `codex exec` timeout.
- `REAL_CODEX_SMOKE_CLI_TIMEOUT_MS`: total CLI command timeout used by the test.
- `REAL_CODEX_KEEP_SMOKE_FIXTURE=1`: keep successful smoke fixtures for inspection.

## CI Provider Integrations

Optional GitHub Actions integrations for agent PR review and guarded CI-failure autofix are documented in `docs/ci-provider-integrations.md`.

These workflows are not required for local CLI usage. Configure provider secrets only when maintainers want GitHub-hosted agent review or manual autofix branches.
