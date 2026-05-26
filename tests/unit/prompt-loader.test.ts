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

test("major plan prompt exposes and renders initial context", async () => {
  const prompt = await loadPrompt("major-plan", { cwd: process.cwd() });

  assert.equal(prompt.ok, true);
  if (!prompt.ok) return;

  assert.deepEqual(findPromptVariables(prompt.value.text), [
    "config",
    "goal",
    "initialContext",
  ]);

  const rendered = renderPrompt(prompt.value.text, {
    goal: "Add feature X",
    config: { checks: ["npm test"], runner: { type: "fake" } },
    initialContext: [
      "Initial context files:",
      "- README.md",
      "- docs/architecture.md",
    ].join("\n"),
  });

  assert.equal(rendered.ok, true);
  if (rendered.ok) {
    assert.match(rendered.value, /Initial context files:/);
    assert.match(rendered.value, /README\.md/);
    assert.match(rendered.value, /docs\/architecture\.md/);
  }
});

test("major plan review prompt exposes and renders initial context", async () => {
  const prompt = await loadPrompt("major-plan-review", { cwd: process.cwd() });

  assert.equal(prompt.ok, true);
  if (!prompt.ok) return;

  assert.deepEqual(findPromptVariables(prompt.value.text), [
    "goal",
    "initialContext",
    "majorPlan",
  ]);

  const rendered = renderPrompt(prompt.value.text, {
    goal: "Add feature X",
    majorPlan: "# Major Plan",
    initialContext: [
      "Initial context files:",
      "- README.md",
    ].join("\n"),
  });

  assert.equal(rendered.ok, true);
  if (rendered.ok) {
    assert.match(rendered.value, /Initial context files:/);
    assert.match(rendered.value, /README\.md/);
    assert.match(rendered.value, /# Major Plan/);
  }
});

test("milestone prompts expose the expected implementation variables", async () => {
  const prompts = await loadPrompts([
    "milestone-plan",
    "milestone-plan-review",
    "final-milestone-plan",
    "implement-milestone",
  ], {
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
  assert.deepEqual(findPromptVariables(prompts.value["milestone-plan-review"]?.text ?? ""), [
    "activeMilestone",
    "finalMajorPlan",
    "goal",
    "milestonePlanDraft",
    "milestones",
    "state",
  ]);
  assert.deepEqual(findPromptVariables(prompts.value["final-milestone-plan"]?.text ?? ""), [
    "activeMilestone",
    "finalMajorPlan",
    "goal",
    "milestonePlanDraft",
    "milestonePlanReview",
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
  const prompts = await loadPrompts([
    "milestone-plan",
    "milestone-plan-review",
    "final-milestone-plan",
    "implement-milestone",
  ], {
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

  const planReviewPrompt = renderPrompt(
    prompts.value["milestone-plan-review"]?.text ?? "",
    {
      goal: "Add feature X",
      finalMajorPlan: "# Final Plan",
      milestones: { milestones: [] },
      activeMilestone: { id: 1, title: "Milestone 1" },
      state: { currentPhase: "implementing" },
      milestonePlanDraft: "# Draft Milestone Plan",
    },
  );
  assert.equal(planReviewPrompt.ok, true);
  if (planReviewPrompt.ok) {
    assert.match(planReviewPrompt.value, /Milestone 1/);
    assert.match(planReviewPrompt.value, /# Draft Milestone Plan/);
    assert.match(planReviewPrompt.value, /Return a concise Markdown review/);
    assert.match(planReviewPrompt.value, /Do not implement code/);
  }

  const finalPlanPrompt = renderPrompt(
    prompts.value["final-milestone-plan"]?.text ?? "",
    {
      goal: "Add feature X",
      finalMajorPlan: "# Final Plan",
      milestones: { milestones: [] },
      activeMilestone: { id: 1, title: "Milestone 1" },
      state: { currentPhase: "implementing" },
      milestonePlanDraft: "# Draft Milestone Plan",
      milestonePlanReview: "# Review\n- Tighten validation.",
    },
  );
  assert.equal(finalPlanPrompt.ok, true);
  if (finalPlanPrompt.ok) {
    assert.match(finalPlanPrompt.value, /Milestone 1/);
    assert.match(finalPlanPrompt.value, /Tighten validation/);
    assert.match(finalPlanPrompt.value, /Write only the corrected Markdown implementation plan/);
    assert.match(finalPlanPrompt.value, /Do not include commentary before or after/);
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
    "reviewEvidence",
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
    reviewEvidence: "# Review Evidence\n\n- `npm run test` backed by package.json.",
    latestChecksPassed: true,
    reviewedArtifacts: [
      "diffs/12-milestone-1.diff",
      "reviews/19-milestone-1-review-evidence.md",
    ],
    state: { currentPhase: "reviewing" },
  });
  assert.equal(reviewPrompt.ok, true);
  if (reviewPrompt.ok) {
    assert.match(reviewPrompt.value, /Return only JSON/);
    assert.match(reviewPrompt.value, /Milestone 1/);
    assert.match(reviewPrompt.value, /Overall: passed/);
    assert.match(reviewPrompt.value, /# Review Evidence/);
    assert.match(reviewPrompt.value, /review evidence artifact/);
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

test("real-run prompts keep orchestration and output contracts explicit", async () => {
  const prompts = await loadPrompts([
    "major-plan",
    "major-plan-review",
    "final-major-plan",
    "final-plan-json",
    "milestone-plan",
    "milestone-plan-review",
    "final-milestone-plan",
    "implement-milestone",
    "review-milestone",
    "fix-review-findings",
  ], {
    cwd: process.cwd(),
  });

  assert.equal(prompts.ok, true);
  if (!prompts.ok) return;

  const text = (name: keyof typeof prompts.value) => prompts.value[name]?.text ?? "";

  assert.match(text("major-plan"), /orchestrator owns sequencing/i);
  assert.match(text("major-plan"), /Do not run commands/);
  assert.match(text("major-plan"), /expected to produce a non-empty Git diff/);
  assert.match(text("major-plan"), /Do not create standalone inspection/);

  assert.match(text("major-plan-review"), /implementation agent to decide status/);
  assert.match(text("final-major-plan"), /Git diff capture, checks, review decisions/);
  assert.match(text("final-major-plan"), /Do not preserve standalone inspection/);

  assert.match(text("final-plan-json"), /This phase is schema-constrained/);
  assert.match(text("final-plan-json"), /Return only valid JSON matching the schema/);
  assert.match(text("final-plan-json"), /Do not include Markdown, code fences, comments, or explanatory prose/);
  assert.match(text("final-plan-json"), /Every milestone must describe concrete file or code changes/);

  assert.match(text("milestone-plan"), /Do not tell the implementation agent to create commits/);
  assert.match(text("milestone-plan"), /Do not produce an inspection-only or no-op milestone plan/);

  assert.match(text("milestone-plan-review"), /implementation agents orchestration authority/);
  assert.match(text("milestone-plan-review"), /Return a concise Markdown review/);
  assert.match(text("milestone-plan-review"), /Do not implement code/);
  assert.match(text("milestone-plan-review"), /Do not run commands/);
  assert.match(text("milestone-plan-review"), /Do not create commits/);
  assert.match(text("milestone-plan-review"), /Do not make acceptance decisions/);

  assert.match(text("final-milestone-plan"), /Write only the corrected Markdown implementation plan/);
  assert.match(text("final-milestone-plan"), /Preserve the active milestone boundary/);
  assert.match(text("final-milestone-plan"), /The plan must lead to a non-empty Git diff/);
  assert.match(text("final-milestone-plan"), /Do not give implementation agents orchestration authority/);
  assert.match(text("final-milestone-plan"), /Do not include commentary before or after/);

  assert.match(text("implement-milestone"), /The orchestrator will capture the Git diff, run final checks/);
  assert.match(text("implement-milestone"), /Do not change orchestrator artifacts under `\.agent-work\/`/);
  assert.match(text("implement-milestone"), /Do not decide whether the milestone passed/);
  assert.match(text("implement-milestone"), /do not stop after context inspection/);

  assert.match(text("review-milestone"), /This phase is schema-constrained/);
  assert.match(text("review-milestone"), /Return only JSON matching `schemas\/review-verdict\.schema\.json`/);
  assert.match(text("review-milestone"), /Do not update files, run commands, create commits, or change state/);

  assert.match(text("fix-review-findings"), /The orchestrator will capture the Git diff, rerun checks/);
  assert.match(text("fix-review-findings"), /Do not fix non-blocking findings/);
  assert.match(text("fix-review-findings"), /Return a concise Markdown fix report/);
});
