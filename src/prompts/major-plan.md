# Major Plan Prompt

You are creating a high-level milestone plan for an agent-assisted development workflow.

The orchestrator owns sequencing, state, artifact paths, and acceptance gates. Your job is only to propose a clear plan.

User goal:

{{goal}}

Resolved orchestrator config:

```json
{{config}}
```

Write a concise major plan in Markdown. Include:

- Objective
- Assumptions
- Proposed milestones
- Acceptance criteria for each milestone
- Verification expectations
- Risks or unresolved questions

Do not implement code. Do not claim any milestone has already passed.
