# Frontend Interface Plan

## Goal

Add an optional local dashboard for operating the existing pipeline without making
the frontend part of the orchestration core.

The dashboard should let a user:

- Enter an initial task prompt.
- Start a dry run or real run with selected pipeline options.
- See the current run, current phase, active milestone, and latest action.
- Inspect the ordered steps already taken.
- Open relevant artifacts such as plans, diffs, checks, reviews, summaries,
  timings, and runner diagnostics.
- Resume constrained or stopped runs when it is safe to do so.

The terminal CLI remains the canonical interface. Users must be able to ignore
the dashboard completely and keep using `node dist/cli/main.js ...`.

## Pillar Principles

- Separation of concerns: orchestration logic stays in `src/orchestration`,
  `src/implementation`, `src/review`, `src/planning`, and related core modules.
- Optional top module: dashboard code and dependencies must not be required for
  normal CLI usage.
- Artifact-driven visibility: the dashboard reads existing run state and
  artifacts instead of inventing a parallel state model.
- Thin launcher: the dashboard starts the same pipeline entrypoint used by the
  CLI, then observes the resulting `.agent-work/<run-id>/` artifacts.
- Local-first safety: the first dashboard is a localhost operator tool, not a
  hosted multi-user service.
- Progressive fidelity: start with phase-level progress from existing artifacts;
  add richer live events only after the basic dashboard is useful.

## Proposed Module Boundaries

```text
src/
  cli/                  existing terminal entrypoint
  orchestration/        existing workflow and state machine
  artifacts/            existing artifact path conventions
  state/                existing state shape and transitions
  dashboard/            optional dashboard backend module
    server.ts
    api-types.ts
    run-reader.ts
    run-launcher.ts
    event-stream.ts

dashboard/
  public/               static frontend assets for first implementation
    index.html
    styles.css
    app.js
```

The backend may reuse read-only helpers from core modules, but dashboard modules
must not own milestone selection, phase transitions, runner prompts, check
execution, review decisions, or artifact writing for the pipeline.

Because the current root `tsconfig.json` compiles every `src/**/*.ts` file,
`src/dashboard` must stay dependency-light and use only Node built-ins plus
existing project modules in the first implementation. If the dashboard later
needs third-party frontend or server dependencies, introduce a separate
dashboard package or dashboard-specific `tsconfig` so normal CLI builds do not
require optional dashboard dependencies.

## Data Sources

Initial dashboard visibility should come from existing durable artifacts:

- `.agent-work/<run-id>/state.json`
- `.agent-work/<run-id>/logs/timeline.jsonl`
- `.agent-work/<run-id>/logs/80-timings.json`
- `.agent-work/<run-id>/logs/81-timings.md`
- `.agent-work/<run-id>/milestones/*`
- `.agent-work/<run-id>/diffs/*`
- `.agent-work/<run-id>/checks/*`
- `.agent-work/<run-id>/reviews/*`
- `.agent-work/<run-id>/runner/*.json`

The first version should not depend on parsing Codex reasoning or live model
events for correctness. If `codex-exec` JSON events are later enabled, they can
be exposed as an enhancement.

## Dashboard API Contracts

Define these shared contracts in `src/dashboard/api-types.ts` before building the
server or frontend. The server should be the only producer of these shapes.

