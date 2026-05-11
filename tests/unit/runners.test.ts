import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseMilestoneMetadataJson } from "../../src/milestones/milestone-validator.js";
import { parseReviewVerdictJson } from "../../src/review/review-verdict-validator.js";
import { CodexExecRunner } from "../../src/runners/codex-exec/codex-exec-runner.js";
import { createAgentRunner } from "../../src/runners/create-runner.js";
import { FakeRunner } from "../../src/runners/fake/fake-runner.js";

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

test("CodexExecRunner run method is a non-executing skeleton", async () => {
  const runner = new CodexExecRunner({
    command: "codex",
    options: {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "never",
    },
  });

  const result = await runner.run({
    phase: "planning",
    prompt: "make a plan",
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.text, "CodexExecRunner execution is not implemented in Milestone 2.");
  assert.deepEqual(result.metadata, {
    runner: "codex-exec",
    command: "codex",
    implemented: false,
  });
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
    options: {
      sandboxForPlanning: "read-only",
      sandboxForImplementation: "workspace-write",
      approvalPolicy: "never",
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.runner.type, "codex-exec");
  }
});
