import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { buildTimingArtifactPaths } from "../artifacts/timing-artifacts.js";
import type { RunPaths } from "../artifacts/paths.js";
import type {
  MilestoneStatus,
  OrchestratorPhase,
  RunState,
} from "../state/state-types.js";
import type {
  ChangedMilestoneStatus,
  TimingWarning,
  TimingWarningCollector,
  WorkflowTimelineEventName,
  WorkflowTimelineEvent,
} from "./timing-types.js";

export type TimelineAppendResult =
  | { ok: true; appended: false }
  | { ok: true; appended: true; event: WorkflowTimelineEvent }
  | { ok: false; warning: TimingWarning };

export interface BuildStateTimelineEventOptions {
  previousState: RunState | null;
  nextState: RunState;
  timestamp?: string;
}

export interface AppendStateTimelineEventOptions extends BuildStateTimelineEventOptions {
  paths: RunPaths;
  warnings?: TimingWarningCollector;
}

export interface AppendInvocationTimelineEventOptions {
  paths: RunPaths;
  invocationId: string;
  event: "invocation_started" | "invocation_ended";
  timestamp: string;
  state: RunState;
  warnings?: TimingWarningCollector;
}

export function buildStateTimelineEvent(
  options: BuildStateTimelineEventOptions,
): WorkflowTimelineEvent | null {
  const timestamp = options.timestamp ?? options.nextState.updatedAt;
  const previous = options.previousState;
  const next = options.nextState;

  if (previous === null) {
    return {
      timestamp,
      event: "state_initialized",
      phase: next.currentPhase,
      status: next.status,
      currentMilestoneId: next.currentMilestoneId,
      changedMilestoneStatuses: changedMilestoneStatuses({}, next.milestoneStatuses),
    };
  }

  const phaseChanged = previous.currentPhase !== next.currentPhase;
  const statusChanged = previous.status !== next.status;
  const currentMilestoneChanged =
    previous.currentMilestoneId !== next.currentMilestoneId;
  const milestoneChanges = changedMilestoneStatuses(
    previous.milestoneStatuses,
    next.milestoneStatuses,
  );

  const hasMilestoneChanges = Object.keys(milestoneChanges).length > 0;
  if (
    !phaseChanged &&
    !statusChanged &&
    !currentMilestoneChanged &&
    !hasMilestoneChanges
  ) {
    return null;
  }

  const eventName: WorkflowTimelineEventName = phaseChanged
    ? "phase_changed"
    : statusChanged
      ? "status_changed"
      : currentMilestoneChanged
        ? "current_milestone_changed"
        : "milestone_status_changed";

  return omitUndefined({
    timestamp,
    event: eventName,
    phase: next.currentPhase,
    status: next.status,
    currentMilestoneId: next.currentMilestoneId,
    previousPhase: phaseChanged ? previous.currentPhase : undefined,
    previousStatus: statusChanged ? previous.status : undefined,
    previousCurrentMilestoneId: currentMilestoneChanged
      ? previous.currentMilestoneId
      : undefined,
    changedMilestoneStatuses: hasMilestoneChanges ? milestoneChanges : undefined,
  });
}

export async function appendStateTimelineEvent(
  options: AppendStateTimelineEventOptions,
): Promise<TimelineAppendResult> {
  const event = buildStateTimelineEvent(options);
  if (event === null) {
    return { ok: true, appended: false };
  }

  return appendTimelineEvent(options.paths, event, options.warnings);
}

export async function appendInvocationTimelineEvent(
  options: AppendInvocationTimelineEventOptions,
): Promise<TimelineAppendResult> {
  const event: WorkflowTimelineEvent = {
    timestamp: options.timestamp,
    event: options.event,
    invocationId: options.invocationId,
    phase: options.state.currentPhase,
    status: options.state.status,
    currentMilestoneId: options.state.currentMilestoneId,
  };

  return appendTimelineEvent(options.paths, event, options.warnings);
}

export async function nextTimelineInvocationId(
  paths: RunPaths,
  warnings?: TimingWarningCollector,
): Promise<string> {
  const timelinePath = buildTimingArtifactPaths(paths).files.timeline;
  let raw: string;

  try {
    raw = await readFile(timelinePath, "utf8");
  } catch (error) {
    if (isNoEntryError(error)) return "1";
    recordWarning(
      warnings,
      timelineWarning(
        "timeline_incomplete",
        `Failed to read timeline for invocation sequencing: ${formatError(error)}`,
        { timeline: timelinePath },
      ),
    );
    return "1";
  }

  let maxInvocationId = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      recordWarning(
        warnings,
        timelineWarning("timeline_incomplete", "Timeline contains malformed JSON.", {
          timeline: timelinePath,
        }),
      );
      continue;
    }

    if (!isInvocationStartedEvent(parsed)) continue;

    const numericId = Number.parseInt(parsed.invocationId, 10);
    if (Number.isInteger(numericId) && numericId > 0) {
      maxInvocationId = Math.max(maxInvocationId, numericId);
    }
  }

  return String(maxInvocationId + 1);
}

async function appendTimelineEvent(
  paths: RunPaths,
  event: WorkflowTimelineEvent,
  warnings?: TimingWarningCollector,
): Promise<TimelineAppendResult> {
  const timelinePath = buildTimingArtifactPaths(paths).files.timeline;

  try {
    await mkdir(path.dirname(timelinePath), { recursive: true });
    await appendFile(timelinePath, `${JSON.stringify(event)}\n`, "utf8");
    return { ok: true, appended: true, event };
  } catch (error) {
    const warning = timelineWarning(
      "timeline_incomplete",
      `Failed to append timeline event ${event.event}: ${formatError(error)}`,
      { timeline: timelinePath, event: event.event },
    );
    recordWarning(warnings, warning);
    return { ok: false, warning };
  }
}

function changedMilestoneStatuses(
  previousStatuses: Record<string, MilestoneStatus>,
  nextStatuses: Record<string, MilestoneStatus>,
): Record<string, ChangedMilestoneStatus> {
  const result: Record<string, ChangedMilestoneStatus> = {};
  const keys = new Set([
    ...Object.keys(previousStatuses),
    ...Object.keys(nextStatuses),
  ]);

  for (const key of keys) {
    const previous = previousStatuses[key];
    const next = nextStatuses[key];
    if (previous === next || next === undefined) continue;

    result[key] = {
      ...(previous === undefined ? {} : { previous }),
      next,
    };
  }

  return result;
}

function timelineWarning(
  code: Extract<TimingWarning["code"], "timeline_incomplete">,
  message: string,
  details?: object,
): TimingWarning {
  return {
    code,
    message,
    source: "timeline",
    ...(details === undefined ? {} : { details }),
  };
}

function recordWarning(
  warnings: TimingWarningCollector | undefined,
  warning: TimingWarning,
): void {
  warnings?.add(warning);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as T;
}

function isInvocationStartedEvent(
  value: unknown,
): value is { event: "invocation_started"; invocationId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "event" in value &&
    value.event === "invocation_started" &&
    "invocationId" in value &&
    typeof value.invocationId === "string"
  );
}

function isNoEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
