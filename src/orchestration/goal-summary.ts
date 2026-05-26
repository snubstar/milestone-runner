import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildGoalArtifactPaths } from "../artifacts/goal-artifacts.js";
import { resolveRunArtifactPath, type RunPaths } from "../artifacts/paths.js";
import { writeTextArtifact } from "../artifacts/planning-artifacts.js";
import type { Milestone, MilestoneMetadata } from "../milestones/milestone-types.js";
import { parseReviewVerdictJson } from "../review/review-verdict-validator.js";
import type {
  ReviewFinding,
  ReviewVerdictDocument,
} from "../review/review-types.js";
import type {
  CommandResult,
  CommandRunner,
} from "../shell/command-runner.js";
import type { RunState } from "../state/state-types.js";

export interface GoalSummaryDiagnostic {
  message: string;
  details?: string | object | unknown[] | null;
}

export interface GoalSummaryArtifactRef {
  milestoneId: number;
  stateKey: string;
  path: string;
  attempt: number | null;
}

export interface GoalSummaryReviewRef extends GoalSummaryArtifactRef {
  verdict?: ReviewVerdictDocument;
  error?: string;
}

export interface FormatGoalSummaryOptions {
  state: RunState;
  metadata: MilestoneMetadata;
  changedFiles: string[];
  latestChecks: GoalSummaryArtifactRef[];
  latestReviews: GoalSummaryReviewRef[];
  residualRisks: string[];
}

export interface WriteGoalSummaryOptions {
  paths: RunPaths;
  state: RunState;
  metadata: MilestoneMetadata;
  cwd: string;
  commandRunner: CommandRunner;
  diagnostics?: GoalSummaryDiagnostic[];
}

export type WriteGoalSummaryResult =
  | {
      ok: true;
      file: string;
      statePath: string;
      content: string;
    }
  | {
      ok: false;
      error: string;
      details?: unknown;
    };

interface ChangedFilesResult {
  files: string[];
  residualRisk?: string;
}

