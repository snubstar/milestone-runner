# Fix Issue 3 Plan: Make Run Inputs and Target Repository Explicit

## Motivation

`desiderata.md` points at a broader usability gap that is now more important
than another narrow review-evidence patch.

The orchestrator currently has an implicit run boundary:

- The target repository is `process.cwd()` for new CLI runs.
- Config lookup, artifact paths, Git preflight, checks, dashboard run listing,
  dashboard launch/resume, and `codex exec --cd` all derive from that same
  working directory.
- The initial goal is supplied as CLI argv or as a dashboard prompt string.
- Dashboard launch input rejects prompts over 20,000 characters.
- Files or docs mentioned by the initial goal are not validated, recorded as
  run inputs, or presented to the planning agent as explicit readable context.
- The Codex account is ambient shell state. Config can pass a Codex profile, but
  run reports do not make the selected runner identity clear enough for an
  operator.

This creates avoidable ambiguity for real use:

- If the orchestrator repository is separate from the repository being edited,
  it is unclear whether the operator should run this tool from the target repo,
  copy the tool into that repo, or reference that repo from the prompt.
- Long or structured initial instructions are awkward because shell argv and
  browser text limits become part of the product behavior.
- The agent may be told to inspect files, but the pipeline does not know which
  files are intended inputs or whether they are accessible.
- Operators cannot easily see which local Codex profile/account is associated
  with a run before it starts.

Before adding seeded-plan mode, the pipeline needs a clear contract for:

1. where work happens,
2. which initial inputs are authoritative, and
3. which runner identity will execute the work.

## Goals

- Add an explicit target repository/workspace selector for new CLI runs and
  resumes.
- Preserve the current behavior when no target repository is specified, except
  for intentionally rejecting unsafe/absolute artifact-root values so artifact
  ownership is deterministic.
- Make it clear that the orchestrator does not need to be duplicated into every
  target repository.
- Allow long initial goals through a file-based input path instead of relying on
  shell argv or dashboard prompt size.
- Allow the operator to attach specific repository files/docs as initial
  planning context.
- Validate and record those initial input files before the first runner call.
- Include initial input references in planning prompts so the agent knows what
  to read.
- Surface runner identity information, especially Codex profile/account label,
  in dry runs, final reports, state snapshots, and runner diagnostics.
- Keep all new behavior deterministic and testable with the fake runner.

## Non-Goals

- Do not implement seeded major-plan mode in this issue. This plan prepares the
  run-input contract that seeded plans should reuse.
- Do not manage Codex authentication, API keys, or secrets.
- Do not infer or verify the actual authenticated remote OpenAI/Codex account.
  The pipeline can label and pass profiles, but the Codex CLI owns auth.
- Do not allow arbitrary browser users to choose host filesystem paths through
  the dashboard.
- Do not support arbitrary external context files by default. Initial context
  should be inside the selected target repository unless a later plan adds an
  explicit external-file policy.
- Do not change milestone execution semantics, review strictness, fix-loop
  behavior, or dashboard artifact rendering beyond showing the new run boundary.

## Desired Operator UX

From inside the target repository, existing commands keep working:

```bash
node /path/to/orchestrator/dist/cli/main.js --runner codex-exec \
  "Add a short manual testing section to README.md"
```

From the orchestrator repository, an operator can target another repository
without copying the tool:

```bash
node dist/cli/main.js --repo /path/to/target-repo --runner codex-exec \
  --goal-file docs/task.md \
  --context README.md \
  --context docs/architecture.md
```

Relative `--goal-file`, `--context`, `--config`, and `--artifact-root` values
resolve against the target repository. Absolute `--config` paths remain allowed
for operators who want a central config file. Absolute or escaping
`--artifact-root` values are rejected so run artifacts stay under the selected
target repository.

Dry run output should make the boundary obvious:

```text
Invocation cwd: /path/to/orchestrator
Target repository: /path/to/target-repo
Config: /path/to/target-repo/orchestrator.config.json
Artifact root: /path/to/target-repo/.agent-work
Goal source: docs/task.md
Initial context files: README.md, docs/architecture.md
Runner: codex-exec
Runner profile: work-profile
Runner account label: work-codex
```

