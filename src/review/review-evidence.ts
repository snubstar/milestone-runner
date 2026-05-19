import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface BuildReviewEvidenceOptions {
  cwd: string;
  gitRoot: string | null;
  runDir: string;
  runId: string;
  milestoneId: number;
  reviewRound:
    | { kind: "base" }
    | { kind: "fix"; attempt: number };
  diff: string;
  packageJsonPath?: string;
  maxSnippetMatches?: number;
  maxExcerptLines?: number;
  maxSnippets?: number;
  maxFileBytes?: number;
}

export interface ReviewEvidenceResult {
  markdown: string;
  warnings: ReviewEvidenceWarning[];
  snippets: ReviewEvidenceSnippet[];
}

export interface ReviewEvidenceSnippet {
  original: string;
  normalized: string;
  kind: "command" | "path" | "url" | "package-script" | "flag";
  originFiles: string[];
  status: "backed" | "unmatched" | "self_match_only" | "decomposed";
  matches: ReviewEvidenceMatch[];
  derivedFrom?: string;
}

export interface ReviewEvidenceMatch {
  file: string;
  line: number;
  excerpt: string;
  source: "structured" | "exact";
}

export interface ReviewEvidenceWarning {
  code: string;
  message: string;
  snippet?: string;
  file?: string;
}

interface AddedMarkdownLine {
  file: string;
  text: string;
}

interface DiffClaims {
  changedFiles: string[];
  addedMarkdownLines: AddedMarkdownLine[];
}

interface SearchFile {
  absolutePath: string;
  relativePath: string;
  content: string;
}

interface EvidenceLimits {
  maxSnippetMatches: number;
  maxExcerptLines: number;
  maxSnippets: number;
  maxFileBytes: number;
}

interface StructuredValidationResult {
  matches: ReviewEvidenceMatch[];
  warnings: ReviewEvidenceWarning[];
}

interface EvidenceContext {
  repoRoot: string;
  runDir: string;
  packageJsonPath?: string;
  limits: EvidenceLimits;
}

const defaultLimits: EvidenceLimits = {
  maxSnippetMatches: 3,
  maxExcerptLines: 3,
  maxSnippets: 80,
  maxFileBytes: 256_000,
};

const generatedDirectoryNames = new Set([
  ".agent-work",
  ".cache",
  ".git",
  "build",
  "cache",
  "coverage",
  "dist",
  "dist-test",
  "node_modules",
]);

const textFileExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".jsonc",
  ".log",
  ".md",
  ".mjs",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);

const dashboardFlags = new Set([
  "--artifact-root",
  "--cli-path",
  "--host",
  "--port",
  "--static-root",
]);

const artifactDirectories = new Set([
  "checks/",
  "diffs/",
  "fixes/",
  "logs/",
  "milestones/",
  "plans/",
  "reviews/",
  "runner/",
]);

export async function buildReviewEvidence(
  options: BuildReviewEvidenceOptions,
): Promise<ReviewEvidenceResult> {
  const warnings: ReviewEvidenceWarning[] = [];
  const context = resolveEvidenceContext(options, warnings);
  const claims = parseDiffClaims(options.diff);
  const changedMarkdownFiles = new Set(
    claims.changedFiles.filter(isMarkdownPath).map(normalizeRelativePath),
  );
  const snippets = extractReviewEvidenceSnippets(claims.addedMarkdownLines, warnings);
  const cappedSnippets = capSnippets(snippets, context.limits, warnings);
  const searchFiles = await readSearchFiles({
    repoRoot: context.repoRoot,
    runDir: context.runDir,
    changedMarkdownFiles,
    limits: context.limits,
    warnings,
  });
  const changedMarkdownSearchFiles = await readChangedMarkdownFiles({
    repoRoot: context.repoRoot,
    changedMarkdownFiles,
    limits: context.limits,
  });

  for (const snippet of cappedSnippets) {
    const structured = await validateStructuredSnippet({
      snippet,
      repoRoot: context.repoRoot,
      packageJsonPath: context.packageJsonPath,
      limits: context.limits,
    });
    warnings.push(...structured.warnings);

    const exactMatches =
      structured.matches.length > 0
        ? []
        : findExactMatches(searchFiles, snippet, context.limits, warnings);
    snippet.matches = [...structured.matches, ...exactMatches];

    if (snippet.matches.length > 0) {
      snippet.status = "backed";
      continue;
    }

    const selfMatches = findExactMatches(
      changedMarkdownSearchFiles,
      snippet,
      context.limits,
      warnings,
      { suppressLimitWarnings: true },
    );
    if (selfMatches.length > 0) {
      snippet.status = "self_match_only";
    } else {
      snippet.status = "unmatched";
    }
  }

  markDecomposedCommandSnippets(cappedSnippets);
  appendSnippetStatusWarnings(cappedSnippets, warnings);

  return {
    markdown: formatReviewEvidenceMarkdown({
      options,
      claims,
      snippets: cappedSnippets,
      warnings,
    }),
    warnings,
    snippets: cappedSnippets,
  };
}

