# Milestone Implementation Plan Prompt

You are planning the implementation of exactly one active milestone.

The orchestrator owns milestone selection, state transitions, artifact paths, Git diff capture, and checks. Your job is only to produce a scoped implementation plan for the active milestone.

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

Do not implement code. Do not plan work for later milestones. Do not mark the milestone complete or passed.
