import assert from "node:assert/strict";
import test from "node:test";

import { createCheckTimingCollector } from "../../src/timings/check-timing-collector.js";

test("createCheckTimingCollector records structured check timing entries only", () => {
  const collector = createCheckTimingCollector();

  collector.recordCheckRun({
    stateKey: "1-fix-2",
    milestoneId: 1,
    attempt: 2,
    artifactPath: "checks/23-milestone-1-checks-after-fix-2.txt",
    result: {
      ok: false,
      report: "large report should not be copied",
      results: [
        {
          command: "npm run test:build",
          exitCode: 1,
          stdout: "large stdout should not be copied",
          stderr: "large stderr should not be copied",
          durationMs: 1234,
          error: "failed",
        },
      ],
    },
  });

  assert.deepEqual(collector.list(), [
    {
      stateKey: "1-fix-2",
      milestoneId: 1,
      attempt: 2,
      commandIndex: 1,
      command: "npm run test:build",
      durationMs: 1234,
      exitCode: 1,
      source: "structured",
      confidence: "high",
      sourceArtifact: "checks/23-milestone-1-checks-after-fix-2.txt",
    },
  ]);
});
