# Milestone 1 Plan: Prototype Foundations

## Objective

Create the foundation for a modular TypeScript CLI that will later orchestrate agent planning, implementation, verification, review, and fix loops, with Codex Exec as the first real runner adapter.

This milestone should not build the full workflow. It should make the project shape, safety model, artifact conventions, config format, and schema contracts clear enough that Milestone 2 can implement the first executable skeleton without architectural guesswork.

## Scope

Milestone 1 covers:

- Project scaffold and directory layout.
- Initial documentation.
- Git safety policy.
- Run artifact layout.
- Core state model.
- Minimal config format.
- JSON schema contracts for future structured artifacts.
- Prompt-template placement conventions.

Milestone 1 does not cover:

- Calling any real agent runner, including `codex exec`.
- Running agent-generated plans.
- Implementing the state machine.
- Running project checks.
- Review/fix retry logic.
- Multi-milestone execution.

## Locked Decisions

- The prototype will be a local TypeScript CLI.
- Shell scripts, if added later, will be thin wrappers only.
- The tool will run against the current working directory by default.
- A later milestone may add `--repo <path>` for explicit target repositories.
- Implementation-capable runs require a Git repository.
- Planning-only runs may eventually support non-Git directories, but implementation, diff capture, and fix loops require Git.
- Agent prompt templates will live as separate files rather than large inline strings.
- Human-readable artifacts and machine-readable artifacts will be stored separately.
- Codex Exec will be the first real runner adapter, but the orchestration core should depend on an `AgentRunner` interface.

## Proposed File Layout

Milestone 1 should establish this layout:

```text
package.json
tsconfig.json
README.md
.gitignore
orchestrator.config.example.json
schemas/
  config.schema.json
  state.schema.json
  milestones.schema.json
  review-verdict.schema.json
src/
  artifacts/
  checks/
  cli/
    main.ts
  config/
  git/
  prompts/
  review/
  runners/
    codex-exec/
    fake/
  state/
tests/
  fixtures/
  smoke/
  unit/
```

`.agent-work/` is generated runtime output and should not be created as part of the scaffold. It should be listed in `.gitignore`, and later runner code should create it on demand.

## Work Plan

### Step 1: Establish Project Scaffold

Create the basic TypeScript project files and empty module directories.

Expected outputs:

- `package.json`
- `tsconfig.json`
- `.gitignore`
- `src/` module directories
- `src/cli/main.ts`
- `tests/` directories

Notes:

- Keep dependencies minimal.
- Prefer built-in Node APIs where reasonable.
- Configure `package.json` with a `bin` entry that points to the compiled CLI output.
- Do not add provider SDK dependencies yet; the first real runner adapter will shell out to `codex exec`.
- Do not create `.agent-work/` yet.

`.gitignore` should include at least:

```text
node_modules/
dist/
coverage/
.agent-work/
orchestrator.config.json
*.log
```

### Step 2: Document The Prototype Contract

Create or update `README.md` with the high-level prototype contract.

The README should explain:

- What problem the prototype solves.
- Why the orchestrator, not the agent, controls the loop.
- The first one-milestone workflow target.
- The Git safety requirement.
- The artifact directory convention.
- The distinction between fake runners and real agent runner adapters.
- The intended milestone sequence from `general_plan.md`.

### Step 3: Define Git Safety Policy

Document the safety rules that later code must enforce.

Initial rules:

- Implementation-capable phases require `git rev-parse --show-toplevel` to succeed.
- Implementation-capable phases require a clean working tree by default.
- Diff capture uses `git diff`.
- The orchestrator records the starting commit SHA when available.
- Non-Git directories are allowed only for documentation/planning-only phases.
- Any override flag for dirty trees or non-Git operation must be explicit and visible in run state.

Expected output:

- A Git safety section in `README.md`.
- State schema fields that can record Git root, start SHA, dirty-tree override, and planning-only mode.

### Step 4: Define Artifact Layout

Document the run directory layout under `.agent-work/<run-id>/`.

Initial layout:

```text
.agent-work/<run-id>/
  00-goal.txt
  state.json
  logs/
  plans/
  milestones/
  reviews/
  checks/
  diffs/
```

Artifact naming should reserve the milestone-specific names from `general_plan.md`, including:

- `01-major-plan.md`
- `02-major-plan-review.md`
- `03-final-major-plan.md`
- `04-final-major-plan.json`
- `05-milestones.json`
- `10-milestone-1-plan.md`
- `12-milestone-1.diff`
- `20-milestone-1-review.json`

Expected output:

- Artifact layout documented in `README.md`.
- Schema support for tracking artifact paths in `state.json`.

### Step 5: Define Minimal Config Format

