import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { isSafeRunId } from "../artifacts/paths.js";
import type {
  DashboardArtifactLink,
  DashboardError,
  DashboardRunDetail,
  DashboardStreamEvent,
  DashboardStreamEventName,
  DashboardTimelineEvent,
} from "./api-types.js";
import { readDashboardRun } from "./run-reader.js";

export interface DashboardRunEventStreamOptions {
  cwd: string;
  artifactRoot: string;
  runId: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  now?: () => Date;
}

export interface DashboardRunEventSink {
  send(event: DashboardStreamEvent): void;
}

export type DashboardRunEventStreamResult =
  | { ok: true; close(): void }
  | { ok: false; error: DashboardError };

export interface DashboardLauncherOutputEventOptions {
  runId: string;
  launchId: string;
  stream: "stdout" | "stderr";
  text: string;
  timestamp?: string;
}

export interface DashboardLauncherCompletionEventOptions {
  runId: string;
  launchId: string;
  status: "completed" | "spawn_failed";
  exitCode: number | null;
  signal: string | null;
  diagnosticsPath?: string;
  timestamp?: string;
}

interface LaunchDiagnosticsSnapshot {
  launchId?: unknown;
  runId?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  status?: unknown;
  exitCode?: unknown;
  signal?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

const processEventEmitter = new EventEmitter();
processEventEmitter.setMaxListeners(100);
let liveLauncherEventSequence = 0;

export async function startDashboardRunEventStream(
  options: DashboardRunEventStreamOptions,
  sink: DashboardRunEventSink,
): Promise<DashboardRunEventStreamResult> {
  if (!isSafeRunId(options.runId)) {
    return {
      ok: false,
      error: {
        code: "invalid_run_id",
        message: `Invalid run id: ${options.runId}`,
      },
    };
  }

  const seenEventIds = new Set<string>();
  let latestRun: DashboardRunDetail | null = null;
  let closed = false;
  let polling = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeLiveEvents = () => {};

  const close = () => {
    if (closed) return;
    closed = true;
    if (pollTimer !== null) clearInterval(pollTimer);
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    unsubscribeLiveEvents();
  };

  const send = (event: DashboardStreamEvent, dedupe = true) => {
    if (closed) return;
    if (dedupe && seenEventIds.has(event.id)) return;
    if (dedupe) seenEventIds.add(event.id);

    try {
      sink.send(event);
    } catch {
      close();
    }
  };

  const pollOnce = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      const result = await readDashboardRun({
        cwd: options.cwd,
        artifactRoot: options.artifactRoot,
        runId: options.runId,
      });
      if (result.ok) {
        for (const event of buildDashboardStreamEvents(result.run, latestRun)) {
          send(event);
        }
        latestRun = result.run;
      } else {
        send(streamErrorEvent(options.runId, result.error, options.now));
      }

      for (const event of await readLaunchDiagnosticsEvents(options)) {
        send(event);
      }
    } catch (error) {
      send(
        streamErrorEvent(
          options.runId,
          {
            code: "stream_read_failed",
            message: "Failed to read run updates for the dashboard stream.",
            details: formatError(error),
          },
          options.now,
        ),
      );
    } finally {
      polling = false;
    }
  };

  unsubscribeLiveEvents = subscribeDashboardProcessEvents(options.runId, (event) => {
    send(event);
  });

  await pollOnce();
  pollTimer = setInterval(() => {
    void pollOnce();
  }, options.pollIntervalMs ?? 1000);
  heartbeatTimer = setInterval(() => {
    send(heartbeatEvent(options.runId, options.now), false);
  }, options.heartbeatIntervalMs ?? 15000);

  return { ok: true, close };
}

export function buildDashboardStreamEvents(
  run: DashboardRunDetail,
  previousRun: DashboardRunDetail | null = null,
): DashboardStreamEvent[] {
  const events: DashboardStreamEvent[] = [];
  const previousTimelineKeys = new Set(
    previousRun?.timeline.map((event) => timelineKey(event)) ?? [],
  );

  for (const timeline of run.timeline) {
    if (previousTimelineKeys.has(timelineKey(timeline))) continue;
    events.push(...streamEventsForTimeline(run.runId, timeline));
  }

  const previousArtifacts = artifactSignatureMap(previousRun);
  for (const artifact of existingArtifacts(run)) {
    const signature = artifactSignature(artifact);
    if (previousArtifacts.get(artifact.id) === signature) continue;

    events.push(
      artifact.group === "runner"
        ? runnerDiagnosticWrittenEvent(run.runId, artifact)
        : artifactWrittenEvent(run.runId, artifact),
    );
  }

  return events.sort(compareStreamEvents);
}

