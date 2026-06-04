import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildGoalArtifactPaths } from "../artifacts/goal-artifacts.js";
import { resolveRunArtifactPath, type RunPaths } from "../artifacts/paths.js";
import { writeTextArtifact } from "../artifacts/planning-artifacts.js";
import {
  parseCheckFailureSummaryArtifact,
  type CheckFailureSummaryArtifact,
} from "../checks/check-failure-summary.js";
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

type GoalSummaryArtifactSource = "base" | "fix" | "repair" | "recheck";

export interface GoalSummaryArtifactRef {
  milestoneId: number;
  stateKey: string;
  path: string;
  attempt: number | null;
  artifactSource?: GoalSummaryArtifactSource;
}

export interface GoalSummaryReviewRef extends GoalSummaryArtifactRef {
  verdict?: ReviewVerdictDocument;
  error?: string;
}

export interface GoalSummaryCheckFailureRef extends GoalSummaryArtifactRef {
  source: "failed" | "repair" | "recheck";
  summary?: CheckFailureSummaryArtifact;
  error?: string;
}

export interface GoalSummaryAutonomousDecisionRef {
  kind:
    | "review_repair"
    | "review_resolution"
    | "resume_resolution"
    | "unknown";
  path: string;
  milestoneId: number | null;
  attempt: number | null;
  status: string | null;
  action?: string;
  sourceCondition?: string;
  summary?: string;
  rationale?: string;
  assumptions: string[];
  error?: string;
}

