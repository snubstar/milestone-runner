# Timings Artifact Plan

## Goals

- Produce a durable timing artifact for every real workflow run, including successful, failed, constrained, and human-review stops.
- Make timings easy to inspect manually and easy to consume programmatically.
- Aggregate timing information from three sources:
  - runner diagnostics for agent/model phases
  - check reports for deterministic verification commands
  - state transition timestamps for workflow phase wall-clock intervals
- Keep the timing feature observational. Timing collection must not change orchestration decisions, review decisions, fix behavior, or resume safety.
- Avoid leaking prompt text or duplicating large stdout/stderr payloads in timing summaries.
- Preserve current behavior for existing artifacts and state shape as much as possible.

## Implementation Decisions

- Add two generated artifacts:
  - `logs/80-timings.json`: machine-readable timing data
  - `logs/81-timings.md`: human-readable summary
- Record the timing artifacts under `state.artifacts.logs` with stable keys, for example:
  - `timingsJson`
  - `timingsMarkdown`
- Add `durationMs` to runner diagnostic JSON. Continue writing `startedAt` and `endedAt`.
- Do not rely on runner diagnostics alone. `light` milestone plans intentionally skip `milestone_plan`, fake runner calls do not currently persist diagnostics, and non-agent operations still matter.
- Add a small state timeline log under `logs/timeline.jsonl` to preserve state transition timestamps over time. The current `state.json` only stores the latest `updatedAt`, so it cannot reconstruct historical phase durations by itself.
- Treat workflow wall-clock phase durations, runner durations, and check durations as related but distinct. Runner and check durations are nested inside workflow phases, so totals must not double-count them.
- Timing artifact generation should be best-effort. If timing generation fails after the primary workflow result is known, the run should still report the primary result and surface a warning or residual risk.
- Define `runEndedAt` as the primary workflow terminal or pause timestamp captured before timing artifacts are written and recorded in state. Timing artifact writes are post-run metadata and must not move the measured run end.
- Treat goal summary generation as primary workflow work. It is included in the measured run end. Timing artifact generation is not primary workflow work.
- Distinguish run lifecycle duration from active workflow duration:
  - `lifecycleDurationMs` spans original `state.createdAt` to the latest captured `runEndedAt` and includes idle time between stopped/resumed invocations.
  - `activeWorkflowDurationMs` is the sum of non-dry workflow invocation spans and excludes idle time between stopped/resumed invocations.
  - `latestInvocationDurationMs` measures only the current CLI invocation being finalized.
- Record invocation boundaries in the timeline with an `invocation_started` event near the start of each non-dry workflow invocation and an `invocation_ended` event at captured `runEndedAt`.
- Timeline events are append-only observations. Phase interval aggregation must use only phase-bearing baseline events and phase-change events. Milestone-status-only and invocation-only events are annotations and must not create separate workflow phase intervals.
- Check durations should come from structured `CheckRunResult` values while a workflow is running. Parsing text check reports is only a fallback for resume/reconstruction scenarios.
- Surface non-fatal timing problems through a typed warning channel:
  - include warnings in `timings.json`
  - return timing warnings from `runGoalWorkflow`
  - print timing warnings in CLI run reports
  - when timing artifact generation fails completely, report `timing_finalization_failed` through the workflow result and CLI output

## Proposed JSON Shape