```ts
export type DashboardArtifactGroup =
  | "goal"
  | "plans"
  | "milestones"
  | "diffs"
  | "checks"
  | "reviews"
  | "summaries"
  | "fixes"
  | "logs"
  | "runner";

export interface DashboardWarning {
  code: string;
  message: string;
  source: "state" | "timeline" | "artifact" | "server" | "launcher";
  details?: unknown;
}

export interface DashboardArtifactLink {
  id: string;
  group: DashboardArtifactGroup;
  label: string;
  relativePath: string;
  href: string;
  mediaType: string;
  exists: boolean;
  sizeBytes?: number;
  updatedAt?: string;
  milestoneId?: number | null;
  source: "state" | "known-path" | "derived";
}

export interface DashboardTimelineEvent {
  index: number;
  timestamp: string | null;
  event: string;
  phase?: string;
  status?: string;
  currentMilestoneId?: number | null;
  invocationId?: string;
  raw: unknown;
}

export interface DashboardRunSummary {
  runId: string;
  runDir: string;
  goal: string;
  status: string;
  currentPhase: string;
  currentMilestoneId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  active: boolean;
  warnings: DashboardWarning[];
}

export interface DashboardRunDetail extends DashboardRunSummary {
  milestoneStatuses: Record<string, string>;
  lastError: unknown | null;
  artifacts: Record<DashboardArtifactGroup, DashboardArtifactLink[]>;
  timeline: DashboardTimelineEvent[];
  timingArtifacts: DashboardArtifactLink[];
  runnerDiagnostics: DashboardArtifactLink[];
  statePath: string;
}

export interface DashboardErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

Artifact URLs must use `DashboardArtifactLink.id`, not client-supplied filesystem
paths or raw filenames. Generate each id from the normalized run-relative path,
for example a URL-safe base64url encoding or deterministic slug plus short hash.
The server must resolve the id by looking it up in the selected run model.

Use these HTTP endpoints for the first read-only slice:

- `GET /api/runs` returns `{ runs: DashboardRunSummary[] }`.
- `GET /api/runs/:runId` returns `DashboardRunDetail`.
- `GET /api/runs/:runId/artifacts/:artifactId` returns the artifact content.
- All errors return `DashboardErrorResponse`.

## Local Security Contract

The dashboard is local-only, but mutating endpoints still need browser-origin
protection before task launch or resume is added.

- Bind to `127.0.0.1` by default, not `0.0.0.0`.
- Reject requests whose `Host` header is not `127.0.0.1:<port>` or
  `localhost:<port>`, unless the operator explicitly opts into another host.
- For `POST`, `PUT`, `PATCH`, and `DELETE`, require:
  - `Origin` absent or matching the dashboard origin exactly;
  - `Sec-Fetch-Site` absent, `same-origin`, or `none`;
  - a per-server random operator token in `X-Dashboard-Token`.
- Embed the token only in the served local `index.html` response or expose it
  through a same-origin bootstrap endpoint used by the static frontend.
- Never accept shell commands, executable paths, or arbitrary filesystem paths
  from the browser.
- Keep all launch and resume arguments allowlisted and serialized as argv array
  elements for `child_process.spawn`, never through a shell string.

## Non-Goals For The First Version

- Do not replace the CLI.
- Do not make the dashboard required for tests, builds, or normal runs.
- Do not duplicate orchestration logic in frontend or dashboard backend code.
- Do not add remote access, authentication, or team collaboration features.
- Do not stream private prompt or runner logs to an external service.
- Do not depend on unstable model event internals to determine pipeline state.
- Do not expose mutating dashboard endpoints without the local security contract
  above.

## Milestone 1: Run Read Model

Primary outcomes:

- Provide a stable read-only dashboard model for existing run artifacts.
- Make current run status easy to consume from UI code.

Implementation steps:

1. Add `src/dashboard/run-reader.ts`.
2. Implement a function that lists run directories under the configured artifact
   root, sorted newest first.
3. Implement a function that reads one run and returns `DashboardRunDetail`.
4. Keep this model read-only. It must never mutate `state.json`.
5. Normalize artifacts from both `state.artifacts` and known artifact locations.
6. Generate stable artifact ids from normalized run-relative paths.
7. Validate every artifact path before exposing it:
   - non-empty;
   - not absolute;
   - does not contain `..`;
   - resolves inside the selected run directory;
   - exists or is represented with `exists: false` and a warning.
8. Treat degraded run data as a readable dashboard state:
   - missing `state.json` means the directory is skipped by run listing unless a
     detail endpoint is requested directly, where it returns a structured error;
   - malformed `state.json` returns a structured error for detail and a warning
     summary when discoverable;
   - missing `logs/timeline.jsonl` returns an empty timeline and a warning;
   - malformed timeline lines are skipped and surfaced as warnings;
   - missing optional timing artifacts do not crash the model.
9. Add unit tests using fixture run directories.

Acceptance criteria:

- The reader can load a completed run.
- The reader can load a failed or `needs_human_review` run.
- Missing optional timing artifacts do not crash the dashboard model.
- Missing `logs/timeline.jsonl` produces an empty timeline plus a warning.
- Malformed timeline lines are surfaced as warnings, not fatal errors.
- Invalid artifact paths are not exposed as links.
- Every artifact link has a stable id and a server-resolvable run-relative path.

## Milestone 2: Local Dashboard Server

Primary outcomes:

- Add a local HTTP server that exposes run data and static assets.
- Keep dashboard startup separate from the CLI task runner.
- Make artifact serving safe before any artifact endpoint is exposed.

Implementation steps:

1. Add `src/dashboard/server.ts`.
2. Add a new script such as:

   ```json
   "dashboard": "npm run build && node dist/dashboard/server.js"
   ```

3. Serve static files from `dashboard/public/`.
4. Expose JSON endpoints:
   - `GET /api/runs`
   - `GET /api/runs/:runId`
   - `GET /api/runs/:runId/artifacts/:artifactId`
5. Resolve artifact requests only from the selected run model returned by
   `run-reader`; do not accept arbitrary filesystem paths from the client.
6. Validate resolved artifact paths with `path.resolve` and require every served
   file to remain inside the selected run directory.
7. Return `DashboardErrorResponse` for all API errors.
8. Restrict the server to `127.0.0.1` by default.
9. Add Host validation for every request.
10. Add a configurable port with a conservative default, for example `3737`.

Acceptance criteria:

- `npm run dashboard` starts a localhost server.
- The server lists runs from `.agent-work`.
- The server returns a normalized run detail JSON document.
- The server does not start during normal `npm run build` or CLI execution.
- Artifact endpoints cannot read files outside the selected run directory.
- Unknown artifact ids return `404` without revealing arbitrary filesystem
  details.
- Requests with invalid Host headers return `403`.

## Milestone 3: Read-Only Frontend Dashboard

Primary outcomes:

- Build the first useful dashboard without task launching.
- Let users inspect progress for runs started from the terminal.

Implementation steps:

1. Add `dashboard/public/index.html`, `styles.css`, and `app.js`.
2. Render a run list with status, phase, active milestone, and updated time.
3. Render run detail:
   - goal;
   - current phase;
   - milestone table;
   - latest timeline event;
   - last error and runner diagnostic path when present;
   - artifact links grouped by plans, diffs, checks, reviews, summaries, logs,
     and runner diagnostics.
4. Poll `GET /api/runs/:runId` on a short interval while a run is active.
5. Use restrained dashboard styling: dense, readable, and operational rather
   than marketing-oriented.

Acceptance criteria:

- A user can start a run in the terminal and watch progress in the browser.
- Completed, failed, and human-review states are visually distinct.
- Artifact links open the relevant text/JSON/diff content.
- The UI remains usable without JavaScript build tooling.
- Degraded runs show warnings instead of a blank or crashed page.

## Milestone 4: Task Launcher API

Primary outcomes:

- Let the frontend submit a prompt and start the existing pipeline.
- Keep launch behavior equivalent to terminal usage.
- Establish a reliable mapping from a dashboard launch request to the created
  run directory.

Required launch identity decision:

Before implementing `POST /api/runs`, choose one of these contracts:

1. Preferred: add a CLI `--run-id <id>` option for new runs only.
   - Validate the id as a filesystem-safe run id.
   - Reject reuse of an existing run directory through existing
     `createRunDirectory` behavior.
   - Keep the option out of normal examples unless dashboard or test tooling
     needs deterministic run ids.
2. Acceptable alternative: launch each dashboard-started run with a unique
   temporary artifact root and discover the single run created there, then
   surface that path in the dashboard.

Do not infer the created run by picking the newest `.agent-work/run-*` directory
when multiple launch sources can be active.

Required dry-run output decision:

Before implementing launch UI, add one machine-readable contract:

1. Preferred: add CLI `--json` for dry-run output and final run report output.
   The JSON shape should include `allowed`, `exitCode`, `nextAction`,
   `warnings`, `details`, and, for real runs, the exact `runId` and `runDir`.
2. Acceptable alternative: expose shared internal report builders that
   `run-launcher.ts` can call for dry-run validation without parsing CLI text.

Do not parse human-readable CLI output to decide whether launch or resume is
allowed.

Implementation steps:

1. Add `src/dashboard/run-launcher.ts`.
2. Launch the built CLI as a child process instead of reimplementing workflow
   calls in the dashboard backend.
3. Implement the chosen launch identity contract.
4. Implement the chosen machine-readable dry-run/report contract.
5. Apply the local security contract to `POST /api/runs`.
6. Accept launch options:
   - prompt;
   - runner, initially `codex-exec` and `fake`;
   - `dryRun`;
   - `milestone`;
   - `milestonePlanPolicy`;
   - `milestonePlanReviewPolicy`;
   - `allowDirty`;
   - `allowNonGitPlanning`;
   - optional artifact root.
7. Validate inputs before spawning the process.
8. Spawn the CLI with an argv array and `shell: false`.
9. Persist dashboard launch diagnostics separately from run artifacts, for
   example under `.agent-work/dashboard-launches/<launch-id>.json` or an
   equivalent dashboard-owned directory that is not treated as a pipeline run.
10. Expose:
   - `POST /api/runs`
11. Do not expose real resume from this milestone. Resume controls require the
   safety gate in Milestone 6.

Acceptance criteria:

- Submitting a prompt with `dryRun: true` performs a dry run and shows the
  resulting report.
- Submitting a prompt with `dryRun: false` starts the existing CLI pipeline.
- The dashboard response includes the exact run id or exact run directory for
  the launched run.
- The dashboard does not need to understand pipeline internals to start a run.
- Failed process spawn or missing CLI build produces a clear dashboard error.
- Concurrent terminal and dashboard runs cannot cause the dashboard to attach to
  the wrong run.
- `POST /api/runs` rejects missing or invalid dashboard tokens.
- The launcher does not parse human-readable CLI output for correctness.

## Milestone 5: Live Progress Stream

Primary outcomes:

- Improve perceived progress beyond polling.
- Show phase-level action history as it happens.
- Represent artifact visibility accurately without relying on nonexistent
  artifact-only timeline events.

Implementation steps:

1. Add `src/dashboard/event-stream.ts`.
2. Use Server-Sent Events for `GET /api/runs/:runId/events`.
3. Stream normalized events from:
   - appended timeline entries;
   - process stdout/stderr for dashboard-launched runs;
   - newly written runner diagnostics;
   - artifact changes derived by comparing successive run-reader snapshots.
4. Treat artifact events as derived dashboard events unless the core timeline is
   later extended to record artifact-only writes explicitly.
5. Keep polling as a fallback for browsers or environments where SSE fails.
6. Add a compact activity feed in the frontend:
   - invocation started;
   - phase changed;
   - milestone status changed;
   - artifact written;
   - runner diagnostic written;
   - invocation ended.

Acceptance criteria:

- The activity feed updates while a run is active.
- Refreshing the browser reconstructs history from durable artifacts.
- Live streaming is an enhancement, not the source of truth.
- Artifact-written entries are either derived reproducibly from state/artifact
  snapshots or backed by a deliberate core timeline extension.
- SSE events use documented event names and JSON payloads from `api-types.ts`.

## Milestone 6: Resume And Operator Controls

Primary outcomes:

- Make safe resume paths visible and operable from the dashboard.
- Avoid hiding risks from the user.
- Add resume only after dry-run safety reporting is wired into the dashboard.

Implementation steps:

1. Reuse existing dry-run resume reporting where possible.
2. Use the machine-readable dry-run contract from Milestone 4. Do not parse
   human-readable CLI output.
3. Show the dry-run next action before offering a real resume.
4. Store each successful resume dry-run response under a dashboard-owned
   directory with:
   - run id;
   - selected options;
   - allowed flag;
   - next action;
   - warnings;
   - generated confirmation token;
   - creation timestamp;
   - short expiration time.
5. Add controls for:
   - resume dry run;
   - real resume;
   - `--allow-dirty`;
   - plan policy override;
   - plan review policy override.
6. Render saved policy versus effective policy when they differ.
7. Show `needs_human_review` states as terminal until the user explicitly takes
   action outside the dashboard or starts a new run.
8. Apply the local security contract to both resume endpoints.
9. Expose `POST /api/runs/:runId/resume/dry-run`.
10. Expose `POST /api/runs/:runId/resume` only after the dry-run response is
   allowed and the request includes an explicit confirmation token or matching
   dry-run result id.

Acceptance criteria:

- The dashboard does not resume unsafe transient states silently.
- A resume-time override is shown as per-invocation only.
- Dirty-tree resume requires an explicit user option.
- Real resume cannot be called without a successful resume dry run for the same
  run and selected options.
- Resume confirmation tokens are single-use or expire quickly.
- Resume endpoints reject missing or invalid dashboard tokens.

## Milestone 7: Optional Dependency Packaging

Primary outcomes:

- Keep frontend dependencies isolated from core CLI usage.
- Make dashboard installation and execution obvious.

Implementation steps:

1. Decide whether the first dashboard remains static HTML/JS or moves to a
   frontend build tool.
2. If frontend dependencies are added, isolate them under `dashboard/` or clearly
   mark them as dashboard-only.
3. If dashboard backend dependencies are added, move dashboard backend build
   output behind a dashboard-specific package or `tsconfig` instead of importing
   those dependencies from the core `src/**/*.ts` build.
4. Ensure `npm run build`, `npm run typecheck`, and CLI runs do not require a
   browser build or optional dashboard dependency installation.
5. Add dashboard-specific scripts only:
   - `npm run dashboard`;
   - optional `npm run dashboard:build`;
   - optional `npm run dashboard:test`.
6. Document dashboard usage in `docs/how-to.md`.

Acceptance criteria:

- Existing CLI instructions remain valid.
- Users who never run the dashboard do not need to learn dashboard concepts.
- Dashboard failures do not block ordinary pipeline operation.
- A clean CLI-only install/build path remains possible without frontend tooling.

## Milestone 8: Testing And Hardening

Primary outcomes:

- Prove the dashboard is reliable enough for local operator use.
- Avoid accidental command exposure.

Implementation steps:

1. Add unit tests for run-reader normalization.
2. Add server endpoint tests with fixture artifacts.
3. Add launcher tests using a fake CLI command.
4. Add frontend smoke tests only after the UI stabilizes.
5. Add concurrency tests proving dashboard-launched runs map to the intended run
   id or isolated artifact root.
6. Add tests for Host validation, Origin validation, `Sec-Fetch-Site` handling,
   and dashboard token enforcement on mutating endpoints.
7. Add tests for malformed state, missing timeline, malformed timeline lines,
   and unsafe artifact paths.
8. Bind to localhost by default and document the security model.
9. Add clear error states for:
   - missing `.agent-work`;
   - no runs;
   - malformed state;
   - missing artifacts;
   - CLI process failure;
   - dirty tree block;
   - missing `codex`.

Acceptance criteria:

- Dashboard tests run offline by default.
- No real `codex` invocation is required for deterministic dashboard tests.
- Artifact endpoint path safety remains covered by Milestone 2 tests.
- Launch identity remains correct under concurrent run creation.
- Mutating endpoint protections are covered by endpoint tests before launch or
  resume is exposed.

## Suggested First Implementation Slice

The first practical slice should be milestones 1 through 3 only:

1. Read existing run artifacts.
2. Serve a local dashboard.
3. Display run progress and artifact links.

That gives immediate value without command-launching risk. It is implementation
ready when the `api-types.ts` contracts, artifact id resolver, degraded-state
warnings, Host validation, and read-only endpoint tests are complete. Once the
read-only dashboard is useful, task submission can be added as a thin launcher
around the existing CLI after the local security and machine-readable dry-run
contracts are in place.

## Completion Definition

This frontend interface work is complete when:

- CLI-only usage remains unchanged.
- The dashboard starts only when explicitly requested.
- A user can start a task from the dashboard or terminal.
- The dashboard shows current phase, current milestone, ordered action history,
  terminal state, last error, timings, and artifact links.
- The dashboard does not duplicate pipeline state-machine logic.
- Tests prove artifact reading, server APIs, launcher behavior, and path safety.
- Mutating endpoints require local origin checks and a dashboard token.
- Launch and resume decisions use machine-readable reports, not parsed terminal
  text.
