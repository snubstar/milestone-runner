import type { RunnerType } from "../runners/runner-types.js";

export interface CliOptions {
  goal: string;
  configPath?: string;
  artifactRoot?: string;
  planningOnly: boolean;
  allowDirty: boolean;
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

export function usage(): string {
  return [
    "Usage: agent-orchestrator [options] <goal>",
    "",
    "Options:",
    "  --config <path>         Path to config file.",
    "  --artifact-root <path>  Override artifact root.",
    "  --planning-only         Allow planning-only operation.",
    "  --allow-dirty           Allow dirty Git working tree for planning-only runs.",
    "  --runner <type>         Runner type: fake or codex-exec.",
  ].join("\n");
}
