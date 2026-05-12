# Milestone 8 Plan: Hardening And Developer Experience

## Objective

Make the multi-milestone runner safe, inspectable, and comfortable for real local use.

Milestone 8 should not add new orchestration phases. It should expose the Milestone 7 goal workflow through practical CLI controls, improve failure diagnostics, make resume and dry-run behavior explicit, and document the workflows a developer is expected to use day to day.

The main outcome is a CLI that can start, inspect, resume, constrain, and safely override a local run without requiring the user to read internal state files or orchestration code.

## Current Starting Point

Milestones 1 through 7 already provide:

- a TypeScript CLI with config loading, Git preflight, artifact directory creation, and state persistence;
- planning, implementation, deterministic checks, review, bounded fix attempts, and final goal summaries;
- a goal-level workflow that advances through multiple milestones from `milestones/05-milestones.json`;
- conservative core resume normalization for stable persisted states;
- final goal summary generation from deterministic artifacts;
- fake-runner coverage for full multi-milestone success, stop conditions, and resume behavior;
- CLI output with run id, run directory, final state, milestone statuses, and final summary path.

The current CLI still behaves like a fresh-run command:

```text
parse args -> load config -> Git preflight -> create new run -> run goal workflow
```

It supports:

- `--config`;
- `--artifact-root`;
- `--planning-only`;
- `--allow-dirty`, currently limited to planning-only by the CLI;
- `--runner`.

Milestone 8 should turn this into a user-facing run manager:

```text
start new run
resume existing run
inspect next action without running agents
constrain execution to one milestone
override fix attempts
explain safety gates and tool availability clearly
```

## In Scope

- Add user-facing CLI options:
  - `--dry-run`;
  - `--resume <run-dir-or-id>`;
  - `--max-fix-attempts <n>`;
  - `--milestone <id>`.
- Make `--resume` load `state.json` from an existing run instead of creating a new run.
- Make `--dry-run` validate inputs and print the action that would run without creating or modifying workflow artifacts.
- Allow `--max-fix-attempts` to override the loaded config for the current run.
- Allow `--milestone` to constrain implementation/review work to one runnable milestone.
- Improve Git safety overrides:
  - support explicit dirty-tree override for implementation-capable runs;
  - make non-Git planning-only behavior explicit and visible;
  - record or report all safety overrides clearly.
- Improve validation and diagnostics for:
  - missing or invalid config files;
  - missing `git`;
  - non-Git directories;
  - dirty working trees;
  - missing runner commands;
  - unsupported real-runner execution paths;
  - configured check commands.
- Improve terminal output for start, resume, dry-run, pass, fail, and human-review outcomes.
- Update README usage examples and recommended workflows.
- Add CLI and unit tests for the new option semantics and safety gates.

## Out Of Scope

- Implementing real `codex exec` execution for implementation, review, or fixes.
- CI, GitHub Actions, pull request automation, or provider-specific integrations.
- Automatic commits, rollback, branch creation, stash management, or patch application.
- Running milestones concurrently.
- Replacing the artifact layout or state schema unless a small backward-compatible field is needed for auditability.
- Changing the review verdict schema.
- Adding an interactive TUI or long-running daemon.

## Locked Decisions

- `state.json` remains the source of truth for resume.
- `milestones/05-milestones.json` remains the source of milestone definitions.
- Runtime milestone status remains in `state.milestoneStatuses`; metadata status is not mutated.
- Resume must stay conservative. If the workflow cannot prove a safe continuation point, it stops as `needs_human_review`.
- `--dry-run` must not call agent runners, run verification commands, create a run directory, or write state.
- `--resume` must not accept a conflicting goal argument; the goal is read from the saved state.
- CLI overrides apply to the current invocation only. Persisted state records the config snapshot used when the run was created unless a deliberate compatibility update is added.
- Dirty-tree implementation runs are allowed only with an explicit override and must surface the startup dirty status in output.
- Non-Git operation is allowed only for planning-only runs and must be explicit in CLI output.
- `--milestone` constrains work; it must not skip unmet dependencies or mark unrelated milestones passed.
- The default full fake path remains deterministic and offline.
- Non-fake implementation/review/fix execution remains gated until a later milestone implements the real runner path.

## CLI Option Semantics

### `--resume <run-dir-or-id>`

Resume an existing run from its saved state.

Accepted values:

- an absolute or relative path to a run directory containing `state.json`;
- an absolute or relative path to a `state.json` file;
- a run id, resolved under the effective `artifactRoot`.

Rules:

- Do not require a goal argument when `--resume` is set.
- Reject a goal argument with `--resume` unless a future explicit `--new-goal` option exists.
- Load the state before creating any directories.
- Treat the resolved `state.json` location as canonical:
  - `runDir` is the parent directory of the resolved `state.json`;
  - runtime paths use `state.runId` as the run id;
  - `state.runDir`, if different from the resolved run directory, is a warning for legacy/moved runs, not the path to execute from.
- Rebuild `RunPaths` from the canonical resolved run directory and loaded `state.runId`.
- Use `state.config.snapshot` as the runtime config.
- If `state.config.snapshot` is missing or null, reject resume with a clear message. Milestone 8 should not guess a config for an existing run.
- If `--config` is also provided, reject it for Milestone 8 unless an explicit config-override design is added.
- If `--resume` is a run id, resolve it under `--artifact-root` when provided, otherwise under `.agent-work`.
- After state is loaded, prefer the artifact root recorded in state over the artifact root used only for lookup.
- Resolve the target repository for resume before calling the workflow:
  - if `state.git.root` is known, it is the target `cwd` for the resumed workflow;
  - the saved Git root must still exist;
  - the current process directory must be inside the same Git repository as `state.git.root`; otherwise reject and tell the user to `cd` into the saved repository before resuming;
  - if `state.git.root` is null, resume is allowed only for planning-only states that do not need Git, and the target `cwd` is the current process directory.
- Run Git preflight against the saved target Git root when known, not the artifact directory:
  - if `state.git.startSha` is known, keep it as the baseline for diffs and summaries;
  - if the working tree is dirty, require `--allow-dirty`.
- Call the existing goal workflow with the loaded state.
- Print that the run was resumed, the loaded run directory, current phase before resume, final phase after resume, and any final summary path.

### `--dry-run`

Inspect what would happen without writing artifacts or calling runners.

For new runs, dry-run should:

- parse CLI options;
- load and validate config;
- apply CLI overrides in memory;
- run non-mutating tool checks;
- run Git preflight;
- print the resolved runner, checks, artifact root, planning mode, safety overrides, and whether a new run would be allowed;
- not create `.agent-work/<run-id>/`.

For resume runs, dry-run should:

- load `state.json`;
- load milestone metadata if available;
- run resume normalization in inspect-only mode;
- print the current phase, current milestone, milestone status list, and next action;
- not normalize or persist state;
- not write a final summary.

Dry-run output should be concise but explicit enough that the user can decide whether to run the command without `--dry-run`.

Dry-run exit codes:

- return `0` when the requested workflow would be allowed to start or resume;
- return `1` when dry-run discovers a blocking condition that would prevent execution;
- return `1` for invalid CLI arguments, invalid config, missing state, missing tools, unsafe resume, dirty tree without override, unsupported runner execution, or unmet `--milestone` dependencies;
- never return success for a dry-run whose `allowed` field is `false`.

### `--max-fix-attempts <n>`

Override `config.maxFixAttempts` for the current invocation.

Rules:

- Require a non-negative integer.
- Apply before config validation returns the final runtime config.
- Print the effective value in the run report.
- For new runs, store the effective config in the state snapshot.
- For resume runs, apply the override in memory for the resumed workflow and print that it differs from the saved snapshot.
- For resume runs, do not mutate `state.config.snapshot` just to record this override. The report should show both the saved value and the effective value for the invocation.
- Reject values that are not finite safe integers.

### `--milestone <id>`

Constrain execution to one milestone.

Rules:

- Require a positive integer.
- Planning still generates the full major plan and milestone metadata.
- Implementation/review may run only for the requested milestone.
- The requested milestone must exist in metadata.
- The requested milestone must be pending or currently active in the loaded state.
- All declared dependencies for the requested milestone must already be passed.
- The requested milestone must match the selector's next runnable milestone unless it is already the active milestone in a resumed run. This keeps `--milestone` from skipping lower-id pending work.
- If dependencies are unmet, stop before runner execution with a clear diagnostic.
- After the requested milestone passes:
  - if other milestones remain pending, stop before advancing and report that the run can be resumed without `--milestone`;
  - if all milestones are passed, complete the goal and write the final goal summary.
- `--milestone` must not run earlier dependency milestones automatically in Milestone 8.

Persisted state after a constrained milestone run:

- If the target milestone passes and other milestones remain pending:
  - keep the target milestone status as `passed`;
  - keep other milestone statuses unchanged;
  - set `currentPhase = "passed"` and `status = "passed"`;
  - keep `currentMilestoneId = <target milestone id>`;
  - clear `lastError`;
  - do not write `milestones/90-goal-summary.md`;
  - print `Next action: resume without --milestone to continue remaining milestones`.
- If the target milestone fails, needs human review, or exhausts fixes, preserve the existing failure/human-review state from the phase workflow and write or attempt the final goal summary according to the normal terminal-stop rules.
- If the target milestone passes and all milestones are now passed, use the normal goal completion path: write `milestones/90-goal-summary.md`, set `currentMilestoneId = null`, and end with `currentPhase = "passed"` and `status = "passed"`.
- On a later unrestricted resume, the existing Milestone 7 resume behavior should see `passed` with pending milestones and advance to the next runnable milestone.

This likely requires adding a workflow option such as:

```ts
export interface GoalWorkflowExecutionLimits {
  targetMilestoneId?: number;
  stopAfterTargetMilestone?: boolean;
}
```

The selector or goal workflow should enforce the limit instead of relying on CLI-only checks.

### Safety Overrides

Milestone 8 should clarify and implement explicit safety overrides:

- `--allow-dirty`: allow implementation-capable runs to start or resume from a dirty working tree.
- `--allow-non-git-planning`: allow `--planning-only` in a directory that is not inside Git.

Behavior:

- Without `--allow-dirty`, dirty implementation-capable runs fail before agent execution.
- With `--allow-dirty`, record `git.dirtyOverride = true`, keep `git.statusPorcelain`, and print a visible warning line.
- Without `--allow-non-git-planning`, planning-only outside Git should fail with a message explaining the flag.
- With `--allow-non-git-planning`, planning-only outside Git can proceed and state should record `git.required = false`, `git.root = null`, and `git.startSha = null`.

## Proposed Module Layout

```text
src/
  cli/
    args.ts
    main.ts
    run-loader.ts
    run-report.ts
    dry-run.ts
  diagnostics/
    environment-validator.ts
    tool-validator.ts
  orchestration/
    goal-workflow-types.ts
    milestone-selector.ts
```

Tests:

```text
tests/unit/
  cli-args.test.ts
  cli-main.test.ts
  cli-run-loader.test.ts
  cli-dry-run.test.ts
  environment-validator.test.ts
```

Keep the split conservative. If new test folders are added, update `package.json` so `npm run test:build` runs every required deterministic test.

## Resume Loader Design

Add a small loader around existing state and path helpers:

```ts
export interface LoadResumeRunOptions {
  cwd: string;
  artifactRoot: string;
  resumeValue: string;
  commandRunner: CommandRunner;
}

export type LoadResumeRunResult =
  | {
      ok: true;
      state: RunState;
      paths: RunPaths;
      statePath: string;
      runDir: string;
      config: OrchestratorConfig;
      targetCwd: string;
      warnings: string[];
    }
  | { ok: false; error: string };
```

Resolution rules:

1. If `resumeValue` points to a directory, use `<resumeValue>/state.json`.
2. If `resumeValue` points to a file named `state.json`, use that file and its parent as the run directory.
3. Otherwise resolve `<artifactRoot>/<resumeValue>/state.json`.
4. Canonicalize the resolved state path with `realpath` where available.
5. Validate that parsed JSON has the minimum `RunState` shape before using it.
6. Ensure `state.runId` matches the canonical run directory basename unless the resume value was a direct path to a moved run directory. A moved run is allowed only when all artifact paths in state remain run-relative.
7. Rebuild all runtime paths from the canonical run directory. Do not trust absolute directory strings from state for filesystem writes.
8. Resolve the target repo using `state.git.root` when present and reject resume if the current Git root does not match that saved root.
9. Return `config = state.config.snapshot` after validating it with `validateConfig`.
10. For `state.git.root = null`, return `targetCwd = options.cwd` only for planning-only resumable states; otherwise reject.

Add or extend a path helper for resume:

```ts
buildRunPathsFromRunDir({
  runDir,
  runId,
}): RunPaths
```

This helper should derive `artifactRoot` from `path.dirname(runDir)` and use the existing subdirectory and artifact filename conventions. Resume should use this helper instead of trying to reverse-engineer a `cwd` plus `artifactRoot` pair for `buildRunPaths`.

Milestone 8 does not need a full state schema validator at CLI load time if the existing test assertion helpers are not production-ready. It does need clear guardrails before passing arbitrary JSON into the workflow.

## Dry-Run Design

Add a dry-run reporter that produces structured lines from preflight data:

```ts
export interface DryRunReport {
  mode: "new" | "resume";
  allowed: boolean;
  exitCode: 0 | 1;
  nextAction: string;
  warnings: string[];
  details: Record<string, string | number | boolean | null>;
}
```

For new runs, `nextAction` examples:

- `create_run`;
- `run_planning_only`;
- `run_full_goal`;
- `blocked_dirty_tree`;
- `blocked_non_git_planning_requires_override`;
- `blocked_runner_not_supported`;

For resume runs, `nextAction` examples:

- `continue_planning`;
- `continue_milestone`;
- `continue_review`;
- `advance_to_next_milestone`;
- `complete_goal_summary`;
- `stopped_failed`;
- `stopped_needs_human_review`;
- `blocked_unsafe_resume`.

Prefer reusing `normalizeStateForGoalResume` and `selectNextRunnableMilestone` for resume dry-run decisions so inspection and execution do not drift.

## Environment Validation

Improve validation before agent execution.

Checks to add:

- `git` command availability and actionable messages when it cannot be spawned.
- Runner command availability for `codex-exec`, separate from whether implementation is currently supported.
- Shell availability for configured check commands:
  - `sh` on POSIX;
  - `cmd` on Windows.
- Empty checks report as a warning, not an error.
- Check command strings are listed in dry-run and run reports.

Do not execute check commands during dry-run. Check commands can have side effects and must remain part of the normal verification phase.

Error messages should include:

- what failed;
- which command or path was involved;
- whether the user can fix config, install a missing tool, add an override flag, or run planning-only.

## Terminal Output

Refactor `printRunReport` into a small report module so output is consistent across success, failure, dry-run, and resume.

The report should include:

- mode: `new`, `resume`, or `dry-run`;
- run id and run directory when known;
- goal;
- planning-only status;
- target milestone when set;
- runner type;
- config path or snapshot source;
- effective max fix attempts;
- artifact root;
- Git root, start SHA, dirty status, and override status;
- state before and after resume when applicable;
- current milestone;
- sorted milestone statuses;
- latest error message when present;
- final summary artifact when present;
- next suggested action for stopped states.

Keep output plain text. Avoid progress spinners or interactive prompts.

## Documentation Updates

Update README sections for:

- current milestone detail link from Milestone 7 to Milestone 8;
- CLI usage;
- starting a full fake run;
- planning-only runs;
- dry-run inspection;
- resuming from a run directory;
- running one milestone;
- overriding max fix attempts;
- dirty-tree and non-Git planning overrides;
- interpreting final states:
  - `passed`;
  - `failed`;
  - `needs_human_review`;
- recommended verification commands.

Add examples:

```bash
node dist/cli/main.js --dry-run --runner fake "example goal"
node dist/cli/main.js --runner fake "example goal"
node dist/cli/main.js --resume .agent-work/<run-id>
node dist/cli/main.js --resume <run-id> --dry-run
node dist/cli/main.js --runner fake --milestone 1 "example goal"
node dist/cli/main.js --runner fake --max-fix-attempts 1 "example goal"
node dist/cli/main.js --planning-only --allow-non-git-planning --runner fake "example goal"
```

## Test Coverage

Add or strengthen tests for:

- parsing `--dry-run`;
- parsing `--resume <value>`;
- parsing `--max-fix-attempts <n>`;
- rejecting invalid max-fix-attempt values;
- parsing `--milestone <id>`;
- rejecting invalid milestone values;
- rejecting a missing goal for new non-resume runs;
- allowing a missing goal for resume runs;
- rejecting a goal combined with `--resume`;
- rejecting `--config` combined with `--resume` for Milestone 8;
- rejecting resume when `state.config.snapshot` is missing or null;
- resolving resume by run directory path;
- resolving resume by `state.json` path;
- resolving resume by run id under `artifactRoot`;
- rejecting resume paths without state;
- rejecting resume from outside the saved Git repository;
- allowing resume from a direct moved run directory only when artifact paths remain run-relative;
- dry-run for a new full fake run creates no run directory;
- dry-run for planning-only creates no run directory;
- dry-run for resume writes no state changes;
- dry-run returns exit code `1` when the reported action is blocked;
- dry-run returns exit code `0` when the reported action is allowed;
- resume from `ready_for_milestone`;
- resume from `ready_for_review`;
- resume from `passed` with pending milestones;
- resume from failed state prints the stopped reason and does not rerun agents;
- `--max-fix-attempts` override reaches workflow config;
- resume with `--max-fix-attempts` reports saved and effective values without mutating the saved config snapshot;
- `--milestone 1` runs milestone 1 and stops before milestone 2;
- `--milestone 1` leaves state as `passed` with `currentMilestoneId = 1` and no goal summary when milestone 2 remains pending;
- `--milestone` rejects a pending milestone that is not the selector's next runnable milestone;
- `--milestone 2` with unmet dependencies stops before runner execution;
- `--milestone` rejects missing milestone ids after metadata load;
- dirty implementation run is rejected without `--allow-dirty`;
- dirty implementation run proceeds with `--allow-dirty` and records the override;
- non-Git planning-only is rejected without `--allow-non-git-planning`;
- non-Git planning-only proceeds with `--allow-non-git-planning`;
- missing `git` produces an actionable diagnostic;
- missing configured `codex-exec` runner command produces an actionable diagnostic;
- empty checks produce a warning in dry-run/report output;
- README examples stay aligned with CLI usage text where practical.

