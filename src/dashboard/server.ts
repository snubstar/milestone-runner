#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstat, open, readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeArtifactRoot } from "../artifacts/artifact-root.js";
import {
  resolveDashboardTargetCwd,
  validateDashboardArtifactRootForRead,
} from "./dashboard-safety.js";
import type {
  DashboardErrorResponse,
  DashboardRunsResponse,
  DashboardStreamEvent,
  DashboardWarning,
} from "./api-types.js";
import { startDashboardRunEventStream } from "./event-stream.js";
import { launchDashboardRun } from "./run-launcher.js";
import {
  dryRunDashboardResume,
  resumeDashboardRun,
} from "./run-resumer.js";
import {
  findDashboardArtifact,
  listDashboardRuns,
  readDashboardRun,
} from "./run-reader.js";

export interface DashboardServerOptions {
  cwd: string;
  targetCwd: string;
  artifactRoot: string;
  staticRoot: string;
  host: string;
  port: number;
  cliPath?: string;
  dashboardToken: string;
}

export interface DashboardServerInstance {
  server: Server;
  url: string;
  dashboardToken: string;
  close(): Promise<void>;
}

interface DashboardRequestContext extends DashboardServerOptions {
  expectedPort(): number;
}

const defaultOptions: DashboardServerOptions = {
  cwd: process.cwd(),
  targetCwd: process.cwd(),
  artifactRoot: ".agent-work",
  staticRoot: "dashboard/public",
  host: "127.0.0.1",
  port: 3737,
  dashboardToken: "",
};

export async function startDashboardServer(
  options: Partial<DashboardServerOptions> = {},
): Promise<DashboardServerInstance> {
  const baseOptions = resolveServerOptions(options);
  const targetResult = await resolveDashboardTargetCwd({
    cwd: baseOptions.cwd,
    targetCwd: baseOptions.targetCwd,
  });
  if (!targetResult.ok) throw new Error(targetResult.error);
  const artifactRootSafety = await validateDashboardArtifactRootForRead({
    targetCwd: targetResult.value,
    artifactRoot: baseOptions.artifactRoot,
  });
  if (!artifactRootSafety.ok) {
    throw new Error(`Invalid artifactRoot: ${artifactRootSafety.error}`);
  }
  const resolved = {
    ...baseOptions,
    targetCwd: targetResult.value,
    artifactRoot: artifactRootSafety.value,
  };
  let actualPort = resolved.port;
  const server = createServer((request, response) => {
    void handleDashboardRequest(request, response, {
      ...resolved,
      expectedPort: () => actualPort,
    });
  });

  await listen(server, resolved.port, resolved.host);
  const address = server.address();
  if (typeof address === "object" && address !== null) {
    actualPort = address.port;
  }

  return {
    server,
    url: `http://${hostForUrl(resolved.host)}:${actualPort}`,
    dashboardToken: resolved.dashboardToken,
    close: () => closeServer(server),
  };
}

export function resolveServerOptions(
  options: Partial<DashboardServerOptions> = {},
): DashboardServerOptions {
  const cwd = options.cwd ?? defaultOptions.cwd;
  const artifactRootResult = normalizeArtifactRoot(
    options.artifactRoot ?? defaultOptions.artifactRoot,
  );
  if (!artifactRootResult.ok) {
    throw new Error(`Invalid artifactRoot: ${artifactRootResult.error}`);
  }

  return {
    cwd,
    targetCwd: options.targetCwd === undefined
      ? path.resolve(cwd)
      : path.resolve(cwd, options.targetCwd),
    artifactRoot: artifactRootResult.value,
    staticRoot: options.staticRoot ?? defaultOptions.staticRoot,
    host: options.host ?? defaultOptions.host,
    port: options.port ?? defaultOptions.port,
    cliPath: options.cliPath,
    dashboardToken: options.dashboardToken || createDashboardToken(),
  };
}

