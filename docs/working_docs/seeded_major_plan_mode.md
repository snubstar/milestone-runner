# Seeded Major Plan Mode

## Motivation

`desiderata.md` asks for a mode where the operator provides the first general
plan in the expected format and the pipeline treats that first planning step as
already done.

Issue 3 made this practical by adding an explicit run boundary:

- target repositories are selected with `--repo`;
- long goals can come from `--goal-file`;
- initial context files are validated, recorded, and snapshotted;
- artifacts stay under a target-contained artifact root;
- runner identity is visible in dry runs, reports, and diagnostics.

The next missing operator workflow is plan seeding. In many real runs, the
operator already knows the desired major plan, or wants to edit the plan by hand
before allowing agent execution. Today the pipeline must still spend a runner
call generating `major_plan`, even if the desired plan already exists. That is
slower, less deterministic, and makes it harder to use a human-authored plan as
the run's starting point.

Seeded Major Plan Mode should let the operator provide the initial major plan
as a repository file while preserving the rest of the orchestration rigor:
review, final plan generation, milestone JSON validation, implementation,
checks, review, and fix loops still run normally.

## Goals

- Add a new new-run-only CLI option:

  ```text
  --seed-major-plan <path>
  ```

- Resolve and validate the seed file with the same target-repository containment
  rules used for `--goal-file` and `--context`.
- Treat the seed file as the output of the `major_plan` runner phase.
- Write the seeded plan to the canonical artifact path:

  ```text
  plans/01-major-plan.md
  ```

- Skip only the `major_plan` runner call.
- Continue the existing planning sequence from `major_plan_review` onward:

  ```text
  seeded plans/01-major-plan.md
  -> major_plan_review
  -> final_major_plan
  -> final_plan_json
  -> milestone implementation
  -> checks
  -> review
  -> fix loop when needed
  ```

- Record seed metadata in run state and input artifacts so the source of the
  major plan is auditable.
- Surface seeded-plan mode in dry-run output, final reports, JSON reports, and
  dashboard diagnostics.
- Ensure the first runner phase in a seeded run, `major_plan_review`, receives
  the same initial context-file guidance that `major_plan` receives in normal
  runs.
- Keep existing behavior unchanged when `--seed-major-plan` is omitted.
- Keep the implementation deterministic and covered by fake-runner tests.

## Non-Goals

- Do not skip plan review, final major plan generation, milestone JSON
  generation, implementation, checks, review, or fix attempts.
- Do not accept a new `--seed-major-plan` value during resume. Resume should
  continue from saved seeded state when the original run was seeded.
- Do not support arbitrary external seed files in this phase. The seed must
  resolve inside the selected target repository after symlink resolution.
- Do not add a dashboard browser UI for selecting seed files in the first pass.
  The backend/API can support a repository-relative seed path so the UI can be
  added later.
- Do not change milestone execution semantics or review strictness.
- Do not infer whether a seeded plan is "good" locally. The existing
  `major_plan_review` and `final_major_plan` runner phases own that assessment.

## Desired Operator UX

From the target repository:

```bash
node /path/to/orchestrator/dist/cli/main.js --runner codex-exec \
  --goal-file tasks/goal.md \
  --seed-major-plan tasks/major-plan.md
```

From the orchestrator repository while targeting another repo:

```bash
node dist/cli/main.js --repo /path/to/target-repo --runner codex-exec \
  --goal-file tasks/goal.md \
  --context README.md \
  --seed-major-plan tasks/major-plan.md
```

Dry-run output should make the seeded path explicit:

```text
Goal source: tasks/goal.md
Initial context files: README.md
Major plan source: seeded from tasks/major-plan.md
Next action: review seeded major plan
Runner calls skipped: major_plan
```

The first runner request in a seeded run should be `major_plan_review`, not
`major_plan`.

## Design

### CLI Contract

Add `seedMajorPlanFile?: string` to `CliOptions` and parse:

```text
--seed-major-plan <path>
```

Rules:

- Allowed only for new runs.
- Rejected with `--resume`.
- Allowed with argv goals and with `--goal-file`.
- Allowed with `--context`.
- Resolved relative to `targetCwd` when relative.
- Absolute paths are accepted only if their canonical `realpath` stays inside
  `targetCwd`, matching `--goal-file` behavior.
- The file must exist, be a regular file, be non-empty after UTF-8 decoding and
  whitespace trimming, and be valid UTF-8 text. Invalid UTF-8 byte sequences must
  be rejected explicitly rather than accepted through replacement characters.
- The canonical file must not escape the target repository through symlinks.
- Duplicate relationship with context is allowed. A file may be both context and
  seed if the operator intentionally wants it listed as context too. Dashboard
  API validation must use the same overlap policy.
- Apply a clear byte limit. Use 1 MiB initially, matching `--goal-file`, unless
  implementation discovers a stronger local reason to choose a separate limit.

Usage output should document the option near `--goal-file` and `--context`.

### Input Model

Extend `src/inputs/initial-inputs.ts` rather than adding unrelated path logic.
The seed is a first-class initial input, but it is distinct from context:

```ts
interface InitialInputsState {
  goalSource: {
    type: "argv" | "file";
    path: string | null;
  };
  majorPlanSource?: {
    type: "runner" | "seed";
    path: string | null;
    sizeBytes?: number;
    sha256?: string;
  };
  context: Array<{
    path: string;
    artifactPath: string;
    sizeBytes: number;
    sha256: string;
  }>;
}
```

New runs without a seed may omit `majorPlanSource` or write
`{ type: "runner", path: null }`. Prefer writing the explicit runner source for
new state if it keeps reports simpler, but keep the field optional for old state
compatibility.

The input manifest should include the same seed metadata:

```json
{
  "createdAt": "...",
  "goalSource": { "type": "file", "path": "tasks/goal.md" },
  "majorPlanSource": {
    "type": "seed",
    "path": "tasks/major-plan.md",
    "sizeBytes": 1234,
    "sha256": "..."
  },
  "context": []
}
```

Do not create a separate seed snapshot in `inputs/context/`. The canonical copy
of the plan for orchestration is `plans/01-major-plan.md`. The manifest and
state provide traceability back to the source file. The `sha256` records the
original seed file bytes. The canonical plan artifact should use the existing
planning artifact text normalization contract unless that writer is deliberately
changed for all planning artifacts: trim trailing whitespace and write one final
newline.

`writeInitialInputArtifacts` and `createInitialState` should be the single
writer for `state.inputs.majorPlanSource`. The planning workflow may read this
metadata, but it should not rewrite input provenance. Planning records only the
canonical plan artifact under `state.artifacts.majorPlan`.

`state.inputs.majorPlanSource` is the authoritative persisted source of truth for
whether a run is seeded. A missing `majorPlanSource` means `runner` for backward
compatibility. Transient CLI/workflow option data may carry the already-resolved
seed text to avoid a duplicate file read during a new run, but it must be treated
only as a cache. If transient seed data is present while state says `runner`, or
if transient seed metadata does not match the saved state path, size, and hash,
the workflow must fail in `planning` instead of silently choosing one source.

Seed resolution should return a structured value:

```ts
interface ResolvedSeedMajorPlan {
  text: string;
  path: string;          // target-repository-relative path
  canonicalPath: string;
  sizeBytes: number;
  sha256: string;
}
```

Use `TextDecoder("utf-8", { fatal: true })` or an equivalent fatal UTF-8 decode
path so invalid input bytes fail validation.

### Planning Workflow

Seeded mode must not be decided from a transient workflow option. Add a planning
cache option only if it simplifies new-run wiring:

```ts
resolvedSeedMajorPlan?: {
  text: string;
  path: string;
  canonicalPath: string;
  sizeBytes: number;
  sha256: string;
};
```