The dashboard should support the same model through a server-level target repo:

```bash
npm run dashboard -- --repo /path/to/target-repo --artifact-root .agent-work
```

The browser UI may still send a prompt string initially, but dashboard-launched
CLI processes should run against the configured target repository and show that
target in diagnostics.

## Design

### Target Repository Resolution

Add a target repository resolver used by CLI new runs, CLI resumes, and the
dashboard.

Suggested CLI option:

```text
--repo <path>
```

Rules:

- If `--repo` is omitted, `targetCwd = process.cwd()`.
- If `--repo` is provided, resolve it against `process.cwd()` and canonicalize
  it with `realpath`.
- The target must exist and be a directory.
- New-run config lookup uses `targetCwd`.
- New-run environment validation, Git preflight, run path construction, checks,
  and runner calls use `targetCwd`.
- `artifactRoot` remains a config/CLI value, but it must be a non-empty relative
  path that stays inside `targetCwd` after normalization. Reject absolute
  artifact roots, `..` segments, empty segments, and normalized values of `.`
  or `..`. This intentionally aligns CLI behavior with the dashboard artifact
  root policy.
- `--config custom.json` resolves inside `targetCwd`; absolute config paths are
  respected.
- Resume by run id resolves under `targetCwd` plus `artifactRoot`.
- Resume by direct run directory or direct `state.json` path may be absolute.
- Resume still verifies that the saved workspace target or saved Git root
  matches an explicit `--repo` when one is provided.
- If `--repo` is omitted during direct-path resume, newer state files use the
  saved `workspace.targetCwd` as the work directory. Older state files fall back
  to the existing Git-root matching behavior, and old planning-only non-Git
  states may use the invocation cwd only for phases that are already safe today.

Keep three roots separate throughout the implementation:

```ts
interface WorkspaceResolution {
  invocationCwd: string; // shell cwd where the CLI or dashboard server was started
  targetCwd: string;     // repository/workspace where runner, Git, checks, and artifacts operate
  repoExplicit: boolean;
}

interface ResourceResolution {
  orchestratorRoot: string; // installed orchestrator project root
  promptDir: string;        // <orchestratorRoot>/src/prompts
  schemaRoot: string;       // <orchestratorRoot>/schemas
}
```

`targetCwd` must never be used to locate bundled orchestrator prompts or JSON
schemas. Refactor workflow options so runner/check/Git work receives
`targetCwd`, while prompt loading and output-schema lookup receive
`promptDir`/`schemaRoot` from `ResourceResolution`.

For the CLI, resolve `orchestratorRoot` from the current module URL rather than
from `process.cwd()`. The helper should derive `moduleDir =
dirname(fileURLToPath(import.meta.url))`, try these candidates in order, and
accept the first directory containing both `schemas/milestones.schema.json` and
`src/prompts/major-plan.md`:

```ts
[
  path.resolve(moduleDir, "../.."),   // dist/cli/main.js or src/cli/main.js
  path.resolve(moduleDir, "../../.."), // dist-test/src/cli/main.js
  process.cwd(),
]
```

Tests may pass an explicit resource root through internal helpers. Dashboard
`cwd` remains the tool/server root used for static assets and CLI path
resolution, while dashboard `targetCwd` is the repository being operated on.

Persist the selected target in state. Prefer adding an explicit field rather
than relying only on `git.root`, because planning-only non-Git runs can have no
Git root.

Suggested state additions for new state files:

```ts
workspace?: {
  targetCwd: string;
  invocationCwd: string;
};
```

The fields are optional in the TypeScript interface because existing state
files do not contain them. New runs must always write `workspace`. Resume code
should normalize loaded state through a helper instead of assuming these fields
exist.

### Initial Goal and Context Inputs

Add file-based input options:

```text
--goal-file <path>
--context <path>
```

Rules:

- A new run must receive exactly one goal source: argv goal or `--goal-file`.
- `--goal-file` is not allowed with `--resume`.
- `--context` is allowed only for new runs.
- Relative goal/context paths resolve inside `targetCwd`.
- Goal and context files must resolve inside `targetCwd`. External goal files
  are intentionally out of scope for this issue.
