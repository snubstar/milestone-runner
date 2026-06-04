# Fix Check Failures

Fix only the deterministic check failures for the active milestone. The orchestrator will capture the Git diff, rerun all configured checks, manage review, and update state after you finish.

Rules:

- Do not work on later milestones.
- Do not rewrite unrelated code.
- Do not create commits.
- Do not use destructive Git operations.
- Do not change orchestrator artifacts under `.agent-work/`.
- Do not decide whether the milestone passed, failed, or needs review.
- Preserve existing user changes outside the active milestone scope.
- Treat the structured failure summary as a compact index; use the full failed check report for source-of-truth output.
- Return a concise Markdown repair report listing changed areas, failing checks addressed, and anything still uncertain.

Goal:

{{goal}}

Final major plan:

```md
{{finalMajorPlan}}
```

Active milestone:

```json
{{activeMilestone}}
```

Milestone implementation plan:

```md
{{milestonePlan}}
```

Implementation report:

```md
{{implementationReport}}
```

Latest reviewable diff:

```diff
{{latestDiff}}
```

Latest failed check report:

```text
{{latestFailedCheckReport}}
```

Structured check-failure summary:

```text
{{checkFailureSummary}}
```

Check repair attempts completed:

{{checkFixAttempts}}

Maximum check repair attempts:

{{maxCheckFixAttempts}}

Current run state:

```json
{{state}}
```
