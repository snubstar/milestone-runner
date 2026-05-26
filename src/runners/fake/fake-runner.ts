import { writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
} from "../agent-runner.js";

export class FakeRunner implements AgentRunner {
  readonly type = "fake";

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const milestoneResponse = await fakeMilestoneResponse(request);
    if (milestoneResponse) {
      return milestoneResponse;
    }

    const reviewResponse = fakeReviewResponse(request);
    if (reviewResponse) {
      return reviewResponse;
    }

    const planningResponse = fakePlanningResponse(request.phase);
    if (planningResponse) {
      return {
        text: planningResponse,
        exitCode: 0,
        metadata: {
          runner: this.type,
          phase: request.phase,
          promptLength: request.prompt.length,
          artifactCount: Object.keys(request.artifacts ?? {}).length,
        },
      };
    }

    return {
      text: `Fake runner response for phase "${request.phase}".`,
      exitCode: 0,
      metadata: {
        runner: this.type,
        promptLength: request.prompt.length,
        artifactCount: Object.keys(request.artifacts ?? {}).length,
      },
    };
  }
}

async function fakeMilestoneResponse(
  request: AgentRunRequest,
): Promise<AgentRunResult | null> {
  if (request.phase === "milestone_plan") {
    if (!isPositiveInteger(request.milestoneId)) {
      return fakeFailure(request, "Fake milestone planning requires a positive milestoneId.");
    }

    return {
      text: [
        `# Fake Milestone ${request.milestoneId} Plan`,
        "",
        "## Scope",
        "",
        `Implement only milestone ${request.milestoneId}.`,
        "",
        "## Expected Change",
        "",
        `Create fake-milestone-${request.milestoneId}-implementation.txt in the workspace root.`,
        "",
        "## Verification",
        "",
        "- Inspect the generated file.",
      ].join("\n"),
      exitCode: 0,
      metadata: milestoneMetadata(request),
    };
  }

  if (request.phase === "milestone_plan_review") {
    if (!isPositiveInteger(request.milestoneId)) {
      return fakeFailure(request, "Fake milestone plan review requires a positive milestoneId.");
    }

    return {
      text: [
        `# Fake Milestone ${request.milestoneId} Plan Review`,
        "",
        `The fake milestone plan is acceptable for milestone ${request.milestoneId}.`,
        "",
        "Recommended changes:",
        "",
        `- Keep implementation scoped to milestone ${request.milestoneId}.`,
        "- Preserve concrete verification steps.",
      ].join("\n"),
      exitCode: 0,
      metadata: milestoneMetadata(request),
    };
  }

  if (request.phase === "final_milestone_plan") {
    if (!isPositiveInteger(request.milestoneId)) {
      return fakeFailure(request, "Fake final milestone planning requires a positive milestoneId.");
    }

    return {
      text: [
        `# Fake Final Milestone ${request.milestoneId} Plan`,
        "",
        "## Scope",
        "",
        `Implement only milestone ${request.milestoneId}.`,
        "",
        "## Expected Change",
        "",
        `Create fake-milestone-${request.milestoneId}-implementation.txt in the workspace root.`,
        "",
        "## Verification",
        "",
        "- Inspect the generated file.",
      ].join("\n"),
      exitCode: 0,
      metadata: milestoneMetadata(request),
    };
  }

  if (request.phase === "implement_milestone") {
    if (!isPositiveInteger(request.milestoneId)) {
      return fakeFailure(request, "Fake milestone implementation requires a positive milestoneId.");
    }

    if (!request.cwd || request.cwd.trim().length === 0) {
      return fakeFailure(request, "Fake milestone implementation requires cwd.");
    }

    const workspaceRoot = path.resolve(request.cwd);
    const outputPath = path.resolve(
      workspaceRoot,
      `fake-milestone-${request.milestoneId}-implementation.txt`,
    );

    if (path.dirname(outputPath) !== workspaceRoot) {
      return fakeFailure(request, "Fake milestone implementation output escaped cwd.");
    }

    try {
      await writeFile(outputPath, fakeImplementationFile(request), "utf8");
    } catch (error) {
      return fakeFailure(
        request,
        `Fake milestone implementation failed to write output: ${formatError(error)}`,
      );
    }

    return {
      text: [
        `# Fake Milestone ${request.milestoneId} Implementation`,
        "",
        `Wrote ${path.basename(outputPath)} in the workspace root.`,
      ].join("\n"),
      exitCode: 0,
      metadata: {
        ...milestoneMetadata(request),
        outputPath,
      },
    };
  }

  return null;
}

