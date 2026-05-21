# Milestone 2 Plan: Core Orchestrator Skeleton

## Objective

Build the first executable orchestration skeleton without implementing the full agent workflow.

Milestone 2 should turn the Milestone 1 contracts into runnable infrastructure: a CLI that accepts a goal, loads config, performs Git safety preflight, creates a run directory, writes `00-goal.txt` and `state.json`, and exercises runner abstractions through fake-runner paths.

This milestone should prove the project structure is viable and testable before any real planning, implementation, review, or fix loops are built.

## Scope

Milestone 2 covers:

- CLI argument parsing for a goal.
- Config loading and validation.
- Run id and run directory creation.
- Initial artifact creation.
- Initial state creation and updates.
- Git preflight checks.
- Command execution abstraction.
- `AgentRunner` interface.
- `FakeRunner` implementation for deterministic tests.
- `CodexExecRunner` skeleton, without real workflow integration.
- Basic logging.
- Unit tests for the above.

Milestone 2 does not cover:

- Generating major plans.
- Reviewing plans.
- Implementing milestones.
- Running review/fix loops.
- Real `codex exec` workflow calls.
- Multi-milestone state machine behavior.
- Full JSON Schema validation library integration unless needed for config/state loading.

## Locked Decisions

- The CLI entry remains `src/cli/main.ts`.
- The command name remains `agent-orchestrator`.
- The default target repository is the current working directory.
- Real implementation-capable runs require Git and a clean working tree.
- `orchestrator.config.example.json` is committed; `orchestrator.config.json` is local and ignored.
- If no local config exists, the CLI may fall back to the example config for prototype use.
- `.agent-work/` is created only when a run starts.
- The first Milestone 2 execution path should be fake-runner-based and deterministic.
- The default validation/smoke command for Milestone 2 should use `--planning-only --runner fake` so development can proceed while the working tree is dirty.
- `CodexExecRunner` must be instantiable without requiring `codex` to be installed. Tool availability checks for real runner execution belong to later milestones or explicit real-runner smoke checks.

## Proposed Module Layout

Milestone 2 should add real TypeScript files under the existing scaffold:

```text
src/
  artifacts/
    paths.ts
    run-directory.ts
  cli/
    args.ts
    main.ts
  config/
    config-loader.ts
    config-types.ts
  git/
    git-preflight.ts
    git-types.ts
  runners/
    agent-runner.ts
    codex-exec/
      codex-exec-runner.ts
    fake/
      fake-runner.ts
  state/
    initial-state.ts
    state-store.ts
    state-types.ts
  shell/
    command-runner.ts
tests/
  unit/
    *.test.ts
```

If this feels too granular during implementation, files may be combined conservatively, but the ownership boundaries should remain clear.

## CLI Contract

Initial command:

```bash
agent-orchestrator "Add feature X"
```

Equivalent development command before package linking:

```bash
npm run build
node dist/cli/main.js --planning-only --runner fake "Add feature X"
```

Initial options:

```text
--config <path>           Path to config file. Default: orchestrator.config.json if present, otherwise orchestrator.config.example.json.
--artifact-root <path>    Override artifact root. Default: config artifactRoot.
--planning-only           Allow non-Git operation and skip implementation-capable safety requirements.
--allow-dirty             Allow dirty Git working tree and record the override in state.
--runner <type>           Override runner type. Initial values: fake, codex-exec.
```

Milestone 2 may keep option parsing minimal, but the parser should reject unknown options and missing goal text.

## Run Behavior

For a successful skeleton run, the CLI should:

1. Parse CLI arguments.
2. Resolve the target directory as `process.cwd()`.
3. Load config.
4. Apply CLI overrides.
5. Run Git preflight unless `--planning-only` permits skipping implementation-capable checks.
6. Create a unique run id.
7. Create `.agent-work/<run-id>/`.
8. Create expected subdirectories:
   - `logs/`
   - `plans/`
   - `milestones/`
   - `reviews/`
   - `checks/`
   - `diffs/`
   - `fixes/`
9. Write `00-goal.txt`.
10. Create initial `state.json`.
11. Instantiate the configured `AgentRunner`.
12. Write a simple log entry that the skeleton run initialized.
13. Exit successfully without asking any real agent to plan or edit code.

## State Expectations

The initial `state.json` should conform conceptually to `schemas/state.schema.json`.

Initial values:

- `currentPhase`: `initialized`
- `status`: `initialized`
- `currentMilestoneId`: `null`
- `milestoneStatuses`: `{}`
- `fixAttempts`: `{}`
- `lastError`: `null`
- `artifacts.goal`: `00-goal.txt`
- `artifacts.logs["run"]`: `logs/run.log`, if log map support is implemented

Git metadata should record:

- whether Git was required;
- whether this was planning-only;
- Git root, if available;
- start commit SHA, if available;
- dirty status;
- dirty override flag;
- raw `git status --porcelain` output.

## Config Loading Plan

Config loading should:

