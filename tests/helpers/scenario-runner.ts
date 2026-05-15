import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
} from "../../src/runners/agent-runner.js";

export interface ScenarioFileWrite {
  path: string;
  content: string;
}

export interface ScenarioStep {
  phase: string;
  text: string;
  exitCode: number;
  metadata?: Record<string, unknown>;
  writeFiles?: ScenarioFileWrite[];
  throwError?: Error | string;
}

export interface ScenarioRequest {
  phase: string;
  prompt: string;
  artifacts: Record<string, string>;
  cwd?: string;
  milestoneId?: number;
  outputSchemaPath?: string;
}

export class ScenarioRunner implements AgentRunner {
  readonly requests: ScenarioRequest[] = [];

  constructor(
    private readonly steps: ScenarioStep[],
    readonly type = "scenario",
  ) {}

  phases(): string[] {
    return this.requests.map((request) => request.phase);
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push({
      phase: request.phase,
      prompt: request.prompt,
      artifacts: { ...(request.artifacts ?? {}) },
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.milestoneId === undefined ? {} : { milestoneId: request.milestoneId }),
      ...(request.outputSchemaPath === undefined
        ? {}
        : { outputSchemaPath: request.outputSchemaPath }),
    });

    const stepIndex = this.steps.findIndex((step) => step.phase === request.phase);
    if (stepIndex === -1) {
      return {
        text: `Unhandled phase ${request.phase}`,
        exitCode: 1,
      };
    }

    const [step] = this.steps.splice(stepIndex, 1);
    if (!step) {
      return {
        text: `Unhandled phase ${request.phase}`,
        exitCode: 1,
      };
    }

    if (step.throwError) {
      throw step.throwError instanceof Error ? step.throwError : new Error(step.throwError);
    }

    await writeScenarioFiles(request, step.writeFiles ?? []);

    return {
      text: step.text,
      exitCode: step.exitCode,
      ...(step.metadata ? { metadata: step.metadata } : {}),
    };
  }
}

async function writeScenarioFiles(
  request: AgentRunRequest,
  files: ScenarioFileWrite[],
): Promise<void> {
  if (files.length === 0) return;
  if (!request.cwd) {
    throw new Error("Scenario file writes require cwd.");
  }

  const root = path.resolve(request.cwd);
  for (const file of files) {
    const targetPath = path.resolve(root, file.path);
    if (!isInsideDirectory(root, targetPath)) {
      throw new Error(`Scenario file write escaped cwd: ${file.path}`);
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, "utf8");
  }
}

function isInsideDirectory(root: string, targetPath: string): boolean {
  return targetPath === root || targetPath.startsWith(`${root}${path.sep}`);
}
