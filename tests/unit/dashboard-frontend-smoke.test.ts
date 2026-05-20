import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("static dashboard frontend has valid script syntax and DOM wiring", async () => {
  const publicRoot = path.join(process.cwd(), "dashboard", "public");
  const html = await readFile(path.join(publicRoot, "index.html"), "utf8");
  const appJs = await readFile(path.join(publicRoot, "app.js"), "utf8");
  const launchRequestJs = await readFile(
    path.join(publicRoot, "launch-request.js"),
    "utf8",
  );

  assert.equal(checkJavaScriptSyntax(path.join(publicRoot, "app.js")), "");
  assert.equal(checkJavaScriptSyntax(path.join(publicRoot, "launch-request.js")), "");
  assert.match(appJs, /from "\.\/launch-request\.js"/);
  assert.match(launchRequestJs, /export function buildLaunchRequestPayload/);

  const htmlIds = new Set(
    [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]),
  );
  const queriedIds = [
    ...appJs.matchAll(/document\.querySelector\("#([^"]+)"\)/g),
  ].map((match) => match[1]);

  assert.notEqual(queriedIds.length, 0);
  for (const id of queriedIds) {
    assert.equal(htmlIds.has(id), true, `Missing static dashboard element #${id}`);
  }

  for (const id of [
    "launchGoalSourceMode",
    "launchGoalFilePath",
    "launchContextPaths",
    "launchSeedMajorPlanPath",
    "inputsSummary",
  ]) {
    assert.equal(htmlIds.has(id), true, `Missing static dashboard element #${id}`);
  }
  assert.match(appJs, /inputs:\s*"Inputs"/);
});

test("static dashboard referenced assets exist", async () => {
  const publicRoot = path.join(process.cwd(), "dashboard", "public");
  const html = await readFile(path.join(publicRoot, "index.html"), "utf8");
  const assetPaths = [...html.matchAll(/\b(?:href|src)="\/([^"]+)"/g)].map(
    (match) => match[1],
  );

  assert.notEqual(assetPaths.length, 0);
  for (const assetPath of assetPaths) {
    const asset = await stat(path.join(publicRoot, assetPath));
    assert.equal(asset.isFile(), true, `Missing static dashboard asset ${assetPath}`);
  }
});