```json
{
  "schemaVersion": 1,
  "runId": "run-...",
  "generatedAt": "2026-05-18T10:00:00.000Z",
  "runStartedAt": "2026-05-18T09:55:00.000Z",
  "latestInvocationStartedAt": "2026-05-18T09:55:00.000Z",
  "runEndedAt": "2026-05-18T10:00:00.000Z",
  "finalizedAt": "2026-05-18T10:00:01.000Z",
  "lifecycleDurationMs": 300000,
  "activeWorkflowDurationMs": 300000,
  "latestInvocationDurationMs": 300000,
  "aggregates": {
    "runnerDurationMs": 120000,
    "checkDurationMs": 5000,
    "knownWorkflowPhaseDurationMs": 295000
  },
  "invocations": [
    {
      "invocationId": "1",
      "startedAt": "2026-05-18T09:55:00.000Z",
      "endedAt": "2026-05-18T10:00:00.000Z",
      "durationMs": 300000,
      "startPhase": "initialized",
      "terminalPhase": "passed",
      "terminalStatus": "passed"
    }
  ],
  "workflowPhases": [
    {
      "phase": "planning",
      "milestoneId": null,
      "startedAt": "2026-05-18T09:55:00.000Z",
      "endedAt": "2026-05-18T09:56:10.000Z",
      "durationMs": 70000
    }
  ],
  "runnerPhases": [
    {
      "phase": "major_plan",
      "milestoneId": null,
      "startedAt": "2026-05-18T09:55:02.000Z",
      "endedAt": "2026-05-18T09:55:30.000Z",
      "durationMs": 28000,
      "exitCode": 0,
      "timedOut": false,
      "sourceArtifact": "runner/major_plan-01.json"
    }
  ],
  "checks": [
    {
      "stateKey": "1",
      "milestoneId": 1,
      "attempt": null,
      "commandIndex": 1,
      "command": "npm run test:build",
      "durationMs": 1200,
      "exitCode": 0,
      "source": "structured",
      "confidence": "high",
      "sourceArtifact": "checks/13-milestone-1-checks.txt"
    }
  ],
  "warnings": [
    {
      "code": "timeline_incomplete",
      "message": "Timeline was missing an expected invocation boundary.",
      "source": "timeline"
    }
  ]
}
```

## Finalization Ordering

Timing finalization must happen in this order:

1. A non-dry workflow invocation starts after a run directory and `state.json` exist.
2. Append an `invocation_started` timeline event with a per-run sequential `invocationId`.
3. The primary workflow reaches its terminal or pause state and writes all primary artifacts it can, including the goal summary when applicable.
4. Capture `runEndedAt` once, immediately after the primary workflow result is known and before adding timing artifact references.
5. Append an `invocation_ended` timeline event using the same `invocationId` and captured `runEndedAt`.
6. Build `timings.json` and `timings.md` using the captured `runEndedAt`.
7. Write timing artifacts.
8. Record timing artifact paths under `state.artifacts.logs`.
9. Persist the final state.

This means `state.updatedAt` may be later than `runEndedAt` after timing artifact paths are recorded. That is expected. Consumers should use the explicit duration fields in `timings.json` for runtime measurements and `timings.json.finalizedAt` for when timing artifacts were generated.

If timing finalization fails after step 4, return the primary workflow result unchanged and attach a `timing_finalization_failed` warning to the workflow result. If the warning cannot be written into `timings.json` because timing generation failed completely, the CLI report is still responsible for printing it.

## Milestone 1: Timing Artifact Paths And Types

Implementation steps:

1. Add `src/artifacts/timing-artifacts.ts`.
2. Add a `buildTimingArtifactPaths(paths)` helper with:
   - `logs/timeline.jsonl`
   - `logs/80-timings.json`
   - `logs/81-timings.md`
3. Add timing types in `src/timings/timing-types.ts`.
4. Define types for:
   - timing warning codes and warning entries
   - workflow invocation timings
   - workflow timeline events
   - runner phase timings
   - check timings
   - aggregate timings
   - final timings document
5. Keep all timing paths run-relative when recorded in state.
6. Add warning result types for workflow integration, for example `TimingWarning` and `TimingWarningCollector`.
7. Use a stable warning shape:
   - `code`: machine-readable string such as `timeline_missing`, `timeline_incomplete`, `phase_interval_incomplete`, `runner_diagnostic_malformed`, `check_report_malformed`, or `timing_finalization_failed`
   - `message`: short human-readable explanation
   - `source`: `timeline`, `runner`, `checks`, `finalization`, or `workflow`
   - `details`: optional structured metadata only, with no prompt text or large command output

Acceptance criteria:

- Timing paths are stable and use the existing `logs/` directory.
- Timing JSON has a versioned schema.
- Timing JSON explicitly distinguishes lifecycle duration, active workflow duration, and latest invocation duration.
- Timing warnings have stable machine-readable codes.
- No existing artifact paths change.

Verification:

- Unit tests for timing path construction.
- TypeScript build passes.

## Milestone 2: State Timeline Recording

Implementation steps:

