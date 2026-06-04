import type { CheckCommandResult, CheckRunResult } from "./check-types.js";

export const CHECK_FAILURE_OUTPUT_SNIPPET_MAX_CHARS = 2000;
export const CHECK_FAILURE_DETECTED_ITEM_LIMIT = 20;
export const CHECK_FAILURE_DETECTED_MESSAGE_MAX_CHARS = 500;

export interface CheckFailureOutputSnippet {
  snippet: string;
  truncated: boolean;
}

export interface CheckFailureCommandSummary {
  checkIndex: number;
  command: string;
  exitCode: number | null;
  durationMs: number;
  stdout: CheckFailureOutputSnippet;
  stderr: CheckFailureOutputSnippet;
  failingNodeTestNames: string[];
  assertionMessages: string[];
  failingNodeTestNamesTruncated: boolean;
  assertionMessagesTruncated: boolean;
  error?: string;
}

export interface CheckFailureSummaryArtifact {
  schemaVersion: 1;
  kind: "check_failure_summary";
  milestoneId: number;
  attempt: number;
  stateKey: string;
  generatedAt: string;
  fullCheckReportArtifactPath: string;
  totalCheckCount: number;
  failedCheckCount: number;
  failedChecks: CheckFailureCommandSummary[];
  limits: {
    outputSnippetMaxChars: number;
    detectedItemLimit: number;
    detectedMessageMaxChars: number;
  };
}

export interface BuildCheckFailureSummaryOptions {
  milestoneId: number;
  attempt: number;
  stateKey: string;
  fullCheckReportArtifactPath: string;
  result: CheckRunResult;
  generatedAt: Date;
  outputSnippetMaxChars?: number;
  detectedItemLimit?: number;
  detectedMessageMaxChars?: number;
}

export function buildCheckFailureSummaryArtifact(
  options: BuildCheckFailureSummaryOptions,
): CheckFailureSummaryArtifact {
  const outputSnippetMaxChars =
    options.outputSnippetMaxChars ?? CHECK_FAILURE_OUTPUT_SNIPPET_MAX_CHARS;
  const detectedItemLimit =
    options.detectedItemLimit ?? CHECK_FAILURE_DETECTED_ITEM_LIMIT;
  const detectedMessageMaxChars =
    options.detectedMessageMaxChars ?? CHECK_FAILURE_DETECTED_MESSAGE_MAX_CHARS;

  const failedChecks = options.result.results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => result.exitCode !== 0)
    .map(({ result, index }) =>
      summarizeFailedCheck({
        result,
        index,
        outputSnippetMaxChars,
        detectedItemLimit,
        detectedMessageMaxChars,
      }),
    );

  return {
    schemaVersion: 1,
    kind: "check_failure_summary",
    milestoneId: options.milestoneId,
    attempt: options.attempt,
    stateKey: options.stateKey,
    generatedAt: options.generatedAt.toISOString(),
    fullCheckReportArtifactPath: options.fullCheckReportArtifactPath,
    totalCheckCount: options.result.results.length,
    failedCheckCount: failedChecks.length,
    failedChecks,
    limits: {
      outputSnippetMaxChars,
      detectedItemLimit,
      detectedMessageMaxChars,
    },
  };
}

