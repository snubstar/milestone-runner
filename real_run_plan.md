# Real Run Plan: Codex Exec Task-Running Adapter

## Goal

Implement the real task-running path so the orchestrator can execute an actual user task through `codex exec`, not only the deterministic fake runner.

Target behavior:

```text
agent-orchestrator "real user task"
-> plan
-> review plan
-> select milestone
-> invoke codex exec to edit the working tree
-> capture git diff
-> run checks
-> invoke codex exec to review/fix when needed
-> write final artifacts and state
```

## Verified Codex Exec Contract

Official Codex CLI reference:

- `https://developers.openai.com/codex/cli/reference#codex-exec`
- `https://developers.openai.com/codex/config-reference#configtoml`

The adapter must use `codex exec` for non-interactive scripted runs.

Supported command shape:

```bash
codex exec [OPTIONS] -
```

Required options for this adapter:

```bash
--cd <target-repo-root>
--sandbox read-only|workspace-write|danger-full-access
--color never
--output-last-message <path>
-c approval_policy="<policy>"
-
```

Schema-constrained phases also pass:

```bash
--output-schema <schema-path>
```

Prompt handling:

- Always pass the rendered prompt on stdin.
- Always use `-` as the prompt argument.
- Never pass large rendered prompts as command-line arguments.

Output handling:

- Read the final assistant response from `--output-last-message`.
- Capture stdout and stderr separately for diagnostics.
- Treat a non-zero exit code as runner failure.
- Treat a missing or empty final message as runner failure.

## Completion Status

Status: complete as of 2026-05-15.

The original real-run gaps are closed:

- `CodexExecRunner.run()` shells out to `codex exec`.
- The CLI allows implementation-capable `codex-exec` new and resume runs after environment and Git preflight checks pass.
- `CommandRunner` supports stdin and timeout handling.
- Every workflow runner call passes the target `cwd`.
- Real-run diagnostics are persisted under `.agent-work/<run-id>/runner/`.
- Deterministic fake-`codex` integration tests prove adapter command shape, stdin, schema, sandbox, diff capture, checks, review, and diagnostics without network or auth.
- The opt-in live Codex smoke test proves a fixture repository can be modified by real `codex exec`.
- A clean temporary repository manual run proved the documented real command reaches `passed`.

Final hardening discovered during live verification:

- Codex structured output rejected JSON Schema `uniqueItems`; the runner-facing milestone and review schemas now omit that keyword, while local validators still enforce duplicate dependency and duplicate reviewed-artifact rejection.
- A broad manual goal initially produced an inspection-only first milestone and therefore an empty diff. Planning prompts now explicitly prohibit standalone inspection, research, planning, review, and no-op milestones; any needed inspection must be folded into the same milestone that changes files.

## Non-Goals For First Real Run

- Do not add CI automation.
- Do not auto-commit changes.
- Do not auto-revert changes.
- Do not support non-Git implementation runs.
- Do not use `danger-full-access` by default.
- Do not parse Codex reasoning or depend on unstable JSON event fields for correctness.
- Do not rely on real Codex model behavior for ordinary unit tests.

## Milestone 1: Command Runner Stdin And Timeout

Primary outcomes:

- Extend `CommandRequest` with:

```ts
stdin?: string;
timeoutMs?: number;
```

- Write `stdin` to the child process when provided.
- Close child stdin after writing.
- Preserve `shell: false`.
- Preserve stdout, stderr, exit code, and spawn errors.
- Enforce `timeoutMs` by killing the child process and returning a command error.
- Add `timedOut?: boolean` to `CommandResult`.
- Make stdin write failures visible in `CommandResult.error`.

Implementation notes:

- Use `child.stdin.end(request.stdin)` when stdin is provided.
- Use `child.stdin.end()` when stdin is not provided and stdin is piped.
- Keep existing check runner behavior unchanged.
- Default timeout should be absent at the command-runner layer; runner config decides when to set one.

Acceptance criteria:

- A unit test runs a small Node subprocess that reads stdin and echoes it.
- A unit test verifies stdout and stderr capture still work.
- A unit test verifies non-zero exit codes are returned without throwing.
- A unit test verifies spawn failure is reported.
- A unit test verifies timeout kills a long-running process and sets `timedOut: true`.
- Existing command-runner and check-runner tests pass.

## Milestone 2: Runner Configuration Contract

Primary outcomes:

- Extend `CodexExecRunnerOptions` with:

```ts
timeoutMs?: number;
model?: string;
profile?: string;
jsonEvents?: boolean;
```

- Keep current required fields:

```ts
sandboxForPlanning
sandboxForImplementation
approvalPolicy
```

- Update config validation and schema.
- Update `orchestrator.config.example.json`.
- Remove support for deprecated `approvalPolicy: "on-failure"` or fail config validation with a migration message.

