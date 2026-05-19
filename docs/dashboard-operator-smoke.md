# Dashboard Operator Smoke Test

Use this short smoke test when checking the local dashboard against the same
run artifacts and CLI entrypoint used by terminal runs.

## Start The Local Dashboard

```bash
npm run dashboard
```

The default server is `http://127.0.0.1:3737`, with `.agent-work` as the
artifact root and `dist/cli/main.js` as the CLI entrypoint. To point at an
existing artifact root, start it with:

```bash
npm run dashboard -- --artifact-root .agent-work
```

## Launch A Dry Run

In the dashboard Launch form, enter a prompt, choose `fake` for an offline smoke
check or the runner you are validating, leave `Dry run` checked, then select
`Start`.

The dashboard sends the built CLI the same dry-run flag documented for terminal
usage:

```bash
node dist/cli/main.js --dry-run --runner fake "example goal"
```

Dry runs validate and report the next action without starting a mutating
workflow run.

## Launch A Real Run

Only launch a real run when the required runner credentials and local config are
ready. For `codex-exec`, the Codex CLI must be installed, available on `PATH`,
and authenticated in the shell. The target directory must be a Git repository
with at least one commit, the tree must be clean unless `Allow dirty` is
intentional, and `orchestrator.config.json` must exist unless the example config
is acceptable for the run.

In the dashboard Launch form, use `codex-exec`, fill the prompt and milestone
scope, clear `Dry run`, then select `Start`. The equivalent source-backed CLI
command is:

```bash
node dist/cli/main.js --runner codex-exec --milestone 1 \
  "Add a short manual testing section to README.md"
```

Unlike the dry run, this can edit the working tree and write workflow artifacts.

## Inspect Artifacts

Select a run in the dashboard and open the `Artifacts` section. Artifact links
are grouped from run-relative paths recorded in `state.json`, plus known
directories such as `logs/`, `plans/`, `milestones/`, `diffs/`, `checks/`,
`reviews/`, and `runner/`.

For terminal inspection of the newest run:

```bash
RUN_DIR=$(ls -td .agent-work/run-* | head -1)

find "$RUN_DIR" -maxdepth 3 -type f | sort
cat "$RUN_DIR/state.json"
cat "$RUN_DIR/logs/81-timings.md"
ls "$RUN_DIR/runner"
```

Real runs may also include `.agent-work/<run-id>/diffs/`,
`.agent-work/<run-id>/checks/`, `.agent-work/<run-id>/reviews/`, and
`.agent-work/<run-id>/runner/`.
