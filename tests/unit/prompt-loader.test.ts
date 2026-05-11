import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadPrompt,
  loadPrompts,
  resolvePromptDir,
} from "../../src/prompts/prompt-loader.js";
import {
  findPromptVariables,
  renderPrompt,
} from "../../src/prompts/prompt-renderer.js";

test("resolvePromptDir defaults to src/prompts under cwd", () => {
  assert.equal(resolvePromptDir({ cwd: "/repo" }), path.resolve("/repo", "src", "prompts"));
});

test("loadPrompt reads a named prompt", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-prompts-"));
  try {
    const promptDir = path.join(tempDir, "prompts");
    await mkdir(promptDir);
    await writeFile(path.join(promptDir, "major-plan.md"), "Goal: {{goal}}\n", "utf8");

    const result = await loadPrompt("major-plan", { promptDir });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.name, "major-plan");
      assert.equal(result.value.text, "Goal: {{goal}}\n");
      assert.equal(result.value.path, path.join(promptDir, "major-plan.md"));
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadPrompt reports missing prompts clearly", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-prompts-"));
  try {
    const result = await loadPrompt("major-plan", { promptDir: tempDir });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /Failed to read prompt "major-plan"/);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadPrompts reads multiple prompts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-prompts-"));
  try {
    await writeFile(path.join(tempDir, "major-plan.md"), "major\n", "utf8");
    await writeFile(path.join(tempDir, "major-plan-review.md"), "review\n", "utf8");

    const result = await loadPrompts(["major-plan", "major-plan-review"], {
      promptDir: tempDir,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value["major-plan"]?.text, "major\n");
      assert.equal(result.value["major-plan-review"]?.text, "review\n");
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("renderPrompt replaces named variables", () => {
  const result = renderPrompt("Goal: {{ goal }}\nConfig: {{config}}", {
    goal: "Add feature X",
    config: { checks: ["npm test"] },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.value, /Goal: Add feature X/);
    assert.match(result.value, /"checks": \[/);
  }
});

test("renderPrompt rejects missing variables", () => {
  const result = renderPrompt("Goal: {{goal}} {{missing}}", {
    goal: "Add feature X",
  });

  assert.deepEqual(result, {
    ok: false,
    error: "Missing prompt variables: missing",
  });
});

test("renderPrompt rejects unresolved placeholders", () => {
  const result = renderPrompt("Goal: {{goal-name}}", {
    goal: "Add feature X",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /Unresolved prompt placeholders/);
  }
});

test("renderPrompt allows placeholder-looking text inside values", () => {
  const result = renderPrompt("Goal: {{goal}}", {
    goal: "Document {{example}} template syntax",
  });

  assert.deepEqual(result, {
    ok: true,
    value: "Goal: Document {{example}} template syntax",
  });
});

test("findPromptVariables returns unique sorted variable names", () => {
  assert.deepEqual(findPromptVariables("{{zeta}} {{alpha}} {{ zeta }}"), [
    "alpha",
    "zeta",
  ]);
});

test("milestone prompts expose the expected implementation variables", async () => {
  const prompts = await loadPrompts(["milestone-plan", "implement-milestone"], {
    cwd: process.cwd(),
  });

  assert.equal(prompts.ok, true);
  if (!prompts.ok) return;

  assert.deepEqual(findPromptVariables(prompts.value["milestone-plan"]?.text ?? ""), [
    "activeMilestone",
    "finalMajorPlan",
    "goal",
    "milestones",
    "state",
  ]);
  assert.deepEqual(findPromptVariables(prompts.value["implement-milestone"]?.text ?? ""), [
    "activeMilestone",
    "finalMajorPlan",
    "goal",
    "milestonePlan",
    "state",
  ]);
});

test("milestone prompts render with workflow-shaped values", async () => {
  const prompts = await loadPrompts(["milestone-plan", "implement-milestone"], {
    cwd: process.cwd(),
  });

  assert.equal(prompts.ok, true);
  if (!prompts.ok) return;

  const planPrompt = renderPrompt(prompts.value["milestone-plan"]?.text ?? "", {
    goal: "Add feature X",
    finalMajorPlan: "# Final Plan",
    milestones: { milestones: [] },
    activeMilestone: { id: 1, title: "Milestone 1" },
    state: { currentPhase: "ready_for_milestone" },
  });
  assert.equal(planPrompt.ok, true);
  if (planPrompt.ok) {
    assert.match(planPrompt.value, /Add feature X/);
    assert.match(planPrompt.value, /Milestone 1/);
    assert.match(planPrompt.value, /Do not implement code/);
  }

  const implementationPrompt = renderPrompt(prompts.value["implement-milestone"]?.text ?? "", {
    goal: "Add feature X",
    finalMajorPlan: "# Final Plan",
    activeMilestone: { id: 1, title: "Milestone 1" },
    milestonePlan: "# Milestone Plan",
    state: { currentPhase: "implementing" },
  });
  assert.equal(implementationPrompt.ok, true);
  if (implementationPrompt.ok) {
    assert.match(implementationPrompt.value, /Implement only the active milestone/);
    assert.match(implementationPrompt.value, /Do not create commits/);
    assert.match(implementationPrompt.value, /# Milestone Plan/);
  }
});

test("review prompts expose the expected variables", async () => {
  const prompts = await loadPrompts(["review-milestone", "fix-review-findings"], {
    cwd: process.cwd(),
  });

  assert.equal(prompts.ok, true);
  if (!prompts.ok) return;

  assert.deepEqual(findPromptVariables(prompts.value["review-milestone"]?.text ?? ""), [
    "activeMilestone",
    "checks",
    "diff",
    "finalMajorPlan",
    "goal",
    "implementationReport",
    "latestChecksPassed",
    "milestonePlan",
    "reviewedArtifacts",
    "state",
  ]);
  assert.deepEqual(findPromptVariables(prompts.value["fix-review-findings"]?.text ?? ""), [
    "activeMilestone",
    "blockingFindings",
    "goal",
    "latestChecks",
    "latestDiff",
    "reviewVerdict",
    "state",
  ]);
});

test("review prompts render with workflow-shaped values", async () => {
  const prompts = await loadPrompts(["review-milestone", "fix-review-findings"], {
    cwd: process.cwd(),
  });

  assert.equal(prompts.ok, true);
  if (!prompts.ok) return;

  const reviewPrompt = renderPrompt(prompts.value["review-milestone"]?.text ?? "", {
    goal: "Add feature X",
    finalMajorPlan: "# Final Plan",
    activeMilestone: { id: 1, title: "Milestone 1" },
    milestonePlan: "# Milestone Plan",
    implementationReport: "# Implementation",
    diff: "diff --git a/file b/file",
    checks: "Overall: passed",
    latestChecksPassed: true,
    reviewedArtifacts: ["diffs/12-milestone-1.diff"],
    state: { currentPhase: "reviewing" },
  });
  assert.equal(reviewPrompt.ok, true);
  if (reviewPrompt.ok) {
    assert.match(reviewPrompt.value, /Return only JSON/);
    assert.match(reviewPrompt.value, /Milestone 1/);
    assert.match(reviewPrompt.value, /Overall: passed/);
  }

  const fixPrompt = renderPrompt(prompts.value["fix-review-findings"]?.text ?? "", {
    goal: "Add feature X",
    activeMilestone: { id: 1, title: "Milestone 1" },
    blockingFindings: [{ issue: "Missing behavior" }],
    reviewVerdict: { verdict: "fail" },
    latestDiff: "diff --git a/file b/file",
    latestChecks: "Overall: failed",
    state: { currentPhase: "fixing" },
  });
  assert.equal(fixPrompt.ok, true);
  if (fixPrompt.ok) {
    assert.match(fixPrompt.value, /Fix only the blocking findings/);
    assert.match(fixPrompt.value, /Do not create commits/);
    assert.match(fixPrompt.value, /Missing behavior/);
  }
});
