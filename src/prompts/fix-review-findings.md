# Fix Review Findings

Fix only the blocking findings for the active milestone. The orchestrator will capture the Git diff, rerun checks, request another review, and update state after you finish.

Rules:

- Do not work on later milestones.
- Do not rewrite unrelated code.
- Do not create commits.
- Do not use destructive Git operations.
- Do not change orchestrator artifacts under `.agent-work/`.
- Do not fix non-blocking findings unless they are inseparable from a blocking fix.
- Do not decide whether the milestone passed, failed, or needs review.
- Preserve existing user changes outside the active milestone scope.
- Return a concise Markdown fix report listing changed areas, blocking findings addressed, and unresolved findings.

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
