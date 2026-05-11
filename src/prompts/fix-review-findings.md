# Fix Review Findings

Fix only the blocking findings for the active milestone.

Rules:

- Do not work on later milestones.
- Do not rewrite unrelated code.
- Do not create commits.
- Do not use destructive Git operations.
- Preserve existing user changes outside the active milestone scope.
- Return a concise Markdown fix report listing changed areas and unresolved findings.

Goal:

{{goal}}

Active milestone:

{{activeMilestone}}

Blocking findings:

{{blockingFindings}}

Latest review verdict:

{{reviewVerdict}}

Latest diff:

{{latestDiff}}

Latest checks:

{{latestChecks}}

Current state:

{{state}}
