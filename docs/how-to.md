# Manual Run Guide

Use this guide when you want to exercise the orchestrator from the command line.

## Build

```bash
npm run build
```

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
- The target directory is a Git repository with at least one commit.
- The working tree is clean unless you pass `--allow-dirty`.
- `orchestrator.config.json` exists or `orchestrator.config.example.json` is acceptable.

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

The run list distinguishes an empty artifact root from a missing or invalid
artifact root. Malformed run state stays visible as an unreadable run with a
warning, and missing artifacts are shown as missing links rather than hidden.
Launch and resume dry-runs surface CLI blocks such as dirty-tree protection or
missing runner tools before starting a mutating process.

Useful server options can be passed after `--`:

```bash
npm run dashboard -- --port 4747
npm run dashboard -- --artifact-root .agent-work
npm run dashboard -- --cli-path dist/cli/main.js
```

Available options:

- `--port <port>`: listen on a different port.
- `--host <host>`: bind to a different host. Use the default for local-only operation.
- `--artifact-root <path>`: read runs from a different artifact root.
- `--static-root <path>`: serve dashboard assets from a different static root.
- `--cli-path <path>`: launch or resume through a different built CLI entrypoint.

If the dashboard fails to start or a browser action fails, ordinary CLI commands
can still be run directly from the terminal.

## Opt-In Real Smoke Test

```bash
RUN_REAL_CODEX=1 npm run test:real-codex
```

Without `RUN_REAL_CODEX=1`, the smoke test compiles and skips safely.
