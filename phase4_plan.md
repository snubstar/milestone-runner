# Phase 4 Plan: Dashboard Run Intake Parity

## Motivation

`desiderata.md` asked for four operator-facing capabilities:

1. reference initial files/docs the agent can read;
2. avoid practical limits on the initial prompt;
3. make the associated Codex account/profile clear;
4. make it clear how to run the pipeline against a separate target repository.

`fix_issue3_plan.md` implemented the run boundary and initial-input contract:

- `--repo` selects the target repository;
- `--goal-file` supports long, versioned goals;
- `--context` validates and snapshots repository files;
- runner identity is visible in CLI dry-runs, final reports, state, and
  diagnostics.

`seeded_major_plan_mode.md` then implemented seeded major-plan mode:

- `--seed-major-plan` lets the operator provide the first draft major plan;
- seeded runs skip only `major_plan`;
- plan review, final planning, milestone JSON, implementation, checks, review,
  and fix loops still run normally;
- seed metadata is recorded in state, input manifests, reports, and dashboard
  launch diagnostics.

The remaining gap is operator experience parity. The engine and dashboard
backend can now support richer initial inputs, but the browser launch form still
mostly exposes a prompt string and basic execution controls. At the start of
this phase, seeded major-plan launch required programmatic requests, context
paths were not first-class in the UI, and dashboard launches still relied on a
bounded prompt instead of offering `--goal-file` semantics.

Phase 4 should close that gap by making the dashboard a complete local operator
surface for the run-intake model already available through the CLI.

## Goals

- Add dashboard browser support for repository-relative launch inputs:
  - goal file path;
  - context file paths;
  - seeded major-plan path.
- Keep the current prompt-text launch path working.
- Let operators choose either prompt text or goal file for a launch, but not
  both.
- Harden shared goal-file validation so CLI and dashboard `goalFilePath`
  launches reject invalid UTF-8 explicitly instead of accepting replacement
  characters.
- Validate dashboard goal files through the same shared target-repository
  containment, byte-limit, regular-file, symlink, non-empty, and fatal UTF-8
  rules as CLI `--goal-file`.
- Keep browser-submitted paths repository-relative only. Do not let browser
  clients submit arbitrary absolute host paths.
- Show launch dry-run results as a preflight preview that makes these fields
  visible:
  - target repository;
  - artifact root;
  - goal source;
  - initial context files;
  - major-plan source;
  - runner type/profile/account label;
  - next action.
- Surface saved input provenance in dashboard run detail:
  - goal source;
  - context snapshots;
  - seeded major-plan source and hash/size metadata;
  - input manifest artifact.
- Update operator docs and smoke docs so dashboard and CLI workflows describe
  the same run-intake model.
- Keep launch/resume safety unchanged: dry-run confirmation remains required for
  resume, and new dashboard input fields do not bypass existing CLI validation.

## Non-Goals

- Do not support arbitrary external files from the dashboard. Browser launch
  paths remain target-repository-relative.
- Do not add a file picker that browses the host filesystem.
- Do not change CLI semantics for `--goal-file`, `--context`, or
  `--seed-major-plan`, except for the deliberate validation hardening that makes
  invalid UTF-8 goal files fail instead of being decoded with replacement
  characters.
- Do not change seeded planning behavior. This phase only exposes it in the
  dashboard UI and reports it more clearly.
- Do not infer or verify the actual authenticated OpenAI/Codex account. Continue
  to show configured runner profile/account labels and runner diagnostics.
- Do not redesign the dashboard into a general IDE. Keep the launch panel dense,
  predictable, and task-focused.

## Desired Operator UX

Dashboard server targeting another repository:

```bash
npm run dashboard -- --repo /path/to/target-repo --artifact-root .agent-work
```

Browser launch form:

- enter either a prompt or `tasks/goal.md`;
- optionally enter context paths, one per line:

  ```text
  README.md
  docs/architecture.md
  ```

