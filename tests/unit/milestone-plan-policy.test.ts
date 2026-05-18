import assert from "node:assert/strict";
import test from "node:test";

import { buildRunPaths } from "../../src/artifacts/paths.js";
import {
  formatFullMilestonePlan,
  formatLightMilestonePlan,
  selectMilestonePlanDecision,
} from "../../src/implementation/milestone-plan-policy.js";
import type { Milestone, MilestoneMetadata } from "../../src/milestones/milestone-types.js";
import { createInitialState } from "../../src/state/initial-state.js";
import type { RunState } from "../../src/state/state-types.js";

test("selectMilestonePlanDecision maps explicit policies directly", () => {
  const activeMilestone = milestone();

  assert.deepEqual(
    selectMilestonePlanDecision({
      policy: "always",
      activeMilestone,
      metadata: metadata(activeMilestone),
      state: state(),
    }),
    { policy: "always", mode: "full", reason: "policy=always" },
  );

  assert.deepEqual(
    selectMilestonePlanDecision({
      policy: "light",
      activeMilestone,
      metadata: metadata(activeMilestone),
      state: state(),
    }),
    { policy: "light", mode: "light", reason: "policy=light" },
  );
});

test("selectMilestonePlanDecision selects light for simple auto milestones", () => {
  const activeMilestone = milestone({
    scope: ["Update the CLI usage text", "Add a focused unit test"],
    acceptanceCriteria: ["The option is documented"],
    verification: ["npm test -- cli-args"],
  });

  const decision = selectMilestonePlanDecision({
    policy: "auto",
    activeMilestone,
    metadata: metadata(activeMilestone),
    state: state(),
  });

  assert.deepEqual(decision, {
    policy: "auto",
    mode: "light",
    reason: "auto: no dependencies, small scope, clear verification",
  });
});

test("selectMilestonePlanDecision selects full for dependency-bearing auto milestones", () => {
  const activeMilestone = milestone({ dependencies: [1] });

  const decision = selectMilestonePlanDecision({
    policy: "auto",
    activeMilestone,
    metadata: metadata(activeMilestone),
    state: state(),
  });

  assert.equal(decision.mode, "full");
  assert.equal(decision.reason, "auto: milestone has dependencies");
});

test("selectMilestonePlanDecision selects full for broad or risky terms", () => {
  const activeMilestone = milestone({
    title: "Improve runner diagnostics",
    summary: "Surface clearer execution failures.",
  });

  const decision = selectMilestonePlanDecision({
    policy: "auto",
    activeMilestone,
    metadata: metadata(activeMilestone),
    state: state(),
  });

  assert.equal(decision.mode, "full");
  assert.equal(decision.reason, 'auto: broad/risky term "runner" detected');
});

test("selectMilestonePlanDecision treats common auth wording as risky", () => {
  const cases: Array<[string, string]> = [
    ["Add authentication flow", "authentication"],
    ["Configure OAuth callback", "oauth"],
    ["Build login form", "login"],
  ];

  for (const [title, term] of cases) {
    const activeMilestone = milestone({ title });
    const decision = selectMilestonePlanDecision({
      policy: "auto",
      activeMilestone,
      metadata: metadata(activeMilestone),
      state: state(),
    });

    assert.equal(decision.mode, "full", title);
    assert.equal(decision.reason, `auto: broad/risky term "${term}" detected`, title);
  }
});

test("selectMilestonePlanDecision selects full when verification is only vague", () => {
  const activeMilestone = milestone({
    verification: ["Run tests", "manual test"],
  });

  const decision = selectMilestonePlanDecision({
    policy: "auto",
    activeMilestone,
    metadata: metadata(activeMilestone),
    state: state(),
  });

  assert.equal(decision.mode, "full");
  assert.equal(decision.reason, "auto: verification is vague");
});

test("selectMilestonePlanDecision does not treat mixed verification as vague", () => {
  const activeMilestone = milestone({
    verification: ["Run tests", "npm run test:build"],
  });

  const decision = selectMilestonePlanDecision({
    policy: "auto",
    activeMilestone,
    metadata: metadata(activeMilestone),
    state: state(),
  });

  assert.equal(decision.mode, "light");
});

