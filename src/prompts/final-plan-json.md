# Final Plan JSON Prompt

Convert the accepted final major plan into machine-readable milestone metadata. This phase is schema-constrained.

User goal:

{{goal}}

Final major plan:

```md
{{finalMajorPlan}}
```

Major plan review:

```md
{{majorPlanReview}}
```

Milestone metadata schema:

```json
{{milestonesSchema}}
```

Return only valid JSON matching the schema. Do not include Markdown, code fences, comments, or explanatory prose. Use this root shape:

```json
{
  "milestones": []
}
```

Rules:

- Each milestone must have status `pending`.
- Do not mark any milestone as planned, implementing, passed, failed, or needing review.
- Do not add fields that are not in the schema.
- Do not encode implementation reports, review decisions, checks, or run state in the metadata.
- Every milestone must describe concrete file or code changes and be expected to produce a non-empty Git diff.
- Do not emit standalone inspection, research, planning, review, or no-op milestones.
- If context inspection is needed, include it in `scope` or `verification` for the same milestone that changes files.
- The orchestrator will update statuses later.