function resolveEvidenceContext(
  options: BuildReviewEvidenceOptions,
  warnings: ReviewEvidenceWarning[],
): EvidenceContext {
  const repoRoot = path.resolve(options.gitRoot ?? options.cwd);
  const cwd = path.resolve(options.cwd);
  if (!pathIsInsideOrSame(repoRoot, cwd)) {
    throw new Error(
      `Review evidence cwd must be inside repository root. cwd=${cwd} repoRoot=${repoRoot}`,
    );
  }

  const packageJsonPath = resolvePackageJsonPath(
    repoRoot,
    options.packageJsonPath,
    warnings,
  );

  return {
    repoRoot,
    runDir: path.resolve(options.runDir),
    ...(packageJsonPath === undefined ? {} : { packageJsonPath }),
    limits: resolveEvidenceLimits(options),
  };
}

function resolveEvidenceLimits(options: BuildReviewEvidenceOptions): EvidenceLimits {
  return {
    ...defaultLimits,
    ...(options.maxSnippetMatches === undefined
      ? {}
      : { maxSnippetMatches: options.maxSnippetMatches }),
    ...(options.maxExcerptLines === undefined
      ? {}
      : { maxExcerptLines: options.maxExcerptLines }),
    ...(options.maxSnippets === undefined ? {} : { maxSnippets: options.maxSnippets }),
    ...(options.maxFileBytes === undefined
      ? {}
      : { maxFileBytes: options.maxFileBytes }),
  };
}

function resolvePackageJsonPath(
  repoRoot: string,
  packageJsonPath: string | undefined,
  warnings: ReviewEvidenceWarning[],
): string | undefined {
  if (packageJsonPath === undefined) return path.join(repoRoot, "package.json");

  const resolved = path.resolve(repoRoot, packageJsonPath);
  if (pathIsInsideOrSame(repoRoot, resolved)) return resolved;

  warnings.push({
    code: "package_json_path_outside_repo",
    message: "Configured packageJsonPath is outside the repository root and was ignored.",
    file: normalizeRelativePath(packageJsonPath),
  });
  return undefined;
}

function parseDiffClaims(diff: string): DiffClaims {
  const changedFiles: string[] = [];
  const addedMarkdownLines: AddedMarkdownLine[] = [];
  let currentFile: string | null = null;

  for (const line of diff.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      currentFile = normalizeRelativePath(header[2] ?? header[1] ?? "");
      if (currentFile.length > 0 && currentFile !== "/dev/null") {
        changedFiles.push(currentFile);
      }
      continue;
    }

    if (!currentFile || !isMarkdownPath(currentFile)) continue;
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    addedMarkdownLines.push({
      file: currentFile,
      text: line.slice(1),
    });
  }

  return {
    changedFiles: unique(changedFiles),
    addedMarkdownLines,
  };
}

