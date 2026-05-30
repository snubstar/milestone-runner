import assert from "node:assert/strict";
import test from "node:test";

import {
  parseReviewResolutionJson,
  validateReviewResolution,
} from "../../src/review/review-resolution-validator.js";

const validResolution = {
  resolution: {
    summary: "Resolved autonomously.",
    rationale: "Checks passed and artifacts support acceptance.",
    assumptions: ["The review evidence is complete."],
    sourceCondition: "explicit_needs_human_review",
  },
  verdict: {
    verdict: "pass",
    summary: "The milestone is accepted.",
    findings: [],
    reviewedArtifacts: ["reviews/20-milestone-1-review.json"],
  },
};

test("validateReviewResolution accepts a resolution wrapper with embedded verdict", () => {
  const result = validateReviewResolution(validResolution);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.resolution.sourceCondition, "explicit_needs_human_review");
  assert.equal(result.value.verdict.verdict, "pass");
});

test("parseReviewResolutionJson parses and validates JSON", () => {
  const result = parseReviewResolutionJson(JSON.stringify(validResolution));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.resolution.assumptions, ["The review evidence is complete."]);
});

test("parseReviewResolutionJson rejects invalid JSON", () => {
  const result = parseReviewResolutionJson("not json");

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Invalid review resolution JSON/);
});

test("validateReviewResolution rejects unsupported wrapper fields", () => {
  const result = validateReviewResolution({
    ...validResolution,
    extra: true,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /unsupported fields: extra/);
});

test("validateReviewResolution rejects invalid resolution metadata", () => {
  const result = validateReviewResolution({
    ...validResolution,
    resolution: {
      ...validResolution.resolution,
      assumptions: ["ok", ""],
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /assumptions\[1\]/);
});

test("validateReviewResolution rejects invalid embedded verdicts", () => {
  const result = validateReviewResolution({
    ...validResolution,
    verdict: {
      ...validResolution.verdict,
      reviewedArtifacts: [],
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /reviewedArtifacts/);
});
