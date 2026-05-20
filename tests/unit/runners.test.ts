import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseMilestoneMetadataJson } from "../../src/milestones/milestone-validator.js";
import { parseReviewVerdictJson } from "../../src/review/review-verdict-validator.js";
import { CodexExecRunner } from "../../src/runners/codex-exec/codex-exec-runner.js";
import { createAgentRunner } from "../../src/runners/create-runner.js";
import { FakeRunner } from "../../src/runners/fake/fake-runner.js";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../../src/shell/command-runner.js";

test("FakeRunner returns deterministic output", async () => {
  const runner = new FakeRunner();
  const result = await runner.run({
    phase: "initialized",
    prompt: "hello",
    artifacts: {
      goal: "00-goal.txt",
    },
  });

  assert.equal(runner.type, "fake");
  assert.equal(result.exitCode, 0);
  assert.equal(result.text, 'Fake runner response for phase "initialized".');
  assert.deepEqual(result.metadata, {
    runner: "fake",
    promptLength: 5,
    artifactCount: 1,
  });
});

test("FakeRunner returns deterministic planning Markdown", async () => {
  const runner = new FakeRunner();
  const result = await runner.run({
    phase: "major_plan",
    prompt: "make a plan",
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.text, /^# Fake Major Plan/);
  assert.match(result.text, /npm run test:build/);
  assert.deepEqual(result.metadata, {
    runner: "fake",
    phase: "major_plan",
    promptLength: 11,
    artifactCount: 0,
  });
});

test("FakeRunner returns deterministic planning review Markdown", async () => {
  const runner = new FakeRunner();
  const result = await runner.run({
    phase: "major_plan_review",
    prompt: "review a plan",
    artifacts: {
      majorPlan: "plans/01-major-plan.md",
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.text, /^# Fake Major Plan Review/);
  assert.deepEqual(result.metadata, {
    runner: "fake",
    phase: "major_plan_review",
    promptLength: 13,
    artifactCount: 1,
  });
});

test("FakeRunner returns deterministic final plan Markdown", async () => {
  const runner = new FakeRunner();
  const result = await runner.run({
    phase: "final_major_plan",
    prompt: "finalize",
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.text, /^# Fake Final Major Plan/);
  assert.match(result.text, /Milestone 1: Planning Workflow/);
});

test("FakeRunner returns valid milestone metadata JSON", async () => {
  const runner = new FakeRunner();
  const result = await runner.run({
    phase: "final_plan_json",
    prompt: "json",
  });

  assert.equal(result.exitCode, 0);

  const parsed = parseMilestoneMetadataJson(result.text);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.milestones.length, 2);
    assert.equal(parsed.value.milestones[0]?.status, "pending");
    assert.deepEqual(parsed.value.milestones[1]?.dependencies, [1]);
  }
});

test("FakeRunner returns deterministic milestone implementation plan", async () => {
  const runner = new FakeRunner();
  const result = await runner.run({
    phase: "milestone_plan",
    prompt: "plan milestone",
    milestoneId: 1,
    artifacts: {
      milestones: "milestones/05-milestones.json",
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.text, /^# Fake Milestone 1 Plan/);
  assert.match(result.text, /fake-milestone-1-implementation\.txt/);
  assert.deepEqual(result.metadata, {
    runner: "fake",
    phase: "milestone_plan",
    promptLength: 14,
    artifactCount: 1,
    milestoneId: 1,
  });
});

test("FakeRunner returns deterministic scrupulous milestone planning artifacts", async () => {
  const runner = new FakeRunner();
  const review = await runner.run({
    phase: "milestone_plan_review",
    prompt: "review draft",
    milestoneId: 2,
    artifacts: {
      milestonePlanDraft: "milestones/10-milestone-2-plan-draft.md",
    },
  });
  const finalPlan = await runner.run({
    phase: "final_milestone_plan",
    prompt: "final draft",
    milestoneId: 2,
    artifacts: {
      milestonePlanDraft: "milestones/10-milestone-2-plan-draft.md",
      milestonePlanReview: "milestones/10-milestone-2-plan-review.md",
    },
  });

  assert.equal(review.exitCode, 0);
  assert.match(review.text, /^# Fake Milestone 2 Plan Review/);
  assert.match(review.text, /Keep implementation scoped to milestone 2/);
  assert.deepEqual(review.metadata, {
    runner: "fake",
    phase: "milestone_plan_review",
    promptLength: 12,
    artifactCount: 1,
    milestoneId: 2,
  });

  assert.equal(finalPlan.exitCode, 0);
  assert.match(finalPlan.text, /^# Fake Final Milestone 2 Plan/);
  assert.match(finalPlan.text, /fake-milestone-2-implementation\.txt/);
  assert.deepEqual(finalPlan.metadata, {
    runner: "fake",
    phase: "final_milestone_plan",
    promptLength: 11,
    artifactCount: 2,
    milestoneId: 2,
  });
});

test("FakeRunner returns milestone-specific outputs for generated fake milestones", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-fake-runner-"));
  try {
    const runner = new FakeRunner();
    const planOne = await runner.run({
      phase: "milestone_plan",
      prompt: "plan one",
      milestoneId: 1,
      artifacts: {
        milestones: "milestones/05-milestones.json",
      },
    });
    const planTwo = await runner.run({
      phase: "milestone_plan",
      prompt: "plan two",
      milestoneId: 2,
      artifacts: {
        milestones: "milestones/05-milestones.json",
      },
    });

    assert.equal(planOne.exitCode, 0);
    assert.equal(planTwo.exitCode, 0);
    assert.match(planOne.text, /^# Fake Milestone 1 Plan/);
    assert.match(planTwo.text, /^# Fake Milestone 2 Plan/);
    assert.match(planOne.text, /fake-milestone-1-implementation\.txt/);
    assert.match(planTwo.text, /fake-milestone-2-implementation\.txt/);

    const implementationOne = await runner.run({
      phase: "implement_milestone",
      prompt: "implement one",
      cwd: tempDir,
      milestoneId: 1,
      artifacts: {
        milestonePlan: "milestones/10-milestone-1-plan.md",
      },
    });
    const implementationTwo = await runner.run({
      phase: "implement_milestone",
      prompt: "implement two",
      cwd: tempDir,
      milestoneId: 2,
      artifacts: {
        milestonePlan: "milestones/10-milestone-2-plan.md",
      },
    });

    const outputOne = path.join(tempDir, "fake-milestone-1-implementation.txt");
    const outputTwo = path.join(tempDir, "fake-milestone-2-implementation.txt");
    assert.equal(implementationOne.exitCode, 0);
    assert.equal(implementationTwo.exitCode, 0);
    assert.equal(implementationOne.metadata?.outputPath, outputOne);
    assert.equal(implementationTwo.metadata?.outputPath, outputTwo);
    assert.match(await readFile(outputOne, "utf8"), /Milestone: 1/);
    assert.match(await readFile(outputTwo, "utf8"), /Milestone: 2/);

    const reviewTwo = await runner.run({
      phase: "review_milestone",
      prompt: "review two",
      milestoneId: 2,
      artifacts: {
        diff: "diffs/12-milestone-2.diff",
        checks: "checks/13-milestone-2-checks.txt",
      },
    });

    assert.equal(reviewTwo.exitCode, 0);
    const parsed = parseReviewVerdictJson(reviewTwo.text);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.verdict, "pass");
      assert.equal(parsed.value.summary, "Fake review accepted milestone 2.");
      assert.deepEqual(parsed.value.reviewedArtifacts, [
        "diffs/12-milestone-2.diff",
        "checks/13-milestone-2-checks.txt",
      ]);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("FakeRunner writes deterministic milestone implementation output inside cwd", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-fake-runner-"));
  try {
    const runner = new FakeRunner();
    const result = await runner.run({
      phase: "implement_milestone",
      prompt: "implement",
      cwd: tempDir,
      milestoneId: 3,
      artifacts: {
        milestonePlan: "milestones/10-milestone-3-plan.md",
      },
    });

    const outputPath = path.join(tempDir, "fake-milestone-3-implementation.txt");
    assert.equal(result.exitCode, 0);
    assert.match(result.text, /^# Fake Milestone 3 Implementation/);
    assert.equal(result.metadata?.outputPath, outputPath);
    assert.equal(
      await readFile(outputPath, "utf8"),
      [
        "Fake milestone implementation",
        "Milestone: 3",
        "Prompt length: 9",
        "Artifact count: 1",
        "",
      ].join("\n"),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("FakeRunner refuses milestone implementation without required context", async () => {
  const runner = new FakeRunner();

  const missingMilestone = await runner.run({
    phase: "implement_milestone",
    prompt: "implement",
    cwd: "/tmp/workspace",
  });
  assert.equal(missingMilestone.exitCode, 1);
  assert.match(missingMilestone.text, /positive milestoneId/);

  const missingCwd = await runner.run({
    phase: "implement_milestone",
    prompt: "implement",
    milestoneId: 1,
  });
  assert.equal(missingCwd.exitCode, 1);
  assert.match(missingCwd.text, /requires cwd/);
});

test("FakeRunner returns a deterministic passing review verdict", async () => {
  const runner = new FakeRunner();
  const result = await runner.run({
    phase: "review_milestone",
    prompt: "review",
    milestoneId: 1,
    artifacts: {
      diff: "diffs/12-milestone-1.diff",
      checks: "checks/13-milestone-1-checks.txt",
    },
  });

  assert.equal(result.exitCode, 0);
  const parsed = parseReviewVerdictJson(result.text);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.verdict, "pass");
    assert.deepEqual(parsed.value.findings, []);
    assert.deepEqual(parsed.value.reviewedArtifacts, [
      "diffs/12-milestone-1.diff",
      "checks/13-milestone-1-checks.txt",
    ]);
  }
  assert.deepEqual(result.metadata, {
    runner: "fake",
    phase: "review_milestone",
    promptLength: 6,
    artifactCount: 2,
    milestoneId: 1,
  });
});

test("FakeRunner refuses milestone review without required context", async () => {
  const runner = new FakeRunner();
  const result = await runner.run({
    phase: "review_milestone",
    prompt: "review",
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.text, /positive milestoneId/);
});

test("CodexExecRunner can be instantiated without executing codex", () => {
  const runner = new CodexExecRunner({
    command: "codex",
    options: {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "never",
    },
  });

  assert.equal(runner.type, "codex-exec");
  assert.equal(runner.command, "codex");
  assert.equal(runner.options.approvalPolicy, "never");
});

test("CodexExecRunner builds codex exec requests for every phase", async () => {
  const phases = [
    ["major_plan", "read-only"],
    ["major_plan_review", "read-only"],
    ["final_major_plan", "read-only"],
    ["final_plan_json", "read-only"],
    ["milestone_plan", "read-only"],
    ["milestone_plan_review", "read-only"],
    ["final_milestone_plan", "read-only"],
    ["implement_milestone", "workspace-write"],
    ["review_milestone", "read-only"],
    ["fix_review_findings", "workspace-write"],
  ] as const;

  for (const [phase, expectedSandbox] of phases) {
    const commandRunner = new CapturingCommandRunner({
      finalMessage: `final message for ${phase}`,
    });
    const cwd = path.join(os.tmpdir(), `agent-orchestrator-${phase}`);
    const runner = new CodexExecRunner({
      command: "codex",
      options: {
        sandboxForPlanning: "read-only",
        sandboxForImplementation: "workspace-write",
        approvalPolicy: "never",
        timeoutMs: 1234,
      },
      commandRunner,
    });

    const result = await runner.run({
      phase,
      prompt: `prompt for ${phase}`,
      cwd,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.text, `final message for ${phase}`);

    const request = commandRunner.singleRequest();
    assert.equal(request.command, "codex");
    assert.equal(request.cwd, cwd);
    assert.equal(request.stdin, `prompt for ${phase}`);
    assert.equal(request.timeoutMs, 1234);
    assert.deepEqual(request.args.slice(0, 2), ["exec", "--cd"]);
    assert.equal(argumentAfter(request.args, "--cd"), cwd);
    assert.equal(argumentAfter(request.args, "--sandbox"), expectedSandbox);
    assert.equal(argumentAfter(request.args, "--color"), "never");
    assert.equal(argumentAfter(request.args, "-c"), 'approval_policy="never"');
    assert.equal(request.args.at(-1), "-");
    assert.equal(result.metadata?.sandbox, expectedSandbox);
    assert.equal(result.metadata?.outputLastMessageCaptured, true);
  }
});

test("CodexExecRunner includes optional model, profile, JSON events, and output schema", async () => {
  const commandRunner = new CapturingCommandRunner({
    finalMessage: "schema-backed result",
  });
  const cwd = "/tmp/agent-orchestrator-cwd";
  const schemaPath = "/tmp/agent-orchestrator-schema.json";
  const runner = new CodexExecRunner({
    command: "codex",
    accountLabel: "work-codex",
    options: {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "on-request",
      model: "gpt-5.5",
      profile: "automation",
      jsonEvents: true,
    },
    commandRunner,
  });

  const result = await runner.run({
    phase: "final_plan_json",
    prompt: "return json",
    cwd,
    outputSchemaPath: schemaPath,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.text, "schema-backed result");

  const request = commandRunner.singleRequest();
  assert.equal(argumentAfter(request.args, "-c"), 'approval_policy="on-request"');
  assert.equal(argumentAfter(request.args, "--model"), "gpt-5.5");
  assert.equal(argumentAfter(request.args, "--profile"), "automation");
  assert.equal(argumentAfter(request.args, "--output-schema"), schemaPath);
  assert.equal(request.args.includes("--json"), true);
  assert.equal(result.metadata?.approvalPolicy, "on-request");
  assert.equal(result.metadata?.profile, "automation");
  assert.equal(result.metadata?.accountLabel, "work-codex");
});

test("CodexExecRunner omits optional args when they are not configured", async () => {
  const commandRunner = new CapturingCommandRunner({
    finalMessage: "plain result",
  });
  const runner = new CodexExecRunner({
    command: "codex",
    options: {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "untrusted",
    },
    commandRunner,
  });

  await runner.run({
    phase: "major_plan",
    prompt: "plan",
    cwd: "/tmp/agent-orchestrator-cwd",
  });

  const request = commandRunner.singleRequest();
  assert.equal(argumentAfter(request.args, "-c"), 'approval_policy="untrusted"');
  assert.equal(request.args.includes("--model"), false);
  assert.equal(request.args.includes("--profile"), false);
  assert.equal(request.args.includes("--json"), false);
  assert.equal(request.args.includes("--output-schema"), false);
});

test("CodexExecRunner reads and cleans up the output-last-message file", async () => {
  const commandRunner = new CapturingCommandRunner({
    finalMessage: "captured final assistant message",
  });
  const runner = new CodexExecRunner({
    command: "codex",
    options: {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "never",
    },
    commandRunner,
  });

  const result = await runner.run({
    phase: "major_plan",
    prompt: "plan",
    cwd: "/tmp/agent-orchestrator-cwd",
  });

  const outputLastMessagePath = commandRunner.singleOutputLastMessagePath();
  assert.equal(result.exitCode, 0);
  assert.equal(result.text, "captured final assistant message");
  assert.equal(result.metadata?.outputLastMessageCaptured, true);
  assert.deepEqual(result.metadata?.args, [
    "exec",
    "--cd",
    "/tmp/agent-orchestrator-cwd",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--output-last-message",
    "<temporary-output-last-message>",
    "-c",
    'approval_policy="never"',
    "-",
  ]);
  await assert.rejects(access(outputLastMessagePath));
});

test("CodexExecRunner propagates non-zero command exits", async () => {
  const commandRunner = new CapturingCommandRunner({
    finalMessage: "codex failed after writing a final message",
    exitCode: 42,
    stdout: "diagnostic stdout",
    stderr: "diagnostic stderr",
    error: "command failed",
  });
  const runner = new CodexExecRunner({
    command: "codex",
    options: {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "never",
    },
    commandRunner,
  });

  const result = await runner.run({
    phase: "review_milestone",
    prompt: "review",
    cwd: "/tmp/agent-orchestrator-cwd",
  });

  assert.equal(result.exitCode, 42);
  assert.equal(result.text, "codex failed after writing a final message");
  assert.equal(result.metadata?.stdout, "diagnostic stdout");
  assert.equal(result.metadata?.stderr, "diagnostic stderr");
  assert.equal(result.metadata?.error, "command failed");
});

test("CodexExecRunner reports timeout and missing final message as a failure", async () => {
  const commandRunner = new CapturingCommandRunner({
    finalMessage: "",
    exitCode: null,
    error: "Command timed out after 50ms.",
    timedOut: true,
  });
  const runner = new CodexExecRunner({
    command: "codex",
    options: {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "never",
      timeoutMs: 50,
    },
    commandRunner,
  });

  const result = await runner.run({
    phase: "implement_milestone",
    prompt: "implement",
    cwd: "/tmp/agent-orchestrator-cwd",
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.text, /did not produce a non-empty final message/);
  assert.match(result.text, /timed out after 50ms/);
  assert.equal(result.metadata?.timedOut, true);
  assert.equal(result.metadata?.outputLastMessageCaptured, false);
});

test("createAgentRunner creates a fake runner", () => {
  const result = createAgentRunner({ type: "fake" });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.runner.type, "fake");
  }
});

test("createAgentRunner creates a codex-exec runner", () => {
  const result = createAgentRunner({
    type: "codex-exec",
    command: "codex",
    accountLabel: "work-codex",
    options: {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "never",
      timeoutMs: 120000,
      model: "gpt-5.5",
      profile: "automation",
      jsonEvents: true,
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.runner.type, "codex-exec");
    assert.ok(result.runner instanceof CodexExecRunner);
    assert.deepEqual(result.runner.options, {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "never",
      timeoutMs: 120000,
      model: "gpt-5.5",
      profile: "automation",
      jsonEvents: true,
    });
    assert.equal(result.runner.accountLabel, "work-codex");
  }
});

function argumentAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

interface CapturingCommandRunnerOptions {
  finalMessage: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  timedOut?: boolean;
}

class CapturingCommandRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  constructor(private readonly options: CapturingCommandRunnerOptions) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    await writeFile(this.singleOutputLastMessagePath(), this.options.finalMessage);

    return {
      ...request,
      exitCode: "exitCode" in this.options ? (this.options.exitCode ?? null) : 0,
      stdout: this.options.stdout ?? "",
      stderr: this.options.stderr ?? "",
      ...(this.options.error !== undefined ? { error: this.options.error } : {}),
      ...(this.options.timedOut !== undefined ? { timedOut: this.options.timedOut } : {}),
    };
  }

  singleRequest(): CommandRequest {
    assert.equal(this.requests.length, 1);
    const request = this.requests[0];
    assert.ok(request);
    return request;
  }

  singleOutputLastMessagePath(): string {
    const request = this.singleRequest();
    const outputLastMessagePath = argumentAfter(request.args, "--output-last-message");
    if (outputLastMessagePath === undefined) {
      throw new Error("Missing --output-last-message argument.");
    }
    return outputLastMessagePath;
  }
}