async function handleDashboardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: DashboardRequestContext,
): Promise<void> {
  try {
    if (!hostIsAllowed(request.headers.host, context.host, context.expectedPort())) {
      sendJson(response, 403, {
        error: {
          code: "host_forbidden",
          message: "Request Host header is not allowed.",
        },
      });
      return;
    }

    const requestUrl = parseRequestUrl(request, context);
    if (!requestUrl) {
      sendJson(response, 400, {
        error: {
          code: "bad_request",
          message: "Request URL is invalid.",
        },
      });
      return;
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApiRequest(request, response, context, requestUrl);
      return;
    }

    await handleStaticRequest(request, response, context, requestUrl);
  } catch (error) {
    sendJson(response, 500, {
      error: {
        code: "server_error",
        message: "Dashboard server failed to handle the request.",
        details: formatError(error),
      },
    });
  }
}

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: DashboardRequestContext,
  requestUrl: URL,
): Promise<void> {
  if (isMutatingMethod(request.method)) {
    const security = validateMutatingRequest(request, context);
    if (!security.ok) {
      sendJson(response, 403, { error: security.error });
      return;
    }
  }

  if (request.method === "GET") {
    await handleGetApiRequest(request, response, context, requestUrl);
    return;
  }

  if (request.method === "POST") {
    await handlePostApiRequest(request, response, context, requestUrl);
    return;
  }

  sendJson(response, 405, {
    error: {
      code: "method_not_allowed",
      message: "HTTP method is not supported by dashboard endpoints.",
    },
  });
}

async function handleGetApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: DashboardRequestContext,
  requestUrl: URL,
): Promise<void> {
  const segments = pathSegments(requestUrl.pathname);
  if (
    segments.length === 2 &&
    segments[0] === "api" &&
    segments[1] === "bootstrap"
  ) {
    sendJson(response, 200, { dashboardToken: context.dashboardToken });
    return;
  }

  if (segments.length === 2 && segments[0] === "api" && segments[1] === "runs") {
    sendJson(response, 200, await readRunsIndex(context));
    return;
  }

  if (
    segments.length === 3 &&
    segments[0] === "api" &&
    segments[1] === "runs"
  ) {
    const runId = segments[2] ?? "";
    const result = await readDashboardRun({
      cwd: context.targetCwd,
      artifactRoot: context.artifactRoot,
      runId,
    });
    if (!result.ok) {
      sendJson(response, errorStatus(result.error.code), { error: result.error });
      return;
    }

    sendJson(response, 200, result.run);
    return;
  }

  if (
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "runs" &&
    segments[3] === "events"
  ) {
    await handleRunEventsRequest(request, response, context, segments[2] ?? "");
    return;
  }

  if (
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "runs" &&
    segments[3] === "artifacts"
  ) {
    await handleArtifactRequest(response, context, segments[2] ?? "", segments[4] ?? "");
    return;
  }

  sendJson(response, 404, {
    error: {
      code: "not_found",
      message: "Dashboard API endpoint not found.",
    },
  });
}

async function handlePostApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: DashboardRequestContext,
  requestUrl: URL,
): Promise<void> {
  const segments = pathSegments(requestUrl.pathname);
  if (segments.length === 2 && segments[0] === "api" && segments[1] === "runs") {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, {
        error: {
          code: "bad_request",
          message: body.error,
        },
      });
      return;
    }

    const result = await launchDashboardRun(body.value, {
      cwd: context.cwd,
      targetCwd: context.targetCwd,
      artifactRoot: context.artifactRoot,
      cliPath: context.cliPath,
    });
    if (!result.ok) {
      sendJson(response, result.statusCode, { error: result.error });
      return;
    }

    sendJson(response, result.statusCode, result.response);
    return;
  }

  if (
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "runs" &&
    segments[3] === "resume" &&
    segments[4] === "dry-run"
  ) {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, {
        error: {
          code: "bad_request",
          message: body.error,
        },
      });
      return;
    }

    const result = await dryRunDashboardResume(segments[2] ?? "", body.value, {
      cwd: context.cwd,
      targetCwd: context.targetCwd,
      artifactRoot: context.artifactRoot,
      cliPath: context.cliPath,
    });
    if (!result.ok) {
      sendJson(response, result.statusCode, { error: result.error });
      return;
    }

    sendJson(response, result.statusCode, result.response);
    return;
  }

  if (
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "runs" &&
    segments[3] === "resume"
  ) {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, 400, {
        error: {
          code: "bad_request",
          message: body.error,
        },
      });
      return;
    }

    const result = await resumeDashboardRun(segments[2] ?? "", body.value, {
      cwd: context.cwd,
      targetCwd: context.targetCwd,
      artifactRoot: context.artifactRoot,
      cliPath: context.cliPath,
    });
    if (!result.ok) {
      sendJson(response, result.statusCode, { error: result.error });
      return;
    }

    sendJson(response, result.statusCode, result.response);
    return;
  }

  sendJson(response, 404, {
    error: {
      code: "not_found",
      message: "Dashboard API endpoint not found.",
    },
  });
}

