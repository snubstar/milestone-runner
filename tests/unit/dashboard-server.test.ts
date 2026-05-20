import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRunPaths, type RunPaths } from "../../src/artifacts/paths.js";
import { createRunDirectory } from "../../src/artifacts/run-directory.js";
import { writeTextArtifact } from "../../src/artifacts/planning-artifacts.js";
import { startDashboardServer, type DashboardServerInstance } from "../../src/dashboard/server.js";
import { createInitialState } from "../../src/state/initial-state.js";
import { writeState } from "../../src/state/state-store.js";
import type { RunState } from "../../src/state/state-types.js";
import { appendStateTimelineEvent } from "../../src/timings/state-timeline.js";
import { defaultTestConfig } from "../helpers/run-fixture.js";

test("dashboard server lists runs and returns run detail JSON", async () => {
  const context = await createServerContext();
  try {
    await createServerRun(context.tempDir, "run-1");
    const server = await startFixtureServer(context);
    try {
      const runsResponse = await request(`${server.url}/api/runs`);
      assert.equal(runsResponse.statusCode, 200);
      const runsBody = JSON.parse(runsResponse.body) as {
        runs: Array<{ runId: string }>;
      };
      assert.equal(runsBody.runs[0]?.runId, "run-1");

      const detailResponse = await request(`${server.url}/api/runs/run-1`);
      assert.equal(detailResponse.statusCode, 200);
      const detail = JSON.parse(detailResponse.body) as {
        runId: string;
        artifacts: { diffs: Array<{ id: string; relativePath: string }> };
      };
      assert.equal(detail.runId, "run-1");
      assert.equal(detail.artifacts.diffs[0]?.relativePath, "diffs/12-milestone-1.diff");
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server reports a missing artifact root as an index warning", async () => {
  const context = await createServerContext();
  try {
    const server = await startFixtureServer(context);
    try {
      const response = await request(`${server.url}/api/runs`);

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as {
        runs: unknown[];
        warnings: Array<{ code: string; source: string }>;
      };
      assert.deepEqual(body.runs, []);
      assert.equal(body.warnings[0]?.code, "artifact_root_missing");
      assert.equal(body.warnings[0]?.source, "server");
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server rejects missing target repos before listening", async () => {
  const context = await createServerContext();
  const missingTarget = path.join(context.tempDir, "missing-target");
  try {
    await assert.rejects(
      startDashboardServer({
        cwd: context.tempDir,
        targetCwd: missingTarget,
        artifactRoot: ".agent-work",
        staticRoot: "dashboard/public",
        host: "127.0.0.1",
        port: 0,
      }),
      /target repository is unavailable/i,
    );
    await assert.rejects(stat(missingTarget));
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server serves artifacts by stable artifact id", async () => {
  const context = await createServerContext();
  try {
    await createServerRun(context.tempDir, "run-1");
    const server = await startFixtureServer(context);
    try {
      const detailResponse = await request(`${server.url}/api/runs/run-1`);
      const detail = JSON.parse(detailResponse.body) as {
        artifacts: { diffs: Array<{ id: string }> };
      };
      const artifactId = detail.artifacts.diffs[0]?.id;
      assert.equal(typeof artifactId, "string");

      const artifactResponse = await request(
        `${server.url}/api/runs/run-1/artifacts/${artifactId}`,
      );
      assert.equal(artifactResponse.statusCode, 200);
      assert.match(
        String(artifactResponse.headers["content-type"]),
        /text\/x-diff/,
      );
      assert.match(artifactResponse.body, /diff --git a\/file\.txt b\/file\.txt/);
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server rejects artifact symlinks before reading content", async () => {
  const context = await createServerContext();
  try {
    const paths = await createServerRun(context.tempDir, "run-1");
    const server = await startFixtureServer(context);
    try {
      const detailResponse = await request(`${server.url}/api/runs/run-1`);
      const detail = JSON.parse(detailResponse.body) as {
        artifacts: { diffs: Array<{ id: string; relativePath: string }> };
      };
      const artifact = detail.artifacts.diffs.find(
        (link) => link.relativePath === "diffs/12-milestone-1.diff",
      );
      assert.equal(typeof artifact?.id, "string");

      const secretPath = path.join(context.tempDir, "outside-secret.diff");
      const artifactPath = path.join(paths.dirs.diffs, "12-milestone-1.diff");
      await writeFile(secretPath, "secret outside artifact\n", "utf8");
      await rm(artifactPath);
      await symlink(secretPath, artifactPath);

      const artifactResponse = await request(
        `${server.url}/api/runs/run-1/artifacts/${artifact?.id}`,
      );
      assert.equal(artifactResponse.statusCode, 404);
      assert.doesNotMatch(artifactResponse.body, /secret outside artifact/);
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server returns 404 for unknown artifact ids", async () => {
  const context = await createServerContext();
  try {
    await createServerRun(context.tempDir, "run-1");
    const server = await startFixtureServer(context);
    try {
      const response = await request(
        `${server.url}/api/runs/run-1/artifacts/not-a-real-artifact`,
      );

      assert.equal(response.statusCode, 404);
      const body = JSON.parse(response.body) as { error: { code: string } };
      assert.equal(body.error.code, "artifact_not_found");
      assert.doesNotMatch(response.body, /\.\.\/|\/private\/|\/Users\//);
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server streams run events as server-sent events", async () => {
  const context = await createServerContext();
  try {
    await createServerRun(context.tempDir, "run-1");
    const server = await startFixtureServer(context);
    try {
      const response = await requestSseUntil(
        `${server.url}/api/runs/run-1/events`,
        "event: phase_changed",
      );

      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers["content-type"]), /text\/event-stream/);
      assert.match(response.body, /event: phase_changed/);
      assert.match(response.body, /data: .*"runId":"run-1"/);
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server rejects invalid Host headers", async () => {
  const context = await createServerContext();
  try {
    await createServerRun(context.tempDir, "run-1");
    const server = await startFixtureServer(context);
    try {
      const response = await request(`${server.url}/api/runs`, {
        Host: "example.com:1234",
      });

      assert.equal(response.statusCode, 403);
      const body = JSON.parse(response.body) as { error: { code: string } };
      assert.equal(body.error.code, "host_forbidden");
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server serves static files from the configured static root", async () => {
  const context = await createServerContext();
  try {
    await mkdir(path.join(context.tempDir, "dashboard", "public"), { recursive: true });
    await writeFile(
      path.join(context.tempDir, "dashboard", "public", "index.html"),
      "<!doctype html><title>Dashboard</title>",
      "utf8",
    );
    const server = await startFixtureServer(context);
    try {
      const response = await request(`${server.url}/`);

      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers["content-type"]), /text\/html/);
      assert.match(response.body, /Dashboard/);
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server exposes a same-origin bootstrap token", async () => {
  const context = await createServerContext();
  try {
    const server = await startFixtureServer(context);
    try {
      const response = await request(`${server.url}/api/bootstrap`);

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as { dashboardToken: string };
      assert.equal(body.dashboardToken, server.dashboardToken);
      assert.equal(typeof body.dashboardToken, "string");
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server rejects mutating requests without the dashboard token", async () => {
  const context = await createServerContext();
  try {
    const server = await startFixtureServer(context);
    try {
      const response = await postJson(`${server.url}/api/runs`, {
        prompt: "Add feature X",
        dryRun: true,
      });

      assert.equal(response.statusCode, 403);
      const body = JSON.parse(response.body) as { error: { code: string } };
      assert.equal(body.error.code, "dashboard_token_invalid");
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server rejects goal-file launches without the dashboard token", async () => {
  const context = await createServerContext();
  try {
    const server = await startFixtureServer(context);
    try {
      const response = await postJson(`${server.url}/api/runs`, {
        goalFilePath: "docs/task.md",
        dryRun: true,
      });

      assert.equal(response.statusCode, 403);
      const body = JSON.parse(response.body) as { error: { code: string } };
      assert.equal(body.error.code, "dashboard_token_invalid");
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server rejects mutating requests with an invalid dashboard token", async () => {
  const context = await createServerContext();
  try {
    const server = await startFixtureServer(context);
    try {
      const response = await postJson(
        `${server.url}/api/runs`,
        {
          prompt: "Add feature X",
          dryRun: true,
        },
        {
          "X-Dashboard-Token": "not-the-token",
        },
      );

      assert.equal(response.statusCode, 403);
      const body = JSON.parse(response.body) as { error: { code: string } };
      assert.equal(body.error.code, "dashboard_token_invalid");
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server rejects mutating requests from a different origin", async () => {
  const context = await createServerContext();
  try {
    const server = await startFixtureServer(context);
    try {
      const response = await postJson(
        `${server.url}/api/runs`,
        {
          prompt: "Add feature X",
          dryRun: true,
        },
        {
          Origin: "http://example.com",
          "Sec-Fetch-Site": "cross-site",
          "X-Dashboard-Token": server.dashboardToken,
        },
      );

      assert.equal(response.statusCode, 403);
      const body = JSON.parse(response.body) as { error: { code: string } };
      assert.equal(body.error.code, "origin_forbidden");
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server rejects mutating requests from cross-site fetch metadata", async () => {
  const context = await createServerContext();
  try {
    const server = await startFixtureServer(context);
    try {
      const response = await postJson(
        `${server.url}/api/runs`,
        {
          prompt: "Add feature X",
          dryRun: true,
        },
        {
          "Sec-Fetch-Site": "cross-site",
          "X-Dashboard-Token": server.dashboardToken,
        },
      );

      assert.equal(response.statusCode, 403);
      const body = JSON.parse(response.body) as { error: { code: string } };
      assert.equal(body.error.code, "fetch_site_forbidden");
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server launches a dry run through POST /api/runs", async () => {
  const context = await createServerContext();
  try {
    const cliPath = await writeStubCli(context.tempDir);
    const server = await startFixtureServer({ ...context, cliPath });
    try {
      const response = await postJson(
        `${server.url}/api/runs`,
        {
          prompt: "Add feature X",
          runner: "fake",
          dryRun: true,
        },
        {
          Origin: server.url,
          "Sec-Fetch-Site": "same-origin",
          "X-Dashboard-Token": server.dashboardToken,
        },
      );

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as {
        dryRun: boolean;
        started: boolean;
        runId: string;
        report: { allowed: boolean; details: { runner: string } };
      };
      assert.equal(body.dryRun, true);
      assert.equal(body.started, false);
      assert.match(body.runId, /^run-/);
      assert.equal(body.report.allowed, true);
      assert.equal(body.report.details.runner, "fake");
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server launches a goal-file dry run through POST /api/runs", async () => {
  const context = await createServerContext();
  try {
    await mkdir(path.join(context.tempDir, "docs"), { recursive: true });
    await writeFile(path.join(context.tempDir, "docs", "task.md"), "Goal from file\n", "utf8");
    const cliPath = await writeStubCli(context.tempDir);
    const server = await startFixtureServer({ ...context, cliPath });
    try {
      const response = await postJson(
        `${server.url}/api/runs`,
        {
          goalFilePath: "docs/task.md",
          runner: "fake",
          dryRun: true,
        },
        {
          Origin: server.url,
          "Sec-Fetch-Site": "same-origin",
          "X-Dashboard-Token": server.dashboardToken,
        },
      );

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as {
        dryRun: boolean;
        started: boolean;
        report: { allowed: boolean; details: { goalSource: string; runner: string } };
      };
      assert.equal(body.dryRun, true);
      assert.equal(body.started, false);
      assert.equal(body.report.allowed, true);
      assert.equal(body.report.details.goalSource, "file:docs/task.md");
      assert.equal(body.report.details.runner, "fake");

      const args = JSON.parse(
        await readFile(path.join(context.tempDir, "server-launch-args.json"), "utf8"),
      ) as string[];
      assert.equal(args.includes("--goal-file"), true);
      assert.equal(args[args.indexOf("--goal-file") + 1], "docs/task.md");
      assert.equal(args.includes("--"), false);
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server launch forwards configured target repo to child CLI", async () => {
  const context = await createServerContext();
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-target-"));
  try {
    const cliPath = await writeStubCli(context.tempDir);
    const canonicalTargetDir = await realpath(targetDir);
    const server = await startDashboardServer({
      cwd: context.tempDir,
      targetCwd: targetDir,
      artifactRoot: ".agent-work",
      staticRoot: "dashboard/public",
      host: "127.0.0.1",
      port: 0,
      cliPath,
    } as Parameters<typeof startDashboardServer>[0] & { targetCwd: string });
    try {
      const response = await postJson(
        `${server.url}/api/runs`,
        {
          prompt: "Add feature X",
          runner: "fake",
          dryRun: true,
        },
        {
          Origin: server.url,
          "Sec-Fetch-Site": "same-origin",
          "X-Dashboard-Token": server.dashboardToken,
        },
      );

      assert.equal(response.statusCode, 200);
      const args = JSON.parse(
        await readFile(path.join(context.tempDir, "server-launch-args.json"), "utf8"),
      ) as string[];
      assert.equal(args.includes("--repo"), true);
      assert.equal(args[args.indexOf("--repo") + 1], canonicalTargetDir);
    } finally {
      await server.close();
    }
  } finally {
    await rm(targetDir, { recursive: true, force: true });
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server dry-runs and starts resume through protected endpoints", async () => {
  const context = await createServerContext();
  try {
    await createServerRun(context.tempDir, "run-1");
    const cliPath = await writeResumeStubCli(context.tempDir);
    const server = await startFixtureServer({ ...context, cliPath });
    try {
      const dryRunResponse = await postJson(
        `${server.url}/api/runs/run-1/resume/dry-run`,
        {
          allowDirty: true,
          milestonePlanPolicy: "light",
        },
        {
          Origin: server.url,
          "Sec-Fetch-Site": "same-origin",
          "X-Dashboard-Token": server.dashboardToken,
        },
      );

      assert.equal(dryRunResponse.statusCode, 200);
      const dryRunBody = JSON.parse(dryRunResponse.body) as {
        resumeId: string;
        confirmationToken: string;
        allowed: boolean;
        report: { mode: string };
      };
      assert.equal(dryRunBody.allowed, true);
      assert.equal(dryRunBody.report.mode, "resume");
      assert.match(dryRunBody.resumeId, /^resume-/);
      assert.equal(typeof dryRunBody.confirmationToken, "string");

      const resumeResponse = await postJson(
        `${server.url}/api/runs/run-1/resume`,
        {
          resumeId: dryRunBody.resumeId,
          confirmationToken: dryRunBody.confirmationToken,
        },
        {
          Origin: server.url,
          "Sec-Fetch-Site": "same-origin",
          "X-Dashboard-Token": server.dashboardToken,
        },
      );

      assert.equal(resumeResponse.statusCode, 202);
      const resumeBody = JSON.parse(resumeResponse.body) as {
        runId: string;
        started: boolean;
        diagnosticsPath: string;
      };
      assert.equal(resumeBody.runId, "run-1");
      assert.equal(resumeBody.started, true);

      const resumeArgsPath = path.join(context.tempDir, "server-resume-args.json");
      await waitForFile(resumeArgsPath);
      const args = JSON.parse(await readFile(resumeArgsPath, "utf8")) as string[];
      assert.equal(args.includes("--resume"), true);
      assert.equal(args.includes("run-1"), true);
      assert.equal(args.includes("--dry-run"), false);
      await waitForDiagnostics(
        path.join(context.tempDir, ".agent-work", resumeBody.diagnosticsPath),
        (diagnostics) => diagnostics.status === "completed",
      );
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server rejects resume dry-runs without the dashboard token", async () => {
  const context = await createServerContext();
  try {
    await createServerRun(context.tempDir, "run-1");
    const server = await startFixtureServer(context);
    try {
      const response = await postJson(
        `${server.url}/api/runs/run-1/resume/dry-run`,
        { allowDirty: true },
      );

      assert.equal(response.statusCode, 403);
      const body = JSON.parse(response.body) as { error: { code: string } };
      assert.equal(body.error.code, "dashboard_token_invalid");
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

test("dashboard server rejects resume starts without the dashboard token", async () => {
  const context = await createServerContext();
  try {
    await createServerRun(context.tempDir, "run-1");
    const server = await startFixtureServer(context);
    try {
      const response = await postJson(
        `${server.url}/api/runs/run-1/resume`,
        {
          resumeId: "resume-20260510120000000-token",
          confirmationToken: "token",
        },
      );

      assert.equal(response.statusCode, 403);
      const body = JSON.parse(response.body) as { error: { code: string } };
      assert.equal(body.error.code, "dashboard_token_invalid");
    } finally {
      await server.close();
    }
  } finally {
    await rm(context.tempDir, { recursive: true, force: true });
  }
});

async function createServerContext(): Promise<{ tempDir: string }> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-orchestrator-server-"));
  return { tempDir };
}

async function startFixtureServer(context: {
  tempDir: string;
  cliPath?: string;
}): Promise<DashboardServerInstance> {
  return startDashboardServer({
    cwd: context.tempDir,
    artifactRoot: ".agent-work",
    staticRoot: "dashboard/public",
    host: "127.0.0.1",
    port: 0,
    cliPath: context.cliPath,
  });
}

async function createServerRun(cwd: string, runId: string): Promise<RunPaths> {
  const paths = buildRunPaths({
    cwd,
    artifactRoot: ".agent-work",
    runId,
  });
  await createRunDirectory(paths, "Add dashboard server");
  await writeTextArtifact(
    path.join(paths.dirs.diffs, "12-milestone-1.diff"),
    "diff --git a/file.txt b/file.txt",
  );
  const state = createInitialState({
    runId,
    goal: "Add dashboard server",
    paths,
    git: {
      required: false,
      planningOnly: true,
      root: null,
      startSha: null,
      dirtyAtStart: false,
      dirtyOverride: false,
      statusPorcelain: "",
    },
    configPath: null,
    configSnapshot: defaultTestConfig(),
    now: new Date("2026-05-10T12:00:00.000Z"),
  });
  const finalState: RunState = {
    ...state,
    currentPhase: "passed",
    status: "passed",
    currentMilestoneId: 1,
    milestoneStatuses: { "1": "passed" },
    artifacts: {
      ...state.artifacts,
      diffs: { "1": "diffs/12-milestone-1.diff" },
    },
  };
  await writeState(paths.files.state, finalState);
  await appendStateTimelineEvent({
    paths,
    previousState: null,
    nextState: finalState,
  });
  return paths;
}

function request(
  url: string,
  headers: Record<string, string> = {},
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const content = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(content.byteLength),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(content);
  });
}

function requestSseUntil(
  url: string,
  marker: string,
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = httpRequest(url, (res) => {
      const chunks: Buffer[] = [];
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(new Error(`Timed out waiting for SSE marker: ${marker}`));
      }, 1000);

      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8");
        if (body.includes(marker) && !settled) {
          settled = true;
          clearTimeout(timeout);
          req.destroy();
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        }
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.end();
  });
}

async function waitForFile(filePath: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    try {
      await stat(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.fail(`Timed out waiting for ${filePath}`);
}

async function waitForDiagnostics(
  filePath: string,
  predicate: (diagnostics: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < 3000) {
    try {
      const diagnostics = JSON.parse(
        await readFile(filePath, "utf8"),
      ) as Record<string, unknown>;
      if (predicate(diagnostics)) return diagnostics;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.fail(`Timed out waiting for diagnostics ${filePath}: ${String(lastError)}`);
}

async function writeStubCli(cwd: string): Promise<string> {
  const cliPath = path.join(cwd, "stub-cli.mjs");
  await writeFile(
    cliPath,
    [
      'import { writeFileSync } from "node:fs";',
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      'writeFileSync(path.join(process.cwd(), "server-launch-args.json"), JSON.stringify(args));',
      'const valueAfter = (flag) => args[args.indexOf(flag) + 1];',
      'const runId = valueAfter("--run-id");',
      'const artifactRoot = valueAfter("--artifact-root") ?? ".agent-work";',
      'const goalFilePath = valueAfter("--goal-file");',
      "const runDir = path.resolve(process.cwd(), artifactRoot, runId);",
      "console.log(JSON.stringify({",
      '  mode: "new",',
      "  allowed: true,",
      "  exitCode: 0,",
      '  nextAction: "run_full_goal",',
      "  runId,",
      "  runDir,",
      "  details: {",
      "    runId,",
      "    runDir,",
      "    runner: valueAfter('--runner') ?? null,",
      "    goalSource: goalFilePath === undefined ? 'argv' : `file:${goalFilePath}`",
      "  }",
      "}));",
    ].join("\n"),
    "utf8",
  );
  return cliPath;
}

async function writeResumeStubCli(cwd: string): Promise<string> {
  const cliPath = path.join(cwd, "resume-stub-cli.mjs");
  await writeFile(
    cliPath,
    [
      'import { writeFileSync } from "node:fs";',
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      'const valueAfter = (flag) => args[args.indexOf(flag) + 1];',
      'const dryRun = args.includes("--dry-run");',
      'const runId = valueAfter("--resume");',
      'const artifactRoot = valueAfter("--artifact-root") ?? ".agent-work";',
      "const runDir = path.resolve(process.cwd(), artifactRoot, runId);",
      'writeFileSync(path.join(process.cwd(), dryRun ? "server-resume-dry-run-args.json" : "server-resume-args.json"), JSON.stringify(args));',
      "console.log(JSON.stringify({",
      '  mode: "resume",',
      "  allowed: true,",
      "  exitCode: 0,",
      '  nextAction: "continue_milestone",',
      "  warnings: [],",
      "  runId,",
      "  runDir,",
      "  details: {",
      "    runId,",
      "    runDir,",
      "    milestonePlanPolicy: valueAfter('--milestone-plan-policy') ?? 'always',",
      "    savedMilestonePlanPolicy: 'always',",
      "    milestonePlanReviewPolicy: valueAfter('--milestone-plan-review-policy') ?? 'normal',",
      "    savedMilestonePlanReviewPolicy: 'normal'",
      "  }",
      "}));",
    ].join("\n"),
    "utf8",
  );
  return cliPath;
}
