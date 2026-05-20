# Manual Run Guide

Use this guide when you want to exercise the orchestrator from the command line.

## Build

```bash
npm run build
```

## Target Repositories

Run from the repository you want the orchestrator to operate on:

```bash
cd /path/to/target-repo
node /path/to/orchestrator/dist/cli/main.js --runner fake \
  "Add a docs note explaining how to run the orchestrator manually"
```

Or run from the orchestrator checkout and select the target explicitly:

```bash
node dist/cli/main.js --repo /path/to/target-repo --runner fake \
  "Add a docs note explaining how to run the orchestrator manually"
```

The selected target repository is where Git preflight checks, configured
checks, runner work, and artifacts happen. Relative `--config`, `--goal-file`,
`--context`, `--seed-major-plan`, and `--artifact-root` values resolve inside
that target. The default config search also runs in the target:
`orchestrator.config.json` first, then `orchestrator.config.example.json`.
Absolute `--config` paths are allowed for a central operator config, but resume
uses the config snapshot saved in state.

`artifactRoot` is relative to the target repository. Absolute paths, `..`
escapes, and malformed relative paths are rejected.

## Goal And Context Files

Use `--goal-file` instead of an argv goal when the prompt should live in the
target repository:

```bash
node dist/cli/main.js --repo /path/to/target-repo --runner fake \
  --goal-file tasks/goal.md
```

Attach target-repository files to planning with repeated `--context` flags:

```bash
node dist/cli/main.js --repo /path/to/target-repo --runner fake \
  --context README.md \
  --context docs/architecture.md \
  "Update the documented architecture"
```

Goal and context files must resolve inside the target repository after symlink
resolution. The goal file limit is 1 MiB, each context file is limited to
512 KiB, and total context is limited to 2 MiB. Non-dry runs write
`inputs/01-inputs.json` plus context snapshots under `inputs/context/`.

## Seeded Major Plans

Use `--seed-major-plan` when the operator has already drafted the first major
plan and wants the workflow to start runner planning at plan review.

From inside the target repository:

```bash
cd /path/to/target-repo
node /path/to/orchestrator/dist/cli/main.js --runner fake \
  --goal-file tasks/goal.md \
  --seed-major-plan tasks/major-plan.md
```

From the orchestrator checkout, point at the target explicitly:

```bash
node dist/cli/main.js --repo /path/to/target-repo --runner codex-exec \
  --goal-file tasks/goal.md \
  --context README.md \
  --seed-major-plan tasks/major-plan.md
```

Seed files must live inside the target repository after symlink resolution, must
be valid non-empty UTF-8 text, and are limited to 1 MiB. A seed file can also
appear in `--context` when it should be listed with the other operator-provided
context.

Seeded runs copy the seed text to `plans/01-major-plan.md` and record source
path, size, and hash in `inputs/01-inputs.json` and `state.json`. Reports show
the major plan source as seeded. Seeded mode skips only the runner-generated
`major_plan` call; the seeded draft is still reviewed by `major_plan_review`,
rewritten into the final major plan, converted to milestone JSON, and then used
by the normal milestone workflow.

Do not pass `--seed-major-plan` on resume. Resume uses the saved seeded state:
it reuses `plans/01-major-plan.md` when present, or recreates it only if the
saved source file still matches the saved metadata. Changed or missing seed
inputs block resume rather than falling back to a runner-generated major plan.

## Fake Runner

The fake runner is deterministic and offline:

```bash
node dist/cli/main.js --runner fake --milestone 1 \
  "Add a docs note explaining how to run the orchestrator manually"
```

The general plan is always produced. To skip only the runner-backed per-milestone plan for simple tasks, add a milestone plan policy:

```bash
node dist/cli/main.js --runner fake --milestone 1 \
  --milestone-plan-policy light \
  "Add a docs note explaining how to run the orchestrator manually"
```

To review and correct each per-milestone plan before implementation, opt into scrupulous mode:

```bash
node dist/cli/main.js --runner fake --milestone 1 \
  --milestone-plan-review-policy scrupulous \
  "Add a docs note explaining how to run the orchestrator manually"
```

