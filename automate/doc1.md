**user**

I am using codex to code. I usually make start from a goal, ask the agent to make a plan, to review its plan and patch it if needed. If the plan is big (major milestones), I then ask the agent to make a plan for the first milestone. Then one step at a time i ask the agent to develop it. After the first milestone plan is finished, I ask the agent to review the job done. If issues are found, I ask the agent to fix them. Then i ask it to make a plan for the second milestone, etc. It seems to me that all this meta-work I am doing can and should be automatable. What options/tools I have to achieve this automation? How to achieve this?

**response**

Yes. What you are doing is basically a **manual orchestration loop**. The right automation is not “one giant prompt,” but a small workflow controller that repeatedly calls Codex with scoped prompts, stores artifacts, checks gates, and decides the next step.

## The main options

| Option                                    | Best for                          | How it helps your loop                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`AGENTS.md`**                           | Removing repeated instructions    | Put your standing workflow rules there: “always plan, review the plan, patch it, implement one milestone, review, fix, then continue.” Codex reads `AGENTS.md` before work, and OpenAI recommends using it for repo layout, test commands, engineering conventions, PR expectations, constraints, and “done” criteria. ([OpenAI Developers][1]) |
| **Codex Skills**                          | Reusable workflows                | A skill packages instructions, resources, and optional scripts so Codex can follow a workflow reliably. Skills work across CLI, IDE extension, and Codex app. ([OpenAI Developers][2])                                                                                                                                                          |
| **`codex exec`**                          | Local shell automation            | This is probably your best first real automation. `codex exec` runs Codex non-interactively from scripts or CI, can pipe output to other tools, and supports explicit sandbox/approval settings. ([OpenAI Developers][3])                                                                                                                       |
| **Codex SDK**                             | Custom orchestration app          | Use this when a shell script becomes too limiting. The SDK lets you programmatically control local Codex agents and is intended for CI/CD, internal tools, and custom agent workflows. ([OpenAI Developers][4])                                                                                                                                 |
| **Codex GitHub Action**                   | PR review, CI gates, release prep | The GitHub Action can run Codex in CI/CD, apply patches, or post reviews from GitHub Actions workflows. ([OpenAI Developers][5])                                                                                                                                                                                                                |
| **Codex app Automations**                 | Recurring background tasks        | Useful for scheduled checks, repeated reviews, drift checks, or periodic repo maintenance. Automations can use worktrees to isolate changes from your local work. ([OpenAI Developers][6])                                                                                                                                                      |
| **Codex Cloud / GitHub / Linear / Slack** | Delegating tasks from team tools  | Codex cloud can run background tasks in its own cloud environment; GitHub PR comments, Linear issues, and Slack mentions can all start Codex tasks. ([OpenAI Developers][7])                                                                                                                                                                    |
| **Hooks / rules**                         | Guardrails around automation      | Hooks let you run deterministic scripts during the Codex lifecycle, such as prompt scanning, validation at stop time, logging, or custom policy checks. ([OpenAI Developers][8])                                                                                                                                                                |

For your specific workflow, I would use this progression:

**Start with `AGENTS.md` + one Codex Skill. Then add a local `codex exec` driver script. Move to the SDK only after the script becomes annoying. Add GitHub Action review later.**

---

## 1. Codify your workflow in `AGENTS.md`

Put this in the repo root, or in `~/.codex/AGENTS.md` if you want it as your personal default across repos.

```md
# Agent workflow policy

For any non-trivial coding goal, follow this workflow:

1. Understand the goal and inspect the relevant code before proposing changes.
2. If the goal is large, create a major milestone plan.
3. Review your own plan for missing steps, risky assumptions, unclear success criteria, and oversized milestones.
4. Patch the plan before implementing.
5. Work on exactly one milestone at a time.
6. For each milestone:
   - Create a milestone-specific plan.
   - Review and patch that milestone plan.
   - Implement only that milestone.
   - Run the relevant tests, type checks, lint checks, or build commands.
   - Review the diff for correctness, regressions, missing tests, security issues, and maintainability.
   - Fix review findings before moving on.
7. Never silently skip verification. If a check cannot be run, explain why and say what should be run manually.
8. At the end of each milestone, summarize:
   - files changed
   - behavior changed
   - checks run
   - remaining risks
   - next recommended milestone

Project verification commands:
- TODO: add test command
- TODO: add lint command
- TODO: add typecheck/build command

Definition of done:
- Relevant tests pass.
- Diff has been reviewed.
- No unaddressed high-confidence findings remain.
- The implementation matches the original goal and milestone acceptance criteria.
```

