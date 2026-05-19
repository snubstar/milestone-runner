# Review Milestone

Review only the active milestone. Decide whether the milestone can be accepted, needs fixes, or needs human review. This phase is schema-constrained.

Return only JSON matching `schemas/review-verdict.schema.json`. Do not include Markdown, code fences, comments, or commentary outside the JSON object.

Rules:

- Compare the implementation diff against the goal, final major plan, active milestone metadata, and milestone plan.
- Consider deterministic check output. If latest checks failed, do not return `pass`.
- Mark a finding as blocking only when it prevents accepting the active milestone.
- Use `needs_human_review` for ambiguity, missing context, unsafe behavior, or unverifiable claims.
- Use the review evidence artifact to verify source-backed documentation claims.
- Treat unmatched review evidence snippets as potential findings, not as automatic pass or fail decisions.
- Do not review later milestones except to confirm they were not started.
- Do not update files, run commands, create commits, or change state.
- Put every artifact path you relied on in `reviewedArtifacts`.

Goal:

{{goal}}

Final major plan:

{{finalMajorPlan}}

Active milestone:

{{activeMilestone}}

Milestone plan:

{{milestonePlan}}

Implementation report:

{{implementationReport}}

Diff:

{{diff}}

Checks:

{{checks}}

Review evidence:

{{reviewEvidence}}

Latest checks passed:

{{latestChecksPassed}}

Reviewed artifacts:

{{reviewedArtifacts}}

Current state:

{{state}}