async function readRunsIndex(
  context: DashboardRequestContext,
): Promise<DashboardRunsResponse> {
  const artifactRoot = path.resolve(context.targetCwd, context.artifactRoot);
  const warnings: DashboardWarning[] = [];

  try {
    const artifactRootStat = await stat(artifactRoot);
    if (!artifactRootStat.isDirectory()) {
      warnings.push({
        code: "artifact_root_not_directory",
        message: `Configured artifact root is not a directory: ${context.artifactRoot}.`,
        source: "server",
        details: { artifactRoot },
      });
      return { runs: [], warnings };
    }
  } catch (error) {
    if (isNoEntryError(error)) {
      warnings.push({
        code: "artifact_root_missing",
        message: `Configured artifact root was not found: ${context.artifactRoot}.`,
        source: "server",
        details: { artifactRoot },
      });
      return { runs: [], warnings };
    }
    throw error;
  }

  const runs = await listDashboardRuns({
    cwd: context.targetCwd,
    artifactRoot: context.artifactRoot,
  });
  return { runs, warnings };
}

async function handleArtifactRequest(
  response: ServerResponse,
  context: DashboardRequestContext,
  runId: string,
  artifactId: string,
): Promise<void> {
  const result = await readDashboardRun({
    cwd: context.targetCwd,
    artifactRoot: context.artifactRoot,
    runId,
  });
  if (!result.ok) {
    sendJson(response, errorStatus(result.error.code), { error: result.error });
    return;
  }

  const artifact = findDashboardArtifact(result.run, artifactId);
  if (!artifact) {
    sendJson(response, 404, {
      error: {
        code: "artifact_not_found",
        message: "Artifact was not found for this run.",
      },
    });
    return;
  }

  if (!artifact.exists) {
    sendJson(response, 404, {
      error: {
        code: "artifact_missing",
        message: "Artifact is known but missing on disk.",
      },
    });
    return;
  }

  const artifactPath = path.resolve(result.run.runDir, artifact.relativePath);
  if (!pathIsInside(result.run.runDir, artifactPath)) {
    sendJson(response, 404, {
      error: {
        code: "artifact_not_found",
        message: "Artifact was not found for this run.",
      },
    });
    return;
  }

  try {
    const artifactStat = await lstat(artifactPath);
    if (!artifactStat.isFile()) {
      sendJson(response, 404, {
        error: {
          code: "artifact_not_found",
          message: "Artifact was not found for this run.",
        },
      });
      return;
    }

    const handle = await open(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) {
        sendJson(response, 404, {
          error: {
            code: "artifact_not_found",
            message: "Artifact was not found for this run.",
          },
        });
        return;
      }

      const content = await handle.readFile();
      response.writeHead(200, {
        "content-type": artifact.mediaType,
        "content-length": String(content.byteLength),
        "cache-control": "no-store",
      });
      response.end(content);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isNoEntryError(error)) {
      sendJson(response, 404, {
        error: {
          code: "artifact_missing",
          message: "Artifact is known but missing on disk.",
        },
      });
      return;
    }
    if (isSymbolicLinkReadError(error)) {
      sendJson(response, 404, {
        error: {
          code: "artifact_not_found",
          message: "Artifact was not found for this run.",
        },
      });
      return;
    }
    throw error;
  }
}