- optionally enter a seeded major-plan path:

  ```text
  tasks/major-plan.md
  ```

- leave `Dry run` checked and click Start to preview the resolved launch;
- to launch a live run, uncheck `Dry run` and click Start with the same fields.

This phase keeps the existing dashboard launch model: dry-run is a launch mode,
not a required confirmation token. Resume continues to use its existing
dry-run-confirmation flow.

Dry-run preview should make the operator boundary obvious:

```text
Target repository: /path/to/target-repo
Artifact root: .agent-work
Goal source: file:tasks/goal.md
Initial context files: README.md, docs/architecture.md
Major plan source: seeded from tasks/major-plan.md
Runner: codex-exec
Runner profile: work-profile
Runner account label: work-codex
Next action: review_seeded_major_plan
```

Run detail should make the saved inputs auditable without opening `state.json`
manually.

## Design

### Dashboard API Contract

Extend `DashboardLaunchRequest` with:

```ts
goalFilePath?: string;
```

Existing fields remain:

```ts
prompt?: string;
contextPaths?: string[];
seedMajorPlanPath?: string;
```

Rules:

- `prompt` remains supported for compatibility.
- `goalFilePath` is optional.
- Exactly one of non-empty `prompt` or non-empty `goalFilePath` must be supplied.
- `goalFilePath` must be a non-empty repository-relative path.
- Absolute browser paths are rejected before filesystem resolution.
- `goalFilePath`, `contextPaths`, and `seedMajorPlanPath` may overlap only where
  the existing CLI policy allows it:
  - seed may also appear in context;
  - goal file may also appear in context. The goal source and context snapshot
    serve different audit purposes, so intentional duplication is allowed.
- Empty strings should normalize to "not supplied" only for optional fields.
  A launch with neither prompt nor goal file is invalid.

### Backend Resolution and CLI Forwarding

Update `src/dashboard/run-launcher.ts` so launch normalization produces either:

```ts
{ prompt: string; goalFilePath?: undefined }
```

or:

```ts
{ prompt?: undefined; goalFilePath: string }
```

Then:

- call `resolveInitialInputs` with:
  - `argvGoal: prompt ?? null`;
  - `goalFile: goalFilePath`;
  - `contextPaths`;
  - `seedMajorPlanFile: seedMajorPlanPath`;
- forward `--goal-file <path>` to the child CLI when `goalFilePath` is present;
- otherwise forward `-- <prompt>` as today;
- record `requestedGoalFilePath` in `DashboardCliDiagnostics` when present;
- preserve `requestedContextPaths` and `requestedSeedMajorPlanPath`.

The dashboard launcher should continue validating initial inputs before writing
launch diagnostics or spawning the child process, except where the existing code
intentionally writes diagnostics first for dry-run/live launch tracking.

### Browser Launch Form

Update `dashboard/public/index.html`, `dashboard/public/app.js`, and
`dashboard/public/styles.css`.

Add launch fields:

- goal source mode:
  - segmented/select control with `Prompt` and `Goal file`;
  - prompt textarea shown for prompt mode;
  - repository-relative goal file input shown for goal-file mode.
- context paths:
  - multiline textarea, one repository-relative path per line;
  - ignore blank lines;
  - trim surrounding whitespace;
  - submit as `contextPaths`.
- seeded major plan:
  - single repository-relative path input;
  - optional;
  - submit as `seedMajorPlanPath`.

Behavior:

- The Start button should keep the current dry-run checkbox behavior.
- Prompt mode and goal-file mode must update native form validation state:
  - prompt textarea is required only in prompt mode;
  - goal-file input is required only in goal-file mode;
  - hidden inactive controls must not block submission.
- If `Dry run` is checked, `POST /api/runs` returns a dry-run report and does
  not start a live process.
- If `Dry run` is unchecked, `POST /api/runs` starts the live process as today.
- New-run launch does not add a resume-style confirmation token. A later phase
  may add a separate Preview/Launch gate, but this phase keeps payload handling
  simple and backward compatible.
