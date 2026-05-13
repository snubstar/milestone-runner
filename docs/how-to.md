codex resume 019e207b-9f9b-7281-929e-7e291a002532

Use the fake runner for now. The real codex-exec path is scaffolded but not implemented for actual
  implementation phases yet.

  From repo root:

  npm run build
  git status --short

  If the tree is clean, run a dry run with a realistic goal:

  node dist/cli/main.js --dry-run --runner fake --milestone 1 \
    "Add a docs note explaining how to run the orchestrator manually"

  Expected: Allowed: true, Next action: run_full_goal, Runner: fake. It may warn that no
  deterministic checks are configured.

  Then run the actual one-milestone workflow:

  node dist/cli/main.js --runner fake --milestone 1 \
    "Add a docs note explaining how to run the orchestrator manually"

  Expected behavior:

  - Creates a new .agent-work/<run-id>/ folder.
  - Writes planning artifacts, milestone artifacts, checks, diff, review JSON, and state.json.
  - Creates fake-milestone-1-implementation.txt in the repo root.
  - Prints milestone 1: passed.
  - Leaves milestone 2 pending, with a next action saying to resume without --milestone.

  Inspect the run:

  RUN_DIR=$(ls -td .agent-work/* | head -1)

  find "$RUN_DIR" -maxdepth 3 -type f | sort
  cat "$RUN_DIR/state.json"
  cat "$RUN_DIR/diffs/12-milestone-1.diff"
  cat "$RUN_DIR/reviews/20-milestone-1-review.json"
  cat fake-milestone-1-implementation.txt

  To test resume through the remaining milestone:

  node dist/cli/main.js --resume "$RUN_DIR" --dry-run --allow-dirty
  node dist/cli/main.js --resume "$RUN_DIR" --allow-dirty

  Use --allow-dirty because milestone 1 intentionally left a generated file in the working tree.
  After resume, expected output is State: passed, milestones 1: passed and 2: passed, and a final
  summary artifact like milestones/90-goal-summary.md.

  To clean up the fake task files afterward:

  rm fake-milestone-1-implementation.txt fake-milestone-2-implementation.txt

  I also verified npm run build and the dry-run command locally; both succeeded.