async function handleRunEventsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: DashboardRequestContext,
  runId: string,
): Promise<void> {
  const bufferedEvents: DashboardStreamEvent[] = [];
  let streamStarted = false;

  const result = await startDashboardRunEventStream(
    {
      cwd: context.targetCwd,
      artifactRoot: context.artifactRoot,
      runId,
    },
    {
      send(event) {
        if (streamStarted) {
          sendSseEvent(response, event);
          return;
        }
        bufferedEvents.push(event);
      },
    },
  );

  if (!result.ok) {
    sendJson(response, errorStatus(result.error.code), { error: result.error });
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(": connected\n\n");
  streamStarted = true;

  for (const event of bufferedEvents) {
    sendSseEvent(response, event);
  }

  const close = () => {
    result.close();
  };
  request.on("close", close);
  response.on("close", close);
}

async function handleStaticRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: DashboardRequestContext,
  requestUrl: URL,
): Promise<void> {
  if (request.method !== "GET") {
    sendPlain(response, 405, "Method not allowed.\n");
    return;
  }

  const staticRoot = path.resolve(context.cwd, context.staticRoot);
  const relativePath = requestUrl.pathname === "/" ? "index.html" : decodePathname(requestUrl.pathname);
  if (!relativePath || relativePath.split(/[\\/]+/).some((segment) => segment === "..")) {
    sendPlain(response, 404, "Not found.\n");
    return;
  }

  const filePath = path.resolve(staticRoot, relativePath);
  if (!pathIsInside(staticRoot, filePath)) {
    sendPlain(response, 404, "Not found.\n");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      sendPlain(response, 404, "Not found.\n");
      return;
    }

    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": staticMediaType(filePath),
      "content-length": String(content.byteLength),
      "cache-control": "no-store",
    });
    response.end(content);
  } catch (error) {
    if (isNoEntryError(error)) {
      sendPlain(response, 404, "Not found.\n");
      return;
    }
    throw error;
  }
}

function validateMutatingRequest(
  request: IncomingMessage,
  context: DashboardRequestContext,
): { ok: true } | { ok: false; error: DashboardErrorResponse["error"] } {
  const expectedOrigin = `http://${request.headers.host ?? ""}`;
  const origin = headerValue(request.headers.origin);
  if (origin !== undefined && origin !== expectedOrigin) {
    return {
      ok: false,
      error: {
        code: "origin_forbidden",
        message: "Request Origin header is not allowed.",
      },
    };
  }

  const fetchSite = headerValue(request.headers["sec-fetch-site"]);
  if (
    fetchSite !== undefined &&
    fetchSite !== "same-origin" &&
    fetchSite !== "none"
  ) {
    return {
      ok: false,
      error: {
        code: "fetch_site_forbidden",
        message: "Request Sec-Fetch-Site header is not allowed.",
      },
    };
  }

  const token = headerValue(request.headers["x-dashboard-token"]);
  if (token !== context.dashboardToken) {
    return {
      ok: false,
      error: {
        code: "dashboard_token_invalid",
        message: "Dashboard operator token is missing or invalid.",
      },
    };
  }

  return { ok: true };
}

function isMutatingMethod(method: string | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readJsonBody(
  request: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 64 * 1024) {
        resolve({ ok: false, error: "Request body is too large." });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", (error) => {
      resolve({ ok: false, error: formatError(error) });
    });
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ ok: true, value: raw.length === 0 ? {} : JSON.parse(raw) });
      } catch (error) {
        resolve({ ok: false, error: `Invalid JSON request body: ${formatError(error)}` });
      }
    });
  });
}

