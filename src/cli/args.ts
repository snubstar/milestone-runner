import type {
  MilestonePlanPolicy,
  MilestonePlanReviewPolicy,
} from "../config/config-types.js";
import type { RunnerType } from "../runners/runner-types.js";
import { isSafeRunId } from "../artifacts/paths.js";
import type { ResumeRecoveryMode } from "../orchestration/resume-recovery.js";

export interface CliOptions {
  goal: string | null;
  repoPath?: string;
  configPath?: string;
  artifactRoot?: string;
  goalFile?: string;
  seedMajorPlanFile?: string;
  contextPaths?: string[];
  planningOnly: boolean;
  allowDirty: boolean;
  allowNonGitPlanning: boolean;
  dryRun: boolean;
  json: boolean;
  resume?: string;
  resumeRecoveryMode: ResumeRecoveryMode;
  runId?: string;
  maxFixAttempts?: number;
  milestone?: number;
  runner?: RunnerType;
  milestonePlanPolicy?: MilestonePlanPolicy;
  milestonePlanReviewPolicy?: MilestonePlanReviewPolicy;
}

export type ParseArgsResult =
  | { ok: true; options: CliOptions }
  | { ok: false; error: string };

const runnerTypes = new Set<RunnerType>(["fake", "codex-exec"]);
const milestonePlanPolicies = new Set<MilestonePlanPolicy>(["always", "auto", "light"]);
const milestonePlanReviewPolicies = new Set<MilestonePlanReviewPolicy>([
  "normal",
  "scrupulous",
]);

export function parseArgs(argv: string[]): ParseArgsResult {
  const goalParts: string[] = [];
  const options: Omit<CliOptions, "goal"> = {
    planningOnly: false,
    allowDirty: false,
    allowNonGitPlanning: false,
    dryRun: false,
    json: false,
    resumeRecoveryMode: "none",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      goalParts.push(...argv.slice(index + 1));
      break;
    }

    if (arg === "--planning-only") {
      options.planningOnly = true;
      continue;
    }

    if (arg === "--allow-dirty") {
      options.allowDirty = true;
      continue;
    }

    if (arg === "--allow-non-git-planning") {
      options.allowNonGitPlanning = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--repair-failed") {
      const recovery = setResumeRecoveryMode(
        options.resumeRecoveryMode,
        "repair_failed",
      );
      if (!recovery.ok) return recovery;
      options.resumeRecoveryMode = recovery.value;
      continue;
    }

    if (arg === "--recheck") {
      const recovery = setResumeRecoveryMode(
        options.resumeRecoveryMode,
        "recheck_failed",
      );
      if (!recovery.ok) return recovery;
      options.resumeRecoveryMode = recovery.value;
      continue;
    }

    if (arg === "--retry-failed") {
      const recovery = setResumeRecoveryMode(
        options.resumeRecoveryMode,
        "retry_failed",
      );
      if (!recovery.ok) return recovery;
      options.resumeRecoveryMode = recovery.value;
      continue;
    }

    if (arg === "--run-id") {
      const value = readOptionValue(argv, index, arg);
      if (!value.ok) return value;
      if (!isSafeRunId(value.value)) {
        return {
          ok: false,
          error:
            `Invalid --run-id value "${value.value}". ` +
            'Expected a filesystem-safe id beginning with "run-".',
        };
      }
      options.runId = value.value;
      index += 1;
      continue;
    }

    if (arg === "--repo") {
      const value = readOptionValue(argv, index, arg);
      if (!value.ok) return value;
      options.repoPath = value.value;
      index += 1;
      continue;
    }

    if (arg === "--resume") {
      const value = readOptionValue(argv, index, arg);
      if (!value.ok) return value;
      options.resume = value.value;
      index += 1;
      continue;
    }

    if (arg === "--max-fix-attempts") {
      const value = readOptionValue(argv, index, arg);
      if (!value.ok) return value;
      const parsed = parseIntegerOption(
        value.value,
        arg,
        0,
        "a non-negative integer",
      );
      if (!parsed.ok) return parsed;
      options.maxFixAttempts = parsed.value;
      index += 1;
      continue;
    }

    if (arg === "--milestone") {
      const value = readOptionValue(argv, index, arg);
      if (!value.ok) return value;
      const parsed = parseIntegerOption(value.value, arg, 1, "a positive integer");
      if (!parsed.ok) return parsed;
      options.milestone = parsed.value;
      index += 1;
      continue;
    }

    if (arg === "--milestone-plan-policy") {
      const value = readOptionValue(argv, index, arg);
      if (!value.ok) return value;
      if (!milestonePlanPolicies.has(value.value as MilestonePlanPolicy)) {
        return {
          ok: false,
          error:
            `Invalid --milestone-plan-policy value "${value.value}". ` +
            'Expected "always", "auto", or "light".',
        };
      }
      options.milestonePlanPolicy = value.value as MilestonePlanPolicy;
      index += 1;
      continue;
    }

    if (arg === "--milestone-plan-review-policy") {
      const value = readOptionValue(argv, index, arg);
      if (!value.ok) return value;
      if (!milestonePlanReviewPolicies.has(value.value as MilestonePlanReviewPolicy)) {
        return {
          ok: false,
          error:
            `Invalid --milestone-plan-review-policy value "${value.value}". ` +
            'Expected "normal" or "scrupulous".',
        };
      }
      options.milestonePlanReviewPolicy = value.value as MilestonePlanReviewPolicy;
      index += 1;
      continue;
    }

    if (arg === "--goal-file") {
      const value = readOptionValue(argv, index, arg);
      if (!value.ok) return value;
      options.goalFile = value.value;
      index += 1;
      continue;
    }

    if (arg === "--seed-major-plan") {
      const value = readOptionValue(argv, index, arg);
      if (!value.ok) return value;
      options.seedMajorPlanFile = value.value;
      index += 1;
      continue;
    }

    if (arg === "--context") {
      const value = readOptionValue(argv, index, arg);
      if (!value.ok) return value;
      options.contextPaths = [...(options.contextPaths ?? []), value.value];
      index += 1;
      continue;
    }

    if (arg === "--config") {
      const value = readOptionValue(argv, index, arg);
      if (!value.ok) return value;
      options.configPath = value.value;
      index += 1;
      continue;
    }

    if (arg === "--artifact-root") {
      const value = readOptionValue(argv, index, arg);
      if (!value.ok) return value;
      options.artifactRoot = value.value;
      index += 1;
      continue;
    }

    if (arg === "--runner") {
      const value = readOptionValue(argv, index, arg);
      if (!value.ok) return value;
      if (!runnerTypes.has(value.value as RunnerType)) {
        return {
          ok: false,
          error: `Invalid --runner value "${value.value}". Expected "fake" or "codex-exec".`,
        };
      }
      options.runner = value.value as RunnerType;
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      return { ok: false, error: `Unknown option: ${arg}` };
    }

    goalParts.push(arg);
  }

  const goal = goalParts.join(" ").trim();
  if (!options.resume && options.resumeRecoveryMode !== "none") {
    return {
      ok: false,
      error:
        "--repair-failed, --recheck, and --retry-failed can only be used with --resume.",
    };
  }

  if (options.resume) {
    if (options.runId) {
      return {
        ok: false,
        error: "--run-id cannot be combined with --resume.",
      };
    }

    if (goal) {
      return {
        ok: false,
        error: "Cannot provide a goal when --resume is set. The saved state provides the goal.",
      };
    }

    if (options.configPath) {
      return {
        ok: false,
        error: "--config cannot be combined with --resume in Milestone 8.",
      };
    }

    if (options.goalFile) {
      return {
        ok: false,
        error: "--goal-file cannot be combined with --resume.",
      };
    }

    if (options.contextPaths && options.contextPaths.length > 0) {
      return {
        ok: false,
        error: "--context cannot be combined with --resume.",
      };
    }

    if (options.seedMajorPlanFile) {
      return {
        ok: false,
        error: "--seed-major-plan cannot be combined with --resume.",
      };
    }

    return {
      ok: true,
      options: {
        ...options,
        goal: null,
      },
    };
  }

  if (goal && options.goalFile) {
    return {
      ok: false,
      error: "Cannot provide both an argv goal and --goal-file.",
    };
  }

  if (!goal && !options.goalFile) {
    return { ok: false, error: "Missing goal." };
  }

  return {
    ok: true,
    options: {
      ...options,
      goal: options.goalFile ? null : goal,
    },
  };
}