The workflow decides whether the run is seeded from
`state.inputs?.majorPlanSource?.type === "seed"`. The optional
`resolvedSeedMajorPlan` value is valid only when it matches that saved state.

In `runPlanningWorkflow`:

1. Set phase to `planning` as today.
2. If state does not say `seed`, keep the current `major_plan` behavior
   unchanged and reject any stray `resolvedSeedMajorPlan` cache.
3. If state says `seed`, load the seed text from the saved source metadata,
   preferring the verified `resolvedSeedMajorPlan` cache on a new run and falling
   back to the source file/hash path used by resume.
4. If a seed is loaded:
   - write the seed text to `plans/01-major-plan.md`;
   - record `state.artifacts.majorPlan`;
   - do not call `runPhase("major_plan", ...)`;
   - do not write a `runner/major_plan-*.json` diagnostic.
5. Set phase to `plan_reviewing`.
6. Render `major-plan-review` using the seeded plan text and the rendered
   initial-context section from state.
7. Continue with `final_major_plan` and `final_plan_json` exactly as today.

Failure handling should preserve existing semantics. If writing the seeded plan
artifact fails, fail the run in `planning`. If `major_plan_review` fails, fail in
`plan_reviewing` as it already does.

### Prompt Context for Seeded Reviews

Today, initial context files are rendered into the `major-plan` prompt. In a
seeded run, the first runner phase is `major_plan_review`, so the review prompt
must also receive the initial-context section.

Update `src/prompts/major-plan-review.md` to include an optional
`{{initialContext}}` block. Render it for every run, not only seeded runs, so
normal and seeded review prompts have one consistent shape. The block should
list repository-relative context paths and snapshot artifacts, matching the
existing major-plan context section. The wording must be review-oriented, for
example "consider these files while reviewing or finalizing the plan"; do not
reuse prompt text that tells the runner to read them "before drafting the major
plan."

The `major_plan_review` runner artifact map should include
`state.artifacts.inputs.manifest` when available, plus the same `initialContextN`
snapshot artifacts used by `major_plan`, so diagnostics show the context
manifest and snapshots that informed the review.

Tests must assert that a seeded run with `--context README.md` sends
`README.md` and the input manifest artifact path to the first runner request,
which should be `major_plan_review`.

### Seeded Resume Semantics

`--seed-major-plan` remains new-run-only, but seeded state must resume
deterministically if a process stops during planning.

Rules:

- New seeded runs write `state.inputs.majorPlanSource.type = "seed"` before
  workflow execution begins. This saved state remains the source of truth even
  when the new-run call also passes a resolved seed cache.
- When `runPlanningWorkflow` starts and `state.inputs.majorPlanSource.type` is
  `"seed"`, it must not call `major_plan`, even on resume.
- If `state.artifacts.majorPlan` exists, read `plans/01-major-plan.md` from the
  run directory and use that as the major plan text for downstream review.
- If `state.artifacts.majorPlan` is missing but the saved seed source path and
  hash are present, re-read the source file from `targetCwd` through the same
  repository-contained resolver, require the hash to match, write
  `plans/01-major-plan.md`, and record `state.artifacts.majorPlan`.
- If neither the artifact nor a matching source file is available, fail safely
  in `planning` with a clear error instead of regenerating `major_plan`.
- Direct-path and run-id resume continue to reject a new `--seed-major-plan`
  value from the CLI.

This avoids changing the resume CLI contract while preventing a seeded run from
silently falling back to runner-generated major planning.

### State and Schemas

Update:

- `src/state/state-types.ts`
- `schemas/state.schema.json`
- test state assertions in `tests/helpers/assertions.ts`

The state schema must allow old states that lack `inputs.majorPlanSource`.

Reports and dashboard readers should treat a missing `majorPlanSource` as
`runner` for backward compatibility.

### Runner Diagnostics and Timings

