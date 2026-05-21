# Fix Issue 2 Plan: Source-Back Dynamic Dashboard Diagnostic Paths

## Motivation

The real Codex-backed rerun for `fix_issue1_plan.md` completed successfully, but
it exposed a second evidence gap during Milestone 1.

The new review evidence artifact was present, was included in the review prompt,
and was listed in `reviewedArtifacts`. The original missing-context failure did
not recur. Instead, the reviewer failed the first milestone for a more specific
and legitimate reason: the generated dashboard smoke guide documented concrete
dashboard diagnostic paths that were not source-backed enough by the evidence
builder.

Examples from the failed first review included:

```text
.agent-work/dashboard-resumes/<resume-id>.json
.agent-work/dashboard-resumes/<resume-id>-diagnostics.json
.agent-work/dashboard-resumes/<resume-id>.claim
.agent-work/dashboard-launches/
```

Those paths are valid concepts, but the source constructs them dynamically from
pieces such as:

- `options.artifactRoot`
- `"dashboard-launches"`
- `"dashboard-resumes"`
- `${launchId}.json`
- `${resumeId}.json`
- `${resumeId}-diagnostics.json`
- `${resumeId}.claim`
- helper functions such as `resumeDryRunRecordPath` and
  `resumeDryRunClaimPath`

The current evidence builder mainly uses exact matching plus a small set of
structured validators. It cannot reliably prove placeholder paths assembled from
source components, so the reviewer may repeatedly push valid docs through the
fix loop. The automatic fix loop handled the observed run, but that is slower
than necessary and can fail if `maxFixAttempts` is lower or the model fixes the
wording less carefully.

## Goals

- Let review evidence source-back dashboard launch and resume diagnostic paths
  that are dynamically constructed in source.
- Keep review strict: fabricated or unsupported dashboard artifact paths should
  still produce warnings and review findings.
- Avoid broad fuzzy matching. Use deterministic decomposition and validators
  against `src/dashboard/run-launcher.ts` and `src/dashboard/run-resumer.ts`.
- Preserve the evidence builder's current safety boundaries: no run artifact
  search, no generated outputs, no external services, no semantic inference.
- Reduce predictable fix-loop churn for valid docs that use placeholders such as
  `<launch-id>` or `<resume-id>`.

## Non-Goals

- Do not weaken reviewer instructions or auto-pass documentation.
- Do not add a general template-language parser.
- Do not make `.agent-work` run contents authoritative evidence.
- Do not change dashboard launch or resume runtime behavior.
- Do not expose absolute machine paths in evidence artifacts.
- Do not support arbitrary dynamically generated paths across the whole codebase;
  this issue is scoped to dashboard launch/resume diagnostics.

## Desired Outcome

If a changed Markdown file documents:

```text
.agent-work/dashboard-resumes/<resume-id>-diagnostics.json
```

the evidence builder should extract the path claim, decompose it into
source-backed components, and mark the parent path as `decomposed` rather than
`self_match_only` or `unmatched`.

The evidence artifact should show matches against source lines in:

```text
src/dashboard/run-resumer.ts
src/dashboard/run-launcher.ts
```

Unsupported variants, such as:

```text
.agent-work/dashboard-resumes/<resume-id>-audit.json
```

should remain unbacked unless source actually supports them.

## Design

### Path Decomposition

Add deterministic path-claim decomposition for dashboard diagnostic paths.

For a path such as:

```text
.agent-work/dashboard-resumes/<resume-id>-diagnostics.json
```

derive component claims such as:

```text
.agent-work
dashboard-resumes
-diagnostics.json
```

Treat `.agent-work` explicitly as the default artifact-root marker, not as a
literal dashboard diagnostic directory. Back it from the dashboard default
artifact root in `src/dashboard/server.ts` when the documented path uses the
default root. If a documented path omits `.agent-work` and starts at
`dashboard-resumes` or `dashboard-launches`, decompose only the dashboard
diagnostic components.

For:

```text
.agent-work/dashboard-resumes/<resume-id>.claim
```

derive:

```text
.agent-work
dashboard-resumes
.claim
```

For:

```text
.agent-work/dashboard-launches/<launch-id>.json
```

derive:

```text
.agent-work
dashboard-launches
.json
```

The parent path should become `decomposed` when all required meaningful
components are backed. Do not require a literal match for placeholder tokens such
as `<resume-id>` or `<launch-id>`.

### Structured Validators

Add dashboard diagnostic validators before raw exact matching:

- `dashboard-launches` and `.agent-work/dashboard-launches/`
  - Verify `"dashboard-launches"` in `src/dashboard/run-launcher.ts`.
  - Prefer the line that builds `diagnosticsPath`.
  - If `.agent-work` is present, verify the default artifact root in
    `src/dashboard/server.ts`.

