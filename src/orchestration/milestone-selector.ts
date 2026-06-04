import type { Milestone, MilestoneMetadata } from "../milestones/milestone-types.js";
import type { MilestoneStatus, RunState } from "../state/state-types.js";

export type MilestoneSelectionDecision =
  | { kind: "runnable"; milestone: Milestone }
  | { kind: "complete" }
  | { kind: "blocked"; message: string; details?: unknown }
  | { kind: "invalid_state"; message: string; details?: unknown };

export type MilestoneSelectionState = Pick<
  RunState,
  "currentMilestoneId" | "milestoneStatuses"
>;

const allowedStatuses = new Set<MilestoneStatus>([
  "pending",
  "planned",
  "ready_for_review",
  "implementing",
  "checking",
  "checks_failed",
  "repairing_checks",
  "rechecking",
  "reviewing",
  "fixing",
  "passed",
  "failed",
  "needs_human_review",
]);

const inProgressStatuses = new Set<MilestoneStatus>([
  "planned",
  "ready_for_review",
  "implementing",
  "checking",
  "repairing_checks",
  "rechecking",
  "reviewing",
  "fixing",
]);

const blockingTerminalStatuses = new Set<MilestoneStatus>([
  "checks_failed",
  "failed",
  "needs_human_review",
]);

export function selectNextRunnableMilestone(
  metadata: MilestoneMetadata,
  state: MilestoneSelectionState,
): MilestoneSelectionDecision {
  const metadataValidation = validateMetadataIds(metadata);
  if (!metadataValidation.ok) return metadataValidation.decision;

  const metadataIds = metadataValidation.ids;
  const metadataIdStrings = new Set([...metadataIds].map(String));

  if (
    state.currentMilestoneId !== null &&
    !metadataIds.has(state.currentMilestoneId)
  ) {
    return invalidState(
      `Current milestone ${state.currentMilestoneId} is not present in milestone metadata.`,
      { currentMilestoneId: state.currentMilestoneId },
    );
  }

  const stateValidation = validateStateStatuses(state, metadataIdStrings);
  if (!stateValidation.ok) return stateValidation.decision;

  const activeInProgress = activeInProgressMilestones(state);
  if (!activeInProgress.ok) return activeInProgress.decision;
  if (activeInProgress.value.length > 0) {
    const active = activeInProgress.value[0];
    return blocked(
      `Milestone ${active.id} is ${active.status} and must finish before another milestone can be selected.`,
      { activeMilestoneId: active.id, status: active.status },
    );
  }

  const blockingStatuses = metadata.milestones
    .map((milestone) => ({
      id: milestone.id,
      status: state.milestoneStatuses[String(milestone.id)],
    }))
    .filter((item): item is { id: number; status: MilestoneStatus } =>
      isMilestoneStatus(item.status) && blockingTerminalStatuses.has(item.status),
    );
  if (blockingStatuses.length > 0) {
    return blocked("A milestone is already blocked and the goal cannot advance.", {
      milestones: blockingStatuses,
    });
  }

  const pendingMilestones = metadata.milestones.filter(
    (milestone) => state.milestoneStatuses[String(milestone.id)] === "pending",
  );

  if (pendingMilestones.length === 0) {
    const incompleteMilestones = metadata.milestones
      .map((milestone) => ({
        id: milestone.id,
        status: state.milestoneStatuses[String(milestone.id)],
      }))
      .filter((item) => item.status !== "passed");

    if (incompleteMilestones.length === 0) {
      return { kind: "complete" };
    }

    return blocked("No pending milestones remain, but the goal is not complete.", {
      milestones: incompleteMilestones,
    });
  }

  const runnableMilestones = pendingMilestones
    .filter((milestone) =>
      milestone.dependencies.every(
        (dependencyId) => state.milestoneStatuses[String(dependencyId)] === "passed",
      ),
    )
    .sort((left, right) => left.id - right.id);

  const nextMilestone = runnableMilestones[0];
  if (nextMilestone) {
    return { kind: "runnable", milestone: nextMilestone };
  }

  return blocked("Pending milestones remain, but none have all dependencies passed.", {
    pendingMilestoneIds: pendingMilestones.map((milestone) => milestone.id),
    milestoneStatuses: state.milestoneStatuses,
  });
}

