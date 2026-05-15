# Final Major Plan Prompt

Create the accepted final major plan from the original major plan and review.

User goal:

{{goal}}

Major plan:

```md
{{majorPlan}}
```

Major plan review:

```md
{{majorPlanReview}}
```

Write a final Markdown plan that resolves the review findings. Preserve milestone boundaries, acceptance criteria, verification expectations, and risks.

Rules:

- Do not implement code.
- Do not run commands.
- Do not mark any milestone as complete.
- Every milestone must require concrete file or code changes and be expected to produce a non-empty Git diff.
- Do not preserve standalone inspection, research, planning, review, or no-op milestones; fold any needed inspection into the milestone that changes files.
- Keep orchestration responsibilities with the orchestrator: state transitions, Git diff capture, checks, review decisions, fix loops, and final acceptance.
