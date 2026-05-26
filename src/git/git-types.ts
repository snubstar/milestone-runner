export interface GitMetadata {
  required: boolean;
  planningOnly: boolean;
  root: string | null;
  startSha: string | null;
  dirtyAtStart: boolean;
  dirtyOverride: boolean;
  statusPorcelain: string;
}

export type GitPreflightResult =
  | { ok: true; metadata: GitMetadata }
  | { ok: false; error: string; metadata: GitMetadata };