A seeded run should not fabricate a runner diagnostic for `major_plan`; no
runner call happened. Timing summaries should naturally show no `major_plan`
runner duration.

If the timeline needs visibility, state/artifact events are enough:

- `state.artifacts.majorPlan` points at `plans/01-major-plan.md`;
- `inputs.majorPlanSource.type` is `seed`;
- dry-run and final reports state that `major_plan` was seeded.

Do not add a fake duration or synthetic runner record.

### Dashboard API

Add optional `seedMajorPlanPath?: string` to `DashboardLaunchRequest`.

Initial backend/API support should:

- accept only repository-relative dashboard paths, matching `contextPaths`;
- reject empty strings, absolute browser paths, directories, symlink escapes,
  invalid UTF-8, and oversized files;
- allow the seed path to also appear in `contextPaths`, matching the CLI policy;
- validate through the same seed resolver used by CLI;
- forward `--seed-major-plan <path>` to the child CLI;
- record `requestedSeedMajorPlanPath` in launch diagnostics.

The existing browser form can omit the field in this phase. A later UI pass can
add a text input for repository-relative seed paths.

## Milestone 1: CLI Surface and Regression Tests

### Objective

Introduce the option and lock down expected behavior before changing planning
execution.

### Implementation Steps

1. Add `seedMajorPlanFile?: string` to `CliOptions`.
2. Parse `--seed-major-plan <path>` in `src/cli/args.ts`.
3. Update usage text.
4. Reject `--seed-major-plan` with `--resume`.
5. Add `tests/unit/cli-args.test.ts` coverage:
   - accepts `--seed-major-plan`;
   - accepts it with argv goal;
   - accepts it with `--goal-file`;
   - accepts it with repeated `--context`;
   - rejects it with `--resume`;
   - rejects missing option values.

### Acceptance Criteria

- CLI parsing is deterministic and backward compatible.
- No runtime behavior changes yet when the option is not used.

### Verification

```text
npm run typecheck
node --test dist-test/tests/unit/cli-args.test.js
```

## Milestone 2: Seed Input Resolution

### Objective

Validate seeded plan files through the same repository-contained input contract
as goal and context files.

### Implementation Steps

1. Extend `src/inputs/initial-inputs.ts` with `seedMajorPlanFile`.
2. Add `seedMajorPlanMaxBytes`, initially 1 MiB.
3. Reuse the existing regular-file, byte-limit, canonical `realpath`, and
   segment-aware containment checks.
4. Reject empty or whitespace-only seed files with a specific error.
5. Reject invalid UTF-8 with a specific error.
6. Return the seed text, target-relative path, canonical path, size, and sha256 in
   `ResolvedInitialInputs`.
7. Update `writeInitialInputArtifacts` to write `majorPlanSource` to
   `inputs/01-inputs.json` and state input data.
8. Keep `writeInitialInputArtifacts` as the only writer for
   `state.inputs.majorPlanSource`; downstream planning should not mutate input
   provenance.
9. Add `tests/unit/initial-inputs.test.ts` coverage:
   - resolves a valid repository-relative seed;
   - accepts an absolute path only when it resolves inside target;
   - rejects missing files;
   - rejects directories;
   - rejects empty files;
   - rejects whitespace-only files;
   - rejects invalid UTF-8;
   - rejects oversized files;
   - rejects outside-target files;
   - rejects sibling-prefix escapes;
   - rejects symlink escapes;
   - records seed metadata in the manifest and state inputs.

### Acceptance Criteria

- Seed validation happens before run execution can call a runner.
- Invalid seed files fail with actionable messages.
- The input manifest clearly identifies seeded major-plan source metadata.

### Verification

```text
npm run typecheck
node --test dist-test/tests/unit/initial-inputs.test.js
```

## Milestone 3: State, Schema, and Reporting

### Objective

Make seeded-plan provenance visible and schema-valid.

