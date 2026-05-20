import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildReviewEvidence,
  type ReviewEvidenceResult,
} from "../../src/review/review-evidence.js";

test("buildReviewEvidence rejects cwd outside the repository root", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-evidence-"));
  try {
    const repo = path.join(tempDir, "repo");
    const outside = path.join(tempDir, "outside");
    await mkdir(repo, { recursive: true });
    await mkdir(outside, { recursive: true });

    await assert.rejects(
      () => buildReviewEvidence({
        cwd: outside,
        gitRoot: repo,
        runDir: path.join(repo, ".agent-work", "run-1"),
        runId: "run-1",
        milestoneId: 1,
        reviewRound: { kind: "base" },
        diff: markdownDiff("Use `logs/secret`."),
      }),
      /cwd must be inside repository root/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildReviewEvidence excludes runDir and changed Markdown from authoritative matches", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-evidence-"));
  try {
    await writeRepoFile(repo, "docs/smoke.md", "Use `logs/secret`.\n");
    await writeRepoFile(repo, ".agent-work/run-1/logs/evidence.txt", "logs/secret\n");

    const result = await buildReviewEvidence({
      cwd: repo,
      gitRoot: repo,
      runDir: path.join(repo, ".agent-work", "run-1"),
      runId: "run-1",
      milestoneId: 1,
      reviewRound: { kind: "base" },
      diff: markdownDiff("Use `logs/secret`."),
    });

    const snippet = result.snippets.find((item) => item.normalized === "logs/secret");
    assert.equal(snippet?.status, "self_match_only");
    assert.deepEqual(snippet?.matches, []);
    assert.equal(
      result.warnings.some((warning) => warning.code === "self_match_only"),
      true,
    );
    assert.doesNotMatch(result.markdown, /\.agent-work\/run-1/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("buildReviewEvidence ignores packageJsonPath outside the repository root", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-evidence-"));
  try {
    const repo = path.join(tempDir, "repo");
    const outside = path.join(tempDir, "outside");
    await writeRepoFile(repo, "package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    await writeRepoFile(repo, "docs/smoke.md", "Run `npm run dashboard`.\n");
    await writeRepoFile(
      outside,
      "package.json",
      `${JSON.stringify({ scripts: { dashboard: "node outside.js" } }, null, 2)}\n`,
    );

    const result = await buildReviewEvidence({
      cwd: repo,
      gitRoot: repo,
      runDir: path.join(repo, ".agent-work", "run-1"),
      runId: "run-1",
      milestoneId: 1,
      reviewRound: { kind: "base" },
      diff: markdownDiff("Run `npm run dashboard`."),
      packageJsonPath: path.join(outside, "package.json"),
    });

    const snippet = result.snippets.find((item) => item.normalized === "npm run dashboard");
    assert.notEqual(snippet?.status, "backed");
    assert.equal(
      result.warnings.some((warning) => warning.code === "package_json_path_outside_repo"),
      true,
    );
    assert.doesNotMatch(result.markdown, /node outside\.js/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildReviewEvidence backs structured claims from authoritative sources", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-evidence-"));
  try {
    await writeValidatorRepo(repo);

    const result = await buildReviewEvidence({
      cwd: repo,
      gitRoot: repo,
      runDir: path.join(repo, ".agent-work", "run-1"),
      runId: "run-1",
      milestoneId: 1,
      reviewRound: { kind: "base" },
      diff: markdownDiff(
        "Run `npm run dashboard`, open `http://127.0.0.1:3737`, pass `--artifact-root`, inspect `dist/cli/main.js`, and check `reviews/`.",
      ),
    });

    assertStructuredBacked(result, "npm run dashboard", "package.json");
    assertStructuredBacked(result, "http://127.0.0.1:3737", "src/dashboard/server.ts");
    assertStructuredBacked(result, "--artifact-root", "src/dashboard/server.ts");
    assertStructuredBacked(result, "dist/cli/main.js", "package.json");
    assertStructuredBacked(result, "reviews/", "src/artifacts/paths.ts");
    assert.equal(
      result.warnings.some((warning) => warning.code === "snippet_unmatched"),
      false,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("buildReviewEvidence normalizes leading dot-slash path claims", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-evidence-"));
  try {
    await writeValidatorRepo(repo);

    const result = await buildReviewEvidence({
      cwd: repo,
      gitRoot: repo,
      runDir: path.join(repo, ".agent-work", "run-1"),
      runId: "run-1",
      milestoneId: 1,
      reviewRound: { kind: "base" },
      diff: markdownDiff(
        "Inspect `./reviews/` for review outputs.",
        "Inspect `./.agent-work/dashboard-launches//` for launch diagnostics.",
      ),
    });

    assertStructuredBacked(result, "reviews/", "src/artifacts/paths.ts");
    assertSnippetExtracted(result, ".agent-work/dashboard-launches/");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("buildReviewEvidence backs dashboard diagnostic artifact path claims", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-evidence-"));
  try {
    await writeValidatorRepo(repo);

    const validClaims = [
      ".agent-work/dashboard-resumes/<resume-id>.json",
      ".agent-work/dashboard-resumes/<resume-id>-diagnostics.json",
      ".agent-work/dashboard-resumes/<resume-id>.claim",
      ".agent-work/dashboard-launches/",
      ".agent-work/dashboard-launches/<launch-id>.json",
      ".agent-work/dashboard-launches/<resume-launch-id>.json",
    ];
    const result = await buildReviewEvidence({
      cwd: repo,
      gitRoot: repo,
      runDir: path.join(repo, ".agent-work", "run-1"),
      runId: "run-1",
      milestoneId: 1,
      reviewRound: { kind: "base" },
      diff: markdownDiff(
        "Inspect dashboard diagnostic artifacts:",
        ...validClaims.map((claim) => `- \`${claim}\``),
      ),
    });

    assertStructuredBacked(result, ".agent-work", "src/dashboard/server.ts");
    assertStructuredBacked(result, "dashboard-resumes/", "src/dashboard/run-resumer.ts");
    assertStructuredBacked(
      result,
      "dashboard-resumes/<resume-id>.json",
      "src/dashboard/run-resumer.ts",
    );
    assertStructuredBacked(
      result,
      "dashboard-resumes/<resume-id>-diagnostics.json",
      "src/dashboard/run-resumer.ts",
    );
    assertStructuredBacked(
      result,
      "dashboard-resumes/<resume-id>.claim",
      "src/dashboard/run-resumer.ts",
    );
    assertStructuredBacked(result, "dashboard-launches/", "src/dashboard/run-launcher.ts");
    assertStructuredBacked(
      result,
      "dashboard-launches/<launch-id>.json",
      "src/dashboard/run-launcher.ts",
    );
    assertStructuredBacked(
      result,
      "dashboard-launches/<resume-launch-id>.json",
      "src/dashboard/run-resumer.ts",
    );

    for (const claim of validClaims) {
      assertBackedOrDecomposedWithoutUnmatchedWarning(result, claim);
    }
    assert.match(
      result.markdown,
      /### `\.agent-work\/dashboard-resumes\/<resume-id>\.json`[\s\S]*- Status: decomposed[\s\S]*- Derived child claims:[\s\S]*`\.agent-work`: backed \(src\/dashboard\/server\.ts:\d+\)[\s\S]*`dashboard-resumes\/<resume-id>\.json`: backed \(src\/dashboard\/run-resumer\.ts:\d+/,
    );
    assert.match(
      result.markdown,
      /### `\.agent-work\/dashboard-launches\/<launch-id>\.json`[\s\S]*- Status: decomposed[\s\S]*`dashboard-launches\/<launch-id>\.json`: backed \(src\/dashboard\/run-launcher\.ts:\d+/,
    );
    assert.match(
      result.markdown,
      /### `\.agent-work\/dashboard-launches\/<resume-launch-id>\.json`[\s\S]*- Status: decomposed[\s\S]*`dashboard-launches\/<resume-launch-id>\.json`: backed \(src\/dashboard\/run-resumer\.ts:\d+/,
    );
    assert.match(result.markdown, /- Matches: none directly; see derived child claims\./);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("buildReviewEvidence rejects unsupported dashboard diagnostic artifact suffixes", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-evidence-"));
  try {
    await writeValidatorRepo(repo);

    const unsupportedClaims = [
      ".agent-work/dashboard-resumes/<resume-id>-audit.json",
      ".agent-work/dashboard-launches/<launch-id>-audit.json",
      ".agent-work/dashboard-launches/<unknown-id>.json",
    ];
    const result = await buildReviewEvidence({
      cwd: repo,
      gitRoot: repo,
      runDir: path.join(repo, ".agent-work", "run-1"),
      runId: "run-1",
      milestoneId: 1,
      reviewRound: { kind: "base" },
      diff: markdownDiff(
        "Reject unsupported dashboard diagnostic artifacts:",
        ...unsupportedClaims.map((claim) => `- \`${claim}\``),
      ),
    });

    for (const claim of unsupportedClaims) {
      const snippet = result.snippets.find((item) => item.normalized === claim);
      assert.ok(snippet, `Expected snippet for ${claim}`);
      assert.equal(snippet.status, "unmatched");
      assert.equal(
        result.warnings.some(
          (warning) => warning.code === "snippet_unmatched" && warning.snippet === claim,
        ),
        true,
      );
    }
    assert.equal(
      result.snippets.some(
        (item) => item.normalized === "dashboard-resumes/<resume-id>-audit.json",
      ),
      false,
    );
    assert.equal(
      result.snippets.some(
        (item) => item.normalized === "dashboard-launches/<launch-id>-audit.json",
      ),
      false,
    );
    assert.equal(
      result.snippets.some(
        (item) => item.normalized === "dashboard-launches/<unknown-id>.json",
      ),
      false,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("buildReviewEvidence decomposes shell commands when derived claims are backed", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-evidence-"));
  try {
    await writeValidatorRepo(repo);

    const command = "npm run dashboard -- --artifact-root .agent-work";
    const result = await buildReviewEvidence({
      cwd: repo,
      gitRoot: repo,
      runDir: path.join(repo, ".agent-work", "run-1"),
      runId: "run-1",
      milestoneId: 1,
      reviewRound: { kind: "base" },
      diff: markdownDiff("```bash", command, "```"),
    });

    const commandSnippet = result.snippets.find((item) => item.original === command);
    assert.equal(commandSnippet?.kind, "command");
    assert.equal(commandSnippet.status, "decomposed");
    assertStructuredBacked(result, "npm run dashboard", "package.json");
    assertStructuredBacked(result, "--artifact-root", "src/dashboard/server.ts");
    assertBacked(result, ".agent-work", "src/dashboard/server.ts");
    assert.equal(
      result.warnings.some(
        (warning) => warning.code === "snippet_unmatched" && warning.snippet === command,
      ),
      false,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("buildReviewEvidence omits machine-specific repository roots from Markdown", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-evidence-"));
  try {
    await writeValidatorRepo(repo);

    const result = await buildReviewEvidence({
      cwd: repo,
      gitRoot: repo,
      runDir: path.join(repo, ".agent-work", "run-1"),
      runId: "run-1",
      milestoneId: 1,
      reviewRound: { kind: "base" },
      diff: markdownDiff("Run `npm run dashboard`."),
    });

    assert.doesNotMatch(result.markdown, /Repository root:/);
    assert.doesNotMatch(result.markdown, new RegExp(escapeRegExp(repo)));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

async function writeRepoFile(repo: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(repo, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function writeValidatorRepo(repo: string): Promise<void> {
  await writeRepoFile(
    repo,
    "package.json",
    `${JSON.stringify(
      {
        bin: { "agent-orchestrator": "./dist/cli/main.js" },
        scripts: {
          dashboard: "npm run build && node dist/dashboard/server.js",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeRepoFile(
    repo,
    "src/dashboard/server.ts",
    [
      "const defaultOptions = {",
      '  artifactRoot: ".agent-work",',
      '  staticRoot: "dashboard/public",',
      '  host: "127.0.0.1",',
      "  port: 3737,",
      "};",
      'const options = ["--artifact-root", "--static-root", "--cli-path", "--host", "--port"];',
      "",
    ].join("\n"),
  );
  await writeRepoFile(
    repo,
    "src/artifacts/paths.ts",
    [
      "const dirs = {",
      '  reviews: "reviews",',
      '  logs: "logs",',
      "};",
      "",
    ].join("\n"),
  );
  await writeRepoFile(
    repo,
    "src/dashboard/run-launcher.ts",
    [
      'import path from "node:path";',
      "",
      "export async function launchDashboardRun(artifactRoot: string, now: Date): Promise<string> {",
      "  const launchId = createLaunchId(now);",
      '  const diagnosticsPath = path.join("dashboard-launches", `${launchId}.json`);',
      "  return path.join(artifactRoot, diagnosticsPath);",
      "}",
      "",
      "function createLaunchId(date: Date): string {",
      '  return `launch-${date.toISOString()}`;',
      "}",
      "",
    ].join("\n"),
  );
  await writeRepoFile(
    repo,
    "src/dashboard/run-resumer.ts",
    [
      'import path from "node:path";',
      "",
      "export async function dryRunDashboardResume(artifactRoot: string, now: Date): Promise<string> {",
      "  const resumeId = createResumeId(now);",
      '  const diagnosticsPath = path.join("dashboard-resumes", `${resumeId}-diagnostics.json`);',
      "  return path.join(artifactRoot, diagnosticsPath);",
      "}",
      "",
      "export async function resumeDashboardRun(artifactRoot: string, now: Date): Promise<string> {",
      "  const launchId = createResumeLaunchId(now);",
      '  const diagnosticsPath = path.join("dashboard-launches", `${launchId}.json`);',
      "  return path.join(artifactRoot, diagnosticsPath);",
      "}",
      "",
      "export function resumeDryRunRecordPath(artifactRoot: string, resumeId: string): string {",
      '  return path.join(artifactRoot, "dashboard-resumes", `${resumeId}.json`);',
      "}",
      "",
      "export function resumeDryRunClaimPath(artifactRoot: string, resumeId: string): string {",
      '  return path.join(artifactRoot, "dashboard-resumes", `${resumeId}.claim`);',
      "}",
      "",
      "function createResumeId(date: Date): string {",
      '  return `resume-${date.toISOString()}`;',
      "}",
      "",
      "function createResumeLaunchId(date: Date): string {",
      '  return `resume-launch-${date.toISOString()}`;',
      "}",
      "",
    ].join("\n"),
  );
}

function assertStructuredBacked(
  result: ReviewEvidenceResult,
  normalized: string,
  file: string,
): void {
  const snippet = assertBacked(result, normalized, file);
  assert.equal(
    snippet.matches.some((match) => match.file === file && match.source === "structured"),
    true,
  );
}

function assertBacked(
  result: ReviewEvidenceResult,
  normalized: string,
  file: string,
): NonNullable<ReviewEvidenceResult["snippets"][number]> {
  const snippet = result.snippets.find((item) => item.normalized === normalized);
  assert.ok(snippet, `Expected snippet for ${normalized}`);
  assert.equal(snippet.status, "backed");
  assert.equal(snippet.matches.some((match) => match.file === file), true);
  return snippet;
}

function assertBackedOrDecomposedWithoutUnmatchedWarning(
  result: ReviewEvidenceResult,
  normalized: string,
): NonNullable<ReviewEvidenceResult["snippets"][number]> {
  const snippet = assertSnippetExtracted(result, normalized);
  assert.notEqual(snippet.status, "self_match_only");
  assert.notEqual(snippet.status, "unmatched");
  assert.equal(
    result.warnings.some(
      (warning) => warning.code === "snippet_unmatched" && warning.snippet === snippet.original,
    ),
    false,
  );
  return snippet;
}

function assertSnippetExtracted(
  result: ReviewEvidenceResult,
  normalized: string,
): NonNullable<ReviewEvidenceResult["snippets"][number]> {
  const snippet = result.snippets.find((item) => item.normalized === normalized);
  assert.ok(snippet, `Expected snippet for ${normalized}`);
  return snippet;
}

function markdownDiff(...addedLines: string[]): string {
  return [
    "diff --git a/docs/smoke.md b/docs/smoke.md",
    "--- a/docs/smoke.md",
    "+++ b/docs/smoke.md",
    `@@ -0,0 +1,${addedLines.length} @@`,
    ...addedLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
