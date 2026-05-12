import type { RunnerType } from "../runners/runner-types.js";

export interface CliOptions {
  goal: string | null;
  configPath?: string;
  artifactRoot?: string;
  planningOnly: boolean;
  allowDirty: boolean;
  allowNonGitPlanning: boolean;
  dryRun: boolean;
  resume?: string;
  maxFixAttempts?: number;
  milestone?: number;
  runner?: RunnerType;
}

export type ParseArgsResult =
  | { ok: true; options: CliOptions }
  | { ok: false; error: string };

const runnerTypes = new Set<RunnerType>(["fake", "codex-exec"]);

export function parseArgs(argv: string[]): ParseArgsResult {
  const goalParts: string[] = [];
  const options: Omit<CliOptions, "goal"> = {
    planningOnly: false,
    allowDirty: false,
    allowNonGitPlanning: false,
    dryRun: false,
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
  if (options.resume) {
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

    return {
      ok: true,
      options: {
        ...options,
        goal: null,
      },
    };
  }

  if (!goal) {
    return { ok: false, error: "Missing goal." };
  }

  return {
    ok: true,
    options: {
      ...options,
      goal,
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

export function usage(): string {
  return [
    "Usage: agent-orchestrator [options] <goal>",
    "       agent-orchestrator --resume <run-dir-or-id> [options]",
    "",
    "Options:",
    "  --config <path>         Path to config file.",
    "  --artifact-root <path>  Override artifact root.",
    "  --planning-only         Allow planning-only operation.",
    "  --allow-dirty           Allow dirty Git working tree for implementation runs.",
    "  --allow-non-git-planning",
    "                          Allow planning-only runs outside a Git repository.",
    "  --dry-run               Validate and report the next action without writing artifacts.",
    "  --resume <value>        Resume from a run directory, state.json path, or run id.",
    "  --max-fix-attempts <n>  Override the configured max fix attempts.",
    "  --milestone <id>        Constrain execution to one milestone.",
    "  --runner <type>         Runner type: fake or codex-exec.",
  ].join("\n");
}