### Implementation Steps

1. Extend `RunState.inputs` in `src/state/state-types.ts`.
2. Update `schemas/state.schema.json` for optional `majorPlanSource`.
3. Update state assertion helpers.
4. Update dry-run output in `src/cli/dry-run.ts`:
   - show `Major plan source: runner` by default;
   - show `Major plan source: seeded from <path>` when present;
   - show the next action as review of the seeded major plan when applicable.
5. Widen `DryRunReport.details` from scalar-only values to
   `Record<string, unknown>` if the report carries structured seed metadata.
   Update the human dry-run printer to render object values as compact JSON or to
   use a separate scalar display string so it never prints `[object Object]`.
6. Update JSON dry-run reports with a stable field, for example:

   ```json
   {
     "majorPlanSource": {
       "type": "seed",
       "path": "tasks/major-plan.md"
     }
   }
   ```

7. Update final report output in `src/cli/run-report.ts`.
8. Update dashboard run-reader display data if it normalizes or summarizes
   `state.inputs`.
9. Add `tests/unit/run-report.test.ts`, `tests/unit/cli-main.test.ts`, and
   dashboard reader tests as needed.

### Acceptance Criteria

- New seeded states validate against the state schema.
- Old states without `inputs.majorPlanSource` remain readable.
- Dry-run and final reports make the seeded source explicit.

### Verification

```text
npm run typecheck
node --test dist-test/tests/unit/run-report.test.js
node --test dist-test/tests/unit/cli-main.test.js
```

## Milestone 4: Planning Workflow Seed Execution

### Objective

Skip only the `major_plan` runner phase and continue the existing planning
pipeline from plan review onward.

### Implementation Steps

1. Extend `PlanningWorkflowOptions` and `GoalWorkflowOptions` with optional
   `resolvedSeedMajorPlan` cache data only if needed for new-run wiring.
2. Pass resolved seed data from `runNewWorkflow` into `runGoalWorkflow` as a
   cache. Do not use this option to decide whether the run is seeded.
3. In `runPlanningWorkflow`, branch before rendering/calling `major_plan` based
   on `state.inputs.majorPlanSource.type`:
   - if state says `runner` or the field is missing, keep normal behavior
     unchanged and fail if a seed cache was unexpectedly provided;
   - if state says `seed`, verify the cache against saved path, size, and sha256
     when the cache is present;
   - if state says `seed` and no cache is present, read the source path from
     state and verify its hash before using it;
   - write the verified seed text to `plans/01-major-plan.md` directly.
4. Record `state.artifacts.majorPlan` in both paths.
5. Do not modify `state.inputs.majorPlanSource` in planning; it was already
   recorded before workflow execution.
6. Extend `major-plan-review` prompt rendering with `initialContext`.
7. Ensure `major-plan-review` receives the seeded text as `majorPlan`.
8. Ensure `major_plan_review` and `final_major_plan` artifact maps reference
   `plans/01-major-plan.md`. Leave `final_plan_json` artifact mapping unchanged:
   it should continue to reference `goal`, `finalMajorPlanMarkdown`, and
   `majorPlanReview` unless a separate diagnostic change is intentionally made
   and tested.
9. Include `state.artifacts.inputs.manifest` in the `major_plan_review`
   artifact map when available.
10. Do not write or expect a `runner/major_plan-*.json` diagnostic for seeded
   runs.
11. Add `tests/unit/prompt-loader.test.ts` coverage for the new
   `major-plan-review` placeholder.
12. Add `tests/unit/planning-workflow.test.ts` coverage:
   - seeded run writes `plans/01-major-plan.md`;
   - first runner request is `major_plan_review`;
   - no `major_plan` request is made;
   - review prompt contains the seeded plan;
   - review prompt contains provided context paths and input manifest artifact;
   - cache metadata mismatch fails in `planning`;
   - stray seed cache with runner-state fails in `planning`;
   - final plan JSON and milestones are still generated;
   - failures in `major_plan_review` still fail as `plan_reviewing`.