function fakeReviewResponse(request: AgentRunRequest): AgentRunResult | null {
  if (request.phase === "review_milestone") {
    if (!isPositiveInteger(request.milestoneId)) {
      return fakeFailure(request, "Fake milestone review requires a positive milestoneId.");
    }

    return {
      text: JSON.stringify(
        {
          verdict: "pass",
          summary: `Fake review accepted milestone ${request.milestoneId}.`,
          findings: [],
          reviewedArtifacts: Object.values(request.artifacts ?? {}),
        },
        null,
        2,
      ),
      exitCode: 0,
      metadata: milestoneMetadata(request),
    };
  }

  if (request.phase === "fix_review_findings") {
    if (!isPositiveInteger(request.milestoneId)) {
      return fakeFailure(request, "Fake review fix requires a positive milestoneId.");
    }

    return {
      text: [
        `# Fake Milestone ${request.milestoneId} Fix`,
        "",
        "No fake fix was required for the deterministic happy path.",
      ].join("\n"),
      exitCode: 0,
      metadata: milestoneMetadata(request),
    };
  }

  return null;
}

function fakePlanningResponse(phase: string): string | null {
  if (phase === "major_plan") {
    return [
      "# Fake Major Plan",
      "",
      "## Objective",
      "",
      "Create a deterministic planning workflow for the prototype.",
      "",
      "## Milestones",
      "",
      "1. Build and validate planning artifacts.",
      "2. Prepare the first implementation milestone.",
      "",
      "## Verification",
      "",
      "- npm run test:build",
    ].join("\n");
  }

  if (phase === "major_plan_review") {
    return [
      "# Fake Major Plan Review",
      "",
      "The major plan is acceptable for the fake planning path.",
      "",
      "Required properties are present: scope, acceptance criteria, and verification.",
    ].join("\n");
  }

  if (phase === "final_major_plan") {
    return [
      "# Fake Final Major Plan",
      "",
      "## Milestone 1: Planning Workflow",
      "",
      "Create planning artifacts and validated milestone metadata.",
      "",
      "## Milestone 2: First Implementation Milestone",
      "",
      "Use the validated metadata as input to the next milestone.",
    ].join("\n");
  }

  if (phase === "final_plan_json") {
    return JSON.stringify(
      {
        milestones: [
          {
            id: 1,
            title: "Planning workflow",
            summary: "Create planning artifacts and validated milestone metadata.",
            scope: ["Write planning artifacts", "Validate milestone metadata"],
            acceptanceCriteria: [
              "Planning artifacts are written",
              "Milestone metadata validates",
            ],
            verification: ["npm run test:build"],
            dependencies: [],
            status: "pending",
          },
          {
            id: 2,
            title: "First implementation milestone",
            summary: "Use validated planning output to implement one milestone.",
            scope: ["Generate a milestone plan", "Prepare implementation inputs"],
            acceptanceCriteria: ["The first pending milestone can be identified"],
            verification: ["npm run test:build"],
            dependencies: [1],
            status: "pending",
          },
        ],
      },
      null,
      2,
    );
  }

  return null;
}

function fakeImplementationFile(request: AgentRunRequest): string {
  return [
    `Fake milestone implementation`,
    `Milestone: ${request.milestoneId}`,
    `Prompt length: ${request.prompt.length}`,
    `Artifact count: ${Object.keys(request.artifacts ?? {}).length}`,
    "",
  ].join("\n");
}

function fakeFailure(request: AgentRunRequest, message: string): AgentRunResult {
  return {
    text: message,
    exitCode: 1,
    metadata: {
      ...milestoneMetadata(request),
      error: message,
    },
  };
}

function milestoneMetadata(request: AgentRunRequest): Record<string, unknown> {
  return {
    runner: "fake",
    phase: request.phase,
    promptLength: request.prompt.length,
    artifactCount: Object.keys(request.artifacts ?? {}).length,
    ...(request.milestoneId === undefined ? {} : { milestoneId: request.milestoneId }),
    ...(request.cwd === undefined ? {} : { cwd: path.resolve(request.cwd) }),
  };
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
