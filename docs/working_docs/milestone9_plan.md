# Milestone 9 Plan: Optional CI And Provider Integrations

Status: Completed

Source: `general_plan.md` Milestone 9: Optional CI And Provider Integrations

Depends on: Milestone 8 complete

## Goal

Add optional repository automation around pull requests and provider-specific agent integrations after the local prototype is already usable.

The first implementation path is a GitHub Actions workflow that shells out to `codex exec`. A provider-specific GitHub Action wrapper can be added later, but it is not required for this milestone.

The integration should make review and CI-failure investigation easier without making hosted providers required for local development.

## Primary Outcomes

- Create a GitHub Action for agent review on PRs using `codex exec` as the initial provider path.
- Store prompts under a dedicated CI prompt directory.
- Limit workflow permissions and trusted triggers.
- Optionally add a CI-failure autofix workflow.

## Non-Goals

- Do not make CI provider setup required for local CLI usage.
- Do not expose provider secrets to untrusted pull request code.
- Do not grant broad repository write permissions to default PR workflows.
- Do not auto-merge or silently push fixes to protected branches.
- Do not replace the local Milestone 8 CLI workflow.
- Do not use `pull_request_target` for untrusted PR code.

## Design Constraints

- CI workflows must be opt-in and provider-specific.
- Prompt text should live in repository files, not inline YAML blocks.
- Workflows should use least-privilege `permissions`.
- Untrusted PR review should run with read-only permissions unless a trusted trigger is explicitly selected.
- Any workflow that can push changes must be manual, trusted, or branch-scoped.
- Missing provider secrets should fail or skip with a clear message.
- Documentation should explain setup, required secrets, safe triggers, and recommended usage.
- The default PR review workflow should not post PR comments, because that requires write permissions. It should write a Markdown review to the GitHub job summary and upload the same Markdown as an artifact.

## CI Integration Contract

Initial provider path:

- The first provider implementation uses `codex exec` from a GitHub Actions shell step.
- The workflow should treat the Codex CLI as an external tool. If the CLI is not preinstalled on the runner, the workflow must install it or fail with a clear setup message.
- Provider-specific GitHub Actions can be introduced in a later milestone or follow-up step, but they should preserve the same prompt files, output files, permissions model, and failure behavior.

Required repository inputs:

- `ci/prompts/pr-review.md` must exist before the PR review workflow is enabled.
- The workflow must check out the repository with enough history to inspect the PR diff.
- The workflow must write generated review content to `agent-review.md` in the workspace.
- The workflow must append `agent-review.md` to `$GITHUB_STEP_SUMMARY`.
- The workflow must upload `agent-review.md` as the `agent-review` artifact.

Secrets and environment:

- The review workflow expects provider authentication to come from GitHub Actions secrets.
- The default secret name should be documented as `OPENAI_API_KEY` unless the chosen Codex CLI setup requires a different provider-specific variable.
- The secret must only be exposed to trusted workflow contexts.
- For untrusted fork PRs, the workflow should either skip provider execution with a clear summary or run only if GitHub makes the required secret available under the selected event.
- Secrets must not be echoed, interpolated into logs, committed to generated artifacts, or passed to commands that print their environment.

Runner assumptions:

- The baseline runner is `ubuntu-latest`.
- The workflow may assume standard shell tools, Node.js setup support, Git, and GitHub artifact upload support.
- Any project dependency installation should be minimal and scoped to what the workflow needs.
- The workflow should not require the local Milestone 8 CLI to run.

Execution behavior:

- The provider command should receive the PR review prompt from `ci/prompts/pr-review.md`.
- The provider command should have access to the checked-out repository and PR diff context.
- Review findings should be written as Markdown.
- Review findings should not fail the PR in the first implementation.
- Infrastructure failures should fail the job.

Exit-code behavior:

- Exit `0` when review generation succeeds, even if the review reports issues.
- Exit `0` when provider execution is intentionally skipped for an untrusted context, as long as the skip is clearly reported in the job summary.
- Exit non-zero when required prompt files are missing.
- Exit non-zero when the provider CLI cannot be installed or found.
- Exit non-zero when required secrets are expected for the current trusted context but are unavailable.
- Exit non-zero when the provider command fails unexpectedly.
- Exit non-zero when `agent-review.md` is not produced.

Fallback behavior:

- For fork PRs or other untrusted contexts without secrets, write a job summary explaining that agent review was skipped because provider credentials were unavailable.
- For local or manual verification without provider credentials, document the expected skip path rather than requiring maintainers to expose secrets.
- For provider outages, fail the job with a concise setup or provider error and do not produce a misleading successful review.

## Output Contract

The PR review workflow must produce:

- A Markdown review in `$GITHUB_STEP_SUMMARY`.
- An uploaded artifact named `agent-review` containing `agent-review.md`.
- A non-zero exit code only for infrastructure failures, provider failures, or malformed output. Review findings should not fail the PR in the first implementation.
- Clear log messages when provider secrets, the Codex CLI, or required commands are unavailable.

The optional autofix workflow must produce:

- A Markdown summary in `$GITHUB_STEP_SUMMARY`.
- An uploaded artifact named `agent-autofix` containing `agent-autofix.md`.
- A branch-scoped commit only when manually triggered with an explicit target branch input.
- No direct pushes to protected branches.

## Workflow Safety Review

Status: Completed

Reviewed workflows:

- `.github/workflows/agent-review.yml`
- `.github/workflows/agent-autofix.yml`

Findings:

- The PR review workflow uses `pull_request` and `workflow_dispatch`; it does not use `pull_request_target`.
- The PR review workflow grants only `contents: read`.
- The PR review workflow does not post PR comments or request `pull-requests: write`.
- The PR review workflow skips provider execution when credentials are unavailable.
- The PR review workflow loads `ci/prompts/pr-review.md` from the trusted base ref for PR events, so PR changes cannot alter the provider prompt used with credentials.
- The autofix workflow uses `workflow_dispatch` only.
- The autofix workflow isolates `contents: write` to the manual autofix workflow.
- The autofix workflow refuses likely protected output branch names and refuses existing output branches.
- Neither workflow writes provider credentials to artifacts or intentionally echoes secret values.

Residual risks:

- Provider prompts include PR diff content, so prompt injection remains a model-level risk. The workflow mitigates this by using a trusted prompt, read-only repository permissions for review, no PR comments, and no write token on PR runs.
- Same-repository PRs may receive provider credentials depending on repository settings. Maintainers should restrict branch creation and secret access according to their GitHub trust model.
- The autofix workflow can write branches by design. It must remain manual-only and should be used only by trusted maintainers.

## Verification Results

Status: Completed

Local verification:

- `.github/workflows/agent-review.yml`: YAML syntax passed.
- `.github/workflows/agent-autofix.yml`: YAML syntax passed.
- `actionlint`: not installed locally, so static GitHub Actions linting was skipped.

Manual GitHub verification path:

- Run `Agent PR Review` with `workflow_dispatch` and `dry_run: true`.
- Confirm the workflow completes without provider credentials.
- Confirm the job summary explains the dry run.
- Confirm the `agent-review` artifact is uploaded.
- Run `Agent PR Review` from a trusted context with `CODEX_API_KEY` or `OPENAI_API_KEY` configured.
- Confirm the job summary contains the generated review.
- Confirm the review workflow does not require write permissions.
- Run `Agent CI Autofix` only from a trusted maintainer context when an autofix branch is desired.

## Proposed Files

- `.github/workflows/agent-review.yml`
- `ci/prompts/pr-review.md`
- `docs/ci-provider-integrations.md`
- `README.md`

Optional stretch files:

- `.github/workflows/agent-autofix.yml`
- `ci/prompts/ci-failure-autofix.md`

## Implementation Steps

1. Status: Completed
   Task: Define the CI integration contract.
   Details: Use `codex exec` as the initial provider path. Document required secrets, expected CLI availability, runner assumptions, output files, exit-code behavior, and fallback behavior when secrets are unavailable.

2. Status: Completed
   Task: Add the CI prompt directory.
   Details: Create `ci/prompts/` and add a focused PR review prompt that asks the agent to prioritize correctness, regressions, security risks, and missing tests. Keep the prompt provider-neutral where possible.

3. Status: Completed
   Task: Add the PR review workflow.
   Details: Create `.github/workflows/agent-review.yml` using `pull_request` and `workflow_dispatch` triggers. Use least-privilege read-only permissions for PR runs. Load `ci/prompts/pr-review.md`, run `codex exec`, write `agent-review.md`, append it to `$GITHUB_STEP_SUMMARY`, and upload it as the `agent-review` artifact.

4. Status: Completed
   Task: Add trusted/manual execution support.
   Details: Add `workflow_dispatch` inputs for branch/ref, prompt path, and dry-run behavior. Manual runs should use the same review output contract as PR runs and should not require write permissions.

5. Status: Completed
   Task: Add optional CI-failure autofix prompt.
   Details: Create `ci/prompts/ci-failure-autofix.md` only if the autofix workflow is included in this milestone. The prompt should instruct the agent to inspect failing logs, propose minimal changes, avoid broad refactors, summarize edits, and list residual risks.

6. Status: Completed
   Task: Add optional autofix workflow.
   Details: Create `.github/workflows/agent-autofix.yml` only if the trust model is clear. Use `workflow_dispatch` only. Require an explicit target branch input. Use `contents: write` only in this workflow. Push only to a branch named with an `agent/autofix-` prefix or a maintainer-provided non-protected branch. Do not use `pull_request_target`.

7. Status: Completed
   Task: Document provider setup and safe usage.
   Details: Add `docs/ci-provider-integrations.md` covering secrets, permissions, event triggers, fork behavior, local alternatives, output artifacts, job summaries, autofix guardrails, and troubleshooting. Link it from `README.md`.

8. Status: Completed
   Task: Review workflow safety.
   Details: Check that workflows do not run write-capable tokens against untrusted code, do not use `pull_request_target`, do not leak secrets in logs, do not post comments from untrusted runs, and do not grant unnecessary permissions.

9. Status: Completed
   Task: Verify CI configuration locally where practical.
   Details: Validate YAML syntax and run any available static checks. If provider execution cannot be tested locally, document the manual GitHub verification path: run `workflow_dispatch`, confirm a job summary is produced, confirm the `agent-review` artifact is uploaded, and confirm no write permission is required for the review workflow.

## Acceptance Criteria

- A PR review workflow exists and can be enabled by maintainers.
- The PR review workflow uses `codex exec` as the initial provider path.
- CI prompts live under a dedicated prompt directory.
- PR review output appears in the GitHub job summary and as an uploaded `agent-review` artifact.
- Workflow permissions are intentionally narrow and documented.
- Untrusted PRs do not receive repository write tokens or provider secrets.
- The review workflow does not use `pull_request_target`.
- Optional autofix behavior is guarded by trusted or manual triggers.
- Documentation explains setup, secrets, triggers, and safe operating modes.
- Local CLI usage continues to work without provider configuration.