13. Add CLI integration-style tests in `tests/unit/cli-main.test.ts`:
    - fake seeded planning-only run succeeds;
    - seeded full fake run succeeds;
    - invalid seed fails before any runner call;
    - dry-run with a valid seed does not create run artifacts.

### Acceptance Criteria

- The normal planning path is unchanged.
- Seeded runs skip exactly one runner phase: `major_plan`.
- Seeded runs still produce the same downstream planning artifacts as normal
  runs.
- Non-seeded resume behavior remains unchanged.

### Verification

```text
npm run typecheck
node --test dist-test/tests/unit/planning-workflow.test.js
node --test dist-test/tests/unit/cli-main.test.js
```

## Milestone 5: Seeded Planning Resume

### Objective

Make interrupted seeded planning safe to resume without allowing an accidental
fallback to runner-generated `major_plan`.

### Implementation Steps

1. Extend the seeded-plan loading helper from Milestone 4 so it can load seeded
   major-plan text from saved state without a new-run cache:
   - prefer `state.artifacts.majorPlan` when present;
   - otherwise use `state.inputs.majorPlanSource.path` plus saved `sha256` to
     re-read the original source file from `targetCwd` through the same
     repository-contained resolver used by new-run seed validation;
   - reject missing source path, missing hash, hash mismatch, invalid UTF-8,
     whitespace-only content, or unavailable files with a clear planning error.
2. Pass `cwd: targetCwd` into that helper through existing workflow options.
3. In `runPlanningWorkflow`, check `state.inputs.majorPlanSource.type` before
   normal major-plan generation:
   - if it is `"seed"`, use the seeded helper;
   - never call `runPhase("major_plan", ...)` for that state;
   - if the major-plan artifact had to be recreated from the saved source, write
     it and record `state.artifacts.majorPlan`.
4. Keep `--seed-major-plan` rejected with `--resume`; resume uses saved state
   only.
5. Add tests:
   - resume from seeded `planning` with existing `plans/01-major-plan.md`
     continues at `major_plan_review`;
   - resume from seeded `planning` with missing major-plan artifact recreates it
     from a matching source file;
   - resume blocks when the source file hash changed;
   - resume blocks when both artifact and source are unavailable;
   - no resumed seeded path calls `major_plan`.

### Acceptance Criteria

- Seeded planning resumes are deterministic.
- A seeded run never silently changes into a runner-generated major-plan run.
- Missing or tampered seeded-plan inputs fail with actionable errors.

### Verification

```text
npm run typecheck
node --test dist-test/tests/unit/planning-workflow.test.js
node --test dist-test/tests/unit/cli-main.test.js
node --test dist-test/tests/unit/cli-run-loader.test.js
```

## Milestone 6: Dashboard Backend Support

### Objective

Allow dashboard launch requests to pass a repository-relative seeded plan path
through to the CLI without adding browser UI yet.

### Implementation Steps

1. Add `seedMajorPlanPath?: string` to `src/dashboard/api-types.ts`.
2. Update `src/dashboard/run-launcher.ts` request normalization:
   - accept an optional non-empty string;
   - require repository-relative paths from browser requests;
   - validate by calling the shared seed resolver;
   - preserve existing prompt limit behavior.
3. Forward `--seed-major-plan <path>` in child CLI args.
4. Record the requested seed path in launch diagnostics.
5. Add dashboard launch tests:
   - accepts a valid seed path;
   - accepts a seed path that also appears in `contextPaths`;
   - forwards `--seed-major-plan`;
   - records diagnostics;
   - rejects absolute browser host paths;
   - rejects missing, directory, invalid UTF-8, oversized, outside-target,
     sibling-prefix, and symlink-escape seed paths;
   - dry-run launch reports seeded-plan source.

### Acceptance Criteria