export function publishDashboardProcessEvent(event: DashboardStreamEvent): void {
  processEventEmitter.emit(optionsEventName(event.runId), event);
}

export function buildDashboardLauncherOutputEvent(
  options: DashboardLauncherOutputEventOptions,
): DashboardStreamEvent {
  const timestamp = options.timestamp ?? new Date().toISOString();
  liveLauncherEventSequence += 1;
  return {
    id: [
      "launcher",
      options.launchId,
      options.stream,
      "live",
      String(liveLauncherEventSequence),
    ].join(":"),
    runId: options.runId,
    event: "launcher_output",
    timestamp,
    message: `Launcher ${options.stream} output`,
    launcher: {
      launchId: options.launchId,
      stream: options.stream,
      text: truncateText(options.text, 8192),
      status: "running",
    },
  };
}

export function buildDashboardLauncherCompletionEvent(
  options: DashboardLauncherCompletionEventOptions,
): DashboardStreamEvent {
  const timestamp = options.timestamp ?? new Date().toISOString();
  return {
    id: [
      "launcher",
      options.launchId,
      options.status,
      String(options.exitCode ?? "null"),
      String(options.signal ?? "null"),
    ].join(":"),
    runId: options.runId,
    event: "launcher_completed",
    timestamp,
    message:
      options.status === "spawn_failed"
        ? "Launcher failed to start"
        : `Launcher completed with exit ${options.exitCode ?? "unknown"}`,
    launcher: {
      launchId: options.launchId,
      status: options.status,
      exitCode: options.exitCode,
      signal: options.signal,
      ...(options.diagnosticsPath === undefined
        ? {}
        : { diagnosticsPath: options.diagnosticsPath }),
    },
  };
}

function subscribeDashboardProcessEvents(
  runId: string,
  listener: (event: DashboardStreamEvent) => void,
): () => void {
  const eventName = optionsEventName(runId);
  processEventEmitter.on(eventName, listener);
  return () => {
    processEventEmitter.off(eventName, listener);
  };
}

function streamEventsForTimeline(
  runId: string,
  timeline: DashboardTimelineEvent,
): DashboardStreamEvent[] {
  const events: DashboardStreamEvent[] = [];
  const eventName = streamEventNameForTimeline(timeline);
  events.push({
    id: `timeline:${timeline.index}:${eventName}`,
    runId,
    event: eventName,
    timestamp: timeline.timestamp,
    message: timelineMessage(timeline),
    ...(timeline.phase === undefined ? {} : { phase: timeline.phase }),
    ...(timeline.status === undefined ? {} : { status: timeline.status }),
    ...(timeline.currentMilestoneId === undefined
      ? {}
      : { currentMilestoneId: timeline.currentMilestoneId }),
    timeline,
  });

  const milestoneChanges = changedMilestoneStatuses(timeline);
  if (
    Object.keys(milestoneChanges).length > 0 &&
    eventName !== "milestone_status_changed"
  ) {
    events.push({
      id: `timeline:${timeline.index}:milestone_status_changed`,
      runId,
      event: "milestone_status_changed",
      timestamp: timeline.timestamp,
      message: `Milestone status changed: ${formatMilestoneChanges(milestoneChanges)}`,
      ...(timeline.phase === undefined ? {} : { phase: timeline.phase }),
      ...(timeline.status === undefined ? {} : { status: timeline.status }),
      ...(timeline.currentMilestoneId === undefined
        ? {}
        : { currentMilestoneId: timeline.currentMilestoneId }),
      timeline,
    });
  }

  return events;
}

function streamEventNameForTimeline(
  timeline: DashboardTimelineEvent,
): DashboardStreamEventName {
  switch (timeline.event) {
    case "invocation_started":
      return "invocation_started";
    case "invocation_ended":
      return "invocation_ended";
    case "milestone_status_changed":
      return "milestone_status_changed";
    case "state_initialized":
    case "phase_changed":
    case "status_changed":
    case "current_milestone_changed":
      return "phase_changed";
    default:
      return "timeline_event";
  }
}