Scrupulous mode keeps the goal-level plan flow unchanged. The selected `milestonePlanPolicy` still controls the initial per-milestone draft: `always` uses a runner-backed plan, `auto` chooses between full and lightweight drafts, and `light` always creates a deterministic lightweight draft. Scrupulous mode then reviews that draft and writes the corrected final plan used by implementation.

Expected behavior:

- Creates `.agent-work/<run-id>/`.
- Writes planning, milestone, check, diff, review, summary, and state artifacts.
- Creates `fake-milestone-1-implementation.txt`.
- Prints milestone `1: passed`.
- Leaves later generated milestones resumable when `--milestone 1` is used.

## Real Codex Runner

Prerequisites:

- `codex` is installed and authenticated.
- The target repository is a Git repository with at least one commit.
- The working tree is clean unless you pass `--allow-dirty`.
- `orchestrator.config.json` exists in the target repository, an absolute
  `--config` is supplied, or the target repository's example config is acceptable.

Run a real one-milestone task from a clean tree:

```bash
git status --short

node dist/cli/main.js --runner codex-exec --milestone 1 \
  "Add a short manual testing section to README.md"
```

For a simple real task where the general plan is enough, use a lightweight per-milestone plan:

```bash
node dist/cli/main.js --runner codex-exec --milestone 1 \
  --milestone-plan-policy light \
  "Add a short manual testing section to README.md"
```

The review policy can also be set explicitly:

```bash
node dist/cli/main.js --runner codex-exec --milestone 1 \
  --milestone-plan-review-policy scrupulous \
  "Add a short manual testing section to README.md"
```

If the starting dirty tree is deliberate:

```bash
node dist/cli/main.js --allow-dirty --runner codex-exec --milestone 1 \
  "Add a short manual testing section to README.md"
```

Codex account selection remains the Codex CLI's responsibility. The orchestrator
passes `runner.options.profile` through to `codex exec` when configured and
reports optional `runner.accountLabel` in dry-run/final output and diagnostics.
That label is for operator clarity only; the pipeline cannot independently
prove which remote Codex account the local CLI will use.

## Task Launchers

For repeatable real tasks, keep a task-specific launcher under `tasks/`. The
script should contain the prompt and the pipeline flags for that task, then call
the built CLI with `-- "$PROMPT"` to avoid shell quoting problems.

Start from `tasks/task-template.sh`, replace the placeholder prompt, and run a
dry run before allowing a real execution:

```bash
tasks/run-your-task.sh --dry-run
tasks/run-your-task.sh
```

## Inspect A Run

```bash
RUN_DIR=$(ls -td .agent-work/run-* | head -1)

find "$RUN_DIR" -maxdepth 3 -type f | sort
cat "$RUN_DIR/state.json"
ls "$RUN_DIR/runner"
```

Important locations:

- `milestones/10-milestone-<id>-plan.md`: final per-milestone plan artifact used for implementation. It may be full, lightweight, or scrupulously corrected depending on `milestonePlanPolicy` and `milestonePlanReviewPolicy`.
- `milestones/10-milestone-<id>-plan-draft.md` and `milestones/10-milestone-<id>-plan-review.md`: scrupulous-mode trace artifacts for the initial draft and its review.
- `diffs/`: Git diffs captured by the orchestrator.
- `checks/`: deterministic check reports.
- `reviews/`: review verdict JSON.
- `runner/`: stdout, stderr, args, sandbox, timeout, and schema diagnostics for real runner calls.
- `state.json`: final status and all artifact paths.

## Inspect Timing

Each non-dry run writes timing artifacts under `logs/`:

- `logs/timeline.jsonl`: append-only state transition and invocation timeline.
- `logs/80-timings.json`: machine-readable timing document.
- `logs/81-timings.md`: human-readable timing summary.

```bash
cat "$RUN_DIR/logs/81-timings.md"
cat "$RUN_DIR/logs/80-timings.json"
```

`lifecycleDurationMs` spans the original run creation through the latest measured run end, so it includes idle time between stopped and resumed invocations. `activeWorkflowDurationMs` sums workflow invocation spans and excludes that idle time. `latestInvocationDurationMs` covers only the invocation that just finalized the timing artifacts.