This removes much of your repeated prompting, but it does **not** fully automate the sequencing. For sequencing, use `codex exec` or the SDK.

---

## 2. Create a reusable Skill for your workflow

Example skill file:

```md
---
name: milestone-development-loop
description: Use for medium or large coding goals that should be planned, reviewed, implemented milestone by milestone, verified, reviewed, and fixed before continuing.
---

When invoked, run the coding goal through this workflow.

## Required phases

1. Goal analysis
2. Major milestone plan, if the goal is large
3. Plan review
4. Plan patch
5. Milestone-specific plan
6. Milestone plan review
7. Milestone implementation
8. Verification
9. Diff review
10. Fix loop
11. Milestone handoff summary

## Rules

- Do not combine milestones unless explicitly asked.
- Do not move to the next milestone while review findings remain.
- Prefer small, high-confidence changes.
- Always state which checks were run.
- If a check cannot be run, state the reason and the exact command the user should run.
- Preserve a clear audit trail in `.codex-work/`.

## Output convention

For each milestone, produce:

- `milestone-N-plan.md`
- `milestone-N-review.md`
- `milestone-N-summary.md`
```

Codex Skills are a good fit because they package reusable workflow instructions instead of making you paste long meta-prompts every time. ([OpenAI Developers][2])

---

## 3. Automate the loop with `codex exec`

A simple local automation can be a shell script. The script should be the **orchestrator**, not Codex. Codex should do scoped subtasks.

Create something like `scripts/ai-milestone.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

GOAL="${*:?Usage: scripts/ai-milestone.sh '<goal>'}"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
RUN_DIR=".codex-work/$RUN_ID"

mkdir -p "$RUN_DIR"

echo "$GOAL" > "$RUN_DIR/goal.txt"

echo "== 1. Creating major plan =="
codex exec \
  --ephemeral \
  --sandbox read-only \
  --ask-for-approval never \
  "Read the repository and the goal in $RUN_DIR/goal.txt.
Create a major milestone plan.
Do not edit files.
Output:
- assumptions
- repo areas involved
- milestones
- acceptance criteria per milestone
- risks
- verification commands." \
  > "$RUN_DIR/00-major-plan.md"

echo "== 2. Reviewing major plan =="
codex exec \
  --ephemeral \
  --sandbox read-only \
  --ask-for-approval never \
  "Review the plan in $RUN_DIR/00-major-plan.md.
Find missing steps, risky assumptions, oversized milestones, unclear acceptance criteria, and verification gaps.
Output a patched plan if changes are needed.
Do not edit code." \
  > "$RUN_DIR/01-major-plan-review.md"

echo "== 3. Implementing milestone 1 =="
codex exec \
  --sandbox workspace-write \
  --ask-for-approval never \
  "Read:
- $RUN_DIR/goal.txt
- $RUN_DIR/00-major-plan.md
- $RUN_DIR/01-major-plan-review.md

Implement ONLY milestone 1.
Before editing, create a short milestone-specific plan.
After editing, run relevant checks.
Do not start milestone 2.
At the end, write a concise summary to $RUN_DIR/02-milestone-1-summary.md."

echo "== 4. Capturing diff =="
git diff > "$RUN_DIR/03-milestone-1.diff"

echo "== 5. Reviewing milestone 1 diff =="
codex exec \
  --ephemeral \
  --sandbox read-only \
  --ask-for-approval never \
  "Review the diff in $RUN_DIR/03-milestone-1.diff.
Focus on correctness, regressions, missing tests, security, maintainability, and whether milestone 1 acceptance criteria are met.
Output JSON only:
{
  \"verdict\": \"pass\" | \"fail\",
  \"findings\": [
    {
      \"severity\": \"high\" | \"medium\" | \"low\",
      \"file\": \"path\",
      \"issue\": \"description\",
      \"suggested_fix\": \"description\"
    }
  ]
}" \
  > "$RUN_DIR/04-milestone-1-review.json"

echo "== 6. Fixing review findings if needed =="
if command -v jq >/dev/null 2>&1 && jq -e '.verdict == "fail"' "$RUN_DIR/04-milestone-1-review.json" >/dev/null; then
  codex exec \
    --sandbox workspace-write \
    --ask-for-approval never \
    "Read the review findings in $RUN_DIR/04-milestone-1-review.json.
Fix only those findings.
Do not start milestone 2.
Run relevant checks again.
Update $RUN_DIR/02-milestone-1-summary.md with what was fixed."
else
  echo "Review passed or jq not installed; inspect $RUN_DIR/04-milestone-1-review.json manually."
fi

echo "== Done =="
echo "Artifacts written to $RUN_DIR"
```