- `dashboard-resumes` and `.agent-work/dashboard-resumes/`
  - Verify `"dashboard-resumes"` in `src/dashboard/run-resumer.ts`.
  - Prefer lines that build `diagnosticsPath`, `resumeDryRunRecordPath`, or
    `resumeDryRunClaimPath`.
  - If `.agent-work` is present, verify the default artifact root in
    `src/dashboard/server.ts`.

- Resume dry-run record pattern:
  - Back `<resume-id>.json` from `resumeDryRunRecordPath` and
    `` `${resumeId}.json` `` in `src/dashboard/run-resumer.ts`.

- Resume dry-run diagnostics pattern:
  - Back `<resume-id>-diagnostics.json` from the `diagnosticsPath` construction
    in `src/dashboard/run-resumer.ts`.

- Resume claim pattern:
  - Back `<resume-id>.claim` from `resumeDryRunClaimPath` and
    `` `${resumeId}.claim` `` in `src/dashboard/run-resumer.ts`.

- Launch diagnostics pattern:
  - Back `<launch-id>.json` and `<resume-launch-id>.json` from
    `diagnosticsPath` construction in `src/dashboard/run-launcher.ts` and
    `src/dashboard/run-resumer.ts`.
  - Do not back unsupported launch suffixes such as
    `<launch-id>-audit.json`.

The validators should return normal `ReviewEvidenceMatch` objects with source
`"structured"`, file path, line number, and short excerpt.

### Claim Extraction Scope

Extend path extraction so it detects both complete and component forms:

- `.agent-work/dashboard-launches/`
- `.agent-work/dashboard-launches/<launch-id>.json`
- `.agent-work/dashboard-resumes/`
- `.agent-work/dashboard-resumes/<resume-id>.json`
- `.agent-work/dashboard-resumes/<resume-id>-diagnostics.json`
- `.agent-work/dashboard-resumes/<resume-id>.claim`
- `dashboard-launches`
- `dashboard-resumes`
- `dashboard-launches/`
- `dashboard-resumes/`

Normalize trailing slashes enough for matching, but keep the original snippet in
the artifact.

### Decomposition Status

Generalize the current command-only decomposition pass so path parents can also
be marked `decomposed`.

Keep the existing status values:

```ts
"backed" | "unmatched" | "self_match_only" | "decomposed"
```

The implementation can rename `markDecomposedCommandSnippets` to something like
`markDecomposedSnippets`, then allow both `command` and `path` parents. A parent
should be `decomposed` only when all derived child snippets are `backed`.

Warnings should still be appended only after decomposition, so a decomposed path
does not also get a stale `snippet_unmatched` warning.

## Implementation Steps

1. Add representative regression tests first.
   - Update `tests/unit/review-evidence.test.ts`.
   - Add a fixture repo with minimal `src/dashboard/run-launcher.ts` and
     `src/dashboard/run-resumer.ts` snippets containing:
     - `path.join("dashboard-launches", `${launchId}.json`)`
     - `path.join("dashboard-resumes", `${resumeId}-diagnostics.json`)`
     - `resumeDryRunRecordPath`
     - `resumeDryRunClaimPath`
     - `` `${resumeId}.json` ``
     - `` `${resumeId}.claim` ``
   - Add tests for the exact failed claims:
     - `.agent-work/dashboard-resumes/<resume-id>.json`
     - `.agent-work/dashboard-resumes/<resume-id>-diagnostics.json`
     - `.agent-work/dashboard-resumes/<resume-id>.claim`
     - `.agent-work/dashboard-launches/`
     - `.agent-work/dashboard-launches/<launch-id>.json`
     - `.agent-work/dashboard-launches/<resume-launch-id>.json`
   - Assert parent path snippets are `decomposed` or `backed`, not
     `self_match_only` or `unmatched`.
   - Assert no `snippet_unmatched` warning is emitted for the valid parent
     claims.
   - Add negative tests for unsupported suffixes such as:
     - `.agent-work/dashboard-resumes/<resume-id>-audit.json`
     - `.agent-work/dashboard-launches/<launch-id>-audit.json`
     - `.agent-work/dashboard-launches/<unknown-id>.json`

2. Extend path extraction.
   - Update the path regexes in `extractUnquotedSnippets` and
     `deriveCommandClaims`, or factor them into one shared helper.
   - Include dashboard diagnostic directory names and paths in the extraction
     patterns.
   - Add an `addPathSnippet` helper that can add the parent path and derived
     component snippets in one place.
   - Preserve current extraction for run artifact directories such as `logs/`,
     `reviews/`, and `runner/`.