- Context paths must resolve inside `targetCwd`.
- Goal and context paths must be regular files.
- Reject duplicate context files after canonicalization.
- Reject symlink escapes by comparing canonical `realpath` values for
  `targetCwd` and each input file. A symlink inside the repository that points
  outside the repository is not a valid input.
- Containment checks must be segment-aware. Do not use string-prefix matching.
  Use `path.relative(canonicalTargetCwd, canonicalInputPath)` and accept only
  relative results that are non-empty, do not start with `..`, and are not
  absolute. Add sibling-prefix regressions such as target `/tmp/repo` and input
  `/tmp/repo-other/task.md`.
- Apply explicit byte limits with useful errors:
  - goal file: high enough for real prompts, for example 1 MiB,
  - each context file: for example 512 KiB,
  - total context: for example 2 MiB.
- Keep dashboard prompt limits for direct browser text, but add API/server
  support for repository-relative context paths before adding richer upload UI.

Write durable input artifacts before planning starts:

```text
inputs/
  01-inputs.json
  context/
    <n>-<safe-basename>
```

`00-goal.txt` remains the canonical goal text. `inputs/01-inputs.json` records:

- goal source type: `argv` or `file`,
- goal file path when applicable,
- target-repository-relative context paths,
- copied snapshot artifact paths,
- byte sizes,
- content hashes,
- created timestamp.

Use one concrete backwards-compatible state shape:

```ts
interface RunState {
  // existing fields...
  workspace?: {
    invocationCwd: string;
    targetCwd: string;
  };
  inputs?: {
    goalSource: {
      type: "argv" | "file";
      path: string | null;
    };
    context: Array<{
      path: string;
      artifactPath: string;
      sizeBytes: number;
      sha256: string;
    }>;
  };
  artifacts: {
    // existing fields...
    inputs?: {
      manifest: string;
      context?: Record<string, string>;
    };
  };
}
```

`inputs.*.path` values are target-repository-relative paths. Artifact paths are
run-relative paths. Older state files without `workspace` or `inputs` remain
valid for resume and dashboard read-only display; readers must treat missing
`inputs` as an empty input manifest rather than as corrupt state.

The planning prompt should receive a rendered context section that lists the
repository-relative paths and snapshot artifacts, for example:

```text
Initial context files:
- README.md
- docs/architecture.md

These files were explicitly provided by the operator. Read them before drafting
the major plan when they are relevant to the goal.
```

Avoid pasting full context file contents into every prompt in this issue. The
agent can read files from the selected target repository through the runner
working directory, and the manifest makes the input set auditable.

### Runner Account/Profile Visibility

Do not make the orchestrator responsible for authentication. Instead, make the
selected runner identity visible and auditable.

Add optional config fields:

```json
{
  "runner": {
    "type": "codex-exec",
    "command": "codex",
    "accountLabel": "work-codex",
    "options": {
      "profile": "work-profile"
    }
  }
}
```

Rules:

- `runner.accountLabel` is an operator-provided display label only.
- `runner.options.profile` remains the actual Codex CLI profile selector.
- Reports and diagnostics show both values when present.
- Do not print secrets, tokens, environment variables, or auth internals.
- If neither value is configured, reports should say the runner uses ambient
  Codex CLI authentication.

### Dashboard Boundary

Add a dashboard server option:

```text
--repo <path>
```

Rules:

- Dashboard `cwd` continues to mean the tool/server root for static assets and
  default CLI path resolution.
- Dashboard `targetCwd` means the repository whose runs are listed, launched,
  and resumed.
- If `--repo` is omitted, `targetCwd = cwd`, preserving current behavior.
- Dashboard launch/resume diagnostics include both `cwd` and `targetCwd`.
- Dashboard launch/resume CLI args include `--repo <targetCwd>`.
- Dashboard artifact root validation is relative to `targetCwd`.
- Dashboard launch requests may include repository-relative context paths, for
  example `contextPaths: ["README.md", "docs/architecture.md"]`.
- Dashboard launch validation uses the same segment-aware target-contained,
  regular-file, duplicate, symlink-escape, and byte-limit rules as the CLI.
- Dashboard launch CLI args forward context paths as repeated
  `--context <path>` values.