Approval policy mapping:

```text
approvalPolicy: "never"      -> -c approval_policy="never"
approvalPolicy: "on-request" -> -c approval_policy="on-request"
approvalPolicy: "untrusted"  -> -c approval_policy="untrusted"
```

Optional model/profile mapping:

```text
model   -> --model <model>
profile -> --profile <profile>
```

JSON events:

- Default `jsonEvents` to `false`.
- If enabled, pass `--json`, capture stdout as JSONL diagnostics only, and do not use JSON events as the source of final output.

Acceptance criteria:

- Config schema and TypeScript types match.
- Invalid approval policies fail before workflow execution.
- Existing fake-runner configs remain valid.
- Unit tests cover default config, explicit timeout, explicit model, explicit profile, and invalid approval policy.

## Milestone 3: Cwd Propagation To Every Runner Phase

Primary outcomes:

- Pass `cwd: options.cwd` in every workflow call to `runner.run()`.
- This applies to planning, milestone planning, implementation, review, and fix phases.
- Do not rely on `process.cwd()` inside `CodexExecRunner` except as a last-resort fallback for defensive behavior.

Required code areas:

- `src/planning/planning-workflow.ts`
- `src/implementation/implementation-workflow.ts`
- `src/review/review-workflow.ts`
- Any future workflow helper that calls `runner.run()`

Acceptance criteria:

- Unit tests assert every real runner phase receives the target cwd.
- Resume tests prove runner cwd comes from the loaded run target, not from the shell directory used to invoke resume.
- Fake runner tests remain unchanged except for accepting the additional cwd field.

## Milestone 4: Schema Path Selection

Primary outcomes:

- Add a small helper that maps runner phases to output schemas.

Required schema mapping:

```text
final_plan_json   -> schemas/milestones.schema.json
review_milestone  -> schemas/review-verdict.schema.json
```

No schema for:

```text
major_plan
major_plan_review
final_major_plan
milestone_plan
implement_milestone
fix_review_findings
```

Implementation notes:

- Resolve schema paths from the target repo root.
- If a required schema file is missing, fail before calling Codex.
- Keep existing validators as the source of truth after Codex returns output.
- `--output-schema` helps Codex produce valid output but does not replace local validation.

Acceptance criteria:

- Unit tests verify `--output-schema` is passed for `final_plan_json` and `review_milestone`.
- Unit tests verify no schema flag is passed for Markdown phases.
- Missing schema files fail with a clear runner error.
- Malformed milestone JSON still fails in planning validation.
- Malformed review JSON still becomes `needs_human_review` through existing review workflow behavior.

## Milestone 5: Codex Exec Runner Implementation

Primary outcomes:

- Replace the `CodexExecRunner.run()` stub with real subprocess execution.
- Inject a `CommandRunner` into `CodexExecRunner` for testability.
- Build arguments deterministically from request phase and runner options.
- Send `request.prompt` through `CommandRequest.stdin`.
- Use `request.cwd` as both:
  - process cwd for spawning `codex`,
  - value passed to `codex exec --cd`.
- Use a temporary `--output-last-message` file for each invocation.
- Read the final message before cleanup.
- Clean up temporary files after reading.

Phase sandbox mapping:

```text
major_plan                 -> sandboxForPlanning
major_plan_review          -> sandboxForPlanning
final_major_plan           -> sandboxForPlanning
final_plan_json            -> sandboxForPlanning
milestone_plan             -> sandboxForPlanning
implement_milestone        -> sandboxForImplementation
review_milestone           -> sandboxForPlanning
fix_review_findings        -> sandboxForImplementation
```

Base command:

```bash
codex exec \
  --cd <cwd> \
  --sandbox <phase-sandbox> \
  --color never \
  --output-last-message <temp-file> \
  -c approval_policy="<approval-policy>" \
  -
```

Optional args:

```bash
--model <model>
--profile <profile>
--json
--output-schema <schema-path>
```

Return shape:

```ts
{
  text: finalAssistantMessage,
  exitCode: commandResult.exitCode ?? 1,
  metadata: {
    runner: "codex-exec",
    command,
    args,
    cwd,
    phase,
    sandbox,
    approvalPolicy,
    timeoutMs,
    timedOut,
    stdout,
    stderr,
    outputLastMessageCaptured: true
  }
}
```

Do not store the temporary output file path in durable metadata after cleanup. If a durable path is needed later, write an explicit run artifact instead.

Acceptance criteria:

- A unit test using a fake command runner asserts command, args, cwd, stdin, timeout, and sandbox for each phase.
- A unit test asserts approval policy is passed through `-c approval_policy="..."`.
- A unit test asserts model/profile args are included only when configured.
- A unit test asserts the runner reads `--output-last-message`.
- A unit test asserts non-zero exit code propagates.
- A unit test asserts timeout propagates as failure metadata.
- Temporary files are cleaned up after the runner reads them.