test("dashboard launch request helpers build prompt and goal-file payloads", async () => {
  const {
    buildLaunchSummaryFields,
    buildLaunchRequestPayload,
    goalSourceValidationState,
    parsePathLines,
  } = await importLaunchRequestHelpers();

  assert.deepEqual(parsePathLines(" README.md\n\n docs/architecture.md \r\n"), [
    "README.md",
    "docs/architecture.md",
  ]);

  assert.deepEqual(
    buildLaunchRequestPayload({
      goalSourceMode: "prompt",
      prompt: "Add feature X",
      goalFilePath: "tasks/ignored.md",
      runner: "fake",
      dryRun: true,
      allowDirty: false,
      allowNonGitPlanning: true,
      milestone: "2",
      milestonePlanPolicy: "light",
      milestonePlanReviewPolicy: "scrupulous",
      contextPathsText: " README.md\n docs/architecture.md ",
      seedMajorPlanPath: " tasks/major-plan.md ",
    }),
    {
      prompt: "Add feature X",
      runner: "fake",
      dryRun: true,
      allowDirty: false,
      allowNonGitPlanning: true,
      milestone: 2,
      milestonePlanPolicy: "light",
      milestonePlanReviewPolicy: "scrupulous",
      contextPaths: ["README.md", "docs/architecture.md"],
      seedMajorPlanPath: "tasks/major-plan.md",
    },
  );

  assert.deepEqual(
    buildLaunchRequestPayload({
      goalSourceMode: "goalFile",
      prompt: "ignored prompt",
      goalFilePath: " tasks/goal.md ",
      runner: "codex-exec",
      dryRun: false,
      allowDirty: true,
      allowNonGitPlanning: false,
      milestone: "",
      milestonePlanPolicy: "",
      milestonePlanReviewPolicy: "",
      contextPathsText: "\n",
      seedMajorPlanPath: " ",
    }),
    {
      goalFilePath: "tasks/goal.md",
      runner: "codex-exec",
      dryRun: false,
      allowDirty: true,
      allowNonGitPlanning: false,
    },
  );

  assert.deepEqual(goalSourceValidationState("prompt"), {
    promptRequired: true,
    promptDisabled: false,
    promptHidden: false,
    goalFileRequired: false,
    goalFileDisabled: true,
    goalFileHidden: true,
  });
  assert.deepEqual(goalSourceValidationState("goalFile"), {
    promptRequired: false,
    promptDisabled: true,
    promptHidden: true,
    goalFileRequired: true,
    goalFileDisabled: false,
    goalFileHidden: false,
  });

  assert.deepEqual(
    buildLaunchSummaryFields({
      dryRun: true,
      started: false,
      report: {
        allowed: true,
        nextAction: "review_seeded_major_plan",
        details: {
          targetCwd: "/tmp/target",
          artifactRoot: ".agent-work",
          goalSource: "file:tasks/goal.md",
          contextInputs: "README.md, docs/architecture.md",
          majorPlanSource: { type: "seed", path: "tasks/major-plan.md" },
          runner: "codex-exec",
          runnerProfile: "work-profile",
          runnerAccountLabel: "work-codex",
          runnerAuthentication:
            'account label "work-codex" using Codex profile "work-profile"',
        },
      },
    }),
    [
      { label: "Status", value: "allowed" },
      { label: "Next action", value: "review_seeded_major_plan" },
      { label: "Target repository", value: "/tmp/target" },
      { label: "Artifact root", value: ".agent-work" },
      { label: "Goal source", value: "file:tasks/goal.md" },
      { label: "Context inputs", value: "README.md, docs/architecture.md" },
      { label: "Major plan source", value: "seeded from tasks/major-plan.md" },
      { label: "Runner", value: "codex-exec" },
      { label: "Runner profile", value: "work-profile" },
      { label: "Runner account label", value: "work-codex" },
      {
        label: "Runner authentication",
        value: 'account label "work-codex" using Codex profile "work-profile"',
      },
    ],
  );

  assert.deepEqual(
    buildLaunchSummaryFields({
      dryRun: true,
      started: false,
      report: {
        allowed: false,
        nextAction: "blocked_dirty_tree",
        details: {
          majorPlanSource: { type: "runner", path: null },
          runner: "fake",
        },
      },
    }).slice(0, 4),
    [
      { label: "Status", value: "blocked" },
      { label: "Next action", value: "blocked_dirty_tree" },
      { label: "Major plan source", value: "runner" },
      { label: "Runner", value: "fake" },
    ],
  );
});

function checkJavaScriptSyntax(filePath: string): string {
  const result = spawnSync(process.execPath, ["--check", filePath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stderr.trim();
}

async function importLaunchRequestHelpers(): Promise<{
  buildLaunchSummaryFields: (response: Record<string, unknown>) => Array<{
    label: string;
    value: string;
  }>;
  buildLaunchRequestPayload: (input: Record<string, unknown>) => Record<string, unknown>;
  goalSourceValidationState: (mode: string) => Record<string, boolean>;
  parsePathLines: (value: string) => string[];
}> {
  return import(
    pathToFileURL(
      path.join(process.cwd(), "dashboard", "public", "launch-request.js"),
    ).href
  ) as Promise<{
    buildLaunchSummaryFields: (response: Record<string, unknown>) => Array<{
      label: string;
      value: string;
    }>;
    buildLaunchRequestPayload: (input: Record<string, unknown>) => Record<string, unknown>;
    goalSourceValidationState: (mode: string) => Record<string, boolean>;
    parsePathLines: (value: string) => string[];
  }>;
}