- Dashboard launch diagnostics record the requested context paths and the
  resolved target repository.
- The browser should not submit arbitrary repo paths in this issue; the operator
  chooses the dashboard target when starting the local server.

## Implementation Steps

1. Add regression tests first.
   - `tests/unit/cli-args.test.ts`
     - Accept `--repo`, `--goal-file`, and repeated `--context`.
     - Reject argv goal combined with `--goal-file`.
     - Reject `--goal-file` and `--context` with `--resume`.
     - Allow `--repo` with `--resume`.
   - `tests/unit/cli-main.test.ts`
     - Run the built main function from an invocation directory while targeting
       a separate fixture repo with `--repo`.
     - Assert config lookup, `.agent-work`, state, checks, and fake runner work
       happen in the target repo.
     - Assert bundled prompts, milestone schema, and output-schema paths are
       resolved from the orchestrator resource root, not from the target repo.
       The target fixture should not need `src/prompts` or `schemas`.
     - Reject absolute `--artifact-root`, `../outside`, empty, `.`, and sibling
       escape artifact roots before creating a run directory.
     - Assert dry-run text and JSON include `invocationCwd`, `targetCwd`,
       `goalSource`, context summary, runner profile, and account label.
     - Assert a goal file is copied to `00-goal.txt` and context manifest
       artifacts are written on real non-dry new runs.
     - Reject missing goal files, directory goal files, oversized goal files,
       goal files outside the target repo, sibling-prefix goal files, and
       goal-file symlink escapes before any runner call.
     - Reject missing context files, directory context files, oversized context
       files, duplicate context files, context files outside the target repo,
       sibling-prefix context files, and context symlink escapes before any
       runner call.
   - `tests/unit/cli-run-loader.test.ts`
     - Resume by run id with `--repo` resolves under the target repo artifact
       root.
     - Direct-path resume with explicit `--repo` rejects when the saved
       `workspace.targetCwd` or saved `git.root` points at a different repo.
     - Direct-path resume without `--repo` uses saved `workspace.targetCwd` for
       newer state files.
     - Older states without `workspace` still resume through existing Git-root
       matching.
     - Older planning-only non-Git states without `workspace` retain the current
       safe-phase fallback behavior.
   - `tests/unit/config-loader.test.ts`
     - Validate optional `runner.accountLabel`.
     - Reject non-string or empty account labels.
   - `tests/unit/prompt-loader.test.ts`
     - Update expected major-plan prompt variables.
     - Assert rendering includes the initial context section and provided
       repository-relative paths.
   - `tests/unit/output-schema.test.ts` or workflow tests
     - Assert codex output schemas resolve from `schemaRoot` while runner cwd is
       the target repo.
   - Dashboard tests
     - Server option resolution accepts `--repo`.
     - Launch request accepts `contextPaths`.
     - Launch request rejects invalid, duplicate, outside-target, symlink-escape,
       sibling-prefix, directory, and oversized context paths.
     - Launch/resume tests assert child CLI args include `--repo <targetCwd>`.
     - Launch tests assert child CLI args include repeated `--context` values.
     - Diagnostics include target repo separately from dashboard server cwd.
     - Diagnostics include requested context paths for launches.

2. Add CLI parsing fields.
   - Extend `CliOptions` with `repoPath`, `goalFile`, and `contextPaths`.
   - Update `usage()`.
   - Preserve existing goal parsing for argv goals.
   - Enforce option conflict rules in `parseArgs`.

3. Add target repository and resource-root resolution.
   - Create a small resolver module, for example `src/workspace/target-repo.ts`.
   - Return `{ invocationCwd, targetCwd, targetCwdDisplay, repoExplicit }`.
   - Add a resource-root resolver, for example
     `src/workspace/orchestrator-resources.ts`.
   - Resolve `orchestratorRoot`, `promptDir`, and `schemaRoot` from the CLI or
     dashboard module location, not from `targetCwd`.
   - Refactor `GoalWorkflowOptions`, planning, implementation, and review
     workflow options so:
     - runner/check/Git work receives `cwd: targetCwd`,
     - prompt loading receives `promptDir`,
     - milestone schema and output-schema lookup receive `schemaRoot`.
   - Use it at the start of `runNewWorkflow` and `runResumeWorkflow`.
   - Pass `targetCwd` to config loading, environment validation, Git preflight,
     run path creation, workflow execution, and resume loading.
   - Keep `process.cwd()` only as invocation metadata and for resolving
     user-provided relative `--repo` values.
   - Add a shared artifact-root normalizer used by CLI and dashboard so relative
     roots stay inside `targetCwd` and absolute/outside roots are rejected.