1. Add `src/timings/state-timeline.ts`.
2. Implement `appendStateTimelineEvent(options)`:
   - accepts `paths`, `previousState`, and `nextState`
   - allows `previousState: null` for the initial `state_initialized` event
   - compares phase, status, current milestone id, and milestone statuses
   - appends a compact JSON line only when a meaningful state transition happened
3. Implement `appendInvocationTimelineEvent(options)`:
   - accepts `paths`, `invocationId`, `event`, `timestamp`, and the current state
   - writes `invocation_started` and `invocation_ended` events
   - never changes workflow phase intervals by itself
4. Include fields:
   - `timestamp`
   - `event`
   - `invocationId`, when known
   - `phase`
   - `status`
   - `currentMilestoneId`
   - changed milestone statuses, when relevant
5. Use event names:
   - `state_initialized`
   - `phase_changed`
   - `status_changed`
   - `current_milestone_changed`
   - `milestone_status_changed`
   - `invocation_started`
   - `invocation_ended`
6. A single state write may produce one compact event containing multiple changed fields. If the phase changed, the event must include `event: "phase_changed"` even if other fields also changed.
7. Record the initial state write as `state_initialized` so phase interval derivation has a baseline before the first `phase_changed` event.
8. Update local `persist` helpers in planning, implementation, review, and goal workflows to append timeline events after state writes.
9. Add CLI integration for invocation boundary events:
   - new runs append `invocation_started` after initial `state.json` exists and before `runGoalWorkflow`
   - resume runs append `invocation_started` after resume state is loaded and before `runGoalWorkflow`
   - the timing finalizer appends `invocation_ended`
10. Timeline append failures must not fail the primary workflow, but they must be recorded in a `TimingWarningCollector` when possible.
11. Avoid logging large state snapshots; timeline entries should contain only timing and transition metadata.

Acceptance criteria:

- Runs produce `logs/timeline.jsonl`.
- Timeline entries are compact and do not contain prompts, diffs, or full state.
- Timeline remains useful across resume runs by appending to the existing file.
- Phase intervals are derived only from `state_initialized` and `phase_changed` events, with open intervals closed at the relevant `runEndedAt`.
- Phase intervals are clipped to invocation spans so idle time between stopped/resumed invocations is not counted in `activeWorkflowDurationMs`.
- Milestone-status-only and invocation-only events are preserved as annotations but do not create workflow phase intervals.

Verification:

- Unit tests for transition detection.
- Unit tests for invocation boundary recording.
- Unit tests for phase interval derivation that ignore milestone-status-only and invocation-only events.
- Unit tests proving open phase intervals close at captured `runEndedAt`.
- Workflow test proving timeline events are written during planning, implementation, review, and fix transitions.
- Resume test proving timeline events append rather than overwrite.

## Milestone 3: Runner Diagnostic Duration

Implementation steps:

1. Update `src/runners/runner-diagnostics.ts` to compute `durationMs` from `startedAt` and `endedAt`.
2. Include `durationMs` in persisted runner diagnostic JSON.
3. Keep existing `startedAt` and `endedAt` fields for auditability.
4. If timestamps are invalid or inverted, omit `durationMs` and let the final timings aggregator emit a warning.
5. Keep diagnostics persisted only for `codex-exec` unless a separate decision is made to persist fake runner diagnostics.
6. Thread each workflow's injected `clock` into `runAgentPhaseWithDiagnostics` so deterministic tests can control runner diagnostic timestamps.

Acceptance criteria:

- Real runner diagnostic artifacts include `durationMs`.
- Existing diagnostic fields remain backward-compatible.
- Timing data is available even when a runner exits non-zero or throws.

Verification:

- Update runner diagnostic unit tests for success, failure, and thrown error cases.
- Update planning, implementation, and review workflow tests to prove injected clocks are passed through to runner diagnostics.
- Existing codex-exec adapter tests continue to pass.

## Milestone 4: Timing Aggregator

Implementation steps:

1. Add `src/timings/run-timings.ts`.
2. Implement readers for:
   - `logs/timeline.jsonl`
   - `runner/*.json`
   - check artifacts referenced by `state.artifacts.checks`
