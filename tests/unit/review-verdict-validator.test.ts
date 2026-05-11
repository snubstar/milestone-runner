import assert from "node:assert/strict";
import test from "node:test";

import type { ReviewVerdictDocument } from "../../src/review/review-types.js";
import {
  parseReviewVerdictJson,
  validateReviewVerdict,
} from "../../src/review/review-verdict-validator.js";

test("validateReviewVerdict accepts a passing verdict", () => {
  const result = validateReviewVerdict(validVerdict());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.verdict, "pass");
    assert.equal(result.value.findings.length, 0);
  }
});

test("validateReviewVerdict accepts a failed verdict with blocking findings", () => {
  const result = validateReviewVerdict({
    ...validVerdict(),
    verdict: "fail",
    findings: [
      {
        severity: "high",
        file: "src/app.ts",
        issue: "The implementation misses the required behavior.",
        suggestedFix: "Add the missing behavior.",
        blocking: true,
      },
    ],
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.verdict, "fail");
    assert.equal(result.value.findings[0]?.blocking, true);
  }
});

test("validateReviewVerdict accepts a needs-human-review verdict", () => {
  const result = validateReviewVerdict({
    ...validVerdict(),
    verdict: "needs_human_review",
    summary: "The diff references behavior that cannot be verified locally.",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.verdict, "needs_human_review");
  }
});

test("parseReviewVerdictJson parses and validates JSON", () => {
  const result = parseReviewVerdictJson(JSON.stringify(validVerdict()));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.reviewedArtifacts[0], "diffs/12-milestone-1.diff");
  }
});

test("parseReviewVerdictJson rejects invalid JSON", () => {
  const result = parseReviewVerdictJson("{");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /Invalid review verdict JSON/);
  }
});

test("validateReviewVerdict rejects unsupported root fields", () => {
  const result = validateReviewVerdict({
    ...validVerdict(),
    extra: true,
  });

  assert.deepEqual(result, {
    ok: false,
    error: "Review verdict has unsupported fields: extra.",
  });
});

test("validateReviewVerdict rejects missing required fields", () => {
  const verdict = validVerdict() as unknown as Record<string, unknown>;
  delete verdict.summary;

  const result = validateReviewVerdict(verdict);

  assert.deepEqual(result, {
    ok: false,
    error: "Review verdict summary is required.",
  });
});

test("validateReviewVerdict rejects invalid verdict values", () => {
  const result = validateReviewVerdict({
    ...validVerdict(),
    verdict: "accepted",
  });

  assert.deepEqual(result, {
    ok: false,
    error: "Review verdict verdict must be pass, fail, or needs_human_review.",
  });
});

test("validateReviewVerdict rejects invalid finding severities", () => {
  const result = validateReviewVerdict({
    ...validVerdict(),
    findings: [
      {
        severity: "critical",
        file: null,
        issue: "Invalid severity.",
        suggestedFix: "Use a supported severity.",
        blocking: true,
      },
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    error: "findings[0].severity must be high, medium, or low.",
  });
});

test("validateReviewVerdict rejects pass verdicts with blocking findings", () => {
  const result = validateReviewVerdict({
    ...validVerdict(),
    findings: [
      {
        severity: "medium",
        file: null,
        issue: "Blocking issue.",
        suggestedFix: "Fix the blocking issue.",
        blocking: true,
      },
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    error: "Review verdict cannot pass with blocking findings.",
  });
});

test("validateReviewVerdict rejects duplicate reviewed artifacts", () => {
  const result = validateReviewVerdict({
    ...validVerdict(),
    reviewedArtifacts: ["diffs/12-milestone-1.diff", "diffs/12-milestone-1.diff"],
  });

  assert.deepEqual(result, {
    ok: false,
    error: "Review verdict reviewedArtifacts must not contain duplicate values.",
  });
});

function validVerdict(): ReviewVerdictDocument {
  return {
    verdict: "pass",
    summary: "The milestone satisfies the requested scope.",
    findings: [],
    reviewedArtifacts: [
      "diffs/12-milestone-1.diff",
      "checks/13-milestone-1-checks.txt",
    ],
  };
}