function parseArgs(argv: string[]): DashboardServerOptions | { help: true } {
  const options: Partial<DashboardServerOptions> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };

    if (arg === "--port") {
      const value = readArgValue(argv, index, arg);
      options.port = parsePort(value, arg);
      index += 1;
      continue;
    }

    if (arg === "--host") {
      options.host = readArgValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--artifact-root") {
      options.artifactRoot = readArgValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--repo") {
      options.targetCwd = readArgValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--static-root") {
      options.staticRoot = readArgValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--cli-path") {
      options.cliPath = readArgValue(argv, index, arg);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return resolveServerOptions(options);
}

function usage(): string {
  return [
    "Usage: dashboard-server [options]",
    "",
    "Options:",
    "  --port <port>           Port to listen on. Default: 3737.",
    "  --host <host>           Host to bind. Default: 127.0.0.1.",
    "  --repo <path>           Target repository/workspace. Default: current directory.",
    "  --artifact-root <path>  Artifact root to read. Default: .agent-work.",
    "  --static-root <path>    Static asset root. Default: dashboard/public.",
    "  --cli-path <path>       Built CLI entrypoint. Default: dist/cli/main.js.",
  ].join("\n");
}

function readArgValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${optionName}.`);
  }
  return value;
}

function parsePort(value: string, optionName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${optionName} value "${value}". Expected a port number.`);
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid ${optionName} value "${value}". Expected 0-65535.`);
  }

  return port;
}

function parseRequestUrl(request: IncomingMessage, context: DashboardRequestContext): URL | null {
  if (!request.url) return null;

  try {
    return new URL(request.url, `http://${hostForUrl(context.host)}:${context.expectedPort()}`);
  } catch {
    return null;
  }
}

function pathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

function decodePathname(pathname: string): string | null {
  try {
    return pathSegments(pathname).join("/");
  } catch {
    return null;
  }
}

export function hostIsAllowed(
  hostHeader: string | undefined,
  configuredHost: string,
  expectedPort: number,
): boolean {
  if (!hostHeader) return false;

  let parsed: URL;
  try {
    parsed = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }

  const requestHost = normalizeHostName(parsed.hostname);
  const configured = normalizeHostName(configuredHost);
  const port = parsed.port || "80";
  if (port !== String(expectedPort)) return false;

  if (configured === "0.0.0.0" || configured === "::") {
    return requestHost === "localhost" || isIP(requestHost) !== 0;
  }

  const allowedHosts = isLoopbackHost(configured)
    ? new Set(["127.0.0.1", "::1", "localhost"])
    : new Set([configured]);

  return allowedHosts.has(requestHost);
}

function normalizeHostName(host: string): string {
  const normalized = host.trim().toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function pathIsInside(root: string, filePath: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function hostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function createDashboardToken(): string {
  return randomBytes(24).toString("base64url");
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: DashboardErrorResponse | object,
): void {
  const content = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(content.byteLength),
    "cache-control": "no-store",
  });
  response.end(content);
}

function sendSseEvent(response: ServerResponse, event: DashboardStreamEvent): void {
  response.write(`id: ${sseField(event.id)}\n`);
  response.write(`event: ${sseField(event.event)}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sseField(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

function sendPlain(response: ServerResponse, statusCode: number, body: string): void {
  const content = Buffer.from(body, "utf8");
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(content.byteLength),
    "cache-control": "no-store",
  });
  response.end(content);
}

function errorStatus(code: string): number {
  switch (code) {
    case "invalid_run_id":
      return 400;
    case "state_missing":
    case "state_malformed":
      return 404;
    default:
      return 500;
  }
}

function staticMediaType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function isNoEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isSymbolicLinkReadError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ELOOP"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let options: DashboardServerOptions | { help: true };
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(formatError(error));
    console.error(usage());
    process.exitCode = 1;
    options = { help: true };
  }

  if ("help" in options) {
    if (process.exitCode !== 1) {
      console.log(usage());
    }
  } else {
    void startDashboardServer(options)
      .then((instance) => {
        console.log(`Dashboard server listening at ${instance.url}`);
      })
      .catch((error: unknown) => {
        console.error(formatError(error));
        process.exitCode = 1;
      });
  }
}
