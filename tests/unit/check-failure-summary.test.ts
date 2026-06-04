import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCheckFailureSummaryArtifact,
  formatCheckFailureSummaryForPrompt,
  parseCheckFailureSummaryArtifact,
} from "../../src/checks/check-failure-summary.js";
import type { CheckRunResult } from "../../src/checks/check-types.js";

test("buildCheckFailureSummaryArtifact captures stdout-only failures", () => {
  const summary = buildCheckFailureSummaryArtifact({
    milestoneId: 4,
    attempt: 1,
    stateKey: "4-failed-1",
    fullCheckReportArtifactPath: "checks/13-milestone-4-checks.txt",
    result: checkRun({
      stdout: [
        "TAP version 13",
        "# Subtest: stdout-only failure",
        "not ok 1 - stdout-only failure",
        "  ---",
        "  error: 'Expected values to be strictly equal:'",
        "  ...",
      ].join("\n"),
      stderr: "",
    }),
    generatedAt: new Date("2026-06-04T10:00:00.000Z"),
  });

  assert.equal(summary.kind, "check_failure_summary");
  assert.equal(summary.milestoneId, 4);
  assert.equal(summary.failedCheckCount, 1);
  assert.equal(
    summary.fullCheckReportArtifactPath,
    "checks/13-milestone-4-checks.txt",
  );
  assert.match(summary.failedChecks[0]?.stdout.snippet ?? "", /stdout-only failure/);
  assert.equal(summary.failedChecks[0]?.stderr.snippet, "");
  assert.deepEqual(summary.failedChecks[0]?.failingNodeTestNames, [
    "stdout-only failure",
  ]);
  assert.deepEqual(summary.failedChecks[0]?.assertionMessages, [
    "Expected values to be strictly equal:",
  ]);
});

test("buildCheckFailureSummaryArtifact truncates stdout and stderr deterministically", () => {
  const options = {
    milestoneId: 4,
    attempt: 1,
    stateKey: "4-failed-1",
    fullCheckReportArtifactPath: "checks/13-milestone-4-checks.txt",
    result: checkRun({
      stdout: "0123456789stdout tail",
      stderr: "abcdefghijstderr tail",
    }),
    generatedAt: new Date("2026-06-04T10:00:00.000Z"),
    outputSnippetMaxChars: 10,
  };

  const first = buildCheckFailureSummaryArtifact(options);
  const second = buildCheckFailureSummaryArtifact(options);

  assert.deepEqual(first, second);
  assert.equal(first.failedChecks[0]?.stdout.snippet, "0123456789");
  assert.equal(first.failedChecks[0]?.stderr.snippet, "abcdefghij");
  assert.equal(first.failedChecks[0]?.stdout.truncated, true);
  assert.equal(first.failedChecks[0]?.stderr.truncated, true);
});

test("buildCheckFailureSummaryArtifact extracts Node TAP failing subtests and messages", () => {
  const summary = buildCheckFailureSummaryArtifact({
    milestoneId: 4,
    attempt: 1,
    stateKey: "4-failed-1",
    fullCheckReportArtifactPath: "checks/13-milestone-4-checks.txt",
    result: checkRun({
      stdout: [
        "TAP version 13",
        "# Subtest: parser",
        "not ok 1 - parser rejects invalid input",
        "  ---",
        "  error: |-",
        "    Expected parser to reject invalid input",
        "  code: 'ERR_ASSERTION'",
        "  ...",
        "not ok 2 - parent suite > child failure # TODO tracked elsewhere",
      ].join("\n"),
      stderr: "AssertionError [ERR_ASSERTION]: secondary assertion message\n",
    }),
    generatedAt: new Date("2026-06-04T10:00:00.000Z"),
  });

  assert.deepEqual(summary.failedChecks[0]?.failingNodeTestNames, [
    "parser rejects invalid input",
    "parent suite > child failure",
  ]);
  assert.deepEqual(summary.failedChecks[0]?.assertionMessages, [
    "Expected parser to reject invalid input",
    "secondary assertion message",
  ]);
});

test("parseCheckFailureSummaryArtifact and prompt formatter preserve the report link", () => {
  const summary = buildCheckFailureSummaryArtifact({
    milestoneId: 4,
    attempt: 1,
    stateKey: "4-failed-1",
    fullCheckReportArtifactPath: "checks/13-milestone-4-checks.txt",
    result: checkRun({
      stdout: "not ok 1 - regression test\n",
      stderr: "Error: regression failed\n",
    }),
    generatedAt: new Date("2026-06-04T10:00:00.000Z"),
  });

  const parsed = parseCheckFailureSummaryArtifact(JSON.parse(JSON.stringify(summary)));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const promptText = formatCheckFailureSummaryForPrompt(parsed.value);
  assert.match(promptText, /Full check report: checks\/13-milestone-4-checks\.txt/);
  assert.match(promptText, /Failing Node tests: regression test/);
  assert.match(promptText, /Detected errors: regression failed/);
});

function checkRun(options: {
  stdout: string;
  stderr: string;
  exitCode?: number | null;
}): CheckRunResult {
  return {
    ok: false,
    results: [
      {
        command: "node --test",
        exitCode: options.exitCode ?? 1,
        stdout: options.stdout,
        stderr: options.stderr,
        durationMs: 42,
      },
    ],
    report: "Check results\n\nOverall: failed\n",
  };
}