`codex exec` is specifically meant for scripts and CI-style workflows, and it prints final output to stdout, which makes this kind of artifact capture straightforward. ([OpenAI Developers][3]) The CLI supports `--ask-for-approval` and `--sandbox` flags; OpenAI’s docs recommend `never` for non-interactive runs and support `read-only`, `workspace-write`, and `danger-full-access` sandbox modes. ([OpenAI Developers][9])

For real use, I would add:

```bash
git checkout -b "ai/$RUN_ID"
```

at the top, and maybe:

```bash
git diff --check
```

before review.

---

## 4. Turn the script into a state machine

The shell script above only does milestone 1. A more complete version should store state:

```json
{
  "goal": "Add OAuth login",
  "current_milestone": 1,
  "max_fix_attempts": 2,
  "status": "implementing",
  "milestones": [
    {
      "id": 1,
      "title": "Add auth provider abstraction",
      "status": "done"
    },
    {
      "id": 2,
      "title": "Add OAuth callback flow",
      "status": "pending"
    }
  ]
}
```

Then the driver does:

```text
create major plan
review plan
patch plan
for each milestone:
    create milestone plan
    review milestone plan
    patch milestone plan
    implement milestone
    run deterministic checks
    review diff
    if review fails:
        fix findings
        re-run checks
        re-review
    stop if max fix attempts exceeded
    mark milestone done
```

Important design rule: **Codex should not decide when the loop ends by vibes.** Your driver should decide based on explicit artifacts: tests, JSON verdicts, max retry counts, and Git diff status.

---

## 5. Use the SDK when you outgrow shell scripts

A shell script is fine until you want richer branching, retries, JSON validation, multiple reviewers, or a UI. Then use the Codex SDK.

Conceptually:

```ts
import { Codex } from "@openai/codex-sdk";

const goal = process.argv.slice(2).join(" ");
const codex = new Codex();
const thread = codex.startThread();

async function runStep(name: string, prompt: string) {
  console.log(`\n=== ${name} ===`);
  const result = await thread.run(prompt);
  console.log(result);
  return result;
}

await runStep("major-plan", `
Goal: ${goal}

Inspect the repo and produce a major milestone plan.
Do not edit files.
`);

await runStep("plan-review", `
Review the plan you just produced.
Find flaws, missing steps, risky assumptions, and oversized milestones.
Patch the plan if needed.
`);

await runStep("milestone-1-plan", `
Create a detailed plan for milestone 1 only.
Do not edit files yet.
`);

await runStep("milestone-1-implementation", `
Implement milestone 1 only.
Run relevant checks.
Do not start milestone 2.
`);

await runStep("milestone-1-review", `
Review the work done for milestone 1.
If issues are found, list them as actionable findings.
`);

await runStep("milestone-1-fix", `
Fix the actionable findings from the milestone 1 review.
Run relevant checks again.
`);
```

The SDK is the right direction if you want a proper local “AI project manager” that controls Codex threads, stores state, resumes runs, validates outputs, and integrates with your own tools. OpenAI’s docs describe the TypeScript SDK as more comprehensive and flexible than non-interactive mode, and show continuing the same thread with repeated `run()` calls. ([OpenAI Developers][4])

For even more orchestration, you can expose Codex as an MCP server and have another agent/controller coordinate it. OpenAI’s Agents SDK guide describes starting Codex CLI as an MCP server with `codex mcp-server`, exposing `codex()` and `codex-reply()` tools, and using that for single- or multi-agent workflows. ([OpenAI Developers][10])

---

## 6. Add GitHub automation for review and CI loops

Once the local loop works, move review and gatekeeping to CI.

A good pattern:

1. Local script creates branch and implements milestone.
2. You open PR.
3. Codex GitHub Action reviews PR.
4. If issues are found, comment or trigger a fix.
5. CI runs tests.
6. If CI fails, another Codex task proposes a fix.

Codex GitHub integration can review PRs, and after Codex posts review findings, you can ask it to fix issues in the same PR with a comment such as `@codex fix the P1 issue`; Codex can start a cloud task with the PR as context and push a fix if it has permission. ([OpenAI Developers][11]) The GitHub Action is intended for running Codex in CI/CD jobs, applying patches, posting reviews, and gating changes on Codex-driven checks. ([OpenAI Developers][5])

---

## 7. Use app Automations for recurring meta-work

Some of your meta-work is not tied to one interactive coding session. Examples:

```text
Every morning, inspect open PRs assigned to me, summarize blockers, and suggest which ones need Codex fixes.

Every weekday, check this repo for stale AGENTS.md guidance based on repeated review findings.

Every hour while this PR is open, check whether CI or review feedback changed; if yes, summarize and propose fixes.
```

Codex app automations can run recurring background tasks and can combine with skills for more complex workflows. For Git repos, they can run in a local project or in a dedicated worktree, which helps isolate automation changes from unfinished local work. ([OpenAI Developers][6])

---

## 8. Recommended setup for you

I would implement this in four stages.

### Stage 1: Durable instructions

Add:

```text
AGENTS.md
.agents/skills/milestone-development-loop/SKILL.md
```

This alone will reduce repeated prompting.

### Stage 2: Local one-milestone driver

Add:

```text
scripts/ai-milestone.sh
.codex-work/
```

Run:

```bash
scripts/ai-milestone.sh "Add feature X"
```

The script should automate only:

```text
major plan → plan review → milestone 1 plan → implement → review → fix
```

Do not automate all milestones at first. Get one milestone reliable.

### Stage 3: Full milestone loop

Add:

```text
scripts/ai-run-goal.ts
```

Use the Codex SDK, store `state.json`, parse JSON reviews, cap fix attempts, and continue milestone by milestone.

### Stage 4: CI/PR integration

Add a GitHub Action that does:

```text
PR opened/synchronized → Codex review → comment findings
CI failed → Codex proposes fix branch or patch
```

---

## Safety settings I would use

For automated **planning and review**:

```bash
codex exec --sandbox read-only --ask-for-approval never "..."
```

For automated **implementation/fixing**:

```bash
codex exec --sandbox workspace-write --ask-for-approval never "..."
```

Avoid this except inside an isolated container/runner:

```bash
codex exec --sandbox danger-full-access --ask-for-approval never "..."
```

OpenAI’s docs note that Codex security is controlled through sandbox mode and approval policy; `workspace-write` limits edits to the workspace, network is off by default in local workspace-write mode, and `danger-full-access`/`--yolo` should only be used in controlled or externally hardened environments. ([OpenAI Developers][12]) For CI/CD, OpenAI recommends API-key authentication for programmatic Codex CLI workflows and warns not to expose Codex execution in untrusted or public environments. ([OpenAI Developers][13])

---

## The practical answer

Your best path is:

```text
AGENTS.md
+ milestone-development-loop skill
+ codex exec wrapper script
+ JSON artifacts and git diffs
+ deterministic checks
+ optional SDK orchestrator
+ GitHub Action for PR review
```

Think of it as building a tiny **development workflow engine**:

```text
Human gives goal.
Driver calls Codex.
Codex produces plan.
Driver asks Codex to review plan.
Driver asks Codex to implement one milestone.
Driver runs tests.
Driver asks Codex to review diff.
Driver asks Codex to fix findings.
Driver stops or advances.
Human reviews the PR.
```

That is much more reliable than asking Codex to autonomously remember and manage the whole meta-process inside one long conversation.

[1]: https://developers.openai.com/codex/guides/agents-md?utm_source=chatgpt.com "Custom instructions with AGENTS.md – Codex"
[2]: https://developers.openai.com/codex/skills "Agent Skills – Codex | OpenAI Developers"
[3]: https://developers.openai.com/codex/noninteractive "Non-interactive mode – Codex | OpenAI Developers"
[4]: https://developers.openai.com/codex/sdk "SDK – Codex | OpenAI Developers"
[5]: https://developers.openai.com/codex/github-action "GitHub Action – Codex | OpenAI Developers"
[6]: https://developers.openai.com/codex/app/automations "Automations – Codex app | OpenAI Developers"
[7]: https://developers.openai.com/codex/cloud "Web – Codex | OpenAI Developers"
[8]: https://developers.openai.com/codex/hooks "Hooks – Codex | OpenAI Developers"
[9]: https://developers.openai.com/codex/cli/reference "Command line options – Codex CLI | OpenAI Developers"
[10]: https://developers.openai.com/cookbook/examples/codex/codex_mcp_agents_sdk/building_consistent_workflows_codex_cli_agents_sdk "Building Consistent Workflows with Codex CLI & Agents SDK"
[11]: https://developers.openai.com/codex/integrations/github "Code review in GitHub – Codex | OpenAI Developers"
[12]: https://developers.openai.com/codex/agent-approvals-security "Agent approvals & security – Codex | OpenAI Developers"
[13]: https://developers.openai.com/codex/auth "Authentication – Codex | OpenAI Developers"
