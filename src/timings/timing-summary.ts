import type {
  CheckTiming,
  FinalTimingsDocument,
  RunnerPhaseTiming,
  TimingWarning,
  WorkflowPhaseTiming,
} from "./timing-types.js";

const slowestEntryLimit = 5;

export function formatTimingMarkdown(document: FinalTimingsDocument): string {
  return [
    "# Timing Summary",
    "",
    `Run: ${document.runId}`,
    `Run started: ${document.runStartedAt}`,
    `Latest invocation started: ${document.latestInvocationStartedAt}`,
    `Run ended: ${document.runEndedAt}`,
    `Generated: ${document.generatedAt}`,
    `Finalized: ${document.finalizedAt}`,
    "",
    "## Totals",
    "",
    formatTable(
      ["Metric", "Duration"],
      [
        ["Lifecycle", formatDurationMs(document.lifecycleDurationMs)],
        ["Active workflow", formatDurationMs(document.activeWorkflowDurationMs)],
        ["Latest invocation", formatDurationMs(document.latestInvocationDurationMs)],
        [
          "Known workflow phases",
          formatDurationMs(document.aggregates.knownWorkflowPhaseDurationMs),
        ],
        ["Runner phases", formatDurationMs(document.aggregates.runnerDurationMs)],
        ["Checks", formatDurationMs(document.aggregates.checkDurationMs)],
      ],
    ),
    "",
    "## Slowest Runner Phases",
    "",
    formatSlowestRunnerPhases(document.runnerPhases),
    "",
    "## Slowest Checks",
    "",
    formatSlowestChecks(document.checks),
    "",
    "## Milestone Timings",
    "",
    formatMilestoneTimings(document),
    "",
    "## Warnings",
    "",
    formatWarnings(document.warnings),
  ].join("\n");
}

export function formatDurationMs(durationMs: number | undefined): string {
  if (
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return "unknown";
  }

  const totalMs = Math.trunc(durationMs);
  if (totalMs === 0) return "0ms";

  let remainingMs = totalMs;
  const hours = Math.floor(remainingMs / 3_600_000);
  remainingMs -= hours * 3_600_000;
  const minutes = Math.floor(remainingMs / 60_000);
  remainingMs -= minutes * 60_000;
  const seconds = Math.floor(remainingMs / 1_000);
  remainingMs -= seconds * 1_000;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  if (remainingMs > 0) parts.push(`${remainingMs}ms`);

  const human = parts.join(" ");
  return totalMs < 1_000 ? human : `${human} (${totalMs}ms)`;
}

function formatSlowestRunnerPhases(phases: RunnerPhaseTiming[]): string {
  if (phases.length === 0) return "No runner timing recorded.";

  const rows = [...phases]
    .sort(compareRunnerPhaseByDurationDesc)
    .slice(0, slowestEntryLimit)
    .map((phase) => [
      phase.phase,
      formatMilestoneId(phase.milestoneId),
      formatDurationMs(phase.durationMs),
      formatRunnerOutcome(phase),
      phase.sourceArtifact,
    ]);

  return formatTable(
    ["Phase", "Milestone", "Duration", "Outcome", "Source"],
    rows,
  );
}

function formatSlowestChecks(checks: CheckTiming[]): string {
  if (checks.length === 0) return "No check timing recorded.";

  const rows = [...checks]
    .sort(compareCheckByDurationDesc)
    .slice(0, slowestEntryLimit)
    .map((check) => [
      formatMilestoneId(check.milestoneId),
      formatCheckAttempt(check.attempt),
      check.command ?? `Check ${check.commandIndex}`,
      formatDurationMs(check.durationMs),
      formatExitCode(check.exitCode),
      `${check.source}/${check.confidence}`,
      check.sourceArtifact,
    ]);

  return formatTable(
    ["Milestone", "Attempt", "Command", "Duration", "Exit", "Source", "Artifact"],
    rows,
  );
}