3. Add dashboard path normalization helpers.
   - Normalize leading `./`.
   - Normalize path separators to `/`.
   - Normalize repeated trailing slash only for matching.
   - Keep `.agent-work/dashboard-resumes/<resume-id>.json` and
     `dashboard-resumes/<resume-id>.json` comparable by recognizing that
     `.agent-work` represents the artifact root, not a source literal.
   - When `.agent-work` appears in a dashboard diagnostic path, add a derived
     artifact-root child claim that validates against `src/dashboard/server.ts`
     default options. Do not require launcher/resumer fixtures to contain
     `.agent-work`.
   - Do not strip arbitrary path prefixes other than the known artifact-root
     marker.

4. Add dashboard diagnostic path classifiers.
   - Implement helper predicates such as:
     - `isDashboardLaunchesPath`
     - `isDashboardResumesPath`
     - `isResumeRecordTemplatePath`
     - `isResumeDiagnosticsTemplatePath`
     - `isResumeClaimTemplatePath`
     - `isLaunchDiagnosticsTemplatePath`
   - Treat `<resume-id>`, `<launch-id>`, and `<resume-launch-id>` as
     placeholders only inside known dashboard diagnostic paths.
   - Avoid accepting unknown suffixes.

5. Add structured validators in `src/review/review-evidence.ts`.
   - In `validateStructuredSnippet`, route path snippets that match dashboard
     diagnostic directories or template paths to new validator functions.
   - Add `validateDashboardLaunchDiagnosticPath`.
   - Add `validateDashboardResumeDiagnosticPath`.
   - Reuse the existing dashboard default validator behavior, or add a small
     `validateDashboardDefaultArtifactRoot` helper, so `.agent-work` is backed
     from `src/dashboard/server.ts`.
   - Reuse `lineMatch` for simple exact source anchors.
   - If a validator proves only a component, return component matches; let parent
     decomposition mark the original path as `decomposed`.

6. Generalize decomposition.
   - Replace `markDecomposedCommandSnippets` with `markDecomposedSnippets`.
   - Allow both `command` and `path` snippets with derived children.
   - Keep the rule that every derived child must be `backed`.
   - Keep warning generation after decomposition.

7. Improve evidence output clarity.
   - For decomposed path parents, make sure the artifact lists:
     - original parent path,
     - `Status: decomposed`,
     - each derived child with its own source-backed matches.
   - Do not add absolute repository paths.
   - Do not hide unmatched child claims.

8. Add focused workflow-level protection if useful.
   - Existing workflow tests already prove evidence artifacts are written and
     passed to review.
   - Only add a new workflow test if the evidence builder API change affects
     prompt or artifact wiring.
   - Otherwise keep this issue covered at the unit level.

9. Run verification.
   - `npm run typecheck`
   - Targeted evidence tests:
     `npm run build`
     `node --test --test-name-pattern "buildReviewEvidence" dist-test/tests/unit/review-evidence.test.js`
   - Full unit/build gate:
     `npm run test:build`
   - Production build:
     `npm run build`

10. Optional actual rerun.
    - Re-run the dashboard smoke docs goal in an isolated temp repo.
    - Confirm Milestone 1 does not fail solely because dynamic
      `dashboard-launches` or `dashboard-resumes` paths are not source-backed.
    - It is still acceptable for review to fail if the generated docs contain
      genuinely unsupported path claims.

## Acceptance Criteria

- Valid dashboard launch diagnostic directory claims are source-backed by
  `src/dashboard/run-launcher.ts`.
- Valid dashboard resume diagnostic directory claims are source-backed by
  `src/dashboard/run-resumer.ts`.
- Valid placeholder paths for resume records, resume diagnostics, resume claim
  files, launch diagnostics, and resume-launched diagnostics are marked `backed`
  or `decomposed`.
- Unsupported dashboard diagnostic suffixes remain unbacked and produce review
  evidence warnings.
- Decomposed path parents do not also receive stale `snippet_unmatched`
  warnings.
- Evidence artifacts continue to exclude absolute repository roots.
- Existing source-backed documentation evidence behavior remains intact.
- Normal build and targeted test commands pass.

## Risks And Mitigations

- Risk: validators become too permissive and back fabricated dashboard paths.
  - Mitigation: only accept known directories and known suffix templates found in
    source.

- Risk: path decomposition hides a partially unsupported claim.
  - Mitigation: mark a parent as `decomposed` only when every derived child is
    backed; otherwise keep normal warnings.

- Risk: extraction gets noisy by treating ordinary prose as paths.
  - Mitigation: limit placeholder recognition to known dashboard diagnostic path
    prefixes.

- Risk: source line anchors are brittle.
  - Mitigation: match both function names and string literals where useful, and
    keep excerpts bounded.

- Risk: this solves dashboard diagnostics but not future dynamic path families.
  - Mitigation: keep validators narrowly structured and add future families only
    when real review failures prove they are needed.