4. Add initial input resolution and artifacts.
   - Create `src/inputs/initial-inputs.ts`.
   - Resolve and validate `--goal-file` and `--context` paths.
   - Canonicalize `targetCwd` and input files with `realpath`; reject any input
     whose canonical path is not inside the canonical target repo using
     segment-aware `path.relative` containment.
   - Reject missing files, directories, duplicate context files, symlink escapes,
     and oversized inputs before creating a run directory or calling a runner.
   - Read the goal text from `--goal-file` before `createRunDirectory`.
   - Extend run paths with an `inputs` directory.
   - Write `inputs/01-inputs.json` and context snapshots after the run directory
     is created and before planning starts.
   - Record input metadata in the top-level `state.inputs` section.
   - Record input artifact paths under `state.artifacts.inputs`.

5. Include context in planning prompts.
   - Extend `PromptVariables` with a rendered initial-context section.
   - Update `src/prompts/major-plan.md` to instruct the planner to read provided
     context files when relevant.
   - Ensure the fake runner remains deterministic when context is present.
   - Include input artifact paths in runner `artifacts` for the major-plan
     phase.
   - Update prompt-loader tests so the new placeholder is required and rendered.

6. Surface runner identity. **Status: complete.**
   - Extend `RunnerConfig` with optional `accountLabel`.
   - Validate it in `config-loader`.
   - Add a formatter used by dry-run and final reports.
   - Include `accountLabel`, `profile`, and ambient-auth fallback text in JSON
     and human reports.
   - Include the same values in `CodexExecRunner` metadata without exposing
     secrets.
   - Verification:
     - `npx tsc -p tsconfig.test.json`
     - `node --test dist-test/tests/unit/config-loader.test.js dist-test/tests/unit/runners.test.js dist-test/tests/unit/runner-diagnostics.test.js dist-test/tests/unit/run-report.test.js dist-test/tests/unit/cli-main.test.js`
     - `npm run test:build` now passes 395 of 401 tests; the remaining six
       failures are the planned resume/dashboard target-repo work in steps 7
       and 8.

7. Update resume handling. **Status: complete.**
   - Persist `workspace.targetCwd` in new state.
   - Extend `loadResumeRun` inputs with the selected workspace resolution:
     `targetCwd` and `repoExplicit`.
   - For resume by run id, always locate the state under
     `<targetCwd>/<artifactRoot>/<runId>/state.json`.
   - For direct run-directory or `state.json` resume, locate the state from the
     direct path first, then choose the runner target:
     - if `--repo` was explicit, require it to match saved `workspace.targetCwd`
       when present, otherwise saved `git.root` when present;
     - if `--repo` was omitted and saved `workspace.targetCwd` is present, use
       the saved workspace target;
     - if `--repo` was omitted and only saved `git.root` is present, keep the
       existing current-Git-root mismatch protection;
     - if no saved workspace or Git root exists, allow the existing
       planning-only non-Git safe-phase fallback only.
   - Normalize loaded state so `state.workspace` and `state.inputs` can be read
     safely by reports and dashboard code even when old state files omit them.
   - Keep the existing saved Git-root mismatch protection for phases that may
     need Git.
   - Verification:
     - `npx tsc -p tsconfig.test.json`
     - `node --test dist-test/tests/unit/cli-run-loader.test.js`
     - `node --test dist-test/tests/unit/cli-main.test.js`
     - `npm run test:build` now passes 397 of 401 tests; the remaining four
       failures are dashboard target-repo/context forwarding work in step 8.