function extractReviewEvidenceSnippets(
  addedMarkdownLines: AddedMarkdownLine[],
  warnings: ReviewEvidenceWarning[],
): ReviewEvidenceSnippet[] {
  const snippets = new Map<string, ReviewEvidenceSnippet>();
  let inFence = false;
  let fenceLanguage = "";
  let currentFenceFile = "";
  let pendingCommand = "";

  for (const line of addedMarkdownLines) {
    if (line.file !== currentFenceFile) {
      inFence = false;
      fenceLanguage = "";
      pendingCommand = "";
      currentFenceFile = line.file;
    }

    const fence = /^\s*```([A-Za-z0-9_-]*)/.exec(line.text);
    if (fence) {
      if (inFence && pendingCommand.trim().length > 0) {
        addCommandSnippet(snippets, pendingCommand, line.file);
        pendingCommand = "";
      }
      inFence = !inFence;
      fenceLanguage = inFence ? (fence[1] ?? "").toLowerCase() : "";
      continue;
    }

    if (inFence && isSupportedShellFence(fenceLanguage)) {
      const commandLine = line.text.trim();
      if (commandLine.length === 0 || commandLine.startsWith("#")) continue;

      const continuation = commandLine.endsWith("\\");
      const commandPart = continuation ? commandLine.replace(/\\+$/, "").trim() : commandLine;
      pendingCommand = pendingCommand
        ? `${pendingCommand} ${commandPart}`.trim()
        : commandPart;
      if (!continuation && pendingCommand.length > 0) {
        addCommandSnippet(snippets, pendingCommand, line.file);
        pendingCommand = "";
      }
      continue;
    }

    extractInlineSnippets(line, snippets);
    extractUnquotedSnippets(line, snippets);
  }

  if (pendingCommand.trim().length > 0) {
    addCommandSnippet(snippets, pendingCommand, currentFenceFile);
    warnings.push({
      code: "unterminated_command_continuation",
      message: "A fenced command ended with a pending shell continuation.",
      file: currentFenceFile,
    });
  }

  return [...snippets.values()];
}

function addCommandSnippet(
  snippets: Map<string, ReviewEvidenceSnippet>,
  command: string,
  originFile: string,
): void {
  const commandSnippet = addSnippet(snippets, command, "command", originFile);
  if (!commandSnippet) return;

  for (const derived of deriveCommandClaims(commandSnippet.original)) {
    addSnippet(
      snippets,
      derived.original,
      derived.kind,
      originFile,
      commandSnippet.original,
    );
  }
}

function extractInlineSnippets(
  line: AddedMarkdownLine,
  snippets: Map<string, ReviewEvidenceSnippet>,
): void {
  for (const match of line.text.matchAll(/`([^`\n]+)`/g)) {
    const original = match[1] ?? "";
    if (!looksLikeClaim(original)) continue;
    const kind = classifySnippetKind(original);
    if (kind === "command") {
      addCommandSnippet(snippets, original, line.file);
    } else {
      addSnippet(snippets, original, kind, line.file);
    }
  }
}

function extractUnquotedSnippets(
  line: AddedMarkdownLine,
  snippets: Map<string, ReviewEvidenceSnippet>,
): void {
  for (const match of line.text.matchAll(/https?:\/\/[^\s`),]+/g)) {
    addSnippet(snippets, match[0], "url", line.file);
  }

  for (const match of line.text.matchAll(/\bnpm\s+run\s+[A-Za-z0-9:_-]+/g)) {
    addSnippet(snippets, match[0], "package-script", line.file);
  }

  for (const match of line.text.matchAll(/(^|\s)(--[A-Za-z0-9][A-Za-z0-9-]*)\b/g)) {
    addSnippet(snippets, match[2] ?? "", "flag", line.file);
  }

  const pathPattern =
    /(^|[\s("'`])((?:\.\/)?(?:\.agent-work|dist\/cli\/main\.js|logs\/|plans\/|milestones\/|diffs\/|checks\/|reviews\/|runner\/)[A-Za-z0-9._/-]*)/g;
  for (const match of line.text.matchAll(pathPattern)) {
    addSnippet(snippets, match[2] ?? "", "path", line.file);
  }
}

function addSnippet(
  snippets: Map<string, ReviewEvidenceSnippet>,
  original: string,
  kind: ReviewEvidenceSnippet["kind"],
  originFile: string,
  derivedFrom?: string,
): ReviewEvidenceSnippet | null {
  const normalized = normalizeSnippet(original, kind);
  if (normalized.length === 0) return null;

  const key = `${kind}\0${normalized}\0${derivedFrom ?? ""}`;
  const existing = snippets.get(key);
  if (existing) {
    existing.originFiles = unique([...existing.originFiles, originFile]);
    return existing;
  }

  const snippet: ReviewEvidenceSnippet = {
    original: original.trim(),
    normalized,
    kind,
    originFiles: [originFile],
    status: "unmatched",
    matches: [],
    ...(derivedFrom === undefined ? {} : { derivedFrom }),
  };
  snippets.set(key, snippet);
  return snippet;
}

function deriveCommandClaims(command: string): Array<{
  original: string;
  kind: ReviewEvidenceSnippet["kind"];
}> {
  const claims: Array<{ original: string; kind: ReviewEvidenceSnippet["kind"] }> = [];
  const packageScript = /\bnpm\s+run\s+([A-Za-z0-9:_-]+)/.exec(command);
  if (packageScript) {
    claims.push({
      original: `npm run ${packageScript[1]}`,
      kind: "package-script",
    });
  }

  for (const match of command.matchAll(/(^|\s)(--[A-Za-z0-9][A-Za-z0-9-]*)\b/g)) {
    claims.push({ original: match[2] ?? "", kind: "flag" });
  }

  for (const match of command.matchAll(/https?:\/\/[^\s`),]+/g)) {
    claims.push({ original: match[0], kind: "url" });
  }

  const pathPattern =
    /(^|[\s="'`])((?:\.\/)?(?:\.agent-work|dist\/cli\/main\.js|logs\/|plans\/|milestones\/|diffs\/|checks\/|reviews\/|runner\/)[A-Za-z0-9._/-]*)/g;
  for (const match of command.matchAll(pathPattern)) {
    claims.push({ original: match[2] ?? "", kind: "path" });
  }

  return claims.filter((claim) => claim.original.length > 0);
}

function capSnippets(
  snippets: ReviewEvidenceSnippet[],
  limits: EvidenceLimits,
  warnings: ReviewEvidenceWarning[],
): ReviewEvidenceSnippet[] {
  if (snippets.length <= limits.maxSnippets) return snippets;
  warnings.push({
    code: "snippet_limit_exceeded",
    message: `Extracted ${snippets.length} snippets; using first ${limits.maxSnippets}.`,
  });
  return snippets.slice(0, limits.maxSnippets);
}

async function validateStructuredSnippet(options: {
  snippet: ReviewEvidenceSnippet;
  repoRoot: string;
  packageJsonPath?: string;
  limits: EvidenceLimits;
}): Promise<StructuredValidationResult> {
  const { snippet } = options;
  if (snippet.kind === "package-script") {
    return validatePackageScript(options);
  }

  if (snippet.kind === "url") {
    return validateDashboardUrl(options);
  }

  if (snippet.kind === "flag" && dashboardFlags.has(snippet.normalized)) {
    return validateDashboardFlag(options);
  }

  if (snippet.kind === "path") {
    if (artifactDirectories.has(snippet.normalized)) {
      return validateArtifactDirectory(options);
    }

    if (snippet.normalized === "dist/cli/main.js") {
      return validateCliEntrypoint(options);
    }
  }

  return { matches: [], warnings: [] };
}

async function validatePackageScript(options: {
  snippet: ReviewEvidenceSnippet;
  repoRoot: string;
  packageJsonPath?: string;
  limits: EvidenceLimits;
}): Promise<StructuredValidationResult> {
  const scriptMatch = /^npm\s+run\s+([A-Za-z0-9:_-]+)$/.exec(options.snippet.normalized);
  if (!scriptMatch) return { matches: [], warnings: [] };
  const scriptName = scriptMatch[1] ?? "";
  const packagePath = path.resolve(options.packageJsonPath ?? path.join(options.repoRoot, "package.json"));
  const packageResult = await readJsonObject(packagePath);
  if (!packageResult.ok) {
    return {
      matches: [],
      warnings: [{
        code: "package_json_unreadable",
        message: packageResult.error,
        snippet: options.snippet.original,
        file: toRepoRelativePath(options.repoRoot, packagePath),
      }],
    };
  }

  const scripts = isRecord(packageResult.value.scripts) ? packageResult.value.scripts : {};
  if (typeof scripts[scriptName] !== "string") {
    return {
      matches: [],
      warnings: [{
        code: "package_script_missing",
        message: `package.json does not define scripts.${scriptName}.`,
        snippet: options.snippet.original,
        file: toRepoRelativePath(options.repoRoot, packagePath),
      }],
    };
  }

  const match = lineMatch(
    packageResult.raw,
    `"${scriptName}"`,
    toRepoRelativePath(options.repoRoot, packagePath),
    options.limits,
    "structured",
  );
  return { matches: match ? [match] : [], warnings: [] };
}

async function validateCliEntrypoint(options: {
  snippet: ReviewEvidenceSnippet;
  repoRoot: string;
  packageJsonPath?: string;
  limits: EvidenceLimits;
}): Promise<StructuredValidationResult> {
  const packagePath = path.resolve(options.packageJsonPath ?? path.join(options.repoRoot, "package.json"));
  const packageResult = await readJsonObject(packagePath);
  if (!packageResult.ok) return { matches: [], warnings: [] };

  const bin = packageResult.value.bin;
  const binValues = isRecord(bin) ? Object.values(bin) : [];
  const found = binValues.some((value) => {
    return typeof value === "string" && normalizePathSnippet(value) === options.snippet.normalized;
  });
  if (!found) return { matches: [], warnings: [] };

  const match = lineMatch(
    packageResult.raw,
    "dist/cli/main.js",
    toRepoRelativePath(options.repoRoot, packagePath),
    options.limits,
    "structured",
  );
  return { matches: match ? [match] : [], warnings: [] };
}

async function validateDashboardUrl(options: {
  snippet: ReviewEvidenceSnippet;
  repoRoot: string;
  limits: EvidenceLimits;
}): Promise<StructuredValidationResult> {
  let url: URL;
  try {
    url = new URL(options.snippet.normalized);
  } catch {
    return { matches: [], warnings: [] };
  }

  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    return { matches: [], warnings: [] };
  }
  if (url.port.length === 0) return { matches: [], warnings: [] };

  const serverPath = path.join(options.repoRoot, "src", "dashboard", "server.ts");
  const raw = await readFile(serverPath, "utf8").catch(() => null);
  if (raw === null) return { matches: [], warnings: [] };

  const hostMatch = lineMatch(
    raw,
    `host: "${url.hostname}"`,
    toRepoRelativePath(options.repoRoot, serverPath),
    options.limits,
    "structured",
  );
  const portMatch = lineMatch(
    raw,
    `port: ${url.port}`,
    toRepoRelativePath(options.repoRoot, serverPath),
    options.limits,
    "structured",
  );

  if (hostMatch && portMatch) {
    return { matches: [hostMatch, portMatch], warnings: [] };
  }

  return {
    matches: [],
    warnings: [{
      code: "dashboard_url_unverified",
      message: "Dashboard URL host or port was not found in dashboard defaults.",
      snippet: options.snippet.original,
      file: toRepoRelativePath(options.repoRoot, serverPath),
    }],
  };
}

async function validateDashboardFlag(options: {
  snippet: ReviewEvidenceSnippet;
  repoRoot: string;
  limits: EvidenceLimits;
}): Promise<StructuredValidationResult> {
  const serverPath = path.join(options.repoRoot, "src", "dashboard", "server.ts");
  const raw = await readFile(serverPath, "utf8").catch(() => null);
  if (raw === null) return { matches: [], warnings: [] };
  const match = lineMatch(
    raw,
    `"${options.snippet.normalized}"`,
    toRepoRelativePath(options.repoRoot, serverPath),
    options.limits,
    "structured",
  );
  return { matches: match ? [match] : [], warnings: [] };
}

async function validateArtifactDirectory(options: {
  snippet: ReviewEvidenceSnippet;
  repoRoot: string;
  limits: EvidenceLimits;
}): Promise<StructuredValidationResult> {
  const pathsFile = path.join(options.repoRoot, "src", "artifacts", "paths.ts");
  const raw = await readFile(pathsFile, "utf8").catch(() => null);
  if (raw === null) return { matches: [], warnings: [] };
  const directoryName = options.snippet.normalized.replace(/\/$/, "");
  const match = lineMatch(
    raw,
    `"${directoryName}"`,
    toRepoRelativePath(options.repoRoot, pathsFile),
    options.limits,
    "structured",
  );
  return { matches: match ? [match] : [], warnings: [] };
}

async function readSearchFiles(options: {
  repoRoot: string;
  runDir: string;
  changedMarkdownFiles: Set<string>;
  limits: EvidenceLimits;
  warnings: ReviewEvidenceWarning[];
}): Promise<SearchFile[]> {
  const files: SearchFile[] = [];
  let skippedLargeFiles = 0;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (isNoEntryError(error)) return [];
      throw error;
    });

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = toRepoRelativePath(options.repoRoot, absolutePath);
      if (!relativePath || shouldExcludePath(relativePath, absolutePath, options.runDir)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (options.changedMarkdownFiles.has(relativePath)) continue;
      if (!isSearchableTextPath(relativePath)) continue;

      const fileStat = await stat(absolutePath);
      if (fileStat.size > options.limits.maxFileBytes) {
        skippedLargeFiles += 1;
        continue;
      }

      const content = await readFile(absolutePath, "utf8");
      if (content.includes("\0")) continue;
      files.push({ absolutePath, relativePath, content });
    }
  }

  await walk(options.repoRoot);
  if (skippedLargeFiles > 0) {
    options.warnings.push({
      code: "large_files_skipped",
      message: `Skipped ${skippedLargeFiles} file(s) larger than ${options.limits.maxFileBytes} bytes.`,
    });
  }

  return files;
}