- Do not add explanatory paragraphs inside the app. Labels should be concise and
  operational.
- Keep the left launch panel compact. Use stable grid dimensions so fields do
  not shift unexpectedly.

### Launch Preview

Improve `renderLaunchResult` in `dashboard/public/app.js` so dry-run reports are
rendered as scannable fields before the raw JSON/report block.

Show at least:

- allowed/blocked status;
- next action;
- target repository;
- artifact root;
- goal source;
- context inputs;
- major-plan source;
- runner;
- runner profile/account label/authentication when present;
- blocked warnings.

Do not remove the raw report view if it is useful for debugging. Prefer a
compact summary above the raw report.

### Run Detail Input Provenance

Add a first-class `inputs` dashboard artifact group and extend
`DashboardRunDetail` with a normalized input summary derived from state in
`run-reader`:

```ts
inputs?: {
  goalSource: { type: "argv" | "file"; path: string | null };
  majorPlanSource: {
    type: "runner" | "seed";
    path: string | null;
    sizeBytes?: number;
    sha256?: string;
  };
  context: Array<{
    path: string;
    artifactPath: string;
    artifact: DashboardArtifactLink | null;
    sizeBytes: number;
    sha256: string;
  }>;
  manifestArtifact?: DashboardArtifactLink;
};
```

Rules:

- Missing `majorPlanSource` displays as runner for backward compatibility.
- Missing `inputs` on old state displays as unavailable, not malformed.
- `state.artifacts.inputs.manifest` is exposed through the `inputs` artifact
  group when the run-relative artifact path is safe.
- Context snapshot artifact paths are exposed as safe `DashboardArtifactLink`
  values through the input summary and the `inputs` artifact group.
- `inputs.context[].artifactPath` remains the saved state value for audit, while
  `inputs.context[].artifact` is the safe dashboard link derived by `run-reader`.
  If the artifact path is missing or unsafe, keep `artifactPath` visible and set
  `artifact` to `null`.
- `inputs.manifestArtifact` is the safe dashboard link for
  `state.artifacts.inputs.manifest`; omit it when the state/artifact path is
  absent or unsafe.
- Unsafe artifact paths must remain hidden by existing artifact safety rules and
  should produce dashboard warnings instead of broken links.

Update the run detail UI with an "Inputs" section:

- goal source;
- major plan source;
- context files with snapshot artifact links when available;
- input manifest link when available.

### Tests

Add or update tests in these areas:

- `tests/unit/dashboard-run-launcher.test.ts`
  - accepts `goalFilePath`;
  - rejects prompt plus goal file;
  - rejects neither prompt nor goal file;
  - rejects absolute goal file paths;
  - rejects missing, directory, invalid UTF-8, oversized, outside-target,
    sibling-prefix, and symlink-escape goal paths;
  - forwards `--goal-file <path>` without argv prompt;
  - forwards `--context` and `--seed-major-plan` together;
  - allows the goal file path to also appear in `contextPaths`;
  - records requested goal/context/seed paths in diagnostics;
  - dry-run report shows file goal and seeded major-plan source.
- `tests/unit/initial-inputs.test.ts` and CLI goal-file coverage
  - reject invalid UTF-8 goal files through the shared resolver;
  - keep valid UTF-8 goal files and argv goals unchanged.
- `tests/unit/dashboard-server.test.ts`
  - `POST /api/runs` accepts goal-file launches through the HTTP layer;
  - CSRF/token behavior remains unchanged for the expanded body.
- `tests/unit/dashboard-run-reader.test.ts`
  - exposes normalized input provenance for new state;
  - treats old state without `inputs` as readable;
  - treats missing `majorPlanSource` as runner.
  - exposes safe manifest and context artifact links in `run.inputs`;
  - preserves unsafe context `artifactPath` values but returns `artifact: null`
    and emits dashboard warnings.
