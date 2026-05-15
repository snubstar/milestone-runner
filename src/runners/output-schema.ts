import { access } from "node:fs/promises";
import path from "node:path";

export type OutputSchemaResult =
  | { ok: true; path?: string }
  | { ok: false; error: string };

const phaseSchemaRelativePaths = new Map<string, string>([
  ["final_plan_json", path.join("schemas", "milestones.schema.json")],
  ["review_milestone", path.join("schemas", "review-verdict.schema.json")],
]);

export function outputSchemaRelativePathForPhase(phase: string): string | null {
  return phaseSchemaRelativePaths.get(phase) ?? null;
}

export async function resolveOutputSchemaPathForPhase(options: {
  phase: string;
  cwd: string;
}): Promise<OutputSchemaResult> {
  const relativePath = outputSchemaRelativePathForPhase(options.phase);
  if (relativePath === null) return { ok: true };

  const schemaPath = path.resolve(options.cwd, relativePath);
  try {
    await access(schemaPath);
  } catch (error) {
    return {
      ok: false,
      error: `Required output schema for phase ${options.phase} was not found at ${schemaPath}: ${formatError(error)}`,
    };
  }

  return { ok: true, path: schemaPath };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
