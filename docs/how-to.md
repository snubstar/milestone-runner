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

If the starting dirty tree is deliberate:

```bash
node dist/cli/main.js --allow-dirty --runner codex-exec --milestone 1 \
  "Add a short manual testing section to README.md"
```

## Inspect A Run

```bash
RUN_DIR=$(ls -td .agent-work/run-* | head -1)

find "$RUN_DIR" -maxdepth 3 -type f | sort
cat "$RUN_DIR/state.json"
ls "$RUN_DIR/runner"
```

Important locations:

- `diffs/`: Git diffs captured by the orchestrator.
- `checks/`: deterministic check reports.
- `reviews/`: review verdict JSON.
- `runner/`: stdout, stderr, args, sandbox, timeout, and schema diagnostics for real runner calls.
- `state.json`: final status and all artifact paths.

## Resume

```bash
node dist/cli/main.js --resume "$RUN_DIR" --dry-run
node dist/cli/main.js --resume "$RUN_DIR"
```

Use `--allow-dirty` on resume only when the current working tree changes are intentional.

## Opt-In Real Smoke Test

```bash
RUN_REAL_CODEX=1 npm run test:real-codex
```

Without `RUN_REAL_CODEX=1`, the smoke test compiles and skips safely.