test("selectMilestonePlanDecision keeps auto conservative for incomplete milestones", () => {
  const base = milestone();
  const cases: Array<[string, Milestone, string]> = [
    ["empty scope", { ...base, scope: [] }, "auto: scope is empty"],
    [
      "large scope",
      { ...base, scope: ["One", "Two", "Three"] },
      "auto: scope has more than two items",
    ],
    [
      "empty acceptance criteria",
      { ...base, acceptanceCriteria: [] },
      "auto: acceptance criteria are empty",
    ],
    [
      "empty verification",
      { ...base, verification: [] },
      "auto: verification is empty",
    ],
    [
      "large verification",
      { ...base, verification: ["npm test", "npm run build", "manual smoke"] },
      "auto: verification has more than two items",
    ],
  ];

  for (const [name, activeMilestone, reason] of cases) {
    const decision = selectMilestonePlanDecision({
      policy: "auto",
      activeMilestone,
      metadata: metadata(activeMilestone),
      state: state(),
    });

    assert.equal(decision.mode, "full", name);
    assert.equal(decision.reason, reason, name);
  }
});

test("formatLightMilestonePlan writes deterministic useful Markdown", () => {
  const dependency = milestone({
    id: 1,
    title: "Add config surface",
    summary: "Expose the config option.",
  });
  const activeMilestone = milestone({
    id: 2,
    title: "Document config surface",
    summary: "Document how to select the milestone plan policy.",
    scope: ["Update README usage", "Add config example"],
    acceptanceCriteria: ["Users can choose a policy without reading source"],
    verification: ["npm run test:build"],
    dependencies: [1],
  });
  const allMetadata = metadata(dependency, activeMilestone);
  const decision = {
    policy: "light" as const,
    mode: "light" as const,
    reason: "policy=light",
  };

  const plan = formatLightMilestonePlan({
    activeMilestone,
    metadata: allMetadata,
    decision,
  });

  assert.equal(
    plan,
    formatLightMilestonePlan({
      activeMilestone,
      metadata: allMetadata,
      decision,
    }),
  );
  assert.match(plan, /^# Milestone 2 Plan: Document config surface/);
  assert.match(plan, /## Plan Metadata\n\n- Policy: light\n- Mode: light\n- Decision: policy=light/);
  assert.match(plan, /## Milestone Summary\n\nDocument how to select the milestone plan policy\./);
  assert.match(plan, /## Scope\n\n- Update README usage\n- Add config example/);
  assert.match(plan, /## Acceptance Criteria\n\n- Users can choose a policy without reading source/);
  assert.match(plan, /## Verification\n\n- npm run test:build/);
  assert.match(plan, /## Dependencies\n\n- Milestone 1: Add config surface/);
  assert.match(
    plan,
    /Implementation must produce concrete code or file changes for this active milestone\./,
  );
});

test("formatFullMilestonePlan wraps runner output with decision metadata", () => {
  const plan = formatFullMilestonePlan({
    generatedPlan: "# Runner Plan\n\nGenerated by the planning phase.",
    decision: {
      policy: "auto",
      mode: "full",
      reason: "auto: milestone has dependencies",
    },
  });

  assert.match(
    plan,
    /## Plan Metadata\n\n- Policy: auto\n- Mode: full\n- Decision: auto: milestone has dependencies/,
  );
  assert.match(plan, /## Runner Plan\n\n# Runner Plan\n\nGenerated by the planning phase\./);
});

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: 1,
    title: "Update CLI option",
    summary: "Add a localized CLI option.",
    scope: ["Parse the option"],
    acceptanceCriteria: ["The option is accepted"],
    verification: ["npm test -- cli-args"],
    dependencies: [],
    status: "pending",
    ...overrides,
  };
}

function metadata(...milestones: Milestone[]): MilestoneMetadata {
  return { milestones };
}

function state(): RunState {
  const paths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });

  return createInitialState({
    runId: "run-1",
    goal: "Add feature X",
    paths,
    git: {
      required: true,
      planningOnly: false,
      root: "/repo",
      startSha: "abc123",
      dirtyAtStart: false,
      dirtyOverride: false,
      statusPorcelain: "",
    },
    configPath: "/repo/orchestrator.config.json",
    configSnapshot: {
      checks: [],
      runner: { type: "fake" },
      maxFixAttempts: 0,
      artifactRoot: ".agent-work",
      milestonePlanPolicy: "always",
    },
  });
}
