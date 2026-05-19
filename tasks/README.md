# Task Launchers

Use this directory for task-specific pipeline launchers: small shell scripts that
keep the exact prompt, runner options, and policy choices for a real
orchestrator task in one reviewable file.

Recommended convention:

- Name scripts after the task, for example `run-readme-cleanup.sh`.
- Keep task launchers scoped to one orchestrator job.
- Keep reusable project maintenance commands out of this directory.
- Use `--dry-run` first when checking environment, config, and next action.
- Prefer `--milestone-plan-review-policy scrupulous` when milestone-level plan
  precision matters.

The template in `task-template.sh` is intentionally guarded so it fails until the
placeholder prompt is replaced.