export async function writeGoalSummary(
  options: WriteGoalSummaryOptions,
): Promise<WriteGoalSummaryResult> {
  const artifactPaths = buildGoalArtifactPaths(options.paths);

  try {
    const changedFiles = await captureChangedFiles({
      state: options.state,
      cwd: options.cwd,
      paths: options.paths,
      commandRunner: options.commandRunner,
    });
    const latestChecks = latestArtifactsByMilestone(
      options.state.artifacts.checks,
      options.metadata,
    );
    const latestReviews = await latestReviewArtifactsByMilestone(
      options.paths.runDir,
      options.state,
      options.metadata,
    );
    const residualRisks = buildResidualRisks({
      state: options.state,
      metadata: options.metadata,
      diagnostics: options.diagnostics ?? [],
      changedFiles,
      latestChecks,
      latestReviews,
    });

    const content = formatGoalSummary({
      state: options.state,
      metadata: options.metadata,
      changedFiles: changedFiles.files,
      latestChecks,
      latestReviews,
      residualRisks,
    });

    await writeTextArtifact(artifactPaths.files.summary, content);

    return {
      ok: true,
      file: artifactPaths.files.summary,
      statePath: artifactPaths.statePaths.summary,
      content,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to write goal summary: ${formatError(error)}`,
      details: error,
    };
  }
}

export function formatGoalSummary(options: FormatGoalSummaryOptions): string {
  const milestones = sortedMilestones(options.metadata);
  const accepted = milestones.filter(
    (milestone) => milestoneStatus(options.state, milestone) === "passed",
  );
  const failed = milestones.filter(
    (milestone) => milestoneStatus(options.state, milestone) === "failed",
  );
  const needsHumanReview = milestones.filter(
    (milestone) =>
      milestoneStatus(options.state, milestone) === "needs_human_review",
  );

  return [
    "# Goal Summary",
    "",
    `Status: ${options.state.status}`,
    `Goal: ${options.state.goal}`,
    `Current milestone: ${options.state.currentMilestoneId ?? "none"}`,
    "",
    "## Accepted Milestones",
    "",
    ...formatMilestoneList(accepted),
    "",
    "## Failed Milestones",
    "",
    ...formatMilestoneList(failed),
    "",
    "## Needs Human Review",
    "",
    ...formatMilestoneList(needsHumanReview),
    "",
    "## Changed Files",
    "",
    ...formatStringList(options.changedFiles, "No changed files captured."),
    "",
    "## Latest Checks",
    "",
    ...formatArtifactRefs(options.latestChecks, "No check artifacts recorded."),
    "",
    "## Latest Reviews",
    "",
    ...formatReviewRefs(options.latestReviews),
    "",
    "## Fix Attempts",
    "",
    ...formatFixAttempts(options.state, milestones),
    "",
    "## Residual Risks",
    "",
    ...formatStringList(options.residualRisks, "None"),
  ].join("\n");
}

async function captureChangedFiles(options: {
  state: RunState;
  cwd: string;
  paths: RunPaths;
  commandRunner: CommandRunner;
}): Promise<ChangedFilesResult> {
  const startSha = options.state.git.startSha;
  if (!startSha) {
    return {
      files: [],
      residualRisk: "Git start SHA is unavailable; changed files were not captured.",
    };
  }

  try {
    const cwd = options.state.git.root ?? options.cwd;
    const diffResult = await options.commandRunner.run({
      command: "git",
      args: ["diff", "--name-only", startSha],
      cwd,
    });

    if (diffResult.exitCode !== 0) {
      return {
        files: [],
        residualRisk: `Changed-file capture failed: ${formatCommandFailure(diffResult)}`,
      };
    }

    const untrackedResult = await options.commandRunner.run({
      command: "git",
      args: ["ls-files", "--others", "--exclude-standard"],
      cwd,
    });
    const residualRisk =
      untrackedResult.exitCode === 0
        ? undefined
        : `Untracked-file capture failed: ${formatCommandFailure(untrackedResult)}`;

    return {
      files: excludeRunDirectory(
        uniqueSorted([
          ...splitChangedFiles(diffResult.stdout),
          ...(untrackedResult.exitCode === 0
            ? splitChangedFiles(untrackedResult.stdout)
            : []),
        ]),
        cwd,
        options.paths.runDir,
      ),
      ...(residualRisk === undefined ? {} : { residualRisk }),
    };
  } catch (error) {
    return {
      files: [],
      residualRisk: `Changed-file capture failed: ${formatError(error)}`,
    };
  }
}

function splitChangedFiles(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function excludeRunDirectory(
  files: string[],
  gitRoot: string,
  runDir: string,
): string[] {
  const runDirRelative = toPosixPath(path.relative(gitRoot, runDir));
  if (
    runDirRelative.length === 0 ||
    runDirRelative.startsWith("..") ||
    path.isAbsolute(runDirRelative)
  ) {
    return files;
  }

  const prefix = `${runDirRelative.replace(/\/+$/, "")}/`;
  return files.filter(
    (file) => file !== runDirRelative && !file.startsWith(prefix),
  );
}

function latestArtifactsByMilestone(
  artifacts: Record<string, string> | undefined,
  metadata: MilestoneMetadata,
): GoalSummaryArtifactRef[] {
  return sortedMilestones(metadata)
    .map((milestone) => latestArtifactForMilestone(artifacts, milestone.id))
    .filter((artifact): artifact is GoalSummaryArtifactRef => artifact !== null);
}

async function latestReviewArtifactsByMilestone(
  runDir: string,
  state: RunState,
  metadata: MilestoneMetadata,
): Promise<GoalSummaryReviewRef[]> {
  const reviewRefs = latestArtifactsByMilestone(state.artifacts.reviews, metadata);

  return Promise.all(
    reviewRefs.map(async (reviewRef): Promise<GoalSummaryReviewRef> => {
      try {
        const resolvedPath = resolveRunArtifactPath(runDir, reviewRef.path);
        if (!resolvedPath.ok) {
          return {
            ...reviewRef,
            error: resolvedPath.error,
          };
        }

        const raw = await readFile(resolvedPath.path, "utf8");
        const verdict = parseReviewVerdictJson(raw);
        if (!verdict.ok) {
          return {
            ...reviewRef,
            error: verdict.error,
          };
        }

        return {
          ...reviewRef,
          verdict: verdict.value,
        };
      } catch (error) {
        return {
          ...reviewRef,
          error: formatError(error),
        };
      }
    }),
  );
}

function latestArtifactForMilestone(
  artifacts: Record<string, string> | undefined,
  milestoneId: number,
): GoalSummaryArtifactRef | null {
  if (!artifacts) return null;

  const baseKey = String(milestoneId);
  let selected:
    | {
        stateKey: string;
        path: string;
        attempt: number | null;
      }
    | null = artifacts[baseKey]
    ? { stateKey: baseKey, path: artifacts[baseKey], attempt: null }
    : null;

  const fixKeyPattern = new RegExp(`^${milestoneId}-fix-(\\d+)$`);
  for (const [stateKey, artifactPath] of Object.entries(artifacts)) {
    const match = fixKeyPattern.exec(stateKey);
    if (!match) continue;

    const attempt = Number(match[1]);
    if (selected?.attempt !== null && selected?.attempt !== undefined && selected.attempt >= attempt) {
      continue;
    }

    selected = {
      stateKey,
      path: artifactPath,
      attempt,
    };
  }

  if (!selected) return null;

  return {
    milestoneId,
    ...selected,
  };
}

function buildResidualRisks(options: {
  state: RunState;
  metadata: MilestoneMetadata;
  diagnostics: GoalSummaryDiagnostic[];
  changedFiles: ChangedFilesResult;
  latestChecks: GoalSummaryArtifactRef[];
  latestReviews: GoalSummaryReviewRef[];
}): string[] {
  const risks: string[] = [];

  if (options.changedFiles.residualRisk) {
    risks.push(options.changedFiles.residualRisk);
  }

  if (options.state.status !== "passed" && options.state.lastError) {
    risks.push(`Stop reason: ${options.state.lastError.message}`);
    if (options.state.lastError.details !== undefined) {
      risks.push(`Stop details: ${formatDetails(options.state.lastError.details)}`);
    }
  }

  for (const diagnostic of options.diagnostics) {
    risks.push(formatDiagnostic(diagnostic));
  }

  for (const review of options.latestReviews) {
    if (review.error) {
      risks.push(
        `Milestone ${review.milestoneId} review artifact ${review.path} could not be parsed: ${review.error}`,
      );
      continue;
    }

    const nonblockingFindings = review.verdict?.findings.filter(
      (finding) => !finding.blocking,
    ) ?? [];
    for (const finding of nonblockingFindings) {
      risks.push(formatNonblockingFinding(review.milestoneId, finding));
    }
  }

  const checkMilestoneIds = new Set(
    options.latestChecks.map((artifact) => artifact.milestoneId),
  );
  const reviewMilestoneIds = new Set(
    options.latestReviews.map((artifact) => artifact.milestoneId),
  );
  for (const milestone of sortedMilestones(options.metadata)) {
    if (milestoneStatus(options.state, milestone) !== "passed") continue;
    if (!checkMilestoneIds.has(milestone.id)) {
      risks.push(`Milestone ${milestone.id} is passed but has no check artifact recorded.`);
    }
    if (!reviewMilestoneIds.has(milestone.id)) {
      risks.push(`Milestone ${milestone.id} is passed but has no review artifact recorded.`);
    }
  }

  return risks;
}

function formatMilestoneList(milestones: Milestone[]): string[] {
  if (milestones.length === 0) return ["- None"];
  return milestones.map((milestone) => `- ${milestone.id}: ${milestone.title}`);
}

function formatStringList(values: string[], emptyText: string): string[] {
  if (values.length === 0) return [`- ${emptyText}`];
  return values.map((value) => `- ${value}`);
}

function formatArtifactRefs(
  refs: GoalSummaryArtifactRef[],
  emptyText: string,
): string[] {
  if (refs.length === 0) return [`- ${emptyText}`];

  return refs.map((ref) => {
    const suffix = ref.attempt === null ? "" : ` (after fix ${ref.attempt})`;
    return `- Milestone ${ref.milestoneId}: ${ref.path}${suffix}`;
  });
}

function formatReviewRefs(refs: GoalSummaryReviewRef[]): string[] {
  if (refs.length === 0) return ["- No review artifacts recorded."];

  return refs.map((ref) => {
    const verdict = ref.verdict ? ` (${ref.verdict.verdict})` : "";
    const error = ref.error ? ` (unreadable: ${ref.error})` : "";
    const suffix = ref.attempt === null ? "" : ` (after fix ${ref.attempt})`;
    return `- Milestone ${ref.milestoneId}: ${ref.path}${suffix}${verdict}${error}`;
  });
}

function formatFixAttempts(state: RunState, milestones: Milestone[]): string[] {
  if (milestones.length === 0) return ["- None"];

  return milestones.map(
    (milestone) =>
      `- Milestone ${milestone.id}: ${state.fixAttempts[String(milestone.id)] ?? 0}`,
  );
}

function formatDiagnostic(diagnostic: GoalSummaryDiagnostic): string {
  if (diagnostic.details === undefined) {
    return `Diagnostic: ${diagnostic.message}`;
  }

  return `Diagnostic: ${diagnostic.message} Details: ${formatDetails(diagnostic.details)}`;
}

function formatNonblockingFinding(
  milestoneId: number,
  finding: ReviewFinding,
): string {
  const location = finding.file ? ` (${finding.file})` : "";
  return `Nonblocking finding from milestone ${milestoneId}${location}: ${finding.issue}`;
}

function sortedMilestones(metadata: MilestoneMetadata): Milestone[] {
  return [...metadata.milestones].sort((left, right) => left.id - right.id);
}

function milestoneStatus(state: RunState, milestone: Milestone): string | undefined {
  return state.milestoneStatuses[String(milestone.id)];
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

function formatCommandFailure(result: CommandResult): string {
  const exitCode = result.exitCode === null ? "unknown" : String(result.exitCode);
  const detail = result.stderr.trim() || result.error || result.stdout.trim();
  return detail.length > 0
    ? `git diff --name-only exited with code ${exitCode}: ${detail}`
    : `git diff --name-only exited with code ${exitCode}`;
}

function formatDetails(value: string | object | unknown[] | null): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }

  return value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
