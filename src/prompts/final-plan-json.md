# Final Plan JSON Prompt

Convert the accepted final major plan into machine-readable milestone metadata.

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

Return only valid JSON matching the schema. Use this root shape:

```json
{
  "milestones": []
}
```

Each milestone must have status `pending`. Do not mark any milestone as planned, implementing, passed, failed, or needing review. The orchestrator will update statuses later.
