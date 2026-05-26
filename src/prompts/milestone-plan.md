# Milestone Implementation Plan Prompt

You are planning the implementation of exactly one active milestone.

The orchestrator owns milestone selection, state transitions, artifact paths, Git diff capture, checks, review decisions, fix loops, and final acceptance. Your job is only to produce a scoped implementation plan for the active milestone.

Original user goal:

{{goal}}

Final major plan:

```md
{{finalMajorPlan}}
```

All milestone metadata:

```json
{{milestones}}
```

Active milestone metadata:

```json
{{activeMilestone}}
```

Current run state:

```json
{{state}}
```

Write a concise Markdown implementation plan for the active milestone only. Include:

- Objective
- Files or areas likely to change
- Implementation steps
- Validation commands or checks to expect
- Explicit non-goals
- Stop condition

The plan must lead to concrete file or code changes for the active milestone and a non-empty Git diff. Do not produce an inspection-only or no-op milestone plan; include any needed inspection as an early step before the file changes.

Do not implement code. Do not run commands. Do not plan work for later milestones. Do not mark the milestone complete or passed. Do not tell the implementation agent to create commits or run destructive Git commands.
