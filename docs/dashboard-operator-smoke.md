# Dashboard Operator Smoke Test

Use this smoke test when checking the local dashboard against the same run
artifacts and CLI entrypoint used by terminal runs.

## Start The Local Dashboard

Build first when the CLI or dashboard code changed:

```bash
npm run build
```

Start the dashboard from this checkout:

```bash
npm run dashboard
```

The default server is `http://127.0.0.1:3737`, with `.agent-work` as the
artifact root and `dist/cli/main.js` as the CLI entrypoint.

To serve the dashboard from this checkout while launching and resuming runs in a
different repository, pass the target repository explicitly:

```bash
npm run dashboard -- --repo /path/to/target-repo --artifact-root .agent-work
```

When the target is a Git repository, ensure `.agent-work/` is ignored by Git
before launching or resuming without `Allow dirty`.

## Prepare Smoke Files

In the target repository, create small repository-relative files for goal,
context, and seeded-plan launches:

```bash
mkdir -p tasks docs
printf 'Add a short dashboard smoke note.\n' > tasks/goal.md
printf '# Dashboard Smoke Context\n' > docs/dashboard-context.md
printf '# Major Plan\n\n1. Update the requested smoke note.\n' > tasks/major-plan.md
```

## Dry-Run Preview Expectations

Leave `Dry run` checked for each browser launch smoke. A dry-run preview should
show these fields before any raw report details:

- status and next action;
- target repository and artifact root;
- goal source;
- context inputs when supplied;
- major-plan source;
- runner, runner profile, and runner account label when configured.

Blocked previews should show the block reason without implying a live process
started. Common blocks include dirty-tree protection, missing runner tools, or
invalid repository-relative paths.

## Prompt Launch

In the Launch form:

- set goal source to `Prompt`;
- enter a short prompt;
- choose `fake` for an offline smoke or the runner being validated;
- leave `Dry run` checked;
- select `Start`.

Equivalent CLI fallback:

```bash
node dist/cli/main.js --dry-run --runner fake \
  "Add a short dashboard smoke note."
```

## Goal-File Launch

In the Launch form:

- set goal source to `Goal file`;
- enter `tasks/goal.md`;
- choose the runner;
- leave `Dry run` checked;
- select `Start`.

The preview goal source should show `file:tasks/goal.md`.

Equivalent CLI fallback:

```bash
node dist/cli/main.js --dry-run --runner fake \
  --goal-file tasks/goal.md
```

## Context-Path Launch

In the Launch form:

- keep either prompt mode or goal-file mode;
- enter context paths one per line:

  ```text
  README.md
  docs/dashboard-context.md
  ```

- leave `Dry run` checked;
- select `Start`.

The preview should list the context inputs. Blank lines are ignored, and browser
paths must be repository-relative.

Equivalent CLI fallback:

```bash
node dist/cli/main.js --dry-run --runner fake \
  --goal-file tasks/goal.md \
  --context README.md \
  --context docs/dashboard-context.md
```

## Seeded-Plan Launch

In the Launch form:

- set goal source to `Goal file`;
- enter `tasks/goal.md`;
- enter `tasks/major-plan.md` in `Seed plan`;
- optionally include the seed file in context when it should be listed with
  other operator-provided context;
- leave `Dry run` checked;
- select `Start`.

The preview should show the major-plan source as seeded and the next action as
plan review.

Equivalent CLI fallback:

```bash
node dist/cli/main.js --dry-run --runner fake \
  --goal-file tasks/goal.md \
  --seed-major-plan tasks/major-plan.md
```

## Launch A Live Smoke Run

Only clear `Dry run` after a preview shows the expected target repository,
artifact root, inputs, and runner. For an offline live smoke, use `fake`. Live
fake runs still perform Git preflight and diff capture, so the target must be a
Git repository with at least one commit and a clean tree unless `Allow dirty` is
intentional.

For `codex-exec`, the Codex CLI must be installed, available on `PATH`, and
authenticated in the shell. The target directory must be a Git repository with
at least one commit, the tree must be clean unless `Allow dirty` is intentional,
and `orchestrator.config.json` must exist unless the example config is
acceptable for the run.

Equivalent source-backed CLI command:

```bash
node dist/cli/main.js --runner codex-exec --milestone 1 \
  --goal-file tasks/goal.md
```

Live runs can edit the working tree and write workflow artifacts.

## Inspect Inputs And Artifacts

Select the run in the dashboard. In run detail:

- open `Inputs` and confirm goal source, context snapshot links, seeded
  major-plan metadata, and the input manifest link;
- open `Artifacts` and confirm grouped artifact links for `inputs/`, `logs/`,
  `plans/`, `milestones/`, `diffs/`, `checks/`, `reviews/`, and `runner/` as
  applicable.

For terminal inspection of the newest run:

```bash
RUN_DIR=$(ls -td .agent-work/run-* | head -1)

find "$RUN_DIR" -maxdepth 3 -type f | sort
cat "$RUN_DIR/state.json"
cat "$RUN_DIR/inputs/01-inputs.json"
cat "$RUN_DIR/logs/81-timings.md"
ls "$RUN_DIR/runner"
```

If the dashboard fails to start or a browser action fails, run the equivalent
CLI command directly from the terminal.
