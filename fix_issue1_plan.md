# Fix Issue 1 Plan: Source-Backed Review Evidence

## Motivation

The first real Codex-backed smoke run completed at the process level but ended
in `needs_human_review`.

The implementation created `docs/dashboard-operator-smoke.md`, captured the
diff, wrote checks, ran review, and generated timing/runner diagnostics. The
stop reason was not a runner crash or missing human input. The automated review
could not verify that the documentation's commands and artifact paths were
source-backed because the review prompt only included:

- final major plan;
- milestone plan;
- implementation report;
- milestone diff;
- check output.

The review prompt also correctly instructs the reviewer to use
`needs_human_review` for missing context or unverifiable claims. That means
source-backed documentation milestones can fail even when the implementation is
reasonable, because the reviewer is not given the source evidence it needs.

This is a workflow design issue. The fix should preserve review rigor while
making the orchestrator provide deterministic evidence before asking the model
for a verdict.

## Goals

- Let automated review verify source-backed documentation claims without human
  intervention.
- Keep review strict: do not weaken `needs_human_review` rules for genuinely
  missing or ambiguous evidence.
- Generate evidence deterministically from repository files, not from model
  guesses.
- Persist the evidence as a normal run artifact so dashboard, CLI, and future
  debugging can inspect it.
- Keep the first implementation narrow enough to be reliable for docs and
  command/path verification tasks.
- Make constrained milestone runs easier to interpret when later milestones
  remain pending.

## Non-Goals

- Do not make the reviewer run shell commands.
- Do not let the browser or dashboard provide arbitrary files for review.
- Do not add remote services, embeddings, semantic search, or external
  dependencies.
- Do not auto-pass documentation changes without model review.
- Do not change the review verdict schema unless a later issue requires it.
- Do not make `.agent-work` artifacts part of source evidence search.

## Desired Outcome

For a docs-only milestone like the dashboard smoke-test task, the run should
produce a new artifact similar to:

```text
reviews/19-milestone-1-review-evidence.md
```

That artifact should include bounded source excerpts showing where documented
commands, paths, scripts, or configuration claims come from. The review prompt
should include this artifact content and list it in `reviewedArtifacts`.

If the documentation claims cannot be source-backed, the evidence artifact should
say so explicitly. The reviewer can then fail the milestone or request human
review for a real content issue, not because the orchestrator omitted context.

## Design

### Implementation Ground Rules

- Evidence must come from repository source or configuration files other than the
  changed Markdown line that made the claim. Changed source files may still be
  authoritative for code-plus-doc milestones.
- Changed Markdown files may be shown as claim origins, but they must never count
  as authoritative source matches for those same claims.
- Evidence generation is deterministic and local. It uses repository files and
  structured parsing only; it does not ask the model to infer missing sources.
- Evidence warnings are data for the reviewer. They do not crash the workflow
  unless evidence generation itself has an internal read/write/parsing error that
  prevents producing the artifact.
- Keep all artifact paths run-relative in state.

### Evidence Artifact

Add a deterministic review evidence builder that runs immediately before
`review_milestone`.

Base review artifact path:

```text
reviews/19-milestone-<id>-review-evidence.md
```

Post-fix review artifact path:

```text
reviews/23-milestone-<id>-review-evidence-after-fix-<attempt>.md
```

The artifact should include:

- run id and milestone id;
- review round: `base` or `fix <attempt>`;
- changed file list parsed from the milestone diff;
- added Markdown lines from changed `.md` files;
- detected command-like snippets from added lines;
- detected path-like snippets from added lines;
- structured source validations, such as `package.json` script checks;
- authoritative source matches found in repository files;
- self-matches from changed Markdown files only as non-authoritative notes, if
  useful for debugging;
- unmatched snippets with a clear warning;
- bounded source excerpts with file path and line number.

The first version should use exact matching plus a small set of structured
validators for the motivating documentation claims. Avoid fuzzy semantic
matching.

### Evidence Search Scope

Search repository text files, excluding generated or unsafe/noisy locations:

- `.agent-work/`
- `dist/`
- `dist-test/`
- `node_modules/`
- `.git/`
- coverage/build/cache directories if present

Prefer source and documentation files that are already authoritative for this
project:

- `package.json`
- `README.md`
- `docs/**/*.md`
- `orchestrator.config.example.json`
- `src/**/*.ts`
- `schemas/**/*.json`

Do not read files outside the Git repository root. Use `state.git.root` when it
is available; otherwise resolve `cwd` and refuse to traverse outside it. Also
exclude `paths.runDir` even if the artifact root is not named `.agent-work`.

Changed Markdown files from the active diff are claim origins, not source
authority. Exclude those files from authoritative matching. If the same string is
only found in the changed documentation, mark it as:

```text
warning: only found in changed file; not source-backed
```

### Claim Extraction

For changed Markdown files, extract from added diff lines:

- fenced command lines under `bash`, `sh`, or untyped code blocks;
- inline backticked snippets containing spaces or command/path characters;
- URL-looking snippets such as `http://127.0.0.1:3737`;
- path-looking snippets such as `.agent-work`, `dist/cli/main.js`, `logs/`,
  `plans/`, `milestones/`, `diffs/`, `checks/`, `reviews/`, and `runner/`;
- package-script-looking snippets such as `npm run dashboard`.

Normalize only enough for matching:

- strip the leading added-line `+`;
- trim shell continuation backslashes;
- split multi-line shell continuations into one command claim plus component
  claims where useful;
- trim surrounding quotes and punctuation;
- normalize a leading `./` in path snippets only for matching;
- keep the original snippet in the evidence artifact.

For a command line such as:

```bash
npm run dashboard -- --artifact-root .agent-work
```

extract both the full command and derived claims:

- `npm run dashboard`
- `--artifact-root`
- `.agent-work`

The full command can remain unmatched if the derived claims are backed by
structured evidence and the artifact clearly explains that the command was
decomposed.

### Structured Validators

Implement these validators before falling back to raw exact matching:

- `npm run <script>`: parse `package.json`, verify `scripts[script]` exists, and
  include an excerpt around the script line.
- `node dist/cli/main.js`: verify the path through `package.json` `bin` or exact
  source matches. Treat `./dist/cli/main.js` as a match for
  `dist/cli/main.js`.
- Dashboard server URL claims such as `http://127.0.0.1:3737`: parse the URL and
  verify host and port against `src/dashboard/server.ts` default options.
- Dashboard/server CLI flags such as `--artifact-root`, `--port`, `--host`,
  `--static-root`, and `--cli-path`: verify exact flag definitions in
  `src/dashboard/server.ts`.
- Run artifact directory names such as `logs/`, `plans/`, `milestones/`,
  `diffs/`, `checks/`, `reviews/`, and `runner/`: verify the directory names in
  `src/artifacts/paths.ts`.

Every validator should return source file, line number, and a short excerpt.
When a validator cannot prove a claim, return a warning and let exact matching
try next.

### Review Prompt Integration

Update `review-milestone.md` to include:

```md
Review evidence:

{{reviewEvidence}}
```

Update `runReviewWorkflow` so:

- it generates the evidence artifact before rendering the review prompt;
- it includes the evidence artifact in `reviewedArtifacts`;
- runner diagnostics for `review_milestone` include either the full
  `request.artifacts` map or a dedicated `reviewEvidence` path;
- malformed evidence generation fails the workflow only for internal errors;
- ordinary unmatched snippets are warnings inside the evidence artifact, not
  workflow crashes.

### State And Artifact Tracking

The existing `StateArtifacts` type has no dedicated `reviewEvidence` field. Use
the existing `reviews` artifact bucket with a stable key, for example:

```text
"1-evidence": "reviews/19-milestone-1-review-evidence.md"
"1-fix-1-evidence": "reviews/23-milestone-1-review-evidence-after-fix-1.md"
```

This keeps the change backward-compatible and lets the dashboard expose the
artifact under the existing review group without a state schema migration.

Update path helpers as follows:

- `BaseReviewArtifactPaths.files.evidence`
- `BaseReviewArtifactPaths.statePaths.evidence`
- `BaseReviewArtifactPaths.stateKeys.evidence`
- `FixAttemptArtifactPaths.files.evidence`
- `FixAttemptArtifactPaths.statePaths.evidence`
- `FixAttemptArtifactPaths.stateKeys.evidence`

Keep existing review, summary, fix, diff, and check paths unchanged.

### Constrained Milestone Reporting

The run also showed a separate UX issue: the task was split into two
milestones, but the command used `--milestone 1`. The README link remained
pending by design, but the final report did not make that obvious enough.

Improve CLI output for constrained runs so it says when later milestones remain
pending, for example:

```text
Target milestone 1 stopped before goal completion.
Pending milestones remain: 2.
Next action: resume without --milestone to continue remaining milestones.
```

This does not fix the review failure, but it prevents confusion during the next
actual run.

## Implementation Steps

1. Add review evidence artifact path helpers.
   - Update `src/artifacts/review-artifacts.ts`.
   - Add `evidence` to `BaseReviewArtifactPaths.files`,
     `BaseReviewArtifactPaths.statePaths`, and
     `BaseReviewArtifactPaths.stateKeys`.
   - Use:

     ```text
     reviews/19-milestone-<id>-review-evidence.md
     reviews["<id>-evidence"]
     ```

   - Add `evidence` and `stateKeys.evidence` to
     `FixAttemptArtifactPaths`.
   - Use:

     ```text
     reviews/23-milestone-<id>-review-evidence-after-fix-<attempt>.md
     reviews["<id>-fix-<attempt>-evidence"]
     ```

   - Keep existing review and summary paths unchanged.
   - Update `tests/unit/review-artifacts.test.ts` for both base and post-fix
     evidence paths.

2. Add a deterministic evidence builder.
   - Create `src/review/review-evidence.ts`.
   - Export a function similar to:

     ```ts
     export async function buildReviewEvidence(options: {
       cwd: string;
       gitRoot: string | null;
       runDir: string;
       runId: string;
       milestoneId: number;
       reviewRound:
         | { kind: "base" }
         | { kind: "fix"; attempt: number };
       diff: string;
       packageJsonPath?: string;
       maxSnippetMatches?: number;
       maxExcerptLines?: number;
       maxSnippets?: number;
       maxFileBytes?: number;
     }): Promise<ReviewEvidenceResult>;
     ```

   - Parse changed files from `diff --git` headers.
   - Parse added lines from Markdown files only for claim extraction.
   - Extract command/path/URL snippets from added Markdown content.
   - Track changed Markdown paths as claim origins.
   - Run structured validators for package scripts, dashboard defaults, CLI
     flags, entrypoint paths, and artifact directory names.
   - Search bounded repo files for exact snippet matches, excluding changed
     Markdown files as authoritative evidence.
   - Return Markdown content plus structured warnings.

3. Define the evidence result types.
   - Add local exported types in `src/review/review-evidence.ts`:

     ```ts
     export interface ReviewEvidenceResult {
       markdown: string;
       warnings: ReviewEvidenceWarning[];
       snippets: ReviewEvidenceSnippet[];
     }

     export interface ReviewEvidenceSnippet {
       original: string;
       normalized: string;
       kind: "command" | "path" | "url" | "package-script" | "flag";
       originFiles: string[];
       status: "backed" | "unmatched" | "self_match_only" | "decomposed";
       matches: ReviewEvidenceMatch[];
       derivedFrom?: string;
     }

     export interface ReviewEvidenceMatch {
       file: string;
       line: number;
       excerpt: string;
       source: "structured" | "exact";
     }

     export interface ReviewEvidenceWarning {
       code: string;
       message: string;
       snippet?: string;
       file?: string;
     }
     ```

   - Keep result data simple and serializable for unit tests.
   - The workflow writes only `markdown` as the artifact.

