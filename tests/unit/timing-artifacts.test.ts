import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildRunPaths } from "../../src/artifacts/paths.js";
import { buildTimingArtifactPaths } from "../../src/artifacts/timing-artifacts.js";

test("buildTimingArtifactPaths creates stable timing artifact paths", () => {
  const runPaths = buildRunPaths({
    cwd: "/repo",
    artifactRoot: ".agent-work",
    runId: "run-1",
  });

  const timingPaths = buildTimingArtifactPaths(runPaths);

  assert.deepEqual(timingPaths.files, {
    timeline: path.resolve("/repo", ".agent-work", "run-1", "logs", "timeline.jsonl"),
    timingsJson: path.resolve("/repo", ".agent-work", "run-1", "logs", "80-timings.json"),
    timingsMarkdown: path.resolve("/repo", ".agent-work", "run-1", "logs", "81-timings.md"),
  });
  assert.deepEqual(timingPaths.statePaths, {
    timeline: path.join("logs", "timeline.jsonl"),
    timingsJson: path.join("logs", "80-timings.json"),
    timingsMarkdown: path.join("logs", "81-timings.md"),
  });
});
