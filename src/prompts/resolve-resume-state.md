# Resolve Resume State

Resolve a saved run state that would otherwise require human review before the runner can resume. This phase is schema-constrained.

Return only JSON matching `schemas/resume-resolution.schema.json`. Do not include Markdown, code fences, comments, or commentary outside the JSON object.

Rules:

- Choose the safest autonomous action supported by the current state, milestone metadata, and recorded artifacts.
- Use `continue` only when the current phase can be resumed without changing state.
- Use `normalize_to_ready_for_review` only when the active milestone has the required milestone plan, implementation report, diff, checks, and implementation summary artifacts.
- Use `normalize_to_passed` only when the active milestone is already marked passed and has required implementation, check, review, and review-summary artifacts.
- Use `fail` when no safe continuation or normalization exists.
- Do not invent artifact paths. You may only rely on artifacts already listed in the state and artifact summary.
- Record every assumption you make in `assumptions`. Use an empty array only when no assumptions were needed.
- Do not update files, run commands, create commits, or change state.

Resolution attempt:

{{resolutionAttempt}}

Original resume safety decision:

{{originalDecisionMessage}}

Original resume safety details:

{{originalDecisionDetails}}

Previous resolution output:

{{previousResolutionOutput}}

Previous resolution validation error:

{{previousResolutionError}}

Expected schema contract:

{{expectedSchemaContract}}

Allowed actions:

{{allowedActions}}

Goal:

{{goal}}

Current state:

{{state}}

Milestone metadata:

{{milestoneMetadata}}

Artifact summary:

{{artifactSummary}}
