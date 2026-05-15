import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRunPaths, type RunPaths } from "../../src/artifacts/paths.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
} from "../../src/runners/agent-runner.js";
import { runAgentPhaseWithDiagnostics } from "../../src/runners/runner-diagnostics.js";

test("runAgentPhaseWithDiagnostics writes sanitized diagnostics for real runner success", async () => {
  const context = await createDiagnosticContext();
  try {
    const runner = new MetadataRunner();
    const result = await runAgentPhaseWithDiagnostics({
      runner,
      paths: context.paths,
      request: {
        phase: "major_plan",
        prompt: "full secret prompt",
        cwd: context.repo,
        artifacts: { goal: "00-goal.txt" },
      },
      now: sequenceClock("2026-05-10T12:00:00.000Z"),
    });

    assert.equal(result.ok, true);
    assert.equal(result.diagnosticArtifact, path.join("runner", "major_plan-01.json"));

    const raw = await readFile(
      path.join(context.paths.runDir, result.diagnosticArtifact ?? ""),
      "utf8",
    );
    assert.doesNotMatch(raw, /SECRET_VALUE/);
    assert.doesNotMatch(raw, /full secret prompt/);

    const diagnostic = JSON.parse(raw);
    assert.deepEqual(diagnostic, {
      phase: "major_plan",
      runner: "codex-exec",
      command: "codex",
      args: ["exec", "-"],
      cwd: context.repo,
      exitCode: 0,
      timedOut: false,
      sandbox: "read-only",
      approvalPolicy: "never",
      timeoutMs: 120000,
      stdout: "stdout text",
      stderr: "",
      outputLastMessageCaptured: true,
      startedAt: "2026-05-10T12:00:00.000Z",
      endedAt: "2026-05-10T12:00:01.000Z",
    });
  } finally {
    await context.cleanup();
  }
});

test("runAgentPhaseWithDiagnostics writes diagnostics when a real runner throws", async () => {
  const context = await createDiagnosticContext();
  try {
    const result = await runAgentPhaseWithDiagnostics({
      runner: new ThrowingRunner(),
      paths: context.paths,
      request: {
        phase: "implement_milestone",
        prompt: "implement secret",
        milestoneId: 3,
        cwd: context.repo,
      },
      now: sequenceClock("2026-05-10T12:00:00.000Z"),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "codex crashed");
    assert.equal(
      result.diagnosticArtifact,
      path.join("runner", "implement_milestone-01.json"),
    );

    const diagnostic = JSON.parse(
      await readFile(path.join(context.paths.runDir, result.diagnosticArtifact ?? ""), "utf8"),
    );
    assert.equal(diagnostic.phase, "implement_milestone");
    assert.equal(diagnostic.milestoneId, 3);
    assert.equal(diagnostic.runner, "codex-exec");
    assert.equal(diagnostic.cwd, context.repo);
    assert.equal(diagnostic.error, "codex crashed");
    assert.equal(diagnostic.startedAt, "2026-05-10T12:00:00.000Z");
    assert.equal(diagnostic.endedAt, "2026-05-10T12:00:01.000Z");
    assert.equal("prompt" in diagnostic, false);
  } finally {
    await context.cleanup();
  }
});

interface DiagnosticContext {
  repo: string;
  paths: RunPaths;
  cleanup: () => Promise<void>;
}

async function createDiagnosticContext(): Promise<DiagnosticContext> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-diagnostics-"));
  const paths = buildRunPaths({
    cwd: repo,
    artifactRoot: ".agent-work",
    runId: "run-1",
  });
  await createRunDirectory(paths, "Add feature X");

  return {
    repo,
    paths,
    cleanup: () => rm(repo, { recursive: true, force: true }),
  };
}

function sequenceClock(startIso: string): () => Date {
  let offset = 0;
  const start = new Date(startIso).getTime();

  return () => {
    const date = new Date(start + offset);
    offset += 1000;
    return date;
  };
}

class MetadataRunner implements AgentRunner {
  readonly type = "codex-exec";

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    return {
      text: "ok",
      exitCode: 0,
      metadata: {
        runner: "codex-exec",
        command: "codex",
        args: ["exec", "-"],
        cwd: request.cwd,
        timedOut: false,
        sandbox: "read-only",
        approvalPolicy: "never",
        timeoutMs: 120000,
        stdout: "stdout text",
        stderr: "",
        outputLastMessageCaptured: true,
        env: { SECRET: "SECRET_VALUE" },
        prompt: request.prompt,
      },
    };
  }
}

class ThrowingRunner implements AgentRunner {
  readonly type = "codex-exec";

  async run(): Promise<AgentRunResult> {
    throw new Error("codex crashed");
  }
}