- Dashboard API can launch seeded runs when called programmatically.
- Browser users cannot submit arbitrary absolute host filesystem paths.
- Existing dashboard launches are unchanged when no seed path is supplied.

### Verification

```text
npm run typecheck
node --test dist-test/tests/unit/dashboard-run-launcher.test.js
```

## Milestone 7: Documentation and Examples

### Objective

Make the seeded workflow clear for operators.

### Implementation Steps

1. Update `README.md` CLI option list.
2. Add a "Seeded Major Plans" section near "Initial Inputs".
3. Update `docs/how-to.md` with one target-repo example and one
   orchestrator-repo `--repo` example.
4. Document that seeded plans:
   - must live inside the target repository;
   - are copied to `plans/01-major-plan.md`;
   - skip only `major_plan`;
   - still go through plan review and final plan generation;
   - resume from saved seeded state and reject changed/missing seed inputs rather
     than regenerating `major_plan`;
   - are available in reports and state.
5. Mention dashboard API support if browser UI is still deferred.
6. Update any smoke docs if they list supported launch inputs.

### Acceptance Criteria

- Operators can discover when and how to use seeded plans.
- Documentation does not imply that seeded plans bypass review or validation.

### Verification

```text
git diff --check -- README.md docs/how-to.md seeded_major_plan_mode.md
```

## Milestone 8: Final Verification

### Objective

Prove seeded mode is implementation-ready and does not regress existing flows.

### Implementation Steps

1. Run the full validation suite:

   ```text
   npm run typecheck
   npm run build
   npm run test:build
   ```

2. Run a manual fake planning-only seeded run from a target repository:

   ```bash
   node dist/cli/main.js --runner fake --planning-only \
     --goal-file tasks/goal.md \
     --seed-major-plan tasks/major-plan.md
   ```

3. Run a manual fake seeded run from the orchestrator repository with `--repo`:

   ```bash
   node dist/cli/main.js --repo /path/to/target-repo --runner fake \
     --goal-file tasks/goal.md \
     --context README.md \
     --seed-major-plan tasks/major-plan.md
   ```

4. Inspect the run directory:
   - `plans/01-major-plan.md` matches the seed text after the standard planning
     artifact normalization of trailing whitespace and final newline;
   - no `runner/major_plan-*.json` exists;
   - `runner/major_plan_review-*.json` exists;
   - `inputs/01-inputs.json` records `majorPlanSource.type = "seed"`;
   - state records `artifacts.majorPlan` and seed metadata.

5. Manually simulate a planning-stage resume if practical:
   - keep a seeded state in `planning` or `plan_reviewing`;
   - resume without passing `--seed-major-plan`;
   - verify `major_plan` is not called and plan review continues from the saved
     seed artifact.

6. Optionally exercise dashboard API launch with `seedMajorPlanPath` and verify
   child CLI args and diagnostics.

### Acceptance Criteria

- Full test suite passes.
- Manual fake seeded runs produce the expected artifacts.
- Seeded planning resume does not call `major_plan`.
- Existing non-seeded runs still produce a `major_plan` runner diagnostic.

## Risks and Notes

- Seeded plans can be low quality or stale. This is acceptable because the next
  phase is still `major_plan_review`, followed by final plan generation.
- The seed artifact should not be treated as final. It is only the draft major
  plan.
- Because seeded runs skip the normal major-plan prompt, context-file guidance
  must be passed into `major_plan_review`; otherwise `--context` becomes
  invisible to the first runner call.
- Avoid inventing a new persisted orchestration phase for this. Existing
  `planning` and `plan_reviewing` phases are sufficient.
- Be careful not to accidentally skip `final_major_plan` or `final_plan_json`.
  Those phases are what convert the reviewed draft into orchestrator-owned
  milestone metadata.
- Do not synthesize runner diagnostics for skipped phases. Reports should state
  that `major_plan` was seeded, not pretend a runner executed it.
