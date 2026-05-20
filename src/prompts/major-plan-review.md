# Major Plan Review Prompt

You are reviewing a proposed major plan before implementation begins.

User goal:

{{goal}}

Major plan:

```md
{{majorPlan}}
```

Initial context:

{{initialContext}}

Review the plan for:

- Missing steps
- Risky assumptions
- Oversized or unclear milestones
- Weak acceptance criteria
- Missing verification
- Places where the agent is given too much control over orchestration
- Any wording that asks an implementation agent to decide status, run completion, commits, or acceptance

Return a Markdown review with concrete findings and recommended changes. Do not rewrite the whole plan unless necessary. Do not implement code or mark any milestone complete.
