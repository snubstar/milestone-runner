export function parsePathLines(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function goalSourceValidationState(mode) {
  const goalFileMode = mode === "goalFile";
  return {
    promptRequired: !goalFileMode,
    promptDisabled: goalFileMode,
    promptHidden: goalFileMode,
    goalFileRequired: goalFileMode,
    goalFileDisabled: !goalFileMode,
    goalFileHidden: !goalFileMode,
  };
}

export function buildLaunchRequestPayload(input) {
  const request = {
    runner: input.runner,
    dryRun: Boolean(input.dryRun),
    allowDirty: Boolean(input.allowDirty),
    allowNonGitPlanning: Boolean(input.allowNonGitPlanning),
  };

  if (input.goalSourceMode === "goalFile") {
    request.goalFilePath = String(input.goalFilePath ?? "").trim();
  } else {
    request.prompt = String(input.prompt ?? "");
  }

  const milestone = String(input.milestone ?? "").trim();
  if (milestone) request.milestone = Number(milestone);
  if (input.milestonePlanPolicy) {
    request.milestonePlanPolicy = input.milestonePlanPolicy;
  }
  if (input.milestonePlanReviewPolicy) {
    request.milestonePlanReviewPolicy = input.milestonePlanReviewPolicy;
  }

  const contextPaths = parsePathLines(input.contextPathsText);
  if (contextPaths.length > 0) request.contextPaths = contextPaths;

  const seedMajorPlanPath = String(input.seedMajorPlanPath ?? "").trim();
  if (seedMajorPlanPath) request.seedMajorPlanPath = seedMajorPlanPath;

  return request;
}

export function buildLaunchSummaryFields(response) {
  const report = isRecord(response?.report) ? response.report : {};
  const details = isRecord(report.details) ? report.details : {};
  const status = launchStatus(response, report);

  return [
    field("Status", status),
    field("Next action", stringValue(report.nextAction)),
    field("Target repository", stringValue(details.targetCwd)),
    field("Artifact root", stringValue(details.artifactRoot)),
    field("Goal source", stringValue(details.goalSource)),
    field("Context inputs", stringValue(details.contextInputs)),
    field("Major plan source", formatMajorPlanSource(details.majorPlanSource)),
    field("Runner", stringValue(details.runner)),
    field("Runner profile", stringValue(details.runnerProfile)),
    field("Runner account label", stringValue(details.runnerAccountLabel)),
    field("Runner authentication", stringValue(details.runnerAuthentication)),
  ].filter((entry) => entry.value !== null);
}

function launchStatus(response, report) {
  if (typeof report.allowed === "boolean") {
    return report.allowed ? "allowed" : "blocked";
  }
  if (response?.started === true) return "started";
  if (response?.dryRun === true) return "unknown";
  return null;
}

function field(label, value) {
  return { label, value };
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatMajorPlanSource(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (!isRecord(value)) return null;
  if (value.type === "seed" && typeof value.path === "string" && value.path.length > 0) {
    return `seeded from ${value.path}`;
  }
  if (value.type === "runner") return "runner";
  return null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