- `tests/unit/dashboard-frontend-smoke.test.ts`
  - launch form contains goal source, goal file, context paths, and seeded plan
    controls;
  - frontend script builds the expected launch request payload for prompt mode;
  - frontend script builds the expected launch request payload for goal-file
    mode;
  - switching goal source mode updates `required` attributes so hidden inactive
    controls do not block submission.

The current frontend smoke coverage is syntax/DOM-wiring oriented, so this phase
must also make the new launch behavior testable. Prefer extracting pure helpers
into a small browser-compatible module, for example
`dashboard/public/launch-request.js`, with no DOM side effects. `app.js` should
import/use those helpers, and `dashboard-frontend-smoke.test.ts` should import
them directly for path-line parsing, launch-request construction, and goal-source
validation-state decisions. If a separate module is too disruptive, expose
equivalent guarded test hooks without running `init()` or touching `document` at
module load time in the test path.

### Documentation

Update:

- `README.md`
- `docs/how-to.md`
- `docs/dashboard-operator-smoke.md`

Docs should state:

- dashboard launch supports prompt or repository-relative goal file;
- context paths and seeded major-plan paths are repository-relative;
- seeded major-plan selection is available in the browser launch form;
- dry-run preview should be used before live runs;
- CLI remains the fallback for any dashboard failure.

## Milestones

### Milestone 1: Backend Goal-File Launch Parity

1. Harden shared goal-file resolution in `src/inputs/initial-inputs.ts` to use
   fatal UTF-8 decoding, matching seeded major-plan validation.
2. Add CLI/shared tests for invalid UTF-8 goal files.
3. Add `goalFilePath?: string` to `DashboardLaunchRequest` and make `prompt`
   optional at the type boundary while keeping prompt-only payloads valid.
4. Normalize dashboard launch bodies to require exactly one of prompt or goal
   file.
5. Validate `goalFilePath` as repository-relative before filesystem resolution.
6. Pass `goalFile` into `resolveInitialInputs`.
7. Forward `--goal-file <path>` to child CLI when present.
8. Record `requestedGoalFilePath` in dashboard diagnostics.
9. Add dashboard launcher and server tests.

Acceptance criteria:

- Programmatic dashboard launch can start from a goal file.
- Prompt-only launches remain backward compatible.
- Invalid goal files, including invalid UTF-8, fail before runner execution.
- CLI and dashboard use the same goal-file decoding behavior.

Verification:

```text
npm run typecheck
tsc -p tsconfig.test.json
node --test dist-test/tests/unit/initial-inputs.test.js
node --test dist-test/tests/unit/cli-main.test.js
node --test dist-test/tests/unit/dashboard-run-launcher.test.js
node --test dist-test/tests/unit/dashboard-server.test.js
```

### Milestone 2: Browser Launch Controls

1. Add goal source mode controls to the launch form.
2. Add goal-file, context-paths, and seed-major-plan inputs.
3. Update `buildLaunchRequest` to submit the correct payload.
4. Add path-line parsing for context paths.
5. Toggle `required` validation between prompt and goal-file controls when the
   goal source mode changes.
6. Keep existing prompt launch behavior and dry-run checkbox behavior
   unchanged.
7. Add frontend smoke/unit coverage.

Acceptance criteria:

- Browser users can submit the same launch inputs exposed by the dashboard API.
- Empty optional path fields are omitted from the request.
- Prompt and goal-file modes are mutually exclusive in the generated request.
- Hidden inactive goal-source controls do not block form submission.

Verification:

```text
npm run typecheck
tsc -p tsconfig.test.json
node --test dist-test/tests/unit/dashboard-frontend-smoke.test.js
```

### Milestone 3: Launch Preview and Diagnostics Display

1. Render dry-run report summaries in the launch result panel.
2. Show target repo, artifact root, goal source, context inputs, major-plan
   source, runner, profile/account labels, next action, and warnings.
3. Keep raw report details available for debugging.
4. Ensure blocked dry-runs are visually distinct and do not imply a live run was
   started.

Acceptance criteria:

- Operators can verify run boundary and initial inputs before live launch.
- Seeded runs clearly show that the next action is plan review.

Verification:

```text
npm run typecheck
tsc -p tsconfig.test.json
node --test dist-test/tests/unit/dashboard-frontend-smoke.test.js
node --test dist-test/tests/unit/dashboard-run-launcher.test.js
```

### Milestone 4: Run Detail Input Provenance

1. Add `inputs` to `DashboardArtifactGroup`.
2. Extend dashboard run-reader output with normalized input provenance and safe
   `DashboardArtifactLink` values for input manifest/context snapshots.
3. Add an Inputs section to run detail.
4. Link the input manifest artifact when present.
5. Link context snapshot artifacts when present and safe.
6. Display seed size/hash metadata compactly for seeded runs.
7. Preserve unsafe or missing context artifact paths as text while suppressing
   unsafe links and emitting warnings.
8. Add run-reader and frontend tests.

Acceptance criteria:

- A completed or in-progress run shows where its goal, context, and major plan
  came from.
- Old runs without input metadata remain readable.
- Unsafe input artifact paths do not produce clickable links.

Verification:

```text
npm run typecheck
tsc -p tsconfig.test.json
node --test dist-test/tests/unit/dashboard-run-reader.test.js
node --test dist-test/tests/unit/dashboard-frontend-smoke.test.js
```

### Milestone 5: Documentation and Operator Smoke

1. Update README dashboard sections.
2. Update `docs/how-to.md` local dashboard workflow.
3. Update `docs/dashboard-operator-smoke.md` with:
   - prompt launch;
   - goal-file launch;
   - context-path launch;
   - seeded-plan launch;
   - dry-run preview expectations.
4. Remove stale language that says seeded major-plan launch requires manual API
   calls.

Acceptance criteria:

- Docs match the dashboard UI and API.
- Operators can run a local dashboard smoke without reading implementation
  details.

Verification:

```text
git diff --check -- README.md docs/how-to.md docs/dashboard-operator-smoke.md phase4_plan.md
```

### Milestone 6: Final Verification

1. Run the full validation suite:

   ```text
   npm run typecheck
   npm run build
   npm run test:build
   ```

2. Manual dashboard smoke:
   - start dashboard against a temporary target repo;
   - run a prompt-text launch with `Dry run` checked;
   - run a `goalFilePath` launch with `Dry run` checked;
   - run a context-path launch with `Dry run` checked;
   - run a seeded major-plan launch with `Dry run` checked;
   - start one fake live run from the browser by unchecking `Dry run`;
   - inspect run detail input provenance.

3. Confirm no regression:
   - CLI `--goal-file`, `--context`, and `--seed-major-plan` still work;
   - programmatic `POST /api/runs` still accepts old prompt-only payloads;
   - resume dry-run/confirmation remains unchanged.

Acceptance criteria:

- Full tests pass.
- Browser and API launch paths expose the same initial-input model.
- Dashboard users no longer need manual API calls to seed a major plan.

## Risks and Notes

- Adding goal-file support to dashboard launch changes the `prompt` requirement
  from required to "required unless `goalFilePath` is supplied." Keep
  compatibility by allowing existing prompt-only request bodies unchanged.
- Fatal UTF-8 decoding for CLI goal files is a deliberate validation tightening.
  It aligns goal-file behavior with seeded major-plan validation and prevents
  silent replacement-character prompts.
- Browser path inputs must stay repository-relative. Reject absolute paths at
  request normalization before filesystem checks.
- Goal/context overlap is allowed intentionally. The same file may be both the
  goal source and a context snapshot, because those records answer different
  audit questions.
- UI should not become verbose. Prefer compact labels and dry-run report fields
  over explanatory text inside the app.
- Run detail should derive from saved state and artifacts, not from launch
  diagnostics, because runs may be created by CLI or resumed later.
- The dashboard should remain a local operator surface over the same CLI
  contract, not a separate execution engine.