export function parseCheckFailureSummaryArtifact(
  value: unknown,
): { ok: true; value: CheckFailureSummaryArtifact } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: "Check failure summary must be an object." };
  }

  if (value.schemaVersion !== 1) {
    return { ok: false, error: "Check failure summary schemaVersion must be 1." };
  }

  if (value.kind !== "check_failure_summary") {
    return { ok: false, error: "Check failure summary kind is invalid." };
  }

  const milestoneId = positiveIntegerField(value.milestoneId, "milestoneId");
  if (!milestoneId.ok) return milestoneId;
  const attempt = positiveIntegerField(value.attempt, "attempt");
  if (!attempt.ok) return attempt;
  const stateKey = nonEmptyStringField(value.stateKey, "stateKey");
  if (!stateKey.ok) return stateKey;
  const generatedAt = nonEmptyStringField(value.generatedAt, "generatedAt");
  if (!generatedAt.ok) return generatedAt;
  const fullCheckReportArtifactPath = nonEmptyStringField(
    value.fullCheckReportArtifactPath,
    "fullCheckReportArtifactPath",
  );
  if (!fullCheckReportArtifactPath.ok) return fullCheckReportArtifactPath;
  const totalCheckCount = nonNegativeIntegerField(
    value.totalCheckCount,
    "totalCheckCount",
  );
  if (!totalCheckCount.ok) return totalCheckCount;
  const failedCheckCount = nonNegativeIntegerField(
    value.failedCheckCount,
    "failedCheckCount",
  );
  if (!failedCheckCount.ok) return failedCheckCount;

  if (!Array.isArray(value.failedChecks)) {
    return { ok: false, error: "Check failure summary failedChecks must be an array." };
  }

  const failedChecks: CheckFailureCommandSummary[] = [];
  for (const [index, item] of value.failedChecks.entries()) {
    const parsed = parseFailedCheckSummary(item, index);
    if (!parsed.ok) return parsed;
    failedChecks.push(parsed.value);
  }

  const limits = parseLimits(value.limits);
  if (!limits.ok) return limits;

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      kind: "check_failure_summary",
      milestoneId: milestoneId.value,
      attempt: attempt.value,
      stateKey: stateKey.value,
      generatedAt: generatedAt.value,
      fullCheckReportArtifactPath: fullCheckReportArtifactPath.value,
      totalCheckCount: totalCheckCount.value,
      failedCheckCount: failedCheckCount.value,
      failedChecks,
      limits: limits.value,
    },
  };
}

