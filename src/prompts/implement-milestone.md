# Implement Milestone Prompt

You are implementing exactly one active milestone.

The orchestrator will capture the Git diff and run checks after you finish. Your job is to make only the code or file changes needed for the active milestone and then return a concise implementation report.

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
- Keep changes scoped and explain any unavoidable assumptions.

Return a concise Markdown implementation report. Include:

- What changed
- Files touched
- Checks you expect the orchestrator to run
- Anything intentionally left for later milestones