8. Update dashboard launch/resume. **Status: complete.**
   - Add `targetCwd` to dashboard server options and request context.
   - Add `--repo` to dashboard server CLI parsing.
   - Use `targetCwd` for run reading, artifact root resolution, run id
     uniqueness, launch/resume diagnostics, and CLI `--repo` forwarding.
   - Keep `cwd` for static root and CLI path resolution.
   - Add `contextPaths?: string[]` to `DashboardLaunchRequest`.
   - Validate launch `contextPaths` through the same input resolver used by CLI
     new runs, without reading or persisting goal files from the browser.
   - Forward each launch context path as `--context <path>`.
   - Persist requested context paths in dashboard launch diagnostics.
   - Update dashboard docs to show `npm run dashboard -- --repo <path>`.
   - Verification:
     - `npx tsc -p tsconfig.test.json`
     - `node --test dist-test/tests/unit/dashboard-run-launcher.test.js dist-test/tests/unit/dashboard-run-resumer.test.js dist-test/tests/unit/dashboard-server.test.js`
     - `npm run test:build` passes 401 of 401 tests.

9. Update docs. **Status: complete.**
   - Update `README.md` and `docs/how-to.md`.
   - Add a short "Target repositories" section:
     - run from the target repo, or
     - run from the orchestrator repo with `--repo`.
   - Clarify config location rules.
   - Document that `artifactRoot` is relative to the target repo and absolute or
     outside-target artifact roots are rejected.
   - Document `--goal-file`, `--context`, and input size limits.
   - Clarify Codex account/profile behavior and what the pipeline can and
     cannot verify.
   - Verification:
     - `git diff --check -- README.md docs/how-to.md fix_issue3_plan.md`

10. Verify. **Status: complete.**
    - `npm run typecheck`
    - `npm run build`
    - `npm run test:build`
    - Optional manual fake dry run from outside a fixture target repo.
    - Optional dashboard dry run against a target repo.
    - Verification:
      - `npm run typecheck`
      - `npm run build`
      - `npm run test:build` passes 402 of 402 tests.
      - Manual fake planning dry run from outside `/private/tmp` target repo
        passed with `--repo`, `--goal-file`, and `--context`.
      - Dashboard dry run against a temporary target repo passed after creating
        the expected target `.gitignore` entry for `.agent-work/`.

## Acceptance Criteria

- Existing CLI commands without `--repo`, `--goal-file`, or `--context` behave
  as before for default and target-contained relative artifact roots.
- A new fake run can be invoked from outside the target repo and still writes
  artifacts, state, checks, and fake-runner output inside the target repo.
- The same outside-target run uses orchestrator-owned prompts and schemas from
  the orchestrator resource root; the target repo does not need copies of
  `src/prompts` or `schemas`.
- Absolute, empty, current-directory, parent-directory, and outside-target
  artifact roots are rejected consistently by CLI and dashboard paths.
- A resume by run id works from outside the target repo when `--repo` is
  provided.
- Direct-path resume with explicit `--repo` rejects if the selected repo does
  not match the saved workspace or saved Git root.
- Direct-path resume without `--repo` uses saved `workspace.targetCwd` for new
  states and preserves the old Git-root fallback for old states.
- Dry-run human and JSON output clearly show invocation cwd, target repo,
  artifact root, goal source, context inputs, runner profile, and account label.
- A goal file can provide long initial instructions without relying on shell
  argv length.
- Context files are validated, recorded in a manifest, snapshotted as local run
  artifacts, and listed in the major-plan prompt.
- Invalid goal/context paths, duplicate context files, directories, files
  outside the target repo, sibling-prefix escapes, symlink escapes, and
  oversized inputs fail before any runner call.
- Dashboard launches and resumes operate on the configured target repo while
  preserving current behavior when no dashboard `--repo` is supplied.
- Dashboard launches can forward validated repository-relative context paths to
  the CLI and record them in diagnostics.
- No secrets or authentication internals are persisted.

## Follow-Up

After this issue lands, seeded-plan mode should be a separate small plan:

- `--seed-major-plan <file>` writes `plans/01-major-plan.md`,
- the pipeline treats `major_plan` as complete,
- plan review, final major plan, milestone JSON, milestone implementation,
  checks, and review still run normally,
- seeded plan input uses the same target repo and input artifact rules from
  this issue.