Create `orchestrator.config.example.json`.

Initial config fields:

```json
{
  "checks": [],
  "runner": {
    "type": "codex-exec",
    "command": "codex",
    "options": {
      "sandboxForPlanning": "read-only",
      "sandboxForImplementation": "workspace-write",
      "approvalPolicy": "never"
    }
  },
  "maxFixAttempts": 2,
  "artifactRoot": ".agent-work"
}
```

Notes:

- `checks` should be an array of shell commands to run during verification.
- Empty `checks` is valid for the earliest prototype but must be reported clearly later.
- Runner-specific settings belong under `runner.options` so future adapters can use different option shapes.
- The example config is not a local secret and can be committed.

Expected outputs:

- `orchestrator.config.example.json`
- `schemas/config.schema.json`

### Step 6: Define State Schema

Create `schemas/state.schema.json`.

The state model should support:

- Run identity.
- Goal.
- Current phase.
- Current milestone id.
- Overall status.
- Artifact root and run directory.
- Git metadata.
- Config snapshot or resolved config path.
- Milestone statuses.
- Fix attempt counts.
- Last error.

The schema should reference generated artifact paths as strings only. It should not require `.agent-work/` to exist during Milestone 1.

Recommended status values:

```text
initialized
planning
plan_reviewing
ready_for_milestone
implementing
checking
reviewing
fixing
passed
failed
needs_human_review
```

Expected output:

- `schemas/state.schema.json`
- README section describing the state file at a conceptual level.

### Step 7: Define Milestone Metadata Schema

Create `schemas/milestones.schema.json`.

The milestone metadata should support:

- `id`
- `title`
- `summary`
- `scope`
- `acceptanceCriteria`
- `verification`
- `dependencies`
- `status`

Recommended milestone status values:

```text
pending
planned
implementing
checking
reviewing
fixing
passed
failed
needs_human_review
```

Expected output:

- `schemas/milestones.schema.json`
- README section explaining that Markdown plans are for humans and `05-milestones.json` is for orchestration.

### Step 8: Define Review Verdict Schema

Create `schemas/review-verdict.schema.json`.

The review verdict should support:

- `verdict`: `pass`, `fail`, or `needs_human_review`
- `summary`
- `findings`
- `reviewedArtifacts`

Each finding should support:

- `severity`: `high`, `medium`, or `low`
- `file`
- `issue`
- `suggestedFix`
- `blocking`

Expected output:

- `schemas/review-verdict.schema.json`
- README section explaining that the orchestrator decides from this JSON, not from free-form prose.

### Step 9: Define Agent Prompt Template Convention

Create the prompt directory and document how templates will be named.

Initial prompt names for later milestones:

```text
src/prompts/major-plan.md
src/prompts/major-plan-review.md
src/prompts/final-plan-json.md
src/prompts/milestone-plan.md
src/prompts/implement-milestone.md
src/prompts/review-milestone.md
src/prompts/fix-review-findings.md
```

Milestone 1 may create placeholder files or only document the convention. If placeholder files are created, keep them short and clearly marked as placeholders.

## Validation For This Milestone

Milestone 1 should be considered complete when:

- The proposed project structure exists.
- `.gitignore` excludes generated output, dependency folders, build output, coverage, logs, and local config.
- `README.md` explains the prototype contract, Git safety model, artifact layout, config format, and schema purpose.
- `orchestrator.config.example.json` exists and matches the documented config format.
- JSON schema files exist for config, state, milestone metadata, and review verdicts.
- Prompt-template placement is documented.
- The scaffold does not create `.agent-work/`.
- No real agent orchestration is attempted yet.

## Risks And Mitigations

- Risk: Overbuilding the scaffold before the first runnable loop.
  Mitigation: Keep Milestone 1 focused on contracts, schemas, and directories only.

- Risk: Schemas become too detailed before implementation teaches us what is needed.
  Mitigation: Define enough structure for Milestone 2 and allow schema revisions during early implementation.

- Risk: The non-Git current workspace blocks implementation.
  Mitigation: Decide during Milestone 1 implementation whether to initialize Git here or test against a fixture Git repository.

- Risk: TypeScript setup adds friction before value is visible.
  Mitigation: Keep dependencies minimal and use fake runners in Milestone 2 to prove the architecture quickly.

## Handoff To Milestone 2

Milestone 2 should start from these completed contracts and implement:

- CLI argument parsing for a goal.
- Run directory creation.
- Config loading.
- State file creation.
- Git preflight checks.
- A command runner abstraction.
- An `AgentRunner` interface.
- A `CodexExecRunner` adapter skeleton.
- A fake runner for deterministic unit tests.