async function readChangedMarkdownFiles(options: {
  repoRoot: string;
  changedMarkdownFiles: Set<string>;
  limits: EvidenceLimits;
}): Promise<SearchFile[]> {
  const files: SearchFile[] = [];
  for (const relativePath of options.changedMarkdownFiles) {
    const absolutePath = path.resolve(options.repoRoot, relativePath);
    if (!pathIsInsideOrSame(options.repoRoot, absolutePath)) continue;
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat?.isFile() || fileStat.size > options.limits.maxFileBytes) continue;
    const content = await readFile(absolutePath, "utf8").catch(() => null);
    if (content === null || content.includes("\0")) continue;
    files.push({ absolutePath, relativePath, content });
  }
  return files;
}

function findExactMatches(
  files: SearchFile[],
  snippet: ReviewEvidenceSnippet,
  limits: EvidenceLimits,
  warnings: ReviewEvidenceWarning[],
  options: { suppressLimitWarnings?: boolean } = {},
): ReviewEvidenceMatch[] {
  const needles = unique([snippet.original.trim(), snippet.normalized])
    .filter((needle) => needle.length > 0);
  const matches: ReviewEvidenceMatch[] = [];

  for (const file of files) {
    for (const needle of needles) {
      const match = lineMatch(file.content, needle, file.relativePath, limits, "exact");
      if (!match) continue;
      if (!matches.some((item) => item.file === match.file && item.line === match.line)) {
        matches.push(match);
      }
      break;
    }

    if (matches.length >= limits.maxSnippetMatches) break;
  }

  if (
    matches.length >= limits.maxSnippetMatches &&
    options.suppressLimitWarnings !== true
  ) {
    warnings.push({
      code: "snippet_match_limit_reached",
      message: `Only the first ${limits.maxSnippetMatches} match(es) were kept.`,
      snippet: snippet.original,
    });
  }

  return matches;
}