Runner and check durations are nested inside workflow phase duration. Use them to identify slow model calls or verification commands, but do not add runner/check totals to workflow duration as total runtime.

## Resume

```bash
node dist/cli/main.js --resume "$RUN_DIR" --dry-run
node dist/cli/main.js --resume "$RUN_DIR"
node dist/cli/main.js --resume "$RUN_DIR" --milestone-plan-policy auto
node dist/cli/main.js --resume "$RUN_DIR" --milestone-plan-review-policy scrupulous
```

Use `--allow-dirty` on resume only when the current working tree changes are intentional. Resume policy overrides are per-invocation and affect only future milestone planning work reached during that invocation.

Scrupulous draft, review, and corrected-plan generation are internal to the existing `implementing` phase. If a run is interrupted during those steps, resume is conservative and stops for human review when implementation-ready artifacts are incomplete. The resume override above does not persist into the saved config snapshot and does not regenerate artifacts for a milestone already stopped in a transient `implementing` state.

## Local Dashboard

The dashboard is an optional localhost operator view over the same runs and
artifacts used by the CLI. Terminal usage remains unchanged if you never start
the dashboard.

Start the dashboard:

```bash
npm run dashboard
```

By default, this builds the project and serves the dashboard at
`http://127.0.0.1:3737`.

Dashboard launch and resume actions call the same built CLI entrypoint used by
terminal runs. The server binds to `127.0.0.1` by default, checks the request
host and browser origin for mutating requests, and uses a per-server operator
token for launch and resume requests from the served page.

When `--repo` is supplied, the dashboard still serves static assets from this
checkout, but run listing, launch, resume, diagnostics, and artifact roots use
the selected target repository.

For launch and resume actions in a Git repository, the dashboard artifact root
must be ignored by Git, for example `.agent-work/` in `.gitignore`, unless
`Allow dirty` is intentional. This prevents dashboard diagnostics from dirtying
the target before the child CLI performs its own preflight.

The run list distinguishes an empty artifact root from a missing or invalid
artifact root. Malformed run state stays visible as an unreadable run with a
warning, and missing artifacts are shown as missing links rather than hidden.
Launch and resume dry-runs surface CLI blocks such as dirty-tree protection or
missing runner tools before starting a mutating process.

The browser launch form supports the same new-run intake fields as the CLI:
prompt text or a repository-relative goal file, optional repository-relative
context paths, and an optional repository-relative seeded major-plan path.
Context paths are entered one per line. Blank lines are ignored. Browser path
fields are repository-relative only; absolute host paths are rejected before
filesystem resolution.

Keep `Dry run` checked for the first submit. The launch preview shows the
target repository, artifact root, goal source, context inputs, major-plan
source, runner type/profile/account label, and next action. Clear `Dry run`
only after that boundary is correct.

Run detail includes an `Inputs` section for runs that recorded initial-input
state. It shows the saved goal source, input manifest, context snapshot artifact
links, and seeded major-plan size/hash metadata. Older runs without input
metadata remain readable and show unavailable input provenance.

Useful server options can be passed after `--`:

```bash
npm run dashboard -- --port 4747
npm run dashboard -- --repo /path/to/target-repo
npm run dashboard -- --artifact-root .agent-work
npm run dashboard -- --cli-path dist/cli/main.js
```

Available options:

- `--port <port>`: listen on a different port.
- `--host <host>`: bind to a different host. Use the default for local-only operation.
- `--repo <path>`: operate on a target repository while serving assets from this checkout.
- `--artifact-root <path>`: read runs from a different artifact root relative to the target repository.
- `--static-root <path>`: serve dashboard assets from a different static root.
- `--cli-path <path>`: launch or resume through a different built CLI entrypoint.

If the dashboard fails to start or a browser action fails, ordinary CLI commands
can still be run directly from the terminal.

## Opt-In Real Smoke Test

```bash
RUN_REAL_CODEX=1 npm run test:real-codex
```

Without `RUN_REAL_CODEX=1`, the smoke test compiles and skips safely.