function validateMetadataIds(
  metadata: MilestoneMetadata,
):
  | { ok: true; ids: Set<number> }
  | { ok: false; decision: MilestoneSelectionDecision } {
  if (metadata.milestones.length === 0) {
    return {
      ok: false,
      decision: invalidState("Milestone metadata must include at least one milestone."),
    };
  }

  const ids = new Set<number>();
  const duplicateIds: number[] = [];

  for (const milestone of metadata.milestones) {
    if (ids.has(milestone.id)) {
      duplicateIds.push(milestone.id);
    }
    ids.add(milestone.id);
  }

  if (duplicateIds.length > 0) {
    return {
      ok: false,
      decision: invalidState("Milestone metadata contains duplicate ids.", {
        duplicateMilestoneIds: [...new Set(duplicateIds)].sort((left, right) => left - right),
      }),
    };
  }

  return { ok: true, ids };
}

function validateStateStatuses(
  state: MilestoneSelectionState,
  metadataIdStrings: Set<string>,
): { ok: true } | { ok: false; decision: MilestoneSelectionDecision } {
  const stateIds = Object.keys(state.milestoneStatuses);
  const unknownStateIds = stateIds
    .filter((id) => !metadataIdStrings.has(id))
    .sort(compareNumericStrings);
  if (unknownStateIds.length > 0) {
    return {
      ok: false,
      decision: invalidState("State contains milestone statuses that are missing from metadata.", {
        milestoneIds: unknownStateIds,
      }),
    };
  }

  const missingStateIds = [...metadataIdStrings]
    .filter((id) => !(id in state.milestoneStatuses))
    .sort(compareNumericStrings);
  if (missingStateIds.length > 0) {
    return {
      ok: false,
      decision: invalidState("State is missing statuses for metadata milestones.", {
        milestoneIds: missingStateIds,
      }),
    };
  }

  const invalidStatusEntries = Object.entries(state.milestoneStatuses)
    .filter(([, status]) => !isMilestoneStatus(status))
    .map(([id, status]) => ({ id, status }));
  if (invalidStatusEntries.length > 0) {
    return {
      ok: false,
      decision: invalidState("State contains invalid milestone statuses.", {
        milestones: invalidStatusEntries,
      }),
    };
  }

  return { ok: true };
}

function activeInProgressMilestones(
  state: MilestoneSelectionState,
):
  | { ok: true; value: Array<{ id: number; status: MilestoneStatus }> }
  | { ok: false; decision: MilestoneSelectionDecision } {
  const inProgress = Object.entries(state.milestoneStatuses)
    .filter(
      (entry): entry is [string, MilestoneStatus] =>
        isMilestoneStatus(entry[1]) && inProgressStatuses.has(entry[1]),
    )
    .map(([id, status]) => ({ id: Number(id), status }));

  const mismatched = inProgress.filter(
    (milestone) => milestone.id !== state.currentMilestoneId,
  );
  if (mismatched.length > 0) {
    return {
      ok: false,
      decision: invalidState(
        "State contains nonterminal milestone statuses that do not match currentMilestoneId.",
        { milestones: mismatched, currentMilestoneId: state.currentMilestoneId },
      ),
    };
  }

  return { ok: true, value: inProgress };
}

function isMilestoneStatus(value: unknown): value is MilestoneStatus {
  return typeof value === "string" && allowedStatuses.has(value as MilestoneStatus);
}

function invalidState(
  message: string,
  details?: unknown,
): MilestoneSelectionDecision {
  return {
    kind: "invalid_state",
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function blocked(message: string, details?: unknown): MilestoneSelectionDecision {
  return {
    kind: "blocked",
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function compareNumericStrings(left: string, right: string): number {
  return Number(left) - Number(right);
}