function lineMatch(
  content: string,
  needle: string,
  relativePath: string,
  limits: EvidenceLimits,
  source: ReviewEvidenceMatch["source"],
): ReviewEvidenceMatch | null {
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) return null;
  return {
    file: relativePath,
    line: index + 1,
    excerpt: excerptAroundLine(lines, index, limits.maxExcerptLines),
    source,
  };
}

function excerptAroundLine(lines: string[], index: number, maxExcerptLines: number): string {
  const extra = Math.max(0, Math.floor((maxExcerptLines - 1) / 2));
  const start = Math.max(0, index - extra);
  const end = Math.min(lines.length, start + Math.max(1, maxExcerptLines));
  return lines.slice(start, end).join("\n").trimEnd();
}

function markDecomposedCommandSnippets(snippets: ReviewEvidenceSnippet[]): void {
  for (const snippet of snippets) {
    if (snippet.kind !== "command" || snippet.status === "backed") continue;
    const derived = snippets.filter((candidate) => candidate.derivedFrom === snippet.original);
    if (derived.length === 0) continue;
    if (derived.every((candidate) => candidate.status === "backed")) {
      snippet.status = "decomposed";
    }
  }
}

function appendSnippetStatusWarnings(
  snippets: ReviewEvidenceSnippet[],
  warnings: ReviewEvidenceWarning[],
): void {
  for (const snippet of snippets) {
    if (snippet.status === "self_match_only") {
      warnings.push({
        code: "self_match_only",
        message: "Snippet was found only in changed Markdown, not authoritative source.",
        snippet: snippet.original,
      });
      continue;
    }

    if (snippet.status === "unmatched") {
      warnings.push({
        code: "snippet_unmatched",
        message: "Snippet was not backed by structured validation or exact source matches.",
        snippet: snippet.original,
      });
    }
  }
}