## Milestone 6: Durable Runner Diagnostics

Primary outcomes:

- Persist runner diagnostics for every real runner invocation.
- Do not rely on `AgentRunResult.metadata` being present only in failure details.
- Add a run artifact directory:

```text
.agent-work/<run-id>/runner/
  <phase>-<sequence>.json
```

Suggested diagnostic shape:

```json
{
  "phase": "implement_milestone",
  "milestoneId": 1,
  "runner": "codex-exec",
  "command": "codex",
  "args": ["exec", "..."],
  "cwd": "/repo",
  "exitCode": 0,
  "timedOut": false,
  "sandbox": "workspace-write",
  "approvalPolicy": "never",
  "stdout": "...",
  "stderr": "...",
  "startedAt": "2026-05-15T00:00:00.000Z",
  "endedAt": "2026-05-15T00:00:00.000Z"
}
```

Implementation options:

- Prefer persisting diagnostics in the workflow layer because workflows know `paths`.
- If persistence is added to the runner, pass a diagnostics directory explicitly and keep runner tests isolated.

Acceptance criteria:

- Successful real runner calls write diagnostics.
- Failed real runner calls write diagnostics.
- Diagnostics never include raw environment variables.
- Diagnostics never include the full rendered prompt by default.
- Failure terminal output points to the relevant diagnostic artifact when available.

## Milestone 7: CLI Real-Runner Enablement

Primary outcomes:

- Remove the fake-only guard for implementation-capable new runs.
- Remove the fake-only guard for implementation-capable resume runs.
- Keep Git preflight exactly as strict as it is today.
- Keep `--allow-dirty` explicit.
- Preserve `--dry-run` behavior, but report that the real runner would execute `codex exec`.
- Improve user-facing errors when `codex` is missing, times out, or returns a non-zero exit code.

Acceptance criteria:

- `node dist/cli/main.js --dry-run --runner codex-exec "task"` is allowed when Git and config checks pass.
- `node dist/cli/main.js --runner codex-exec "task"` reaches `CodexExecRunner`.
- Missing `codex` fails before workflow execution with a clear environment diagnostic.
- Dirty working trees are still blocked unless `--allow-dirty` is set.
- Non-zero Codex exit stops the current phase and does not advance milestones.

## Milestone 8: Deterministic Adapter Integration Test

Primary outcomes:

- Add a deterministic fake `codex` executable for tests.
- Test the real adapter and orchestrator without network, credentials, or model calls.
- The fake executable must simulate `codex exec` enough to verify:
  - `-` stdin prompt handling,
  - `--cd` handling,
  - `--sandbox` handling,
  - `--output-last-message` handling,
  - `--output-schema` handling,
  - fixture file edits during implementation phases,
  - final JSON output during schema phases.

Suggested fixture command behavior:

```text
codex exec ... --output-last-message <file> -
-> read stdin
-> inspect prompt/args
-> if implementation phase, write a fixture file under --cd
-> write phase-specific final message to <file>
-> exit 0
```

Acceptance criteria:

- Integration test creates a temporary Git repo with an initial commit.
- Test config points `runner.command` at the fake executable.
- The orchestrator runs with `--runner codex-exec`.
- The fake executable edits the fixture during implementation.
- The orchestrator captures a non-empty diff.
- Checks pass.
- Review JSON validates.
- Runner diagnostics are written.
- No network or Codex auth is required.

## Milestone 9: Opt-In Real Codex Smoke Test

Primary outcomes:

- Add a real smoke test guarded by an environment variable.
- The smoke task should be low-risk and deterministic, such as adding one line to a text file.
- Configure checks for the fixture, such as a small Node assertion.

Suggested command:

```bash
RUN_REAL_CODEX=1 npm run test:real-codex
```

Acceptance criteria:

- The smoke test skips unless `RUN_REAL_CODEX=1`.
- The smoke test creates a temporary Git repo with an initial commit.
- The orchestrator runs with `--runner codex-exec`.
- Real `codex exec` edits the fixture.
- The orchestrator captures a non-empty diff.
- Checks pass.
- Review output is valid or the test clearly reports a real-run review failure with diagnostics.
- The run writes inspectable artifacts under the fixture `.agent-work/`.

## Milestone 10: Prompt Hardening For Real Runs

Primary outcomes:

- Review every prompt under `src/prompts/` for real Codex execution.
- Make output contracts explicit enough for non-fake runs.
- Ensure planning prompts do not invite implementation.
- Ensure implementation prompts prohibit commits, destructive Git commands, unrelated files, and later milestones.
- Ensure review prompts require JSON only.
- Ensure fix prompts require scoped changes only.

Specific requirements:

- `final-plan-json.md` must say output is schema-constrained and must return only JSON.
- `review-milestone.md` must say output is schema-constrained and must return only JSON.
- `implement-milestone.md` must tell Codex that the orchestrator, not the agent, captures diffs and runs final checks.
- `fix-review-findings.md` must tell Codex to fix only blocking findings and return a concise report.

Acceptance criteria:

- Prompt unit tests still pass.
- Manual inspection confirms no prompt tells the agent to decide workflow completion.
- Real smoke test does not fail because of avoidable prose around JSON phases.

## Milestone 11: Real Manual Test Path

Primary outcomes:

- Document the exact command for running a real task locally.
- Include separate examples for clean and intentionally dirty trees.
- Explain where artifacts, diffs, checks, summaries, and runner diagnostics are written.
- Explain how to resume a stopped run.

Manual test command after implementation:

```bash
npm run build

node dist/cli/main.js --runner codex-exec --milestone 1 \
  "Add a short manual testing section to README.md"
```

If the starting dirty tree is deliberate:

```bash
node dist/cli/main.js --allow-dirty --runner codex-exec --milestone 1 \
  "Add a short manual testing section to README.md"
```

Expected result:

- Codex actually edits the working tree.
- The orchestrator captures the real diff in `.agent-work/<run-id>/diffs/`.
- Configured checks run.
- Review artifacts are written.
- Runner diagnostics are written in `.agent-work/<run-id>/runner/`.
- `state.json` records the final status and every produced artifact path.

## Milestone 12: Documentation Update

Primary outcomes:

- Update `README.md` to distinguish:
  - fake deterministic runs,
  - planning-only real runs,
  - deterministic adapter integration tests,
  - full real Codex runs.
- Document prerequisites:
  - `codex` installed,
  - authenticated Codex environment,
  - Git repo with at least one commit,
  - clean tree unless `--allow-dirty`,
  - configured checks recommended.
- Add troubleshooting for:
  - missing `codex`,
  - dirty tree,
  - timeout,
  - Codex non-zero exit,
  - malformed milestone JSON,
  - malformed review JSON,
  - empty diff.

Acceptance criteria:

- A developer can run a fake workflow and a real Codex workflow from README commands.
- README no longer implies the real adapter is wired before it is.
- The current limitation is removed only when deterministic adapter integration tests pass.
- The real smoke test is documented as opt-in.

## Implementation Order

Built in this order:

1. [x] Add stdin and timeout support to `CommandRunner`.
2. [x] Extend and validate runner config.
3. [x] Pass `cwd` through every workflow runner call.
4. [x] Add schema path selection.
5. [x] Implement `CodexExecRunner`.
6. [x] Persist runner diagnostics.
7. [x] Add deterministic fake-`codex` integration test.
8. [x] Remove fake-only CLI guards.
9. [x] Harden prompts.
10. [x] Add opt-in real Codex smoke test.
11. [x] Update README.

Ordering constraint satisfied: the fake-only CLI guard was removed only after the deterministic adapter integration test passed.

## Definition Of Done

The real task-running adapter is done when all of these are true:

- [x] `CommandRunner` supports stdin and timeouts.
- [x] Every runner phase receives the correct target cwd.
- [x] `CodexExecRunner` shells out to `codex exec`.
- [x] Rendered prompts are passed to Codex through stdin.
- [x] Approval policy is passed with `-c approval_policy="..."`.
- [x] `final_plan_json` and `review_milestone` use `--output-schema`.
- [x] Codex can modify the target repository during implementation and fix phases.
- [x] Planning and review phases run read-only by default.
- [x] Implementation and fix phases run workspace-write by default.
- [x] Real runner stdout/stderr diagnostics are persisted.
- [x] The fake-only CLI guard is removed only after deterministic integration tests pass.
- [x] A real opt-in smoke test proves a fixture repo can be changed by real Codex.
- [x] The manual command in README works on a clean local Git repo.
- [x] Failure modes leave useful state and artifacts for inspection.

## Final Verification

Latest verification commands:

```bash
npm run build
npm run test:build
RUN_REAL_CODEX=1 npm run test:real-codex
```

Results:

- `npm run build` passed.
- `npm run test:build` passed with 258 deterministic tests.
- `RUN_REAL_CODEX=1 npm run test:real-codex` passed with 1 live Codex smoke test.
- The README-style manual command passed in a clean temporary Git repository:

```bash
node dist/cli/main.js --runner codex-exec --milestone 1 \
  "Add a short manual testing section to README.md"
```

Manual verification details:

- Fixture repo: `/private/tmp/agent-orchestrator-manual-WEFsqt`
- Run dir: `/private/tmp/agent-orchestrator-manual-WEFsqt/.agent-work/run-20260515105331937-a0cbee92`
- Final state: `passed`
- Milestone 1: `passed`
