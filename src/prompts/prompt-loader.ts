import { readFile } from "node:fs/promises";
import path from "node:path";

export type PromptName =
  | "major-plan"
  | "major-plan-review"
  | "final-major-plan"
  | "final-plan-json"
  | "milestone-plan"
  | "milestone-plan-review"
  | "final-milestone-plan"
  | "implement-milestone"
  | "review-milestone"
  | "repair-review-verdict"
  | "resolve-review-ambiguity"
  | "resolve-resume-state"
  | "fix-review-findings"
  | "fix-check-failures";

export interface LoadedPrompt {
  name: PromptName;
  path: string;
  text: string;
}

export type PromptResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface LoadPromptOptions {
  cwd?: string;
  promptDir?: string;
}

const promptFiles: Record<PromptName, string> = {
  "major-plan": "major-plan.md",
  "major-plan-review": "major-plan-review.md",
  "final-major-plan": "final-major-plan.md",
  "final-plan-json": "final-plan-json.md",
  "milestone-plan": "milestone-plan.md",
  "milestone-plan-review": "milestone-plan-review.md",
  "final-milestone-plan": "final-milestone-plan.md",
  "implement-milestone": "implement-milestone.md",
  "review-milestone": "review-milestone.md",
  "repair-review-verdict": "repair-review-verdict.md",
  "resolve-review-ambiguity": "resolve-review-ambiguity.md",
  "resolve-resume-state": "resolve-resume-state.md",
  "fix-review-findings": "fix-review-findings.md",
  "fix-check-failures": "fix-check-failures.md",
};

export async function loadPrompt(
  name: PromptName,
  options: LoadPromptOptions = {},
): Promise<PromptResult<LoadedPrompt>> {
  const fileName = promptFiles[name];
  if (!fileName) {
    return { ok: false, error: `Unknown prompt: ${name}` };
  }

  const promptDir = resolvePromptDir(options);
  const promptPath = path.join(promptDir, fileName);

  try {
    const text = await readFile(promptPath, "utf8");
    return {
      ok: true,
      value: {
        name,
        path: promptPath,
        text,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read prompt "${name}" at ${promptPath}: ${formatError(error)}`,
    };
  }
}

export async function loadPrompts(
  names: PromptName[],
  options: LoadPromptOptions = {},
): Promise<PromptResult<Partial<Record<PromptName, LoadedPrompt>>>> {
  const loaded: Partial<Record<PromptName, LoadedPrompt>> = {};

  for (const name of names) {
    const result = await loadPrompt(name, options);
    if (!result.ok) return result;
    loaded[name] = result.value;
  }

  return { ok: true, value: loaded };
}

export function resolvePromptDir(options: LoadPromptOptions = {}): string {
  if (options.promptDir) {
    return path.resolve(options.cwd ?? process.cwd(), options.promptDir);
  }

  return path.resolve(options.cwd ?? process.cwd(), "src", "prompts");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