4. Keep evidence search safe and bounded.
   - Resolve the Git root or use the workflow `cwd` when already known to be a
     Git root.
   - Refuse to search outside the repo root.
   - Exclude `runDir` in addition to `.agent-work`.
   - Exclude changed Markdown files from authoritative matching.
   - Skip generated directories and binary-looking files.
   - Cap file size read for evidence search.
   - Cap total snippets and matches per snippet.
   - Include warning text when caps are hit.
   - Use POSIX-style relative paths in evidence output for stable snapshots.

5. Add structured validators.
   - Parse `package.json` with `JSON.parse`; do not string-scan it for script
     existence.
   - Add a small line-number helper that finds the first line containing an exact
     display string after structured validation succeeds.
   - Validate:
     - `npm run dashboard` from `package.json` `scripts.dashboard`;
     - `dist/cli/main.js` from `package.json` `bin` or exact source;
     - `http://127.0.0.1:3737` from dashboard `defaultOptions`;
     - dashboard flags from `src/dashboard/server.ts`;
     - artifact directories from `src/artifacts/paths.ts`.
   - If a structured validator proves a derived claim, mark the parent command
     line as "decomposed into backed claims" rather than unmatched.

6. Persist evidence before the initial review.
   - In `src/review/review-workflow.ts`, after reading `diff` and `checks`, call
     the evidence builder.
   - Write the Markdown to `reviews/19-milestone-<id>-review-evidence.md`.
   - Record it in state under `reviews["<id>-evidence"]`.
   - Add the evidence path to `reviewedArtifacts`.
   - Pass the evidence content as `reviewEvidence` when rendering the prompt.

7. Persist fresh evidence before every post-fix review.
   - In the fix loop, after post-fix diff and checks are written and before
     rendering the post-fix review prompt, call the evidence builder with:

     ```ts
     reviewRound: { kind: "fix", attempt }
     diff: latestDiff
     ```

   - Write the Markdown to
     `reviews/23-milestone-<id>-review-evidence-after-fix-<attempt>.md`.
   - Record it in state under `reviews["<id>-fix-<attempt>-evidence"]`.
   - Add the post-fix evidence path to `postFixReviewedArtifacts`.
   - Pass the post-fix evidence content as `reviewEvidence`.

8. Pass evidence into the review prompt and diagnostics.
   - Add `reviewEvidence` to `src/prompts/review-milestone.md`.
   - Add a rule telling the reviewer to use the evidence artifact for
     source-backed documentation claims.
   - Include `reviewEvidence` in the `artifacts` argument passed to
     `runPhase("review_milestone", ...)`.
   - Update `src/runners/runner-diagnostics.ts` so persisted diagnostics include
     request artifacts, or at minimum `reviewEvidence`.
   - Update prompt variable tests in `tests/unit/prompt-loader.test.ts`.

9. Keep reviewer behavior strict.
   - Do not remove the rule that missing context can require human review.
   - Add wording that the reviewer should use the evidence artifact to verify
     source-backed claims.
   - Add wording that unmatched snippets in evidence are potential findings, not
     automatic pass/fail decisions.

10. Improve constrained milestone reporting.
    - `runGoalWorkflow` already returns
      `resume without --milestone to continue remaining milestones` when a
      target milestone passes and pending milestones remain.
    - Update `src/cli/run-report.ts` to derive pending milestone ids from
      `finalState.milestoneStatuses` when `targetMilestone !== null` and
      pending statuses remain.
    - Print:

      ```text
      Target milestone <id> stopped before goal completion.
      Pending milestones remain: <ids>.
      Next action: resume without --milestone to continue remaining milestones.
      ```

    - Keep the existing `Next action:` line, but avoid printing contradictory
      guidance.
    - Add `pendingMilestones` to JSON report `details` only if it is useful for
      dashboard display; this is backward-compatible.

