# Repair Review Verdict

Repair malformed milestone review output into valid review verdict JSON. This phase is schema-constrained.

Return only JSON matching `schemas/review-verdict.schema.json`. Do not include Markdown, code fences, comments, or commentary outside the JSON object.

Rules:

- Preserve the original reviewer's intent when it is clear from the raw output.
- Use the validation error to fix only JSON shape, field names, field values, missing required fields, and unsupported extra fields.
- If the raw output is ambiguous, choose the safest valid verdict supported by the evidence.
- Do not return `pass` when latest checks failed.
- Use `fail` with blocking findings when there is an actionable problem the fixer can address.
- Use `needs_human_review` only when the output cannot be converted into a safe `pass` or actionable `fail`.
- Put every artifact path relied on in `reviewedArtifacts`.
- Do not update files, run commands, create commits, or change state.

Repair attempt:

{{repairAttempt}}

Original validation error:

{{validationError}}

Previous repair output:

{{previousRepairOutput}}

Previous repair validation error:

{{previousRepairError}}

Raw malformed output:

{{rawOutput}}

Expected schema contract:

{{expectedSchemaContract}}

Goal:

{{goal}}

Active milestone:

{{activeMilestone}}

Milestone plan:

{{milestonePlan}}

Implementation report:

{{implementationReport}}

Latest diff:

{{diff}}

Latest checks:

{{checks}}

Latest checks passed:

{{latestChecksPassed}}

Review evidence:

{{reviewEvidence}}

Reviewed artifacts:

{{reviewedArtifacts}}

Current state:

{{state}}