function formatReviewEvidenceMarkdown(options: {
  options: BuildReviewEvidenceOptions;
  claims: DiffClaims;
  snippets: ReviewEvidenceSnippet[];
  warnings: ReviewEvidenceWarning[];
}): string {
  return [
    `# Milestone ${options.options.milestoneId} Review Evidence`,
    "",
    `Run id: ${options.options.runId}`,
    `Milestone id: ${options.options.milestoneId}`,
    `Review round: ${formatReviewRound(options.options.reviewRound)}`,
    "",
    "## Changed Files",
    "",
    ...formatList(options.claims.changedFiles, "No changed files parsed from diff."),
    "",
    "## Added Markdown Lines",
    "",
    ...formatAddedMarkdownLines(options.claims.addedMarkdownLines),
    "",
    "## Extracted Claims",
    "",
    ...formatSnippets(options.snippets),
    "",
    "## Warnings",
    "",
    ...formatWarnings(options.warnings),
  ].join("\n");
}

function formatSnippets(snippets: ReviewEvidenceSnippet[]): string[] {
  if (snippets.length === 0) return ["No command, path, URL, or package-script claims detected."];
  const lines: string[] = [];

  for (const snippet of snippets) {
    lines.push(`### ${formatInlineCode(snippet.original)}`);
    lines.push("");
    lines.push(`- Kind: ${snippet.kind}`);
    lines.push(`- Status: ${snippet.status}`);
    lines.push(`- Normalized: ${formatInlineCode(snippet.normalized)}`);
    lines.push(`- Origin files: ${snippet.originFiles.join(", ")}`);
    if (snippet.derivedFrom) {
      lines.push(`- Derived from: ${formatInlineCode(snippet.derivedFrom)}`);
    }

    if (snippet.matches.length === 0) {
      lines.push("- Matches: none");
      lines.push("");
      continue;
    }

    lines.push("- Matches:");
    for (const match of snippet.matches) {
      lines.push(`  - ${match.file}:${match.line} (${match.source})`);
      lines.push("");
      lines.push("```text");
      lines.push(match.excerpt);
      lines.push("```");
    }
    lines.push("");
  }

  return lines;
}

