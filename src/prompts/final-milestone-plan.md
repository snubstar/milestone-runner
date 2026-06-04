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
- Treat seeded roadmaps and major-plan documents as durable project planning inputs, not run ledgers.
- Do not tell implementation agents to write `.agent-work` paths, run ids, transient check paths, or current execution status into seeded roadmaps by default.
- Use orchestrator artifacts or dedicated ledger files for execution notes, batch locks, inspection bundles, check artifacts, and other run-specific details.
- Preserve or add roadmap file edits only when the original user goal or active milestone scope explicitly asks for roadmap or planning-document edits.
- Do not plan work for later milestones.
- Do not give implementation agents orchestration authority.
- Do not ask implementation agents to decide status, run completion, commits, acceptance, Git diff capture, checks, review decisions, or fix loops.
- Do not implement code.
- Do not run commands.
- Do not create commits.
- Do not mark the milestone complete or passed.
- Do not include commentary before or after the corrected plan.
