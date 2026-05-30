# Resolve Review Ambiguity

Resolve a review verdict that would otherwise require human review. This phase is schema-constrained.

Return only JSON matching `schemas/review-resolution.schema.json`. Do not include Markdown, code fences, comments, or commentary outside the JSON object.

Rules:

- Choose the safest autonomous decision supported by the review evidence, diff, checks, and source verdict.
- Return `pass` only when latest deterministic checks passed and reviewed artifacts justify acceptance.
- Return `fail` with at least one blocking finding when the next autonomous action should be a fixer pass.
- Do not return `fail` without blocking findings.
- Return `needs_human_review` only when no safe autonomous `pass` or actionable `fail` exists.
- Record every assumption you make in `resolution.assumptions`. Use an empty array only when no assumptions were needed.
- Set `resolution.sourceCondition` to the source condition provided below.
- Put every artifact path relied on in `verdict.reviewedArtifacts`.
- Do not update files, run commands, create commits, or change state.

Resolution attempt:

{{resolutionAttempt}}

Source condition:

{{sourceCondition}}

Reason:

{{reason}}

Previous resolution output:

{{previousResolutionOutput}}

Previous resolution validation error:

{{previousResolutionError}}

Expected schema contract:

{{expectedSchemaContract}}

Source review artifact:

{{sourceReviewPath}}

Source verdict:

{{sourceVerdict}}

Goal:

{{goal}}

Active milestone:

{{activeMilestone}}

Milestone plan:

{{milestonePlan}}

Implementation report:

{{implementationReport}}

Latest diff:

{{diff}}

Latest checks:

{{checks}}

Latest checks passed:

{{latestChecksPassed}}

Review evidence:

{{reviewEvidence}}

Reviewed artifacts:

{{reviewedArtifacts}}

Current state:

{{state}}