function formatAddedMarkdownLines(lines: AddedMarkdownLine[]): string[] {
  if (lines.length === 0) return ["No added Markdown lines parsed from diff."];
  return lines.map((line) => `- ${line.file}: ${line.text}`);
}

function formatWarnings(warnings: ReviewEvidenceWarning[]): string[] {
  if (warnings.length === 0) return ["None"];
  return warnings.map((warning) => {
    const details = [
      warning.snippet ? `snippet=${warning.snippet}` : undefined,
      warning.file ? `file=${warning.file}` : undefined,
    ].filter((value): value is string => value !== undefined);
    return details.length === 0
      ? `- [${warning.code}] ${warning.message}`
      : `- [${warning.code}] ${warning.message} (${details.join(", ")})`;
  });
}

function formatReviewRound(round: BuildReviewEvidenceOptions["reviewRound"]): string {
  return round.kind === "base" ? "base" : `fix ${round.attempt}`;
}

function formatList(values: string[], emptyText: string): string[] {
  if (values.length === 0) return [`- ${emptyText}`];
  return values.map((value) => `- ${value}`);
}

function formatInlineCode(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

async function readJsonObject(
  filePath: string,
): Promise<
  | { ok: true; value: Record<string, unknown>; raw: string }
  | { ok: false; error: string }
> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    return { ok: false, error: `Failed to read ${filePath}: ${formatError(error)}` };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { ok: false, error: `${filePath} must contain a JSON object.` };
    }
    return { ok: true, value: parsed, raw };
  } catch (error) {
    return { ok: false, error: `Failed to parse ${filePath}: ${formatError(error)}` };
  }
}