## Implementation Steps

1. Completed: Extend `CliOptions`, `parseArgs`, and `usage()` with the new flags and validation.
2. Completed: Add config override support for `--max-fix-attempts`.
3. Completed: Add a resume run loader for `state.json` and reconstructed `RunPaths`.
4. Completed: Refactor CLI startup into separate new-run and resume-run paths.
5. Completed: Add dry-run reporting for both new and resume modes.
6. Completed: Update Git preflight to support dirty implementation overrides and explicit non-Git planning overrides.
7. Completed: Add environment/tool validation helpers and wire their diagnostics into CLI output.
8. Completed: Add a workflow execution limit for `--milestone` and enforce it in the goal workflow or selector.
9. Completed: Refactor terminal reporting into a reusable report module.
10. Completed: Update CLI tests for new options, dry-run behavior, resume behavior, and safety gates.
11. Completed: Update README usage and current milestone references.
12. Completed: Run the full verification sequence and fix regressions.

## Acceptance Criteria

- `--dry-run` reports the intended action and writes no workflow artifacts.
- `--dry-run` exits `0` only when the requested workflow would be allowed to execute.
- `--resume <run-dir-or-id>` resumes from `state.json` without requiring the original goal argument.
- Resume rejects conflicting CLI inputs with clear messages.
- Resume uses the resolved `state.json` directory as the canonical run directory and validates that the current Git repository matches the saved target repository.
- `--max-fix-attempts <n>` overrides the runtime config and is visible in output.
- `--milestone <id>` limits execution to that milestone and does not skip dependencies.
- A constrained milestone run that passes with remaining pending milestones leaves a resumable `passed` state without writing the final goal summary.
- Dirty implementation-capable runs are rejected unless `--allow-dirty` is set.
- Dirty override usage is visible in output and recorded in run state for new runs.
- Non-Git planning-only runs require `--allow-non-git-planning`.
- Missing tools and unsupported runner paths produce actionable diagnostics.
- Terminal output clearly reports run mode, state, milestone statuses, errors, and final summary artifacts.
- README documents start, dry-run, resume, one-milestone, and override workflows.
- Default tests remain deterministic and offline.
- Verification passes with:

```bash
npm run typecheck
npm run build
npm run test:build
```

## Risks And Mitigations

- Risk: resume with CLI overrides makes the saved run hard to audit.
  Mitigation: reject high-risk overrides on resume for Milestone 8, except `--max-fix-attempts`, and print any in-memory override clearly.

- Risk: dry-run behavior drifts from real execution.
  Mitigation: reuse config validation, Git preflight, resume normalization, and selector helpers instead of duplicating decision logic.

- Risk: dirty-tree overrides pollute diffs with pre-existing changes.
  Mitigation: require explicit `--allow-dirty`, preserve startup `statusPorcelain`, and print the dirty override in every report.

- Risk: `--milestone` accidentally skips dependencies or creates misleading goal completion.
  Mitigation: enforce dependency checks in workflow-level logic and stop after the target milestone unless the whole goal is complete.

- Risk: improved validation accidentally runs side-effecting commands during dry-run.
  Mitigation: validate command availability only; do not run configured check commands outside normal verification.

## Handoff To Milestone 9

After Milestone 8, Milestone 9 can safely focus on optional CI and provider integrations:

- add PR or CI review automation using the same artifact and state model;
- decide whether `codex-exec` should be fully implemented before CI integration or remain local-only;
- keep local orchestration usable without GitHub integration;
- preserve the dry-run and resume ergonomics for any CI-facing workflow.