export function formatCheckFailureSummaryForPrompt(
  summary: CheckFailureSummaryArtifact,
): string {
  const lines = [
    `Check failure summary for milestone ${summary.milestoneId}, attempt ${summary.attempt}`,
    `Full check report: ${summary.fullCheckReportArtifactPath}`,
    `Failed checks: ${summary.failedCheckCount} of ${summary.totalCheckCount}`,
  ];

  for (const failedCheck of summary.failedChecks) {
    lines.push(
      "",
      `Check ${failedCheck.checkIndex}: ${failedCheck.command}`,
      `Exit code: ${formatExitCode(failedCheck.exitCode)}`,
      `Duration: ${failedCheck.durationMs}ms`,
    );

    if (failedCheck.error) {
      lines.push(`Runner error: ${failedCheck.error}`);
    }

    if (failedCheck.failingNodeTestNames.length > 0) {
      lines.push(
        `Failing Node tests: ${failedCheck.failingNodeTestNames.join("; ")}`,
      );
    }

    if (failedCheck.assertionMessages.length > 0) {
      lines.push(`Detected errors: ${failedCheck.assertionMessages.join("; ")}`);
    }

    lines.push(
      `Stdout${failedCheck.stdout.truncated ? " (truncated)" : ""}:`,
      formatSnippet(failedCheck.stdout.snippet),
      `Stderr${failedCheck.stderr.truncated ? " (truncated)" : ""}:`,
      formatSnippet(failedCheck.stderr.snippet),
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function summarizeFailedCheck(options: {
  result: CheckCommandResult;
  index: number;
  outputSnippetMaxChars: number;
  detectedItemLimit: number;
  detectedMessageMaxChars: number;
}): CheckFailureCommandSummary {
  const combinedOutput = `${options.result.stdout}\n${options.result.stderr}`;
  const failingNames = boundedUnique(
    extractFailingNodeTestNames(combinedOutput),
    options.detectedItemLimit,
  );
  const assertionMessages = boundedUnique(
    extractAssertionMessages(combinedOutput).map((message) =>
      truncateTo(message, options.detectedMessageMaxChars).value,
    ),
    options.detectedItemLimit,
  );

  return {
    checkIndex: options.index + 1,
    command: options.result.command,
    exitCode: options.result.exitCode,
    durationMs: options.result.durationMs,
    stdout: outputSnippet(options.result.stdout, options.outputSnippetMaxChars),
    stderr: outputSnippet(options.result.stderr, options.outputSnippetMaxChars),
    failingNodeTestNames: failingNames.values,
    assertionMessages: assertionMessages.values,
    failingNodeTestNamesTruncated: failingNames.truncated,
    assertionMessagesTruncated: assertionMessages.truncated,
    ...(options.result.error ? { error: options.result.error } : {}),
  };
}

function outputSnippet(value: string, maxChars: number): CheckFailureOutputSnippet {
  const normalized = normalizeNewlines(value);
  const truncated = truncateTo(normalized, maxChars);
  return {
    snippet: truncated.value,
    truncated: truncated.truncated,
  };
}

function extractFailingNodeTestNames(output: string): string[] {
  const names: string[] = [];
  for (const line of normalizeNewlines(output).split("\n")) {
    const match = /^\s*not ok\s+\d+(?:\s+-\s+(.+?))?\s*$/i.exec(line);
    if (!match) continue;

    const name = cleanDetectedText(match[1] ?? "");
    if (name.length > 0) {
      names.push(stripTapDirective(name));
    }
  }
  return names;
}

function extractAssertionMessages(output: string): string[] {
  const messages: string[] = [];
  const lines = normalizeNewlines(output).split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const yamlMatch = /^\s*(?:error|message):\s*(.+)\s*$/i.exec(line);
    if (yamlMatch) {
      const parsed = parseYamlMessageValue(yamlMatch[1] ?? "", lines, index);
      if (parsed.message.length > 0) {
        messages.push(parsed.message);
      }
      index = parsed.nextIndex;
      continue;
    }

    const errorMatch =
      /^\s*(?:AssertionError(?:\s+\[[^\]]+\])?|Error|TypeError|ReferenceError|SyntaxError|RangeError):\s*(.+)\s*$/i.exec(
        line,
      );
    if (errorMatch) {
      const message = cleanDetectedText(errorMatch[1] ?? "");
      if (message.length > 0) {
        messages.push(message);
      }
    }
  }

  return messages;
}

function parseYamlMessageValue(
  rawValue: string,
  lines: string[],
  lineIndex: number,
): { message: string; nextIndex: number } {
  const cleaned = rawValue.trim();
  if (/^[>|]-?$/.test(cleaned)) {
    const blockLines: string[] = [];
    for (let index = lineIndex + 1; index < lines.length; index += 1) {
      const nextLine = lines[index] ?? "";
      if (nextLine.trim() === "..." || /^\s*[a-zA-Z][a-zA-Z0-9_-]*:\s*/.test(nextLine)) {
        return {
          message: cleanDetectedText(blockLines.join("\n")),
          nextIndex: index - 1,
        };
      }
      if (nextLine.trim().length > 0) {
        blockLines.push(nextLine.trim());
      }
    }
    return {
      message: cleanDetectedText(blockLines.join("\n")),
      nextIndex: lines.length - 1,
    };
  }

  if (/^[>|]-?$/.test(cleaned) || cleaned.length === 0) {
    return { message: "", nextIndex: lineIndex };
  }

  return {
    message: cleanDetectedText(cleaned),
    nextIndex: lineIndex,
  };
}

function parseFailedCheckSummary(
  value: unknown,
  index: number,
): { ok: true; value: CheckFailureCommandSummary } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: `failedChecks[${index}] must be an object.` };
  }

  const checkIndex = positiveIntegerField(value.checkIndex, `failedChecks[${index}].checkIndex`);
  if (!checkIndex.ok) return checkIndex;
  const command = nonEmptyStringField(value.command, `failedChecks[${index}].command`);
  if (!command.ok) return command;
  const durationMs = nonNegativeIntegerField(value.durationMs, `failedChecks[${index}].durationMs`);
  if (!durationMs.ok) return durationMs;
  const stdout = parseOutputSnippet(value.stdout, `failedChecks[${index}].stdout`);
  if (!stdout.ok) return stdout;
  const stderr = parseOutputSnippet(value.stderr, `failedChecks[${index}].stderr`);
  if (!stderr.ok) return stderr;

  if (!(typeof value.exitCode === "number" || value.exitCode === null)) {
    return {
      ok: false,
      error: `failedChecks[${index}].exitCode must be a number or null.`,
    };
  }

  if (!Array.isArray(value.failingNodeTestNames)) {
    return {
      ok: false,
      error: `failedChecks[${index}].failingNodeTestNames must be an array.`,
    };
  }
  if (!Array.isArray(value.assertionMessages)) {
    return {
      ok: false,
      error: `failedChecks[${index}].assertionMessages must be an array.`,
    };
  }

  if (typeof value.failingNodeTestNamesTruncated !== "boolean") {
    return {
      ok: false,
      error: `failedChecks[${index}].failingNodeTestNamesTruncated must be boolean.`,
    };
  }
  if (typeof value.assertionMessagesTruncated !== "boolean") {
    return {
      ok: false,
      error: `failedChecks[${index}].assertionMessagesTruncated must be boolean.`,
    };
  }

  if ("error" in value && typeof value.error !== "string") {
    return {
      ok: false,
      error: `failedChecks[${index}].error must be a string when present.`,
    };
  }

  return {
    ok: true,
    value: {
      checkIndex: checkIndex.value,
      command: command.value,
      exitCode: value.exitCode,
      durationMs: durationMs.value,
      stdout: stdout.value,
      stderr: stderr.value,
      failingNodeTestNames: stringArray(value.failingNodeTestNames),
      assertionMessages: stringArray(value.assertionMessages),
      failingNodeTestNamesTruncated: value.failingNodeTestNamesTruncated,
      assertionMessagesTruncated: value.assertionMessagesTruncated,
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    },
  };
}