function readOptionValue(
  argv: string[],
  optionIndex: number,
  optionName: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = argv[optionIndex + 1];
  if (!value || value.startsWith("--")) {
    return { ok: false, error: `Missing value for ${optionName}.` };
  }

  return { ok: true, value };
}

function parseIntegerOption(
  value: string,
  optionName: string,
  minimum: number,
  description: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (!/^\d+$/.test(value)) {
    return {
      ok: false,
      error: `Invalid ${optionName} value "${value}". Expected ${description}.`,
    };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    return {
      ok: false,
      error: `Invalid ${optionName} value "${value}". Expected ${description}.`,
    };
  }

  return { ok: true, value: parsed };
}

function setResumeRecoveryMode(
  current: ResumeRecoveryMode,
  next: ResumeRecoveryMode,
): { ok: true; value: ResumeRecoveryMode } | { ok: false; error: string } {
  if (current !== "none") {
    return {
      ok: false,
      error: "Only one recovery flag can be supplied.",
    };
  }

  return { ok: true, value: next };
}

export function usage(): string {
  return [
    "Usage: milestone-runner [options] <goal>",
    "       milestone-runner --resume <run-dir-or-id> [options]",
    "",
    "Options:",
    "  --config <path>         Path to config file.",
    "  --repo <path>           Target repository/workspace. Default: current directory.",
    "  --artifact-root <path>  Override artifact root.",
    "  --goal-file <path>      Read the initial goal from a target-repo file.",
    "  --seed-major-plan <path>",
    "                          Seed the initial major plan from a target-repo file.",
    "  --context <path>        Attach a target-repo file as initial context. Repeatable.",
    "  --planning-only         Allow planning-only operation.",
    "  --allow-dirty           Allow dirty Git working tree for implementation runs.",
    "  --allow-non-git-planning",
    "                          Allow planning-only runs outside a Git repository.",
    "  --dry-run               Validate and report the next action without writing artifacts.",
    "  --json                  Print the dry-run or final run report as JSON.",
    "  --run-id <id>           Use a specific filesystem-safe id for a new run.",
    "  --resume <value>        Resume from a run directory, state.json path, or run id.",
    "  --repair-failed         With --resume, repair a failed check milestone.",
    "  --recheck               With --resume, rerun checks after manual repair.",
    "  --retry-failed          With --resume, retry a failed milestone from its baseline.",
    "  --max-fix-attempts <n>  Override the configured max fix attempts.",
    "  --milestone <id>        Constrain execution to one milestone.",
    "  --milestone-plan-policy <policy>",
    "                          Per-milestone plan policy: always, auto, or light.",
    "  --milestone-plan-review-policy <policy>",
    "                          Per-milestone plan review policy: normal or scrupulous.",
    "  --runner <type>         Runner type: fake or codex-exec.",
  ].join("\n");
}
