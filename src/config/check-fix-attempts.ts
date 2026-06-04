import type { OrchestratorConfig } from "./config-types.js";

export function effectiveMaxCheckFixAttempts(
  config: Pick<OrchestratorConfig, "maxFixAttempts" | "maxCheckFixAttempts">,
): number {
  return config.maxCheckFixAttempts ?? config.maxFixAttempts;
}