function timelineMessage(timeline: DashboardTimelineEvent): string {
  switch (timeline.event) {
    case "invocation_started":
      return `Invocation ${timeline.invocationId ?? ""} started`.trim();
    case "invocation_ended":
      return `Invocation ${timeline.invocationId ?? ""} ended`.trim();
    case "state_initialized":
      return `Run initialized in ${timeline.phase ?? "unknown phase"}`;
    case "phase_changed":
      return `Phase changed to ${timeline.phase ?? "unknown"}`;
    case "status_changed":
      return `Status changed to ${timeline.status ?? "unknown"}`;
    case "current_milestone_changed":
      return `Active milestone changed to M${timeline.currentMilestoneId ?? "-"}`;
    case "milestone_status_changed": {
      const changes = changedMilestoneStatuses(timeline);
      return Object.keys(changes).length === 0
        ? "Milestone status changed"
        : `Milestone status changed: ${formatMilestoneChanges(changes)}`;
    }
    default:
      return timeline.event.replace(/_/g, " ");
  }
}

function artifactWrittenEvent(
  runId: string,
  artifact: DashboardArtifactLink,
): DashboardStreamEvent {
  return {
    id: durableArtifactEventId("artifact", artifact),
    runId,
    event: "artifact_written",
    timestamp: artifact.updatedAt ?? null,
    message: `${artifactGroupLabel(artifact.group)} artifact written: ${artifact.label}`,
    artifact,
  };
}

function runnerDiagnosticWrittenEvent(
  runId: string,
  artifact: DashboardArtifactLink,
): DashboardStreamEvent {
  return {
    id: durableArtifactEventId("runner-diagnostic", artifact),
    runId,
    event: "runner_diagnostic_written",
    timestamp: artifact.updatedAt ?? null,
    message: `Runner diagnostic written: ${artifact.label}`,
    runnerDiagnostic: artifact,
  };
}

async function readLaunchDiagnosticsEvents(
  options: DashboardRunEventStreamOptions,
): Promise<DashboardStreamEvent[]> {
  const directory = path.resolve(
    options.cwd,
    options.artifactRoot,
    "dashboard-launches",
  );
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isNoEntryError(error)) return [];
    throw error;
  }

  const events: DashboardStreamEvent[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(directory, entry);
    const diagnostics = await readLaunchDiagnostics(filePath);
    if (!diagnostics || diagnostics.runId !== options.runId) continue;
    const launchId = stringField(diagnostics.launchId) ?? path.basename(entry, ".json");
    const timestamp =
      stringField(diagnostics.updatedAt) ?? stringField(diagnostics.createdAt) ?? null;
    const stdout = stringField(diagnostics.stdout);
    const stderr = stringField(diagnostics.stderr);
    const launcherStatus = launcherDiagnosticStatus(diagnostics.status);
    if (stdout) {
      events.push(launcherDiagnosticOutputEvent({
        runId: options.runId,
        launchId,
        stream: "stdout",
        text: stdout,
        status: launcherStatus,
        timestamp,
      }));
    }
    if (stderr) {
      events.push(launcherDiagnosticOutputEvent({
        runId: options.runId,
        launchId,
        stream: "stderr",
        text: stderr,
        status: launcherStatus,
        timestamp,
      }));
    }

    const status = launcherStatus === "spawn_failed" ? "spawn_failed" : launcherStatus;
    if (status === "completed" || status === "spawn_failed") {
      events.push(
        buildDashboardLauncherCompletionEvent({
          runId: options.runId,
          launchId,
          status,
          exitCode: numberOrNull(diagnostics.exitCode),
          signal: stringOrNull(diagnostics.signal),
          diagnosticsPath: path.posix.join("dashboard-launches", entry),
          ...(timestamp === null ? {} : { timestamp }),
        }),
      );
    }
  }

  return events.sort(compareStreamEvents);
}

