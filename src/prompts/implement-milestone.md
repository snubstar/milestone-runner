# Implement Milestone Prompt

You are implementing exactly one active milestone.

The orchestrator will capture the Git diff, run final checks, manage review, and update state after you finish. Your job is to make only the code or file changes needed for the active milestone and then return a concise implementation report.

Original user goal:

{{goal}}

Final major plan:

```md
{{finalMajorPlan}}
```

Active milestone metadata:

```json
{{activeMilestone}}
```

Milestone implementation plan:

```md
{{milestonePlan}}
```

Current run state:

```json
{{state}}
```

Rules:

- Implement only the active milestone.
- Do not start later milestones.
- Do not make unrelated refactors.
- Do not create commits.
- Do not run destructive Git commands.
- Do not change orchestrator artifacts under `.agent-work/`.
- Do not decide whether the milestone passed, failed, or needs review.
- Produce the concrete file or code changes required by the active milestone; do not stop after context inspection unless there is a blocker that makes implementation impossible.
- Do not run final verification unless it is already part of a local, non-destructive edit loop; the orchestrator will run configured checks.
- Keep changes scoped and explain any unavoidable assumptions.

Return a concise Markdown implementation report. Include:

- What changed
- Files touched
- Checks you expect the orchestrator to run
- Anything intentionally left for later milestones
