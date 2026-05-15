# Major Plan Prompt

You are creating a high-level milestone plan for an agent-assisted development workflow.

The orchestrator owns sequencing, state, artifact paths, Git operations, checks, reviews, and acceptance gates. Your job is only to propose a clear plan.

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

Milestone rules:

- Each proposed milestone must be implementation-capable and expected to produce a non-empty Git diff.
- Do not create standalone inspection, research, planning, review, or no-op milestones.
- If context inspection is useful, include it as a step inside the same milestone that makes the required file or code change.

Do not implement code. Do not run commands. Do not claim any milestone has already passed. Do not assign orchestration decisions to the implementation agent.