3. Add `src/timings/check-timing-collector.ts`.
4. Implement an in-memory check timing collector with an API equivalent to:
   - `recordCheckRun({ stateKey, milestoneId, attempt, artifactPath, result })`
   - one collected check timing entry per `CheckRunResult.results` command
   - no stdout, stderr, prompt text, or diff content
5. Thread the collector from `runGoalWorkflow` into implementation and review workflows.
6. In implementation workflow, record the base milestone check run immediately after `runChecks` returns and before the check report is written.
7. In review workflow, record every post-fix check run immediately after `runChecks` returns and before the post-fix check report is written.
8. For terminal finalization in the same process, prefer structured check timing entries from the collector.
9. For resume/reconstruction, parse check durations from existing check reports using the stable `Duration: <n>ms` lines as a fallback.
10. Parse milestone ids and fix attempt numbers from state artifact keys:
   - `"1"` means milestone 1 base check
   - `"1-fix-2"` means milestone 1, fix attempt 2
11. Compute:
   - `lifecycleDurationMs` from original `state.createdAt` to captured `runEndedAt`
   - `activeWorkflowDurationMs` from summed invocation spans
   - `latestInvocationDurationMs` from the current invocation span
   - workflow phase intervals from `state_initialized` and `phase_changed` timeline events only
   - runner phase durations from diagnostics
   - check durations from structured collector entries or parsed check reports
   - aggregates by category, phase, and milestone
12. Include both timing source and confidence for check timings:
   - `source: "structured"`
   - `source: "parsed_report"`
   - `confidence: "high"` for structured entries
   - `confidence: "medium"` for parsed report entries with command and duration
   - `confidence: "low"` for parsed report entries missing command text or exit code
13. Sort entries deterministically:
   - timeline order by timestamp
   - runner order by diagnostic sequence/file name
   - checks by milestone id, attempt, and command index
14. Emit warnings for missing, malformed, or partial timing sources.
15. Do not fail the run if a timing source is missing. Missing timing data should produce warnings in `timings.json`.

Acceptance criteria:

- Aggregator can produce a useful timing document for:
  - full codex-exec runs
  - light-policy runs where `milestone_plan` is skipped
  - fake-runner tests with no runner diagnostics
  - failed or human-review runs with partial artifacts
- Resume runs report lifecycle duration separately from active workflow duration, so idle time between invocations is not mistaken for execution time.
- Aggregates avoid double-counting nested runner/check durations inside workflow phase wall-clock time.
- Lifecycle and invocation durations are based on captured `runEndedAt`, not on state writes caused by timing finalization.
- Missing or partial timeline data emits explicit warnings such as `timeline_missing`, `timeline_incomplete`, or `phase_interval_incomplete`.
- Check timings use structured data during the current workflow invocation and parsed reports only when structured data is unavailable.

Verification:

- Unit tests for parsing timeline events.
- Unit tests for parsing runner diagnostics.
- Unit tests for parsing base and post-fix check reports.
- Unit tests for missing/malformed artifacts producing warnings.
- Unit test proving timing artifact state recording does not change `runEndedAt`.
- Unit test proving resume idle time is excluded from `activeWorkflowDurationMs` and included in `lifecycleDurationMs`.

## Milestone 5: Human-Readable Timing Summary

Implementation steps:

1. Add a formatter for `logs/81-timings.md`.
2. Include:
   - lifecycle duration
   - active workflow duration
   - latest invocation duration
   - runner duration total
   - check duration total
   - slowest runner phases
   - slowest checks
   - per-milestone timing table
   - warnings
3. Make the Markdown concise enough to inspect quickly.
4. Use fixed labels and stable ordering so snapshots are testable.
5. Avoid including stdout, stderr, prompts, or diffs.

Acceptance criteria:

- A user can answer “where did time go?” without opening many JSON files.
- The Markdown summary is stable and readable.

Verification:

- Unit tests for Markdown formatting.
- Snapshot-style assertions for representative timing documents.

## Milestone 6: Workflow Integration

Implementation steps:

1. Add `writeRunTimings(options)` that:
   - builds the timing document
   - writes JSON and Markdown artifacts
   - returns run-relative artifact paths and warnings