function formatMilestoneTimings(document: FinalTimingsDocument): string {
  const milestoneIds = collectMilestoneIds(document);
  if (milestoneIds.length === 0) return "No milestone-specific timing recorded.";

  const rows = milestoneIds.map((milestoneId) => {
    const workflowDurationMs = sum(
      document.workflowPhases
        .filter((phase) => phase.milestoneId === milestoneId)
        .map((phase) => phase.durationMs),
    );
    const runnerDurationMs = sum(
      document.runnerPhases
        .filter((phase) => phase.milestoneId === milestoneId)
        .map((phase) => phase.durationMs ?? 0),
    );
    const milestoneChecks = document.checks.filter(
      (check) => check.milestoneId === milestoneId,
    );
    const checkDurationMs = sum(milestoneChecks.map((check) => check.durationMs));

    return [
      String(milestoneId),
      formatDurationMs(workflowDurationMs),
      formatDurationMs(runnerDurationMs),
      formatDurationMs(checkDurationMs),
      String(milestoneChecks.length),
    ];
  });

  return formatTable(
    ["Milestone", "Workflow wall time", "Runner time", "Check time", "Checks"],
    rows,
  );
}

function formatWarnings(warnings: TimingWarning[]): string {
  if (warnings.length === 0) return "No timing warnings.";

  return warnings
    .map((warning) => {
      const details =
        warning.details === undefined
          ? ""
          : ` (${formatWarningDetails(warning.details)})`;
      return `- [${warning.code}] ${warning.source}: ${warning.message}${details}`;
    })
    .join("\n");
}

function formatTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(markdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
  ].join("\n");
}

function markdownCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function collectMilestoneIds(document: FinalTimingsDocument): number[] {
  const ids = new Set<number>();
  for (const phase of document.workflowPhases) {
    if (phase.milestoneId !== null) ids.add(phase.milestoneId);
  }
  for (const phase of document.runnerPhases) {
    if (phase.milestoneId !== null) ids.add(phase.milestoneId);
  }
  for (const check of document.checks) {
    ids.add(check.milestoneId);
  }
  return [...ids].sort((left, right) => left - right);
}

function compareRunnerPhaseByDurationDesc(
  left: RunnerPhaseTiming,
  right: RunnerPhaseTiming,
): number {
  return (
    durationSortValue(right.durationMs) - durationSortValue(left.durationMs) ||
    left.startedAt.localeCompare(right.startedAt) ||
    left.phase.localeCompare(right.phase) ||
    left.sourceArtifact.localeCompare(right.sourceArtifact)
  );
}

function compareCheckByDurationDesc(left: CheckTiming, right: CheckTiming): number {
  return (
    right.durationMs - left.durationMs ||
    left.milestoneId - right.milestoneId ||
    (left.attempt ?? 0) - (right.attempt ?? 0) ||
    left.commandIndex - right.commandIndex ||
    left.sourceArtifact.localeCompare(right.sourceArtifact)
  );
}

function durationSortValue(durationMs: number | undefined): number {
  return durationMs === undefined ? Number.NEGATIVE_INFINITY : durationMs;
}

function formatMilestoneId(milestoneId: number | null): string {
  return milestoneId === null ? "none" : String(milestoneId);
}

function formatCheckAttempt(attempt: number | null): string {
  return attempt === null ? "base" : `fix ${attempt}`;
}

function formatRunnerOutcome(phase: RunnerPhaseTiming): string {
  if (phase.timedOut) return "timeout";
  return formatExitCode(phase.exitCode);
}

function formatExitCode(exitCode: number | null | undefined): string {
  if (exitCode === undefined) return "unknown";
  return exitCode === null ? "exit null" : `exit ${exitCode}`;
}

function formatWarningDetails(details: TimingWarning["details"]): string {
  if (details === null) return "null";
  if (
    typeof details === "string" ||
    typeof details === "number" ||
    typeof details === "boolean"
  ) {
    return String(details);
  }
  return JSON.stringify(details);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
