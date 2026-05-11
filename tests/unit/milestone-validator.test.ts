import assert from "node:assert/strict";
import test from "node:test";

import type { MilestoneMetadata } from "../../src/milestones/milestone-types.js";
import {
  firstPendingMilestoneId,
  parseMilestoneMetadataJson,
  toMilestoneStatusMap,
  validateMilestoneMetadata,
} from "../../src/milestones/milestone-validator.js";

test("validateMilestoneMetadata accepts valid pending milestone metadata", () => {
  const result = validateMilestoneMetadata(validMetadata());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.milestones.length, 2);
    assert.equal(result.value.milestones[0]?.status, "pending");
  }
});

test("parseMilestoneMetadataJson parses and validates JSON", () => {
  const result = parseMilestoneMetadataJson(JSON.stringify(validMetadata()));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.milestones[1]?.dependencies[0], 1);
  }
});

test("parseMilestoneMetadataJson rejects invalid JSON", () => {
  const result = parseMilestoneMetadataJson("{");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /Invalid milestone metadata JSON/);
  }
});

test("validateMilestoneMetadata rejects unsupported root fields", () => {
  const result = validateMilestoneMetadata({
    ...validMetadata(),
    extra: true,
  });

  assert.deepEqual(result, {
    ok: false,
    error: "Milestone metadata has unsupported fields: extra.",
  });
});

test("validateMilestoneMetadata rejects missing required milestone fields", () => {
  const metadata = validMetadata();
  const firstMilestone = metadata.milestones[0] as unknown as Record<string, unknown>;
  delete firstMilestone.title;

  const result = validateMilestoneMetadata(metadata);

  assert.deepEqual(result, {
    ok: false,
    error: "milestones[0].title is required.",
  });
});

test("validateMilestoneMetadata rejects duplicate milestone ids", () => {
  const metadata = validMetadata();
  metadata.milestones[1].id = 1;

  const result = validateMilestoneMetadata(metadata);

  assert.deepEqual(result, {
    ok: false,
    error: "Duplicate milestone id: 1.",
  });
});

test("validateMilestoneMetadata rejects missing dependencies", () => {
  const metadata = validMetadata();
  metadata.milestones[1].dependencies = [99];

  const result = validateMilestoneMetadata(metadata);

  assert.deepEqual(result, {
    ok: false,
    error: "Milestone 2 depends on missing milestone 99.",
  });
});

test("validateMilestoneMetadata rejects self-dependencies", () => {
  const metadata = validMetadata();
  metadata.milestones[1].dependencies = [2];

  const result = validateMilestoneMetadata(metadata);

  assert.deepEqual(result, {
    ok: false,
    error: "Milestone 2 cannot depend on itself.",
  });
});

test("validateMilestoneMetadata rejects future dependencies", () => {
  const metadata = validMetadata();
  metadata.milestones[0].dependencies = [2];

  const result = validateMilestoneMetadata(metadata);

  assert.deepEqual(result, {
    ok: false,
    error: "Milestone 1 depends on future milestone 2.",
  });
});

test("validateMilestoneMetadata rejects non-pending generated statuses", () => {
  const metadata = validMetadata();
  metadata.milestones[0].status = "passed";

  const result = validateMilestoneMetadata(metadata);

  assert.deepEqual(result, {
    ok: false,
    error: "milestones[0].status must be pending for generated metadata.",
  });
});

test("validateMilestoneMetadata rejects duplicate dependency values", () => {
  const metadata = validMetadata();
  metadata.milestones[1].dependencies = [1, 1];

  const result = validateMilestoneMetadata(metadata);

  assert.deepEqual(result, {
    ok: false,
    error: "milestones[1].dependencies must not contain duplicate values.",
  });
});

test("toMilestoneStatusMap initializes all milestones as pending", () => {
  assert.deepEqual(toMilestoneStatusMap(validMetadata()), {
    "1": "pending",
    "2": "pending",
  });
});

test("firstPendingMilestoneId returns the smallest pending id", () => {
  assert.equal(firstPendingMilestoneId(validMetadata()), 1);
});

function validMetadata(): MilestoneMetadata {
  return {
    milestones: [
      {
        id: 1,
        title: "Planning",
        summary: "Create validated plans.",
        scope: ["Write planning artifacts"],
        acceptanceCriteria: ["Artifacts exist"],
        verification: ["npm run test:build"],
        dependencies: [],
        status: "pending",
      },
      {
        id: 2,
        title: "Implementation",
        summary: "Implement the first milestone.",
        scope: ["Run one implementation step"],
        acceptanceCriteria: ["Diff is captured"],
        verification: ["npm run test:build"],
        dependencies: [1],
        status: "pending",
      },
    ],
  };
}