2. Extend `GoalWorkflowResult` with `timingWarnings?: TimingWarning[]`.
3. Extend CLI run reporting options with `timingWarnings?: TimingWarning[]` and print them when present.
4. Add a finalization helper in `runGoalWorkflow` that accepts the primary result, invocation metadata, the check timing collector, and accumulated timing warnings.
5. Integrate timing generation at workflow stop points:
   - passed goal
   - failed run
   - needs human review
   - planning-only stop
   - constrained milestone stop with `nextAction`
6. Route every `runGoalWorkflow` return path after state creation through the finalization helper, including early planning-only and constrained milestone returns.
7. The finalization helper must capture `runEndedAt` before writing timing artifacts or recording timing artifact paths.
8. Record timing artifacts in `state.artifacts.logs`.
9. If timing generation fails, preserve the primary workflow result and attach a `timing_finalization_failed` warning to `GoalWorkflowResult.timingWarnings`.
10. Ensure resume runs update the same timing artifacts rather than creating duplicate timing files.
11. Thread the in-memory timing collector through implementation and review workflows so structured check timing data reaches finalization.
12. Thread the timing warning collector through timeline recording and finalization so append failures, malformed timing sources, and finalization failures share the same warning shape.

Acceptance criteria:

- Every non-dry workflow invocation with an existing run directory attempts to write or update timing artifacts.
- The final `state.json` references the timing artifacts.
- Timing generation does not change pass/fail/review outcomes.
- All `runGoalWorkflow` returns after state creation pass through the timing finalizer.
- The timing finalizer preserves the measured `runEndedAt` even though recording timing artifact paths updates `state.updatedAt`.
- Timing warnings are visible in `timings.json` when that file is written and in CLI output when timing finalization fails.

Verification:

- Goal workflow tests for success, failure, planning-only, and constrained milestone stops.
- Resume test showing timing artifacts are regenerated/updated after resume.
- Test that timing writer failure does not mask the primary workflow outcome.
- Test that early planning-only and constrained milestone returns still write timing artifacts.
- Test that `GoalWorkflowResult.timingWarnings` and CLI reports expose timing warnings.

## Milestone 7: CLI Reporting And Documentation

Implementation steps:

1. Update run reports to print timing artifact paths when present.
2. Print compact duration lines when timing artifacts are present:
   - `Lifecycle duration: 3m12s`
   - `Active workflow duration: 2m48s`
   - `Latest invocation duration: 41s`
   - `Runner duration: 2m04s`
   - `Check duration: 5s`
3. Print timing warnings from `GoalWorkflowResult.timingWarnings`.
4. Update README artifact layout to include:
   - `logs/timeline.jsonl`
   - `logs/80-timings.json`
   - `logs/81-timings.md`
5. Update `docs/how-to.md` with a short “Inspect timing” section.
6. Document that runner/check durations are nested inside workflow phase duration and should not be summed as total runtime.
7. Document that lifecycle duration includes idle time across resumes, while active workflow duration excludes idle time.

Acceptance criteria:

- Users can discover timing artifacts from normal run output.
- Documentation explains what is measured and what is not.

Verification:

- CLI report tests.
- Documentation review for consistency with generated artifact names.

## Milestone 8: Final Validation

Implementation steps:

1. Run `npm run test:build`.
2. Run a fake-runner end-to-end workflow and inspect timing artifacts.
3. Run a light-policy fake workflow and confirm skipped `milestone_plan` does not appear as a runner timing.
4. If practical, run one real `codex-exec` smoke task and inspect:
   - runner diagnostic `durationMs`
   - timing JSON runner entries
   - timing Markdown summary
5. Resume a constrained run and confirm timing artifacts update after the resumed work.
6. Confirm resumed timing artifacts show idle time in `lifecycleDurationMs` but not in `activeWorkflowDurationMs`.

Acceptance criteria:

- Timing artifacts are present and referenced in state.
- Timing artifacts are useful for both full and light milestone planning policies.
- Timing artifacts remain clear across resume invocations.
- Existing orchestration behavior and test coverage remain stable.

## Recommended Implementation Order

1. Timing paths and types.
2. State timeline recording.
3. Runner diagnostic duration.
4. Timing aggregation.
5. Markdown timing summary.
6. Workflow integration.
7. CLI/docs updates.
8. Final validation.
