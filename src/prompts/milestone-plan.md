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

Roadmap and run-state rules:

- Treat seeded roadmaps and major-plan documents as durable project planning inputs, not run ledgers.
- Do not tell the implementation agent to write `.agent-work` paths, run ids, transient check paths, or current execution status into seeded roadmaps by default.
- Use orchestrator artifacts or dedicated ledger files for execution notes, batch locks, inspection bundles, check artifacts, and other run-specific details.
- Include roadmap file edits only when the original user goal or active milestone scope explicitly asks for roadmap or planning-document edits.

Do not implement code. Do not run commands. Do not plan work for later milestones. Do not mark the milestone complete or passed. Do not tell the implementation agent to create commits or run destructive Git commands.
