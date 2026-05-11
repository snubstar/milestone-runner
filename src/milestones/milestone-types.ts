import type { MilestoneStatus } from "../state/state-types.js";

export interface Milestone {
  id: number;
  title: string;
  summary: string;
  scope: string[];
  acceptanceCriteria: string[];
  verification: string[];
  dependencies: number[];
  status: MilestoneStatus;
}

export interface MilestoneMetadata {
  milestones: Milestone[];
}

export type MilestoneResult<T> = { ok: true; value: T } | { ok: false; error: string };