11. Add unit tests for evidence extraction.
   - Markdown command extraction from fenced code.
   - Inline path extraction from backticks.
   - URL extraction.
   - `npm run dashboard` validates through `package.json` scripts.
   - `http://127.0.0.1:3737` validates through dashboard default host/port.
   - `--artifact-root` validates through dashboard server args.
   - Artifact directory names validate through `src/artifacts/paths.ts`.
   - Exact source match with file and line number.
   - Changed Markdown self-match does not count as source evidence.
   - Unmatched snippet warning.
   - Exclusion of `.agent-work`, the concrete `runDir`, `dist`,
     `node_modules`, and `.git`.
   - Caps on large files or too many matches.
   - Command decomposition prevents a backed command line from being reported as
     wholly unmatched when its derived claims are backed.

12. Add review workflow tests.
    - Verify `runReviewWorkflow` writes the base evidence artifact.
    - Verify the initial review prompt includes the evidence content.
    - Verify initial `reviewedArtifacts` includes the evidence path.
    - Verify state records the evidence artifact under `reviews`.
    - Verify runner diagnostics include the review evidence artifact path.
    - Verify post-fix review writes a distinct post-fix evidence artifact.
    - Verify post-fix prompt and `postFixReviewedArtifacts` use the post-fix
      evidence, not stale base evidence.
    - Verify malformed evidence builder errors fail the workflow as internal
      review errors.

13. Add dashboard artifact exposure tests.
    - `src/dashboard/run-reader.ts` already collects nested state artifacts by
      group. Add or update a test proving `reviews["1-evidence"]` and
      `reviews["1-fix-1-evidence"]` appear in the Reviews artifact group.
    - No dashboard API schema change should be required.

14. Add CLI reporting tests.
    - A constrained `--milestone 1` run with milestone 2 pending should report
      that pending milestones remain.
    - The report should include the suggested next action to resume without
      `--milestone`.
    - JSON report details should remain backward-compatible.

15. Run verification.
    - `npm run typecheck`
    - `npm run test:build`
    - `npm run build`
    - `node --check dashboard/public/app.js`

16. Re-run the actual smoke task.
    - Prefer committing or stashing unrelated work first.
    - Run the same docs task without constraining to only milestone 1, or resume
      after milestone 1 if testing constrained behavior deliberately.
    - Confirm the run no longer reaches `needs_human_review` solely because
      source evidence was absent.
    - Confirm the dashboard shows the evidence artifact under the run detail.

## Acceptance Criteria

- Every review run writes a review evidence artifact before invoking
  `review_milestone`.
- Post-fix review runs write distinct evidence artifacts for the post-fix diff.
- Review prompts include the evidence artifact content and path.
- Source-backed documentation claims can be verified from artifacts available to
  the reviewer.
- Changed documentation cannot validate its own claims as authoritative source
  evidence.
- `npm run <script>` claims are verified through `package.json` scripts rather
  than raw string coincidence.
- Missing source evidence is surfaced as evidence warnings and review findings,
  not as opaque missing-context failures.
- Existing pass/fail/needs-human-review semantics remain intact.
- Existing dashboard artifact reading exposes the evidence artifact without a
  new dashboard schema.
- Runner diagnostics for review phases include the review evidence artifact path.
- Constrained milestone output clearly tells the operator when later milestones
  remain pending.
- All normal build and test commands pass.

## Risks And Mitigations

- Risk: evidence extraction becomes too broad and noisy.
  - Mitigation: use structured validators for known claim shapes, exact matching
    for the rest, and bounded excerpts.

- Risk: source snippets make prompts too large.
  - Mitigation: cap snippet count, match count, excerpt lines, and file sizes.

- Risk: generated files or run artifacts accidentally validate claims.
  - Mitigation: exclude `.agent-work`, the concrete run directory, build
    outputs, dependencies, Git internals, and changed Markdown claim-origin
    files.

- Risk: documentation commands are valid but phrased differently than source.
  - Mitigation: decompose command lines into structured claims and treat
    remaining unmatched snippets as reviewable warnings, not workflow crashes.

- Risk: post-fix reviews accidentally use stale evidence from the base diff.
  - Mitigation: use distinct post-fix evidence paths and state keys per attempt,
    and test the prompt content for the post-fix review.

- Risk: this solves docs tasks but not other evidence needs.
  - Mitigation: keep the builder generic and add future extractors only when new
    real-run failures prove they are needed.