export interface FormatGoalSummaryOptions {
  state: RunState;
  metadata: MilestoneMetadata;
  changedFiles: string[];
  latestChecks: GoalSummaryArtifactRef[];
  latestCheckFailures: GoalSummaryCheckFailureRef[];
  latestReviews: GoalSummaryReviewRef[];
  autonomousDecisions: GoalSummaryAutonomousDecisionRef[];
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
      ["fix", "repair", "recheck"],
    );
    const latestCheckFailures = await latestCheckFailureArtifactsByMilestone(
      options.paths.runDir,
      options.state,
      options.metadata,
    );
    const latestReviews = await latestReviewArtifactsByMilestone(
      options.paths.runDir,
      options.state,
      options.metadata,
    );
    const autonomousDecisions = await readAutonomousDecisionArtifacts(
      options.paths.runDir,
      options.state,
    );
    const residualRisks = buildResidualRisks({
      state: options.state,
      metadata: options.metadata,
      diagnostics: options.diagnostics ?? [],
      changedFiles,
      latestChecks,
      latestCheckFailures,
      latestReviews,
      autonomousDecisions,
    });

    const content = formatGoalSummary({
      state: options.state,
      metadata: options.metadata,
      changedFiles: changedFiles.files,
      latestChecks,
      latestCheckFailures,
      latestReviews,
      autonomousDecisions,
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
    "## Latest Check Failures",
    "",
    ...formatCheckFailureRefs(options.latestCheckFailures),
    "",
    "## Latest Reviews",
    "",
    ...formatReviewRefs(options.latestReviews),
    "",
    "## Autonomous Decisions",
    "",
    ...formatAutonomousDecisionRefs(options.autonomousDecisions),
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
  attemptSources: GoalSummaryArtifactSource[] = ["fix"],
): GoalSummaryArtifactRef[] {
  return sortedMilestones(metadata)
    .map((milestone) =>
      latestArtifactForMilestone(artifacts, milestone.id, attemptSources),
    )
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

async function latestCheckFailureArtifactsByMilestone(
  runDir: string,
  state: RunState,
  metadata: MilestoneMetadata,
): Promise<GoalSummaryCheckFailureRef[]> {
  const checkFailureRefs = sortedMilestones(metadata)
    .map((milestone) =>
      latestCheckFailureArtifactForMilestone(
        state,
        milestone.id,
      ),
    )
    .filter((artifact): artifact is GoalSummaryCheckFailureRef => artifact !== null);

  return Promise.all(
    checkFailureRefs.map(async (ref): Promise<GoalSummaryCheckFailureRef> => {
      try {
        const resolvedPath = resolveRunArtifactPath(runDir, ref.path);
        if (!resolvedPath.ok) {
          return {
            ...ref,
            error: resolvedPath.error,
          };
        }

        const raw = await readFile(resolvedPath.path, "utf8");
        const parsedJson = safeJsonParse(raw);
        if (!parsedJson.ok) {
          return {
            ...ref,
            error: parsedJson.error,
          };
        }

        const parsedSummary = parseCheckFailureSummaryArtifact(parsedJson.value);
        if (!parsedSummary.ok) {
          return {
            ...ref,
            error: parsedSummary.error,
          };
        }

        return {
          ...ref,
          summary: parsedSummary.value,
        };
      } catch (error) {
        return {
          ...ref,
          error: formatError(error),
        };
      }
    }),
  );
}

function latestArtifactForMilestone(
  artifacts: Record<string, string> | undefined,
  milestoneId: number,
  attemptSources: GoalSummaryArtifactSource[],
): GoalSummaryArtifactRef | null {
  if (!artifacts) return null;

  const baseKey = String(milestoneId);
  const basePath = artifacts[baseKey];
  const attemptSourcePattern = attemptSources
    .filter((source) => source !== "base")
    .join("|");
  const attemptKeyPattern = new RegExp(
    `^${milestoneId}-(${attemptSourcePattern})-(\\d+)$`,
  );
  const baseAttempt = basePath
    ? artifactAttemptMatchingPath(artifacts, attemptKeyPattern, basePath)
    : null;

  if (basePath && baseAttempt) {
    return {
      milestoneId,
      stateKey: baseKey,
      path: basePath,
      attempt: baseAttempt.attempt,
      artifactSource: baseAttempt.artifactSource,
    };
  }

  let selected:
    | {
        stateKey: string;
        path: string;
        attempt: number | null;
        artifactSource: GoalSummaryArtifactSource;
      }
    | null = basePath
    ? {
        stateKey: baseKey,
        path: basePath,
        attempt: null,
        artifactSource: "base",
      }
    : null;

  for (const [stateKey, artifactPath] of Object.entries(artifacts)) {
    const match = attemptKeyPattern.exec(stateKey);
    if (!match) continue;

    const artifactSource = match[1] as GoalSummaryArtifactSource;
    const attempt = Number(match[2]);
    if (
      selected !== null &&
      compareArtifactRefOrder({ artifactSource, attempt }, selected) <= 0
    ) {
      continue;
    }

    selected = {
      stateKey,
      path: artifactPath,
      attempt,
      artifactSource,
    };
  }

  if (!selected) return null;

  return {
    milestoneId,
    ...selected,
  };
}

function artifactAttemptMatchingPath(
  artifacts: Record<string, string>,
  attemptKeyPattern: RegExp,
  artifactPath: string,
): { artifactSource: GoalSummaryArtifactSource; attempt: number } | null {
  let selected: { artifactSource: GoalSummaryArtifactSource; attempt: number } | null = null;

  for (const [stateKey, candidatePath] of Object.entries(artifacts)) {
    if (candidatePath !== artifactPath) continue;

    const match = attemptKeyPattern.exec(stateKey);
    if (!match) continue;

    const artifactSource = match[1] as GoalSummaryArtifactSource;
    const attempt = Number(match[2]);
    if (!Number.isInteger(attempt) || attempt < 1) continue;

    if (
      selected !== null &&
      compareArtifactRefOrder({ artifactSource, attempt }, selected) <= 0
    ) {
      continue;
    }

    selected = { artifactSource, attempt };
  }

  return selected;
}

function latestCheckFailureArtifactForMilestone(
  state: RunState,
  milestoneId: number,
): GoalSummaryCheckFailureRef | null {
  const artifacts = state.artifacts.checkFailures;
  if (!artifacts) return null;

  const lastErrorSelection = checkFailureArtifactFromLastError(state, milestoneId, artifacts);
  if (lastErrorSelection) {
    return {
      milestoneId,
      ...lastErrorSelection,
    };
  }

  let selected:
    | {
        stateKey: string;
        path: string;
        attempt: number;
        source: "failed" | "repair" | "recheck";
      }
    | null = null;

  const keyPattern = new RegExp(`^${milestoneId}-(failed|repair|recheck)-(\\d+)$`);
  for (const [stateKey, artifactPath] of Object.entries(artifacts)) {
    const match = keyPattern.exec(stateKey);
    if (!match) continue;

    const source = match[1] as "failed" | "repair" | "recheck";
    const attempt = Number(match[2]);
    if (
      selected &&
      compareCheckFailureOrder(
        { source, attempt },
        { source: selected.source, attempt: selected.attempt },
      ) <= 0
    ) {
      continue;
    }

    selected = {
      stateKey,
      path: artifactPath,
      attempt,
      source,
    };
  }

  if (!selected) return null;

  return {
    milestoneId,
    stateKey: selected.stateKey,
    path: selected.path,
    attempt: selected.attempt,
    source: selected.source,
  };
}

function checkFailureArtifactFromLastError(
  state: RunState,
  milestoneId: number,
  artifacts: Record<string, string>,
): Omit<GoalSummaryCheckFailureRef, "milestoneId"> | null {
  const statePath = lastErrorCheckFailurePath(state);
  if (!statePath) return null;

  for (const [stateKey, artifactPath] of Object.entries(artifacts)) {
    if (artifactPath !== statePath) continue;

    const parsed = parseCheckFailureArtifactKey(milestoneId, stateKey);
    if (!parsed) continue;

    return {
      stateKey,
      path: artifactPath,
      attempt: parsed.attempt,
      source: parsed.source,
    };
  }

  return null;
}

function lastErrorCheckFailurePath(state: RunState): string | null {
  const details = state.lastError?.details;
  if (!isRecord(details)) return null;

  if (typeof details.checkFailureSummary === "string") {
    return details.checkFailureSummary;
  }

  if (typeof details.latestCheckFailureSummary === "string") {
    return details.latestCheckFailureSummary;
  }

  return null;
}

function parseCheckFailureArtifactKey(
  milestoneId: number,
  stateKey: string,
): { source: "failed" | "repair" | "recheck"; attempt: number } | null {
  const match = new RegExp(`^${milestoneId}-(failed|repair|recheck)-(\\d+)$`).exec(stateKey);
  if (!match) return null;

  const attempt = Number(match[2]);
  if (!Number.isInteger(attempt) || attempt < 1) return null;

  return {
    source: match[1] as "failed" | "repair" | "recheck",
    attempt,
  };
}

function compareCheckFailureOrder(
  left: { source: "failed" | "repair" | "recheck"; attempt: number },
  right: { source: "failed" | "repair" | "recheck"; attempt: number },
): number {
  const sourceRank = {
    failed: 0,
    repair: 1,
    recheck: 2,
  };
  const leftRank = sourceRank[left.source];
  const rightRank = sourceRank[right.source];
  if (leftRank !== rightRank) return leftRank - rightRank;
  return left.attempt - right.attempt;
}

function buildResidualRisks(options: {
  state: RunState;
  metadata: MilestoneMetadata;
  diagnostics: GoalSummaryDiagnostic[];
  changedFiles: ChangedFilesResult;
  latestChecks: GoalSummaryArtifactRef[];
  latestReviews: GoalSummaryReviewRef[];
  autonomousDecisions: GoalSummaryAutonomousDecisionRef[];
  latestCheckFailures: GoalSummaryCheckFailureRef[];
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

  if (options.state.status !== "passed") {
    for (const checkFailure of options.latestCheckFailures) {
      if (!checkFailure.error) continue;
      risks.push(
        `Milestone ${checkFailure.milestoneId} check-failure artifact ${checkFailure.path} could not be parsed: ${checkFailure.error}`,
      );
    }

    for (const decision of options.autonomousDecisions) {
      if (decision.error === undefined && decision.status !== "unresolved") continue;
      const subject = formatAutonomousDecisionSubject(decision);
      const reason = decision.error ?? "unresolved";
      risks.push(`${subject} at ${decision.path} did not resolve: ${reason}`);
    }
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
    const suffix = artifactRefSuffix(ref);
    return `- Milestone ${ref.milestoneId}: ${ref.path}${suffix}`;
  });
}

function formatReviewRefs(refs: GoalSummaryReviewRef[]): string[] {
  if (refs.length === 0) return ["- No review artifacts recorded."];

  return refs.map((ref) => {
    const verdict = ref.verdict ? ` (${ref.verdict.verdict})` : "";
    const error = ref.error ? ` (unreadable: ${ref.error})` : "";
    const suffix = artifactRefSuffix(ref);
    return `- Milestone ${ref.milestoneId}: ${ref.path}${suffix}${verdict}${error}`;
  });
}

function artifactRefSuffix(ref: GoalSummaryArtifactRef): string {
  if (ref.attempt === null) return "";

  switch (ref.artifactSource ?? "fix") {
    case "fix":
      return ` (after fix ${ref.attempt})`;
    case "repair":
      return ` (after check repair ${ref.attempt})`;
    case "recheck":
      return ` (manual recheck ${ref.attempt})`;
    case "base":
      return "";
  }
}

function compareArtifactRefOrder(
  left: {
    artifactSource: GoalSummaryArtifactSource;
    attempt: number | null;
  },
  right: {
    artifactSource: GoalSummaryArtifactSource;
    attempt: number | null;
  },
): number {
  const sourceRank = {
    base: 0,
    fix: 1,
    repair: 2,
    recheck: 3,
  };
  const sourceDelta =
    sourceRank[left.artifactSource] - sourceRank[right.artifactSource];
  if (sourceDelta !== 0) return sourceDelta;

  return (left.attempt ?? 0) - (right.attempt ?? 0);
}

function formatCheckFailureRefs(refs: GoalSummaryCheckFailureRef[]): string[] {
  if (refs.length === 0) return ["- No check-failure summaries recorded."];

  return refs.map((ref) => {
    const summary = ref.summary;
    const source = formatCheckFailureSource(ref.source, ref.attempt);
    const unreadable = ref.error ? ` (unreadable: ${ref.error})` : "";
    if (!summary) {
      return `- Milestone ${ref.milestoneId}: ${ref.path} (${source})${unreadable}`;
    }

    const firstFailedCheck = summary.failedChecks[0];
    const command = firstFailedCheck ? `; command: ${firstFailedCheck.command}` : "";
    const tests =
      firstFailedCheck && firstFailedCheck.failingNodeTestNames.length > 0
        ? `; tests: ${firstFailedCheck.failingNodeTestNames.join("; ")}`
        : "";
    const errors =
      firstFailedCheck && firstFailedCheck.assertionMessages.length > 0
        ? `; errors: ${firstFailedCheck.assertionMessages.join("; ")}`
        : "";

    return [
      `- Milestone ${ref.milestoneId}: ${ref.path}`,
      `(${source}; failed ${summary.failedCheckCount}/${summary.totalCheckCount}`,
      `; full report: ${summary.fullCheckReportArtifactPath}${command}${tests}${errors})`,
      unreadable,
    ].join("");
  });
}

function formatCheckFailureSource(
  source: GoalSummaryCheckFailureRef["source"],
  attempt: number | null,
): string {
  const attemptLabel = attempt === null ? "unknown attempt" : `attempt ${attempt}`;
  switch (source) {
    case "failed":
      return `initial failed checks ${attemptLabel}`;
    case "repair":
      return `check repair ${attemptLabel}`;
    case "recheck":
      return `manual recheck ${attemptLabel}`;
  }
}

async function readAutonomousDecisionArtifacts(
  runDir: string,
  state: RunState,
): Promise<GoalSummaryAutonomousDecisionRef[]> {
  const refs: Array<{ key: string; path: string }> = [];
  for (const [key, artifactPath] of Object.entries(state.artifacts.reviews ?? {})) {
    if (isAutonomousReviewArtifact(key, artifactPath)) {
      refs.push({ key, path: artifactPath });
    }
  }
  for (const [key, artifactPath] of Object.entries(state.artifacts.logs ?? {})) {
    if (isResumeResolutionArtifact(key, artifactPath)) {
      refs.push({ key, path: artifactPath });
    }
  }

  const decisions = await Promise.all(
    refs.map((ref) => readAutonomousDecisionArtifact(runDir, ref)),
  );
  return decisions.sort(compareAutonomousDecisionRefs);
}

async function readAutonomousDecisionArtifact(
  runDir: string,
  ref: { key: string; path: string },
): Promise<GoalSummaryAutonomousDecisionRef> {
  const fallback = autonomousDecisionFallback(ref.key, ref.path);
  const resolvedPath = resolveRunArtifactPath(runDir, ref.path);
  if (!resolvedPath.ok) {
    return {
      ...fallback,
      error: resolvedPath.error,
    };
  }

  try {
    const raw = await readFile(resolvedPath.path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return autonomousDecisionFromDiagnostic(ref.key, ref.path, parsed);
  } catch (error) {
    return {
      ...fallback,
      error: formatError(error),
    };
  }
}

function autonomousDecisionFromDiagnostic(
  key: string,
  artifactPath: string,
  value: unknown,
): GoalSummaryAutonomousDecisionRef {
  const fallback = autonomousDecisionFallback(key, artifactPath);
  if (!isRecord(value)) {
    return {
      ...fallback,
      error: "Autonomous decision artifact is not a JSON object.",
    };
  }

  const kind = kindFromPhase(stringField(value.phase)) ?? fallback.kind;
  const status = stringField(value.status);
  const attempt = numberField(value.attempt) ?? fallback.attempt;
  const resolution = recordField(value.resolution);

  if (kind === "review_resolution") {
    const resolutionMetadata = recordField(resolution?.resolution);
    return {
      kind,
      path: artifactPath,
      milestoneId: fallback.milestoneId,
      attempt,
      status,
      sourceCondition:
        stringField(value.sourceCondition) ??
        stringField(resolutionMetadata?.sourceCondition) ??
        undefined,
      summary: stringField(resolutionMetadata?.summary) ?? undefined,
      rationale: stringField(resolutionMetadata?.rationale) ?? undefined,
      assumptions: stringListField(resolutionMetadata?.assumptions),
      error: stringField(value.resolutionError) ?? undefined,
    };
  }

  if (kind === "resume_resolution") {
    return {
      kind,
      path: artifactPath,
      milestoneId:
        numberField(resolution?.currentMilestoneId) ??
        numberField(recordField(value.originalDecision)?.currentMilestoneId) ??
        fallback.milestoneId,
      attempt,
      status,
      action: stringField(resolution?.action) ?? undefined,
      summary: stringField(resolution?.summary) ?? undefined,
      rationale: stringField(resolution?.rationale) ?? undefined,
      assumptions: stringListField(resolution?.assumptions),
      error: stringField(value.resolutionError) ?? undefined,
    };
  }

  if (kind === "review_repair") {
    return {
      kind,
      path: artifactPath,
      milestoneId: fallback.milestoneId,
      attempt,
      status,
      summary: stringField(recordField(value.repairedVerdict)?.summary) ?? undefined,
      assumptions: [],
      error: stringField(value.repairError) ?? undefined,
    };
  }

  return {
    ...fallback,
    status,
    error: stringField(value.error) ?? undefined,
  };
}

function autonomousDecisionFallback(
  key: string,
  artifactPath: string,
): GoalSummaryAutonomousDecisionRef {
  return {
    kind: kindFromArtifact(key, artifactPath),
    path: artifactPath,
    milestoneId: milestoneIdFromAutonomousArtifact(key, artifactPath),
    attempt: attemptFromAutonomousArtifact(key, artifactPath),
    status: null,
    assumptions: [],
  };
}

function isAutonomousReviewArtifact(key: string, artifactPath: string): boolean {
  return (
    /(?:^|-)repair-\d+$/.test(key) ||
    /(?:^|-)resolution-\d+$/.test(key) ||
    /review-repair-\d+\.json$/.test(artifactPath) ||
    /autonomous-resolution-\d+\.json$/.test(artifactPath)
  );
}

function isResumeResolutionArtifact(key: string, artifactPath: string): boolean {
  return (
    /^resume-resolution-\d+$/.test(key) ||
    /resolve-resume-state-\d+\.json$/.test(artifactPath)
  );
}

function kindFromPhase(
  phase: string | null,
): GoalSummaryAutonomousDecisionRef["kind"] | null {
  if (phase === "repair_review_verdict") return "review_repair";
  if (phase === "resolve_review_ambiguity") return "review_resolution";
  if (phase === "resolve_resume_state") return "resume_resolution";
  return null;
}

function kindFromArtifact(
  key: string,
  artifactPath: string,
): GoalSummaryAutonomousDecisionRef["kind"] {
  if (isResumeResolutionArtifact(key, artifactPath)) return "resume_resolution";
  if (/(?:^|-)repair-\d+$/.test(key) || /review-repair-\d+\.json$/.test(artifactPath)) {
    return "review_repair";
  }
  if (
    /(?:^|-)resolution-\d+$/.test(key) ||
    /autonomous-resolution-\d+\.json$/.test(artifactPath)
  ) {
    return "review_resolution";
  }
  return "unknown";
}

function milestoneIdFromAutonomousArtifact(
  key: string,
  artifactPath: string,
): number | null {
  const keyMatch = key.match(/^(\d+)(?:$|-)/);
  const pathMatch = artifactPath.match(/milestone-(\d+)/);
  const value = keyMatch?.[1] ?? pathMatch?.[1];
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function attemptFromAutonomousArtifact(
  key: string,
  artifactPath: string,
): number | null {
  const keyMatch = key.match(/(?:repair|resolution)-(\d+)$/);
  const pathMatch = artifactPath.match(
    /(?:repair|resolution|resolve-resume-state)-(\d+)\.json$/,
  );
  const value = keyMatch?.[1] ?? pathMatch?.[1];
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function compareAutonomousDecisionRefs(
  left: GoalSummaryAutonomousDecisionRef,
  right: GoalSummaryAutonomousDecisionRef,
): number {
  const milestoneCompare =
    (left.milestoneId ?? Number.MAX_SAFE_INTEGER) -
    (right.milestoneId ?? Number.MAX_SAFE_INTEGER);
  if (milestoneCompare !== 0) return milestoneCompare;

  const kindCompare = kindSortValue(left.kind) - kindSortValue(right.kind);
  if (kindCompare !== 0) return kindCompare;

  const attemptCompare =
    (left.attempt ?? Number.MAX_SAFE_INTEGER) -
    (right.attempt ?? Number.MAX_SAFE_INTEGER);
  if (attemptCompare !== 0) return attemptCompare;

  return left.path.localeCompare(right.path);
}

function kindSortValue(kind: GoalSummaryAutonomousDecisionRef["kind"]): number {
  switch (kind) {
    case "review_repair":
      return 1;
    case "review_resolution":
      return 2;
    case "resume_resolution":
      return 3;
    case "unknown":
      return 4;
  }
}

function formatAutonomousDecisionRefs(
  refs: GoalSummaryAutonomousDecisionRef[],
): string[] {
  if (refs.length === 0) {
    return ["- No autonomous repair or resolution artifacts recorded."];
  }

  return refs.map((ref) => {
    const parts = [
      `${formatAutonomousDecisionSubject(ref)}: ${ref.status ?? "unknown"}`,
      `artifact ${ref.path}`,
    ];
    if (ref.action) parts.push(`action ${ref.action}`);
    if (ref.sourceCondition) parts.push(`source ${ref.sourceCondition}`);
    if (ref.summary) parts.push(`summary ${ref.summary}`);
    if (ref.assumptions.length > 0) {
      parts.push(`assumptions ${ref.assumptions.join("; ")}`);
    }
    if (ref.error) parts.push(`error ${ref.error}`);
    return `- ${parts.join("; ")}`;
  });
}

function formatAutonomousDecisionSubject(
  ref: GoalSummaryAutonomousDecisionRef,
): string {
  const milestone = ref.milestoneId === null ? "" : ` for milestone ${ref.milestoneId}`;
  const attempt = ref.attempt === null ? "" : ` attempt ${ref.attempt}`;
  switch (ref.kind) {
    case "review_repair":
      return `Review repair${attempt}${milestone}`;
    case "review_resolution":
      return `Review resolution${attempt}${milestone}`;
    case "resume_resolution":
      return `Resume resolution${attempt}${milestone}`;
    case "unknown":
      return `Autonomous decision${attempt}${milestone}`;
  }
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

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordField(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringListField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function safeJsonParse(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${formatError(error)}` };
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