function launcherDiagnosticOutputEvent(options: {
  runId: string;
  launchId: string;
  stream: "stdout" | "stderr";
  text: string;
  status: "starting" | "running" | "completed" | "spawn_failed";
  timestamp: string | null;
}): DashboardStreamEvent {
  const replayMarker =
    options.status === "completed" || options.status === "spawn_failed"
      ? "final"
      : `running:${textReplayMarker(options.text)}`;
  return {
    id: [
      "launcher",
      options.launchId,
      options.stream,
      "diagnostic",
      replayMarker,
    ].join(":"),
    runId: options.runId,
    event: "launcher_output",
    timestamp: options.timestamp,
    message: `Launcher ${options.stream} output`,
    launcher: {
      launchId: options.launchId,
      stream: options.stream,
      text: truncateText(options.text, 8192),
      status: options.status,
    },
  };
}

function textReplayMarker(text: string): string {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return `${Buffer.byteLength(text, "utf8")}:${hash}`;
}

function launcherDiagnosticStatus(
  value: unknown,
): "starting" | "running" | "completed" | "spawn_failed" {
  if (
    value === "starting" ||
    value === "running" ||
    value === "completed" ||
    value === "spawn_failed"
  ) {
    return value;
  }

  return "completed";
}

async function readLaunchDiagnostics(
  filePath: string,
): Promise<LaunchDiagnosticsSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNoEntryError(error)) return null;
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function streamErrorEvent(
  runId: string,
  error: DashboardError,
  now?: () => Date,
): DashboardStreamEvent {
  return {
    id: `stream-error:${error.code}`,
    runId,
    event: "stream_error",
    timestamp: (now?.() ?? new Date()).toISOString(),
    message: error.message,
    raw: error,
  };
}

function heartbeatEvent(runId: string, now?: () => Date): DashboardStreamEvent {
  const timestamp = (now?.() ?? new Date()).toISOString();
  return {
    id: `heartbeat:${timestamp}:${randomBytes(3).toString("hex")}`,
    runId,
    event: "heartbeat",
    timestamp,
    message: "Stream heartbeat",
  };
}

function existingArtifacts(run: DashboardRunDetail): DashboardArtifactLink[] {
  return Object.values(run.artifacts)
    .flat()
    .filter((artifact) => artifact.exists);
}

function artifactSignatureMap(
  run: DashboardRunDetail | null,
): Map<string, string> {
  const result = new Map<string, string>();
  if (!run) return result;
  for (const artifact of existingArtifacts(run)) {
    result.set(artifact.id, artifactSignature(artifact));
  }
  return result;
}

function artifactSignature(artifact: DashboardArtifactLink): string {
  return [
    artifact.group,
    artifact.relativePath,
    artifact.updatedAt ?? "",
    String(artifact.sizeBytes ?? ""),
  ].join(":");
}

function durableArtifactEventId(
  prefix: "artifact" | "runner-diagnostic",
  artifact: DashboardArtifactLink,
): string {
  return [
    prefix,
    artifact.id,
    artifact.updatedAt ?? "unknown",
    String(artifact.sizeBytes ?? "unknown"),
  ].join(":");
}

function timelineKey(event: DashboardTimelineEvent): string {
  return [String(event.index), event.timestamp ?? "", event.event].join(":");
}

function changedMilestoneStatuses(
  timeline: DashboardTimelineEvent,
): Record<string, unknown> {
  if (!isRecord(timeline.raw)) return {};
  const value = timeline.raw.changedMilestoneStatuses;
  return isRecord(value) ? value : {};
}

function formatMilestoneChanges(changes: Record<string, unknown>): string {
  return Object.entries(changes)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([milestoneId, value]) => {
      if (isRecord(value)) {
        const previous = stringField(value.previous);
        const next = stringField(value.next);
        if (previous && next) return `M${milestoneId} ${previous} -> ${next}`;
        if (next) return `M${milestoneId} ${next}`;
      }
      if (typeof value === "string") return `M${milestoneId} ${value}`;
      return `M${milestoneId}`;
    })
    .join(", ");
}

function compareStreamEvents(
  left: DashboardStreamEvent,
  right: DashboardStreamEvent,
): number {
  const leftTime = Date.parse(left.timestamp ?? "");
  const rightTime = Date.parse(right.timestamp ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
    return Number.isFinite(leftTime) ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
}

function artifactGroupLabel(group: string): string {
  return group.replace(/_/g, " ");
}

function optionsEventName(runId: string): string {
  return `run:${runId}`;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNoEntryError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
