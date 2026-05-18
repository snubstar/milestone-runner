import type { CheckRunResult } from "../checks/check-types.js";
import type { CheckTiming } from "./timing-types.js";

export interface RecordCheckRunOptions {
  stateKey: string;
  milestoneId: number;
  attempt: number | null;
  artifactPath: string;
  result: CheckRunResult;
}

export interface CheckTimingCollector {
  recordCheckRun(options: RecordCheckRunOptions): void;
  list(): CheckTiming[];
}

export function createCheckTimingCollector(
  initialEntries: CheckTiming[] = [],
): CheckTimingCollector {
  const entries = [...initialEntries];

  return {
    recordCheckRun(options) {
      options.result.results.forEach((result, index) => {
        entries.push({
          stateKey: options.stateKey,
          milestoneId: options.milestoneId,
          attempt: options.attempt,
          commandIndex: index + 1,
          command: result.command,
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          source: "structured",
          confidence: "high",
          sourceArtifact: options.artifactPath,
        });
      });
    },
    list() {
      return [...entries];
    },
  };
}
