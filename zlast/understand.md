Plans are saved in two forms:

  1. Human-readable Markdown:
      - plans/01-major-plan.md
      - plans/02-major-plan-review.md
      - plans/03-final-major-plan.md
      - milestones/10-milestone-<id>-plan.md
      - milestones/11-milestone-<id>-implementation.md
  2. Machine-readable milestone metadata:
      - milestones/05-milestones.json

  That JSON is shaped like:

  {
    "milestones": [
      {
        "id": 1,
        "title": "Add manual testing section",
        "summary": "...",
        "scope": ["..."],
        "acceptanceCriteria": ["..."],
        "verification": ["..."],
        "dependencies": [],
        "status": "pending"
      }
    ]
  }

  So yes, each milestone is an object. But the implementation items inside it are not separate objects today; scope, acceptanceCriteria, and
  verification are arrays of strings.

  Progress is not ticked inside 05-milestones.json. That file is generated metadata and stays as the plan. Actual progress is tracked
  in .agent-work/<run-id>/state.json, mainly through:

  {
    "currentPhase": "checking",
    "currentMilestoneId": 1,
    "milestoneStatuses": {
      "1": "checking",
      "2": "pending"
    },
    "artifacts": {
      "milestonePlans": {
        "1": "milestones/10-milestone-1-plan.md"
      },
      "diffs": {
        "1": "diffs/12-milestone-1.diff"
      }
    }
  }

  Typical milestone status flow is:

  pending
  -> planned
  -> implementing
  -> checking
  -> ready_for_review
  -> reviewing
  -> passed

  If review finds blocking issues:

  reviewing -> fixing -> checking -> reviewing -> passed

  failed

  If the system cannot safely continue:

  needs_human_review

  So the plan is JSON object metadata, while progress is “ticked” by state transitions in state.json plus artifact paths being recorded as each
  phase completes.

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


› will the agent always produce a general plan + plan for each sub-milstone, or does will happen only for more complex tasks?


• Always, for a normal full run.

  The current workflow is fixed, not complexity-adaptive:

  goal
  -> major plan
  -> major plan review
  -> final major plan
  -> milestone JSON
  -> milestone 1 implementation plan
  -> milestone 1 implementation
  -> checks
  -> review
  -> repeat per milestone

  So even a small task gets:

  - plans/01-major-plan.md
  - plans/02-major-plan-review.md
  - plans/03-final-major-plan.md
  - milestones/05-milestones.json
  - milestones/10-milestone-1-plan.md

  Then each active milestone gets its own implementation report, diff, checks, review, and summary artifacts.

  The only exception is --planning-only, which stops after the general plan and milestone metadata. It does not create per-milestone
  implementation plans because no milestone is executed.

  There is no “skip planning for simple tasks” mode today.