function parseOutputSnippet(
  value: unknown,
  label: string,
): { ok: true; value: CheckFailureOutputSnippet } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: `${label} must be an object.` };
  }
  if (typeof value.snippet !== "string") {
    return { ok: false, error: `${label}.snippet must be a string.` };
  }
  if (typeof value.truncated !== "boolean") {
    return { ok: false, error: `${label}.truncated must be boolean.` };
  }
  return {
    ok: true,
    value: {
      snippet: value.snippet,
      truncated: value.truncated,
    },
  };
}

function parseLimits(
  value: unknown,
): {
  ok: true;
  value: CheckFailureSummaryArtifact["limits"];
} | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: "Check failure summary limits must be an object." };
  }

  const outputSnippetMaxChars = positiveIntegerField(
    value.outputSnippetMaxChars,
    "limits.outputSnippetMaxChars",
  );
  if (!outputSnippetMaxChars.ok) return outputSnippetMaxChars;
  const detectedItemLimit = positiveIntegerField(
    value.detectedItemLimit,
    "limits.detectedItemLimit",
  );
  if (!detectedItemLimit.ok) return detectedItemLimit;
  const detectedMessageMaxChars = positiveIntegerField(
    value.detectedMessageMaxChars,
    "limits.detectedMessageMaxChars",
  );
  if (!detectedMessageMaxChars.ok) return detectedMessageMaxChars;

  return {
    ok: true,
    value: {
      outputSnippetMaxChars: outputSnippetMaxChars.value,
      detectedItemLimit: detectedItemLimit.value,
      detectedMessageMaxChars: detectedMessageMaxChars.value,
    },
  };
}

function boundedUnique(
  values: string[],
  limit: number,
): { values: string[]; truncated: boolean } {
  const uniqueValues = [...new Set(values.filter((value) => value.length > 0))];
  return {
    values: uniqueValues.slice(0, limit),
    truncated: uniqueValues.length > limit,
  };
}

function truncateTo(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }
  return {
    value: value.slice(0, maxChars),
    truncated: true,
  };
}

function stripTapDirective(value: string): string {
  return value.replace(/\s+#\s+(?:TODO|SKIP)\b.*$/i, "").trim();
}

function cleanDetectedText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" && last === "'") || (first === "\"" && last === "\"")) {
      return trimmed.slice(1, -1).replace(/''/g, "'").trim();
    }
  }
  return trimmed;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function formatSnippet(value: string): string {
  return value.trimEnd().length > 0 ? value.trimEnd() : "(empty)";
}

function formatExitCode(exitCode: number | null): string {
  return exitCode === null ? "null" : String(exitCode);
}

function stringArray(value: unknown[]): string[] {
  return value.filter((item): item is string => typeof item === "string");
}

function positiveIntegerField(
  value: unknown,
  label: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (!Number.isInteger(value) || (value as number) < 1) {
    return { ok: false, error: `${label} must be a positive integer.` };
  }
  return { ok: true, value: value as number };
}

function nonNegativeIntegerField(
  value: unknown,
  label: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (!Number.isInteger(value) || (value as number) < 0) {
    return { ok: false, error: `${label} must be a non-negative integer.` };
  }
  return { ok: true, value: value as number };
}

function nonEmptyStringField(
  value: unknown,
  label: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: `${label} must be a non-empty string.` };
  }
  return { ok: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