function normalizeSnippet(
  value: string,
  kind: ReviewEvidenceSnippet["kind"],
): string {
  const trimmed = value
    .trim()
    .replace(/\\+$/, "")
    .replace(/^[\s"'([{]+/, "")
    .replace(/[\s"',.;:)\]}]+$/, "");
  if (kind === "path") return normalizePathSnippet(trimmed);
  return trimmed.replace(/\s+/g, " ");
}

function normalizePathSnippet(value: string): string {
  return value
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/\\/g, "/");
}

function classifySnippetKind(value: string): ReviewEvidenceSnippet["kind"] {
  const normalized = normalizeSnippet(value, "command");
  if (/^https?:\/\//.test(normalized)) return "url";
  if (/^npm\s+run\s+[A-Za-z0-9:_-]+$/.test(normalized)) return "package-script";
  if (/^--[A-Za-z0-9][A-Za-z0-9-]*$/.test(normalized)) return "flag";
  if (looksLikePath(normalized)) return "path";
  return "command";
}

function looksLikeClaim(value: string): boolean {
  const normalized = value.trim();
  return (
    /^https?:\/\//.test(normalized) ||
    /^npm\s+run\s+/.test(normalized) ||
    /^node\s+/.test(normalized) ||
    /^(cat|find|ls)\s+/.test(normalized) ||
    /^--[A-Za-z0-9][A-Za-z0-9-]*$/.test(normalized) ||
    looksLikePath(normalized)
  );
}

function looksLikePath(value: string): boolean {
  return (
    value === ".agent-work" ||
    value.startsWith(".agent-work/") ||
    value.includes("/") ||
    artifactDirectories.has(value)
  );
}

function isSupportedShellFence(language: string): boolean {
  return language === "" || language === "bash" || language === "sh" || language === "shell";
}

function isMarkdownPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

function isSearchableTextPath(filePath: string): boolean {
  return textFileExtensions.has(path.extname(filePath).toLowerCase());
}

function shouldExcludePath(relativePath: string, absolutePath: string, runDir: string): boolean {
  if (pathIsInsideOrSame(runDir, absolutePath)) return true;
  const segments = relativePath.split("/");
  return segments.some((segment) => generatedDirectoryNames.has(segment));
}

function pathIsInsideOrSame(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toRepoRelativePath(repoRoot: string, filePath: string): string {
  return normalizeRelativePath(path.relative(repoRoot, filePath));
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNoEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
