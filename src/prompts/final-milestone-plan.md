# Final Milestone Plan Prompt

Create the accepted final implementation plan for exactly one active milestone from the milestone plan draft and review.

The orchestrator owns milestone selection, state transitions, artifact paths, Git diff capture, checks, review decisions, fix loops, and final acceptance. Your job is only to produce the corrected milestone plan that will be handed to the implementation agent.

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

Milestone plan draft:

```md
{{milestonePlanDraft}}
```

Milestone plan review:

```md
{{milestonePlanReview}}
```

Write only the corrected Markdown implementation plan for the active milestone. Include:

- Objective
- Files or areas likely to change
- Implementation steps
- Validation commands or checks to expect
- Explicit non-goals
- Stop condition

Rules:

- Resolve the review findings.
- Preserve the active milestone boundary.
- Keep the plan scoped to concrete file or code changes for this milestone.
- The plan must lead to a non-empty Git diff.
- Do not preserve inspection-only, research-only, planning-only, review-only, or no-op work as the milestone outcome; fold any needed inspection into the steps that change files.
- Do not plan work for later milestones.
- Do not give implementation agents orchestration authority.
- Do not ask implementation agents to decide status, run completion, commits, acceptance, Git diff capture, checks, review decisions, or fix loops.
- Do not implement code.
- Do not run commands.
- Do not create commits.
- Do not mark the milestone complete or passed.
- Do not include commentary before or after the corrected plan.
