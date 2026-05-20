import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ResourceResolution {
  orchestratorRoot: string;
  promptDir: string;
  schemaRoot: string;
}

export type ResourceResolutionResult =
  | { ok: true; value: ResourceResolution }
  | { ok: false; error: string };

export async function resolveOrchestratorResources(options: {
  moduleUrl: string;
  cwd?: string;
  resourceRoot?: string;
}): Promise<ResourceResolutionResult> {
  const moduleDir = path.dirname(fileURLToPath(options.moduleUrl));
  const candidates = options.resourceRoot
    ? [options.resourceRoot]
    : [
        path.resolve(moduleDir, "../.."),
        path.resolve(moduleDir, "../../.."),
        path.resolve(options.cwd ?? process.cwd()),
      ];

  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (await hasRequiredResources(root)) {
      return {
        ok: true,
        value: {
          orchestratorRoot: root,
          promptDir: path.join(root, "src", "prompts"),
          schemaRoot: path.join(root, "schemas"),
        },
      };
    }
  }

  return {
    ok: false,
    error:
      "Failed to resolve orchestrator resources. Expected schemas/milestones.schema.json " +
      `and src/prompts/major-plan.md under one of: ${
        candidates.map((candidate) => path.resolve(candidate)).join(", ")
      }`,
  };
}

async function hasRequiredResources(root: string): Promise<boolean> {
  try {
    await access(path.join(root, "schemas", "milestones.schema.json"));
    await access(path.join(root, "src", "prompts", "major-plan.md"));
    return true;
  } catch {
    return false;
  }
}