- Prefer `--config <path>` when supplied.
- Otherwise use `orchestrator.config.json` if it exists.
- Otherwise use `orchestrator.config.example.json`.
- Parse JSON with clear errors.
- Validate required fields in code, even if full JSON Schema validation is deferred.
- Preserve a config snapshot in state.

Minimum validation:

- `checks` is an array.
- `runner.type` is `fake` or `codex-exec`.
- `runner.command` is required for `codex-exec`.
- `runner.options.sandboxForPlanning`, `runner.options.sandboxForImplementation`, and `runner.options.approvalPolicy` are required for `codex-exec`.
- `maxFixAttempts` is a non-negative integer.
- `artifactRoot` is a non-empty string.

Config validation should not check whether the runner command exists in Milestone 2. The `CodexExecRunner` skeleton must not fail just because `codex` is unavailable.

## Git Preflight Plan

Git preflight should use the command runner abstraction.

Commands:

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
git status --porcelain
```

Behavior:

- In implementation-capable mode, fail if not inside Git.
- In implementation-capable mode, fail if the repository has no initial commit.
- In implementation-capable mode, fail on dirty status unless `--allow-dirty` is set.
- In planning-only mode, capture available Git metadata but do not fail solely because Git is unavailable.
- Always return structured metadata for state creation.

## Runner Interfaces

Create an `AgentRunner` interface with a minimal shape for Milestone 2:

```ts
export interface AgentRunRequest {
  phase: string;
  prompt: string;
  artifacts?: Record<string, string>;
}

export interface AgentRunResult {
  text: string;
  exitCode: number;
  metadata?: Record<string, unknown>;
}

export interface AgentRunner {
  readonly type: string;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
```

`FakeRunner` should return deterministic text and metadata.

`CodexExecRunner` should be a skeleton that stores command/options and can be instantiated. It does not need to execute a real `codex exec` workflow in this milestone.

## Command Runner

Create a small command runner abstraction around `child_process`.

It should return:

- command
- args
- cwd
- exit code
- stdout
- stderr
- failure error, if spawn fails

This enables Git preflight tests without coupling the whole codebase directly to Node process APIs.

## Test Plan

Add a test runner using Node's built-in test module unless implementation shows a strong reason to add a dependency.

Tests should live under `tests/unit/*.test.ts`. Update TypeScript configuration so test files compile into `dist/tests/` while source files compile into `dist/src/` or an equivalent clear structure.

Update `package.json` scripts:

```json
{
  "test": "node --test \"dist/tests/**/*.test.js\"",
  "test:build": "npm run build && npm test"
}
```

Initial unit tests:

- CLI parser accepts goal text.
- CLI parser rejects missing goal.
- Config loader reads example config.
- Config loader reports invalid JSON clearly.
- Config validation rejects missing required runner fields.
- Artifact path builder creates expected run paths.
- State creation writes required fields.
- State store can write and read `state.json`.
- Git preflight succeeds in this repo.
- Git preflight can be tested with fake command results for non-Git, no-commit, and dirty-tree cases.
- `FakeRunner` returns deterministic output.
- `CodexExecRunner` can be instantiated without executing.

## Validation For This Milestone

Milestone 2 should be considered complete when:

- `agent-orchestrator --planning-only --runner fake "example goal"` can initialize a run.
- The equivalent development command `node dist/cli/main.js --planning-only --runner fake "example goal"` can initialize a run.
- The run creates `.agent-work/<run-id>/`.
- The run writes `00-goal.txt`.
- The run writes `state.json`.
- The run records Git metadata in state.
- The run records config path or snapshot in state.
- Missing goal produces a non-zero exit and usage message.
- Dirty/non-Git behavior follows the documented safety policy.
- Implementation-capable runs still fail on dirty trees unless `--allow-dirty` is set.
- Milestone 2 tests and smoke validation do not require `codex` to be installed.
- Unit tests cover config, artifacts, state, Git preflight, and runner abstractions.
- `npm run typecheck` passes.
- `npm run build` passes.
- `npm run test:build` passes.
- No real agent planning, implementation, review, or fix work is attempted.

## Risks And Mitigations

- Risk: The skeleton grows into the full workflow too early.
  Mitigation: Stop after initialization, state creation, and fake-runner wiring.

- Risk: JSON Schema validation adds dependency and complexity too early.
  Mitigation: Do direct code validation in Milestone 2 and add full schema validation later if needed.

- Risk: Git preflight tests are brittle against the developer's real working tree.
  Mitigation: Unit test command-output parsing with fake command runners; keep only one light integration check against the current repo.

- Risk: CLI option parsing becomes ad hoc.
  Mitigation: Keep supported options small and explicit; reject unknown options.

- Risk: `CodexExecRunner` skeleton implies real Codex execution.
  Mitigation: Make it instantiable only; real `codex exec` calls belong to later milestones.

## Handoff To Milestone 3

Milestone 3 should start from a working skeleton and implement:

- prompt loading;
- major plan generation with the selected runner;
- major plan review;
- final plan artifact writing;
- machine-readable milestone metadata creation;
- validation of `05-milestones.json`;
- tests around planning artifacts and milestone metadata parsing.
