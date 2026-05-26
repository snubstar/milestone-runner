# CI Provider Integrations

This project includes optional GitHub Actions automation around agent review and
CI-failure autofix workflows.

These workflows are provider integrations. They are not required for local CLI usage.

## Workflows

### Agent PR Review

Workflow file:

- `.github/workflows/agent-review.yml`

Triggers:

- `pull_request`
- `workflow_dispatch`

Permissions:

- `contents: read`

Behavior:

- Checks out the pull request merge ref for PR events.
- Loads the review prompt from `ci/prompts/pr-review.md` by default.
- Builds repository and diff context for the agent.
- Runs `codex exec` only when provider credentials are available.
- Writes the review to the GitHub job summary.
- Uploads `agent-review.md` as the `agent-review` artifact.
- Does not post PR comments.
- Does not require write permissions.
- Does not fail the PR because review findings exist.

### Agent CI Autofix

Workflow file:

- `.github/workflows/agent-autofix.yml`

Trigger:

- `workflow_dispatch` only

Permissions:

- `contents: write`

Behavior:

- Requires an explicit `target_branch` input.
- Uses `ci/prompts/ci-failure-autofix.md` by default.
- Accepts optional failure context through `failing_command`, `failure_log_url`, and `failure_summary`.
- Runs `codex exec` with workspace write access.
- Defaults the output branch to `agent/autofix-<run_id>`.
- Refuses common protected branch names such as `main`, `master`, `trunk`, `production`, `prod`, `release`, `develop`, and `dev`.
- Refuses to overwrite an existing output branch.
- Pushes a branch only when Codex produced repository changes.
- Writes the summary to the GitHub job summary.
- Uploads `agent-autofix.md` as the `agent-autofix` artifact.

## Required Secrets

Recommended secret:

- `CODEX_API_KEY`

Accepted fallback secret:

- `OPENAI_API_KEY`

The workflows expose the chosen secret to `codex exec` as `CODEX_API_KEY`.

Do not echo secrets, write secrets to artifacts, or include secret values in prompts. If a key is suspected to have leaked through logs or generated output, rotate it immediately.

## Setup

1. Add `CODEX_API_KEY` as a repository or organization secret in GitHub.
2. Confirm the workflow files are present under `.github/workflows/`.
3. Confirm prompts exist under `ci/prompts/`.
4. Run `Agent PR Review` manually with `workflow_dispatch` and `dry_run: true`.
5. Run `Agent PR Review` manually without dry-run from a trusted branch.
6. Confirm the job summary contains the review output.
7. Confirm the `agent-review` artifact is uploaded.
8. Use `Agent CI Autofix` only when a maintainer intentionally wants an automated fix branch.

## Fork And Untrusted PR Behavior

The PR review workflow uses `pull_request`, not `pull_request_target`.

This is intentional:

- `pull_request` avoids running write-capable repository tokens against untrusted pull request code.
- Fork PRs usually do not receive repository secrets.
- When credentials are unavailable, the workflow writes a clear skip summary and exits successfully.
- The workflow does not post PR comments, because comments require write permissions.

Do not change the review workflow to `pull_request_target` unless the workflow is redesigned to avoid checking out or executing untrusted PR code with secrets.

## Output Artifacts

The review workflow produces:

- GitHub job summary content.
- `agent-review` artifact containing `agent-review.md`.

The autofix workflow produces:

- GitHub job summary content.
- `agent-autofix` artifact containing `agent-autofix.md`.
- `git-status.txt` when repository status was captured.

Artifacts are the durable output for later inspection. PR comments are intentionally not used by the default workflow.

## Autofix Guardrails

The autofix workflow is manual-only because it can write to the repository.

Guardrails:

- Requires explicit `target_branch`.
- Defaults to a new `agent/autofix-<run_id>` branch.
- Refuses likely protected branch names.
- Refuses unsafe branch names.
- Refuses existing output branches.
- Does not force-push.
- Does not use `pull_request_target`.
- Checks for likely secret files before committing.

Recommended usage:

- Run autofix only from trusted branches.
- Provide the failing command when known.
- Provide a concise failure summary.
- Review the generated branch before opening or merging a pull request.

## Local Alternatives

Local CLI usage does not require provider CI configuration.

Use the local milestone workflow when you want deterministic local execution, resume support, dry-run planning, or artifact inspection outside GitHub Actions.

## Troubleshooting

### The review workflow skipped Codex execution

Confirm `CODEX_API_KEY` or `OPENAI_API_KEY` is configured as a secret for the workflow context. Fork PRs may not receive repository secrets by design.

### The workflow cannot find the prompt file

Confirm the selected prompt path exists. The default review prompt is `ci/prompts/pr-review.md`; the default autofix prompt is `ci/prompts/ci-failure-autofix.md`.

### The Codex CLI install failed

The workflows install `@openai/codex` with npm on `ubuntu-latest`. Check Node.js setup, npm registry access, and transient network failures.

### The autofix workflow refused the output branch

Choose a new non-protected branch. The workflow intentionally refuses likely protected branch names and existing remote branches to avoid overwrites.

### Codex ran but no branch was pushed

If Codex did not produce repository changes, the autofix workflow records that result and does not push an empty branch.
