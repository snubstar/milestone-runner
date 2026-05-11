# Milestone 6 Plan: Test Harness And Scenario Coverage

## Objective

Turn the current one-milestone prototype into a well-tested platform for the next state-machine work.

Milestone 6 should not add new orchestration behavior. It should reduce test duplication, make edge cases easier to express, expand deterministic fake/scenario coverage, and add integration-style confidence around the full one-milestone path created by Milestones 1 through 5.

The main outcome is a stronger test harness that can support Milestone 7 multi-milestone progression without rewriting the existing tests.

## Current Starting Point

Milestones 1 through 5 already provide:

- a TypeScript CLI and modular orchestration code;
- config loading and validation;
- Git safety preflight;
- run directory and artifact path helpers;
- state creation, persistence, and transitions;
- prompt loading and rendering;
- a production `FakeRunner` for the CLI happy path;
- a non-executing `CodexExecRunner` skeleton;
- planning, implementation, review, and bounded fix workflows;
- unit and integration-style tests covering the first one-milestone loop.

The current test suite works, but many tests build fixture repositories, run directories, scripted runners, and ready-state contexts inline. Milestone 6 should consolidate those patterns before the codebase adds multi-milestone complexity.

## In Scope

- Add reusable test helpers for temporary Git repositories, run directories, config fixtures, and state setup.
- Add a reusable scripted/scenario runner for tests that can:
  - queue responses by phase;
  - mutate fixture files during implementation or fix phases;
  - capture prompts and artifact maps for assertions;
  - simulate runner failures, thrown errors, malformed output, and empty output.
- Refactor selected existing tests to use the shared helpers where this materially reduces duplication.
- Expand workflow coverage for planning, implementation, review, and CLI integration-style paths.
- Add tests that prove artifacts are run-relative and stay inside the run directory model.
- Add tests that verify state remains schema-compatible after major success and failure paths.
- Add checks for prompt variable coverage so prompt edits cannot silently break workflows.
- Add a documented test command matrix for local development.
- Keep all tests deterministic and offline by default.

## Out Of Scope

- Advancing from milestone 1 to milestone 2.
- General resume support.
- New production workflow phases.
- Real `codex-exec` execution against a model.
- Automatic commits, rollback, or branch management.
- CI provider integration.
- Broad CLI developer-experience flags such as `--resume`, `--dry-run`, `--milestone`, or `--max-fix-attempts`.

## Locked Decisions

- Milestone 6 is infrastructure and coverage work. It should not change the external workflow semantics unless a test exposes a real defect.
- The production `FakeRunner` should remain simple and deterministic for the CLI happy path.
- Complex success and failure scenarios should live in test harness utilities, not production runner configuration, unless there is a clear product need.
- Tests should avoid network and real model calls by default.
- Any optional `codex-exec` adapter skeleton smoke test must be skipped unless explicitly enabled by environment variables, and must not execute `codex`.
- The one-milestone stop remains intentional. Milestone 7 owns multi-milestone progression.
- Fixture helpers should be small and explicit; they should make tests clearer, not hide important state transitions.

## Proposed Test Layout

```text
tests/
  helpers/
    fixture-repo.ts
    run-fixture.ts
    scenario-runner.ts
    state-fixture.ts
    assertions.ts
  unit/
    existing unit tests
  integration/
    one-milestone-flow.test.ts
    cli-smoke.test.ts
  smoke/
    codex-exec-adapter-smoke.test.ts
```

The exact split can stay conservative, but test discovery must be explicit:

- required deterministic tests may stay under `tests/unit` if that keeps the current scripts simple;
- if required tests move to `tests/integration`, update `package.json` so `npm run test:build` runs them;
- skipped-by-default smoke tests may live under `tests/smoke`, but they must not run in the default `npm test` path.

Milestone 6 is not complete if required tests exist in a folder that `npm run test:build` does not execute.

## Helper Design

### Fixture Repository Helper

Create a helper for temporary repository setup:

```ts
createFixtureRepo(options): Promise<FixtureRepo>
```

It should support:

- Git initialization with a first commit;
- optional `.gitignore` content;
- initial files;
- optional dirty file setup;
- cleanup through a returned `cleanup()` function;
- helper methods for reading files, writing files, and running Git commands.

This should replace repeated `mkdtemp`, `git init`, `writeFile`, `git add`, and `git commit` setup in workflow tests where practical.

### Run Fixture Helper

Create a helper for run directory and config setup:

```ts
createRunFixture(options): Promise<RunFixture>
```

It should support:

- creating `RunPaths`;
- creating the run directory;
- writing the initial goal and state;
- returning a default valid config;
- allowing config overrides for checks, runner type, max fix attempts, and artifact root.

### Ready-State Fixtures

Create explicit fixture builders for common workflow starting points:

- initialized state;
- planning-complete state;
- ready-for-milestone state;
- ready-for-review state;
- passed state;
- failed state;
- needs-human-review state.

These should call the same state transition helpers as production code, so tests exercise the real state model.

### Scenario Runner

Create a reusable test runner, for example:

```ts
class ScenarioRunner implements AgentRunner
```

It should support scenario steps like:

```ts
{
  phase: "review_milestone",
  text: "{...}",
  exitCode: 0,
  writeFiles: [{ path: "README.md", content: "..." }]
}
```

It should record:

- every request phase;
- prompt text;
- provided artifact map;
- milestone id;
- cwd.

It should allow tests to assert:

- phases ran in the expected order;
- later milestones were not requested;
- prompts included the expected context;
- fix prompts include blocking findings only;
- artifact maps point to the intended run-relative files.

## Coverage Additions

### Planning Workflow

Add or strengthen tests for:

- runner thrown error;
- empty runner output;
- prompt rendering failure from missing variables or missing prompt files;
- artifact write failure where practical;
- invalid final milestone JSON preserving earlier planning artifacts;
- milestone metadata with multiple pending milestones still selects the first pending id.

### Implementation Workflow

Add or strengthen tests for:

- missing final major plan artifact;
- missing active milestone metadata;
- runner thrown error;
- empty implementation output;
- diff capture failure outside Git;
- check command runner error;
- state remains persisted after each durable artifact;
- active milestone only is implemented.

### Review And Fix Workflow

Add or strengthen tests for:

- missing final major plan, milestone plan, diff, and checks artifacts;
- review runner thrown error;
- empty review output;
- diagnostic artifact write failure;
- summary write failure;
- malformed post-fix review output;
- post-fix review with fail/no-blocking-findings;
- multiple fix attempts with stable `fixAttempts` behavior;
- prompt artifact maps and reviewed artifact lists;
- latest check status parsing against misleading stdout/stderr text.

### CLI Integration-Style Tests

Add tests for:

- fresh fake run reaches `passed`;
- planning-only run reaches `ready_for_milestone`;
- dirty implementation run fails before creating a run directory;
- non-fake runner is allowed to reach planning-only execution but rejected for implementation/review execution;
- CLI output prints the important artifact paths when review runs.

### State And Schema Compatibility

Add helper assertions that validate representative generated files with the codebase's existing validators and lightweight state-shape checks:

- `state.json`;
- `05-milestones.json`;
- review verdict JSON artifacts.

For Milestone 6, do not add a JSON Schema validator dependency unless a concrete test need appears. The implementation-ready path is:

- use `parseMilestoneMetadataJson` for `05-milestones.json`;
- use `parseReviewVerdictJson` for review verdict artifacts;
- add a small test-only assertion helper for `RunState` that checks required top-level fields, valid phase/status strings, required `git` fields, required `config` fields, object-shaped artifact maps, and ISO timestamp strings.

Keep full JSON Schema validation as a later hardening task unless the local dependency tradeoff is revisited deliberately.

## Optional Codex Adapter Skeleton Smoke Test

Milestone 6 may add a skipped-by-default smoke test for the `codex-exec` adapter skeleton, but it must not call a model by default and must not imply that real `codex exec` orchestration is implemented.

Preferred shape:

- check whether `RUN_CODEX_EXEC_ADAPTER_SMOKE=1` is set;
- instantiate the runner and assert that the adapter reports its current non-executing status clearly;
- skip otherwise.

Checking whether the configured `codex` command is available is optional and should only be used for an adapter-environment assertion. Do not execute `codex`.

Do not implement real `codex exec` orchestration in Milestone 6. That belongs in a later milestone after the deterministic harness is stronger.

## Package Scripts

Review `package.json` scripts and make the intended commands clear:

```bash
npm run typecheck
npm run build
npm run test:build
npm test
```

Required rule:

- if all required tests remain under `tests/unit`, the existing `npm test` pattern may stay as-is;
- if required tests are added under `tests/integration`, update `npm test` to run both compiled unit and integration tests;
- do not include `dist-test/tests/smoke/*.test.js` in the default `npm test` script;
- add a separate optional script only if a smoke test is actually added, for example `test:smoke`.

Milestone 6 must end with `npm run test:build` executing every required deterministic test.

## README Updates

Update the testing section of `README.md` with:

- the normal local verification sequence;
- what each command checks;
- where the test helpers live;
- how deterministic fake/scenario runners are used;
- how to opt into any skipped adapter-skeleton smoke tests, if one is added.

Keep this documentation short and practical.

## Implementation Steps

1. Add `tests/helpers/fixture-repo.ts` and migrate at least one existing workflow test to prove the helper is useful.
2. Add `tests/helpers/scenario-runner.ts` and migrate review workflow scripted-runner tests where practical.
3. Add `tests/helpers/run-fixture.ts` or `state-fixture.ts` for ready-state setup.
4. Add targeted edge-case tests for planning, implementation, and review workflows.
5. Add CLI integration-style tests that cover the full fake one-milestone path and runner gating.
6. Add state/schema assertion helpers using existing validators plus a lightweight `RunState` assertion helper.
7. Update package scripts if any required tests are placed outside `tests/unit`; otherwise explicitly keep required tests in the current discovered path.
8. Update README testing documentation.
9. Run the full verification sequence and fix any regressions.

## Acceptance Criteria

- Test helpers remove meaningful duplication from workflow tests.
- Scenario runner tests can express pass, fail, malformed output, thrown errors, empty output, file mutations, and runner failures.
- Existing Milestone 1 through 5 behavior remains unchanged except for defects exposed by the new tests.
- Tests cover the main success path and representative failure paths for planning, implementation, review, and CLI execution.
- Generated milestone metadata and review artifacts validate with existing local validators, and generated `state.json` passes the test-only `RunState` assertion helper.
- All default tests are deterministic and offline.
- Optional adapter-skeleton smoke coverage is skipped unless explicitly enabled.
- Documentation explains how to run the test suite.
- `npm run test:build` executes every required deterministic test added in Milestone 6.
- Verification passes with:

```bash
npm run typecheck
npm run build
npm run test:build
```

## Risks And Mitigations

- Risk: helper abstractions hide important workflow details.
  Mitigation: keep fixture builders explicit and allow tests to inspect raw state, artifacts, prompts, and runner requests.

- Risk: broad refactors make tests harder to review.
  Mitigation: migrate tests incrementally and keep behavior-preserving helper extraction separate from new edge-case coverage where possible.

- Risk: smoke tests become flaky or imply real model execution.
  Mitigation: keep adapter-skeleton smoke tests skipped by default, never execute `codex` in Milestone 6, and keep deterministic tests as the required gate.

- Risk: Milestone 6 drifts into Milestone 7 state-machine work.
  Mitigation: do not add milestone advancement, resume behavior, or final goal summaries in this milestone.

## Handoff To Milestone 7

After Milestone 6, Milestone 7 should be able to build multi-milestone progression using:

- reusable fixture repositories;
- reusable ready-state builders;
- scenario runners that can model multi-step agent behavior;
- integration-style fake runs that prove the existing one-milestone path still works.

Milestone 7 should then own advancing from a passed active milestone to the next pending milestone, adding resume behavior, and producing a final goal summary.
