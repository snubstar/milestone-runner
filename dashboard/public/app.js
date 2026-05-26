import {
  buildLaunchSummaryFields,
  buildLaunchRequestPayload,
  goalSourceValidationState,
} from "./launch-request.js";

const POLL_INTERVAL_MS = 3000;
const STREAM_REFRESH_DELAY_MS = 500;

const streamEventNames = [
  "phase_changed",
  "milestone_status_changed",
  "artifact_written",
  "runner_diagnostic_written",
  "invocation_started",
  "invocation_ended",
  "timeline_event",
  "launcher_output",
  "launcher_completed",
  "stream_error",
  "heartbeat",
];

const artifactGroupLabels = {
  goal: "Goal",
  inputs: "Inputs",
  plans: "Plans",
  milestones: "Milestones",
  diffs: "Diffs",
  checks: "Checks",
  reviews: "Reviews",
  summaries: "Summaries",
  fixes: "Fixes",
  logs: "Logs",
  runner: "Runner",
};

const state = {
  runs: [],
  runWarnings: [],
  selectedRunId: null,
  selectedRun: null,
  dashboardToken: null,
  loading: false,
  launching: false,
  pollTimer: null,
  eventSource: null,
  streamRunId: null,
  streamConnected: false,
  streamRefreshTimer: null,
  activityEventsByRun: new Map(),
  activityEventIdsByRun: new Map(),
  resumeDryRunByRun: new Map(),
  resuming: false,
};

const elements = {
  statusLine: document.querySelector("#statusLine"),
  refreshButton: document.querySelector("#refreshButton"),
  launchForm: document.querySelector("#launchForm"),
  launchState: document.querySelector("#launchState"),
  launchGoalSourceMode: document.querySelector("#launchGoalSourceMode"),
  launchPromptField: document.querySelector("#launchPromptField"),
  launchPrompt: document.querySelector("#launchPrompt"),
  launchGoalFileField: document.querySelector("#launchGoalFileField"),
  launchGoalFilePath: document.querySelector("#launchGoalFilePath"),
  launchRunner: document.querySelector("#launchRunner"),
  launchMilestone: document.querySelector("#launchMilestone"),
  launchPlanPolicy: document.querySelector("#launchPlanPolicy"),
  launchReviewPolicy: document.querySelector("#launchReviewPolicy"),
  launchContextPaths: document.querySelector("#launchContextPaths"),
  launchSeedMajorPlanPath: document.querySelector("#launchSeedMajorPlanPath"),
  launchDryRun: document.querySelector("#launchDryRun"),
  launchAllowDirty: document.querySelector("#launchAllowDirty"),
  launchAllowNonGit: document.querySelector("#launchAllowNonGit"),
  launchButton: document.querySelector("#launchButton"),
  launchResult: document.querySelector("#launchResult"),
  resumeSection: document.querySelector("#resumeSection"),
  resumeForm: document.querySelector("#resumeForm"),
  resumeState: document.querySelector("#resumeState"),
  resumeTerminal: document.querySelector("#resumeTerminal"),
  resumeMilestone: document.querySelector("#resumeMilestone"),
  resumePlanPolicy: document.querySelector("#resumePlanPolicy"),
  resumeReviewPolicy: document.querySelector("#resumeReviewPolicy"),
  resumeAllowDirty: document.querySelector("#resumeAllowDirty"),
  resumeAllowNonGit: document.querySelector("#resumeAllowNonGit"),
  resumeDryRunButton: document.querySelector("#resumeDryRunButton"),
  resumeConfirmButton: document.querySelector("#resumeConfirmButton"),
  resumeResult: document.querySelector("#resumeResult"),
  runCount: document.querySelector("#runCount"),
  runList: document.querySelector("#runList"),
  emptyState: document.querySelector("#emptyState"),
  detailState: document.querySelector("#detailState"),
  detailStatus: document.querySelector("#detailStatus"),
  detailGoal: document.querySelector("#detailGoal"),
  detailRunId: document.querySelector("#detailRunId"),
  detailPhase: document.querySelector("#detailPhase"),
  detailMilestone: document.querySelector("#detailMilestone"),
  detailUpdated: document.querySelector("#detailUpdated"),
  streamState: document.querySelector("#streamState"),
  warningSection: document.querySelector("#warningSection"),
  warnings: document.querySelector("#warnings"),
  errorSection: document.querySelector("#errorSection"),
  lastError: document.querySelector("#lastError"),
  inputsSummary: document.querySelector("#inputsSummary"),
  milestoneTable: document.querySelector("#milestoneTable"),
  latestAction: document.querySelector("#latestAction"),
  timeline: document.querySelector("#timeline"),
  activityCount: document.querySelector("#activityCount"),
  activityFeed: document.querySelector("#activityFeed"),
  artifactGroups: document.querySelector("#artifactGroups"),
};

elements.refreshButton.addEventListener("click", () => {
  void refreshDashboard({ forceDetail: true });
});

elements.launchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitLaunch();
});

elements.launchGoalSourceMode.addEventListener("change", applyLaunchGoalSourceMode);

elements.resumeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitResumeDryRun();
});

elements.resumeConfirmButton.addEventListener("click", () => {
  void submitResume();
});

for (const element of [
  elements.resumeMilestone,
  elements.resumePlanPolicy,
  elements.resumeReviewPolicy,
  elements.resumeAllowDirty,
  elements.resumeAllowNonGit,
]) {
  element.addEventListener("change", clearSelectedResumeDryRun);
}

window.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    closeRunStream();
    stopPolling();
    return;
  }
  schedulePolling();
  void refreshDashboard({ forceDetail: true });
});

void init();

async function init() {
  applyLaunchGoalSourceMode();
  await bootstrap();
  await refreshDashboard({ forceDetail: true });
  schedulePolling();
}

async function bootstrap() {
  const bootstrapResponse = await fetchJson("/api/bootstrap");
  state.dashboardToken = bootstrapResponse.dashboardToken ?? null;
}

async function submitLaunch() {
  if (state.launching) return;
  state.launching = true;
  elements.launchButton.disabled = true;
  elements.launchState.textContent = "Starting";
  elements.launchResult.classList.add("hidden");

  const request = buildLaunchRequest();
  try {
    const response = await fetchJson("/api/runs", {
      method: "POST",
      token: state.dashboardToken,
      body: request,
    });
    renderLaunchResult(response);
    if (!response.dryRun && response.runId) {
      if (state.selectedRunId !== response.runId) clearResumeResult();
      state.selectedRunId = response.runId;
      connectRunStream(response.runId);
      window.setTimeout(() => {
        void refreshDashboard({ forceDetail: true });
      }, 600);
    } else {
      await refreshDashboard({ forceDetail: true });
    }
    elements.launchState.textContent = response.dryRun ? "Dry run complete" : "Started";
  } catch (error) {
    elements.launchState.textContent = "Error";
    renderLaunchError(error);
  } finally {
    state.launching = false;
    elements.launchButton.disabled = false;
  }
}

async function submitResumeDryRun() {
  const run = state.selectedRun;
  if (!run || state.resuming || resumeIsTerminal(run)) return;

  let failed = false;
  state.resuming = true;
  elements.resumeDryRunButton.disabled = true;
  elements.resumeConfirmButton.disabled = true;
  elements.resumeState.textContent = "Checking";
  elements.resumeResult.classList.add("hidden");

  try {
    const response = await fetchJson(
      `/api/runs/${encodeURIComponent(run.runId)}/resume/dry-run`,
      {
        method: "POST",
        token: state.dashboardToken,
        body: buildResumeOptions(),
      },
    );
    state.resumeDryRunByRun.set(run.runId, response);
    renderResumeResult(response);
    elements.resumeState.textContent = response.allowed ? "Allowed" : "Blocked";
    elements.resumeConfirmButton.disabled = !response.allowed;
  } catch (error) {
    failed = true;
    state.resumeDryRunByRun.delete(run.runId);
    elements.resumeState.textContent = "Error";
    renderResumeError(error);
  } finally {
    state.resuming = false;
    renderResumeControls(state.selectedRun);
    if (failed) elements.resumeState.textContent = "Error";
  }
}

async function submitResume() {
  const run = state.selectedRun;
  if (!run || state.resuming || resumeIsTerminal(run)) return;
  const dryRun = state.resumeDryRunByRun.get(run.runId);
  if (!dryRun?.allowed || !dryRun.confirmationToken) return;

  let failed = false;
  let started = false;
  state.resuming = true;
  elements.resumeDryRunButton.disabled = true;
  elements.resumeConfirmButton.disabled = true;
  elements.resumeState.textContent = "Starting";

  try {
    const response = await fetchJson(
      `/api/runs/${encodeURIComponent(run.runId)}/resume`,
      {
        method: "POST",
        token: state.dashboardToken,
        body: {
          resumeId: dryRun.resumeId,
          confirmationToken: dryRun.confirmationToken,
        },
      },
    );
    state.resumeDryRunByRun.delete(run.runId);
    renderResumeStarted(response);
    connectRunStream(run.runId);
    window.setTimeout(() => {
      void refreshDashboard({ forceDetail: true });
    }, 600);
    elements.resumeState.textContent = "Started";
    started = true;
  } catch (error) {
    failed = true;
    elements.resumeState.textContent = "Error";
    renderResumeError(error);
  } finally {
    state.resuming = false;
    renderResumeControls(state.selectedRun);
    if (failed) elements.resumeState.textContent = "Error";
    if (started) elements.resumeState.textContent = "Started";
  }
}

function buildLaunchRequest() {
  return buildLaunchRequestPayload({
    goalSourceMode: elements.launchGoalSourceMode.value,
    prompt: elements.launchPrompt.value,
    goalFilePath: elements.launchGoalFilePath.value,
    runner: elements.launchRunner.value,
    dryRun: elements.launchDryRun.checked,
    allowDirty: elements.launchAllowDirty.checked,
    allowNonGitPlanning: elements.launchAllowNonGit.checked,
    milestone: elements.launchMilestone.value,
    milestonePlanPolicy: elements.launchPlanPolicy.value,
    milestonePlanReviewPolicy: elements.launchReviewPolicy.value,
    contextPathsText: elements.launchContextPaths.value,
    seedMajorPlanPath: elements.launchSeedMajorPlanPath.value,
  });
}

function applyLaunchGoalSourceMode() {
  const validation = goalSourceValidationState(elements.launchGoalSourceMode.value);
  elements.launchPrompt.required = validation.promptRequired;
  elements.launchPrompt.disabled = validation.promptDisabled;
  elements.launchPromptField.classList.toggle("hidden", validation.promptHidden);
  elements.launchGoalFilePath.required = validation.goalFileRequired;
  elements.launchGoalFilePath.disabled = validation.goalFileDisabled;
  elements.launchGoalFileField.classList.toggle("hidden", validation.goalFileHidden);
}

function buildResumeOptions() {
  const milestone = elements.resumeMilestone.value.trim();
  const request = {
    allowDirty: elements.resumeAllowDirty.checked,
    allowNonGitPlanning: elements.resumeAllowNonGit.checked,
  };

  if (milestone) request.milestone = Number(milestone);
  if (elements.resumePlanPolicy.value) {
    request.milestonePlanPolicy = elements.resumePlanPolicy.value;
  }
  if (elements.resumeReviewPolicy.value) {
    request.milestonePlanReviewPolicy = elements.resumeReviewPolicy.value;
  }

  return request;
}

function clearSelectedResumeDryRun() {
  if (!state.selectedRunId) return;
  state.resumeDryRunByRun.delete(state.selectedRunId);
  elements.resumeConfirmButton.disabled = true;
  clearResumeResult();
  if (!state.resuming) {
    elements.resumeState.textContent = resumeIsTerminal(state.selectedRun)
      ? "Terminal"
      : "Ready";
  }
}

function clearResumeResult() {
  elements.resumeResult.classList.add("hidden");
  elements.resumeResult.replaceChildren();
  delete elements.resumeResult.dataset.runId;
}

function markResumeResultForRun(runId) {
  if (runId) {
    elements.resumeResult.dataset.runId = runId;
  } else {
    delete elements.resumeResult.dataset.runId;
  }
}

async function refreshDashboard(options = {}) {
  if (state.loading) return;
  state.loading = true;
  elements.refreshButton.disabled = true;
  setStatus("Loading");

  try {
    const runsResponse = await fetchJson("/api/runs");
    state.runs = Array.isArray(runsResponse.runs) ? runsResponse.runs : [];
    state.runWarnings = Array.isArray(runsResponse.warnings)
      ? runsResponse.warnings
      : [];

    const selectedRunStillExists =
      state.selectedRunId !== null &&
      state.runs.some((run) => run.runId === state.selectedRunId);
    const nextSelectedRunId = selectedRunStillExists
      ? state.selectedRunId
      : state.runs[0]?.runId ?? null;
    if (state.selectedRunId !== nextSelectedRunId) {
      state.selectedRunId = nextSelectedRunId;
      clearResumeResult();
    }

    renderRunList();

    if (state.selectedRunId) {
      if (options.forceDetail || shouldPollSelectedRun()) {
        await loadRunDetail(state.selectedRunId);
      }
    } else {
      state.selectedRun = null;
      closeRunStream();
      renderDetail();
    }

    setStatus(statusText());
  } catch (error) {
    setStatus("Error");
    renderRunListError(error);
  } finally {
    state.loading = false;
    elements.refreshButton.disabled = false;
  }
}

async function selectRun(runId) {
  if (state.selectedRunId !== runId) clearResumeResult();
  state.selectedRunId = runId;
  closeRunStream();
  renderRunList();
  await loadRunDetail(runId);
  schedulePolling();
}

async function loadRunDetail(runId) {
  try {
    state.selectedRun = await fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
    renderDetail();
    connectRunStream(runId);
  } catch (error) {
    state.selectedRun = null;
    renderDetailError(error);
    connectRunStream(runId);
  }
}

async function fetchJson(url, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers ?? {}) };
  let body;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  if (options.token) {
    headers["X-Dashboard-Token"] = options.token;
  }

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body,
    cache: "no-store",
  });
  const responseText = await response.text();
  let parsed = null;
  if (responseText.length > 0) {
    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw new Error(`Invalid JSON from ${url}`);
    }
  }

  if (!response.ok) {
    const message = parsed?.error?.message ?? `Request failed with ${response.status}`;
    throw new Error(message);
  }

  return parsed ?? {};
}

function renderLaunchResult(response) {
  const blocked = response.report?.allowed === false;
  elements.launchResult.className = `launch-result${blocked ? " error" : ""}`;
  elements.launchResult.replaceChildren();

  const title = document.createElement("div");
  title.className = "launch-result-title";
  title.textContent = response.dryRun
    ? blocked ? "Dry Run Blocked" : "Dry Run"
    : "Run Started";

  const meta = document.createElement("div");
  meta.className = "launch-result-meta mono";
  meta.textContent = [
    response.runId,
    response.report?.nextAction ?? null,
    response.exitCode === null || response.exitCode === undefined
      ? null
      : `exit ${response.exitCode}`,
  ]
    .filter(Boolean)
    .join(" / ");

  elements.launchResult.append(title, meta);
  const summaryFields = buildLaunchSummaryFields(response);
  if (summaryFields.length > 0) {
    const summary = document.createElement("dl");
    summary.className = "launch-summary";
    for (const field of summaryFields) {
      const row = document.createElement("div");
      const label = document.createElement("dt");
      const value = document.createElement("dd");
      label.textContent = field.label;
      value.textContent = field.value;
      row.append(label, value);
      summary.append(row);
    }
    elements.launchResult.append(summary);
  }
  if (Array.isArray(response.report?.warnings) && response.report.warnings.length > 0) {
    const warnings = document.createElement("div");
    warnings.className = "policy-diff";
    for (const warning of response.report.warnings) {
      const item = document.createElement("div");
      item.textContent = warning;
      warnings.append(item);
    }
    elements.launchResult.append(warnings);
  }
  if (response.report) {
    const report = document.createElement("pre");
    report.className = "launch-report";
    report.textContent = JSON.stringify(response.report, null, 2);
    elements.launchResult.append(report);
  }
}

function renderLaunchError(error) {
  elements.launchResult.className = "launch-result error";
  elements.launchResult.textContent = error instanceof Error ? error.message : String(error);
}

function renderResumeControls(run) {
  if (!elements.resumeSection) return;
  const terminal = run ? resumeIsTerminal(run) : true;
  const dryRun = run ? state.resumeDryRunByRun.get(run.runId) : null;

  elements.resumeSection.classList.toggle("hidden", !run);
  elements.resumeTerminal.classList.toggle("hidden", !run || !terminal);
  elements.resumeTerminal.textContent = terminal
    ? "Human review required outside dashboard"
    : "";

  const disabled = !run || terminal || state.resuming;
  for (const element of [
    elements.resumeMilestone,
    elements.resumePlanPolicy,
    elements.resumeReviewPolicy,
    elements.resumeAllowDirty,
    elements.resumeAllowNonGit,
    elements.resumeDryRunButton,
  ]) {
    element.disabled = disabled;
  }

  elements.resumeConfirmButton.disabled = disabled || !dryRun?.allowed;
  if (!run) {
    elements.resumeState.textContent = "-";
    clearResumeResult();
    return;
  }
  if (terminal) {
    elements.resumeState.textContent = "Terminal";
    clearResumeResult();
    return;
  }
  if (state.resuming) return;
  elements.resumeState.textContent = dryRun
    ? dryRun.allowed ? "Allowed" : "Blocked"
    : "Ready";
  if (dryRun) {
    renderResumeResult(dryRun);
  } else if (elements.resumeResult.dataset.runId !== run.runId) {
    clearResumeResult();
  }
}

function renderResumeResult(response) {
  markResumeResultForRun(response.runId);
  elements.resumeResult.className = `launch-result${response.allowed ? "" : " error"}`;
  elements.resumeResult.replaceChildren();

  const title = document.createElement("div");
  title.className = "launch-result-title";
  title.textContent = response.allowed ? "Dry Run Allowed" : "Dry Run Blocked";

  const meta = document.createElement("div");
  meta.className = "launch-result-meta mono";
  meta.textContent = [
    response.nextAction,
    `exit ${response.exitCode}`,
    response.expiresAt ? `expires ${formatDateTime(response.expiresAt)}` : null,
  ]
    .filter(Boolean)
    .join(" / ");

  elements.resumeResult.append(title, meta);
  const policyDiffs = renderPolicyDiffs(response.report);
  if (policyDiffs) elements.resumeResult.append(policyDiffs);
  if (response.warnings?.length > 0) {
    const warnings = document.createElement("div");
    warnings.className = "policy-diff";
    for (const warning of response.warnings) {
      const item = document.createElement("div");
      item.textContent = warning;
      warnings.append(item);
    }
    elements.resumeResult.append(warnings);
  }
  if (response.report) {
    const report = document.createElement("pre");
    report.className = "launch-report";
    report.textContent = JSON.stringify(response.report, null, 2);
    elements.resumeResult.append(report);
  }
}

function renderResumeStarted(response) {
  markResumeResultForRun(response.runId);
  elements.resumeResult.className = "launch-result";
  elements.resumeResult.replaceChildren();

  const title = document.createElement("div");
  title.className = "launch-result-title";
  title.textContent = "Resume Started";

  const meta = document.createElement("div");
  meta.className = "launch-result-meta mono";
  meta.textContent = [response.runId, response.launchId].filter(Boolean).join(" / ");

  elements.resumeResult.append(title, meta);
}

function renderResumeError(error) {
  markResumeResultForRun(state.selectedRun?.runId ?? state.selectedRunId);
  elements.resumeResult.className = "launch-result error";
  elements.resumeResult.textContent = error instanceof Error ? error.message : String(error);
}

function renderPolicyDiffs(report) {
  const details = report?.details;
  if (!details || typeof details !== "object") return null;

  const rows = [];
  if (
    details.savedMilestonePlanPolicy &&
    details.milestonePlanPolicy &&
    details.savedMilestonePlanPolicy !== details.milestonePlanPolicy
  ) {
    rows.push(
      `Plan policy saved ${details.savedMilestonePlanPolicy}, effective ${details.milestonePlanPolicy}`,
    );
  }
  if (
    details.savedMilestonePlanReviewPolicy &&
    details.milestonePlanReviewPolicy &&
    details.savedMilestonePlanReviewPolicy !== details.milestonePlanReviewPolicy
  ) {
    rows.push(
      `Review policy saved ${details.savedMilestonePlanReviewPolicy}, effective ${details.milestonePlanReviewPolicy}`,
    );
  }
  if (rows.length === 0) return null;

  const container = document.createElement("div");
  container.className = "policy-diff";
  for (const row of rows) {
    const item = document.createElement("div");
    item.textContent = row;
    container.append(item);
  }
  return container;
}

function renderRunList() {
  elements.runCount.textContent = String(state.runs.length);
  elements.runList.replaceChildren();

  if (state.runs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const warning = primaryRunIndexWarning();
    const title = document.createElement("h2");
    title.textContent = warning ? "Artifact Root Unavailable" : "No Runs";
    const message = document.createElement("p");
    message.textContent = warning?.message ?? "No run artifacts found.";
    empty.append(title, message);
    elements.runList.append(empty);
    return;
  }

  for (const run of state.runs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `run-card${run.runId === state.selectedRunId ? " selected" : ""}`;
    button.addEventListener("click", () => {
      void selectRun(run.runId);
    });

    const title = document.createElement("div");
    title.className = "run-card-title";
    title.textContent = run.goal || run.runId;

    const status = document.createElement("span");
    status.className = `status-badge ${statusClass(run.status, run.active)}`;
    status.textContent = formatStatus(run.status);

    const meta = document.createElement("div");
    meta.className = "run-card-meta";
    meta.append(
      status,
      textNode(formatPhase(run.currentPhase)),
      textNode(`M${run.currentMilestoneId ?? "-"}`),
      textNode(formatRelativeTime(run.updatedAt)),
    );

    if (Array.isArray(run.warnings) && run.warnings.length > 0) {
      meta.append(textNode(`${run.warnings.length} warnings`));
    }

    button.append(title, meta);
    elements.runList.append(button);
  }
}

function renderRunListError(error) {
  elements.runCount.textContent = "0";
  state.runWarnings = [];
  elements.runList.replaceChildren();
  const banner = document.createElement("div");
  banner.className = "error-banner";
  banner.textContent = error instanceof Error ? error.message : String(error);
  elements.runList.append(banner);
}

function renderDetail() {
  const run = state.selectedRun;
  elements.emptyState.classList.toggle("hidden", Boolean(run));
  elements.detailState.classList.toggle("hidden", !run);
  if (!run) return;

  elements.detailStatus.className = `status-badge ${statusClass(run.status, run.active)}`;
  elements.detailStatus.textContent = formatStatus(run.status);
  elements.detailGoal.textContent = run.goal || run.runId;
  elements.detailRunId.textContent = run.runId;
  elements.detailPhase.textContent = formatPhase(run.currentPhase);
  elements.detailMilestone.textContent = run.currentMilestoneId ?? "-";
  elements.detailUpdated.textContent = formatDateTime(run.updatedAt);
  renderStreamState();

  renderWarnings(run.warnings ?? []);
  renderLastError(run.lastError);
  renderInputs(run.inputs);
  renderResumeControls(run);
  renderMilestones(run.milestoneStatuses ?? {});
  renderTimeline(run.timeline ?? []);
  renderActivityFeed(run);
  renderArtifacts(run.artifacts ?? {});
}

function renderDetailError(error) {
  elements.emptyState.classList.add("hidden");
  elements.detailState.classList.remove("hidden");
  elements.detailStatus.className = "status-badge failed";
  elements.detailStatus.textContent = "Error";
  elements.detailGoal.textContent = "Run unavailable";
  elements.detailRunId.textContent = state.selectedRunId ?? "";
  elements.detailPhase.textContent = "-";
  elements.detailMilestone.textContent = "-";
  elements.detailUpdated.textContent = "-";
  renderStreamState();
  renderWarnings([
    {
      code: "detail_load_failed",
      message: error instanceof Error ? error.message : String(error),
      source: "server",
    },
  ]);
  renderLastError(null);
  renderInputs(null);
  renderResumeControls(null);
  renderMilestones({});
  renderTimeline([]);
  renderActivityFeed(null);
  renderArtifacts({});
}

function renderWarnings(warnings) {
  elements.warningSection.classList.toggle("hidden", warnings.length === 0);
  elements.warnings.replaceChildren();

  for (const warning of warnings) {
    const item = document.createElement("div");
    item.className = "warning-item";

    const title = document.createElement("div");
    title.textContent = warning.message ?? warning.code ?? "Warning";

    const meta = document.createElement("div");
    meta.className = "warning-meta";
    meta.textContent = [warning.source, warning.code].filter(Boolean).join(" / ");

    item.append(title, meta);
    elements.warnings.append(item);
  }
}

function renderLastError(lastError) {
  elements.errorSection.classList.toggle("hidden", !lastError);
  elements.lastError.textContent = lastError ? JSON.stringify(lastError, null, 2) : "";
}

function renderInputs(inputs) {
  elements.inputsSummary.replaceChildren();

  if (!inputs) {
    const empty = document.createElement("div");
    empty.className = "latest-action muted";
    empty.textContent = "Unavailable";
    elements.inputsSummary.append(empty);
    return;
  }

  const list = document.createElement("dl");
  list.className = "input-summary-grid";
  addInputSummaryRow(list, "Goal source", formatInputGoalSource(inputs.goalSource));
  addInputSummaryRow(
    list,
    "Major plan source",
    formatInputMajorPlanSource(inputs.majorPlanSource),
  );

  if (inputs.manifestArtifact) {
    addInputArtifactRow(list, "Manifest", inputs.manifestArtifact);
  }

  elements.inputsSummary.append(list);

  const contextFiles = Array.isArray(inputs.context) ? inputs.context : [];
  if (contextFiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "input-context-empty muted";
    empty.textContent = "No context files";
    elements.inputsSummary.append(empty);
    return;
  }

  const contextList = document.createElement("ul");
  contextList.className = "input-context-list";
  for (const context of contextFiles) {
    const item = document.createElement("li");
    const title = document.createElement("div");
    title.className = "input-context-title";
    if (context.artifact) {
      title.append(createArtifactAnchor(context.artifact, context.path));
    } else {
      title.textContent = context.path;
    }

    const meta = document.createElement("div");
    meta.className = "artifact-meta";
    meta.textContent = [
      context.artifactPath,
      formatBytes(context.sizeBytes),
      context.sha256,
      context.artifact ? null : "artifact unavailable",
    ]
      .filter(Boolean)
      .join(" / ");

    item.append(title, meta);
    contextList.append(item);
  }
  elements.inputsSummary.append(contextList);
}

function addInputSummaryRow(list, label, value) {
  const wrapper = document.createElement("div");
  const term = document.createElement("dt");
  const description = document.createElement("dd");
  term.textContent = label;
  description.textContent = value ?? "-";
  wrapper.append(term, description);
  list.append(wrapper);
}

function addInputArtifactRow(list, label, artifact) {
  const wrapper = document.createElement("div");
  const term = document.createElement("dt");
  const description = document.createElement("dd");
  term.textContent = label;
  description.append(createArtifactAnchor(artifact, artifact.label || artifact.relativePath));
  wrapper.append(term, description);
  list.append(wrapper);
}

function createArtifactAnchor(artifact, label) {
  if (!artifact.exists) {
    const missing = document.createElement("span");
    missing.className = "artifact-link missing";
    missing.textContent = label || artifact.relativePath;
    return missing;
  }

  const anchor = document.createElement("a");
  anchor.className = "artifact-link";
  anchor.textContent = label || artifact.relativePath;
  anchor.href = artifact.href;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  return anchor;
}

function renderMilestones(statuses) {
  elements.milestoneTable.replaceChildren();
  const entries = Object.entries(statuses).sort(([left], [right]) => Number(left) - Number(right));

  if (entries.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 2;
    cell.className = "muted";
    cell.textContent = "None";
    row.append(cell);
    elements.milestoneTable.append(row);
    return;
  }

  for (const [id, status] of entries) {
    const row = document.createElement("tr");

    const idCell = document.createElement("td");
    idCell.className = "mono";
    idCell.textContent = id;

    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `status-badge ${statusClass(status, !isTerminalStatus(status))}`;
    badge.textContent = formatStatus(status);
    statusCell.append(badge);

    row.append(idCell, statusCell);
    elements.milestoneTable.append(row);
  }
}

function renderTimeline(timeline) {
  elements.timeline.replaceChildren();
  const latest = timeline.at(-1);
  elements.latestAction.textContent = latest ? timelineTitle(latest) : "None";

  if (timeline.length === 0) {
    const item = document.createElement("li");
    item.className = "muted";
    item.textContent = "None";
    elements.timeline.append(item);
    return;
  }

  for (const event of timeline.slice(-30).reverse()) {
    const item = document.createElement("li");

    const title = document.createElement("div");
    title.className = "timeline-title";
    title.textContent = timelineTitle(event);

    const meta = document.createElement("div");
    meta.className = "timeline-meta";
    meta.textContent = [
      formatDateTime(event.timestamp),
      formatPhase(event.phase),
      event.currentMilestoneId === null || event.currentMilestoneId === undefined
        ? null
        : `M${event.currentMilestoneId}`,
      event.invocationId ? `invocation ${event.invocationId}` : null,
    ]
      .filter(Boolean)
      .join(" / ");

    item.append(title, meta);
    elements.timeline.append(item);
  }
}

function renderArtifacts(artifacts) {
  elements.artifactGroups.replaceChildren();
  const groups = Object.keys(artifactGroupLabels);
  let rendered = 0;

  for (const group of groups) {
    const links = Array.isArray(artifacts[group]) ? artifacts[group] : [];
    if (links.length === 0) continue;

    const details = document.createElement("details");
    details.className = "artifact-group";
    details.open = rendered < 3;

    const summary = document.createElement("summary");
    summary.textContent = `${artifactGroupLabels[group]} (${links.length})`;

    const list = document.createElement("ul");
    list.className = "artifact-list";

    for (const artifact of links) {
      const item = document.createElement("li");
      const anchor = document.createElement("a");
      anchor.className = `artifact-link${artifact.exists ? "" : " missing"}`;
      anchor.textContent = artifact.label || artifact.relativePath;
      anchor.href = artifact.exists ? artifact.href : "#";
      anchor.target = "_blank";
      anchor.rel = "noreferrer";

      const meta = document.createElement("div");
      meta.className = "artifact-meta";
      meta.textContent = [
        artifact.relativePath,
        artifact.exists ? formatBytes(artifact.sizeBytes) : "missing",
        artifact.milestoneId === null || artifact.milestoneId === undefined
          ? null
          : `M${artifact.milestoneId}`,
      ]
        .filter(Boolean)
        .join(" / ");

      item.append(anchor, meta);
      list.append(item);
    }

    details.append(summary, list);
    elements.artifactGroups.append(details);
    rendered += 1;
  }

  if (rendered === 0) {
    const empty = document.createElement("div");
    empty.className = "latest-action muted";
    empty.textContent = "None";
    elements.artifactGroups.append(empty);
  }
}

function connectRunStream(runId) {
  if (document.hidden) return;
  if (!("EventSource" in window)) {
    closeRunStream();
    renderStreamState("Polling");
    return;
  }
  if (state.eventSource && state.streamRunId === runId) return;

  closeRunStream();
  state.streamRunId = runId;
  state.streamConnected = false;
  renderStreamState("Connecting");

  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  state.eventSource = source;

  source.onopen = () => {
    state.streamConnected = true;
    renderStreamState();
  };
  source.onerror = () => {
    state.streamConnected = false;
    renderStreamState("Polling");
    closeRunStream({ keepState: true });
  };

  for (const eventName of streamEventNames) {
    source.addEventListener(eventName, handleStreamEvent);
  }
}

function closeRunStream(options = {}) {
  if (state.eventSource) {
    for (const eventName of streamEventNames) {
      state.eventSource.removeEventListener(eventName, handleStreamEvent);
    }
    state.eventSource.close();
  }
  state.eventSource = null;
  state.streamConnected = false;
  if (!options.keepState) {
    state.streamRunId = null;
  }
  if (state.streamRefreshTimer !== null) {
    window.clearTimeout(state.streamRefreshTimer);
    state.streamRefreshTimer = null;
  }
  renderStreamState(options.keepState ? "Polling" : undefined);
}

function handleStreamEvent(messageEvent) {
  let event;
  try {
    event = JSON.parse(messageEvent.data);
  } catch {
    return;
  }
  if (!event || event.runId !== state.selectedRunId) return;

  if (event.event !== "heartbeat") {
    addActivityEvent(event);
  }

  if (
    event.event !== "heartbeat" &&
    event.event !== "launcher_output" &&
    event.event !== "stream_error"
  ) {
    scheduleStreamRefresh();
  }
}

function addActivityEvent(event) {
  if (!event.id || !event.runId) return;
  let ids = state.activityEventIdsByRun.get(event.runId);
  if (!ids) {
    ids = new Set();
    state.activityEventIdsByRun.set(event.runId, ids);
  }
  if (ids.has(event.id)) return;
  ids.add(event.id);

  const events = state.activityEventsByRun.get(event.runId) ?? [];
  events.push(event);
  events.sort(compareActivityEvents);
  state.activityEventsByRun.set(event.runId, events.slice(0, 80));

  if (state.selectedRun?.runId === event.runId) {
    renderActivityFeed(state.selectedRun);
  }
}

function scheduleStreamRefresh() {
  if (state.streamRefreshTimer !== null) return;
  state.streamRefreshTimer = window.setTimeout(() => {
    state.streamRefreshTimer = null;
    void refreshDashboard({ forceDetail: true });
  }, STREAM_REFRESH_DELAY_MS);
}

function renderStreamState(override) {
  if (!elements.streamState) return;
  if (override) {
    elements.streamState.textContent = override;
    return;
  }
  if (!state.selectedRunId) {
    elements.streamState.textContent = "-";
    return;
  }
  if (state.eventSource && state.streamConnected) {
    elements.streamState.textContent = "Live";
    return;
  }
  if (state.eventSource) {
    elements.streamState.textContent = "Connecting";
    return;
  }
  elements.streamState.textContent = "Polling";
}

function renderActivityFeed(run) {
  elements.activityFeed.replaceChildren();
  if (!run) {
    elements.activityCount.textContent = "0";
    const item = document.createElement("li");
    item.className = "muted";
    item.textContent = "None";
    elements.activityFeed.append(item);
    return;
  }

  const events = mergedActivityEvents(run);
  elements.activityCount.textContent = String(events.length);

  if (events.length === 0) {
    const item = document.createElement("li");
    item.className = "muted";
    item.textContent = "None";
    elements.activityFeed.append(item);
    return;
  }

  for (const event of events.slice(0, 50)) {
    const item = document.createElement("li");

    const title = document.createElement("div");
    title.className = "activity-title";
    title.textContent = activityTitle(event);

    const meta = document.createElement("div");
    meta.className = "activity-meta";
    meta.textContent = [
      formatDateTime(event.timestamp),
      activityLabel(event.event),
      formatPhase(event.phase),
      event.currentMilestoneId === null || event.currentMilestoneId === undefined
        ? null
        : `M${event.currentMilestoneId}`,
      event.launcher?.stream ?? null,
    ]
      .filter(Boolean)
      .join(" / ");

    item.append(title, meta);
    elements.activityFeed.append(item);
  }
}

function deriveActivityFromRun(run) {
  const events = [];
  for (const timelineEvent of run.timeline ?? []) {
    events.push({
      id: `fallback-timeline:${timelineEvent.index}`,
      runId: run.runId,
      event: fallbackTimelineEventName(timelineEvent.event),
      timestamp: timelineEvent.timestamp,
      message: timelineTitle(timelineEvent),
      phase: timelineEvent.phase,
      status: timelineEvent.status,
      currentMilestoneId: timelineEvent.currentMilestoneId,
    });
  }

  for (const links of Object.values(run.artifacts ?? {})) {
    for (const artifact of links) {
      if (!artifact.exists) continue;
      const runnerDiagnostic = artifact.group === "runner";
      events.push({
        id: `fallback-artifact:${artifact.id}:${artifact.updatedAt ?? ""}`,
        runId: run.runId,
        event: runnerDiagnostic ? "runner_diagnostic_written" : "artifact_written",
        timestamp: artifact.updatedAt ?? null,
        message: runnerDiagnostic
          ? `Runner diagnostic written: ${artifact.label}`
          : `${artifactGroupLabels[artifact.group] ?? artifact.group} artifact written: ${artifact.label}`,
      });
    }
  }

  return events.sort(compareActivityEvents).slice(0, 80);
}

function mergedActivityEvents(run) {
  const durableEvents = deriveActivityFromRun(run);
  const streamedEvents = state.activityEventsByRun.get(run.runId) ?? [];
  const eventsByKey = new Map();

  for (const event of durableEvents) {
    eventsByKey.set(activityDedupeKey(event), event);
  }

  for (const event of streamedEvents) {
    eventsByKey.set(activityDedupeKey(event), event);
  }

  return Array.from(eventsByKey.values()).sort(compareActivityEvents).slice(0, 80);
}

function activityDedupeKey(event) {
  if (event.timeline?.index !== undefined) {
    return `timeline:${event.timeline.index}:${event.event}`;
  }

  const fallbackTimelineMatch = String(event.id ?? "").match(/^fallback-timeline:(\d+)$/);
  if (fallbackTimelineMatch) {
    return `timeline:${fallbackTimelineMatch[1]}:${event.event}`;
  }

  const artifact = event.artifact ?? event.runnerDiagnostic;
  if (artifact?.id) {
    return `artifact:${event.event}:${artifact.id}:${artifact.updatedAt ?? ""}`;
  }

  const fallbackArtifactMatch = String(event.id ?? "").match(
    /^fallback-artifact:([^:]+):(.*)$/,
  );
  if (fallbackArtifactMatch) {
    return `artifact:${event.event}:${fallbackArtifactMatch[1]}:${fallbackArtifactMatch[2]}`;
  }

  if (event.launcher?.launchId && event.launcher?.stream) {
    return [
      "launcher",
      event.launcher.launchId,
      event.launcher.stream,
      event.launcher.status ?? "",
      event.id ?? "",
    ].join(":");
  }

  return `${event.event}:${event.id ?? event.message ?? ""}`;
}

function compareActivityEvents(left, right) {
  const leftTime = Date.parse(left.timestamp ?? "");
  const rightTime = Date.parse(right.timestamp ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
    return Number.isFinite(leftTime) ? -1 : 1;
  }
  return String(right.id ?? "").localeCompare(String(left.id ?? ""));
}

function activityTitle(event) {
  if (event.event === "launcher_output" && event.launcher?.text) {
    return event.launcher.text.trim() || activityLabel(event.event);
  }
  if (event.message) return event.message;
  return activityLabel(event.event);
}

function activityLabel(eventName) {
  return formatStatus(eventName || "unknown");
}

function fallbackTimelineEventName(eventName) {
  if (eventName === "invocation_started" || eventName === "invocation_ended") {
    return eventName;
  }
  if (eventName === "milestone_status_changed") return "milestone_status_changed";
  if (
    eventName === "state_initialized" ||
    eventName === "phase_changed" ||
    eventName === "status_changed" ||
    eventName === "current_milestone_changed"
  ) {
    return "phase_changed";
  }
  return "timeline_event";
}

function schedulePolling() {
  stopPolling();
  state.pollTimer = window.setInterval(() => {
    void refreshDashboard({ forceDetail: shouldPollSelectedRun() });
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (state.pollTimer !== null) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function shouldPollSelectedRun() {
  if (!state.selectedRunId) return false;
  const summary = state.runs.find((run) => run.runId === state.selectedRunId);
  return Boolean(summary?.active || state.selectedRun?.active);
}

function statusText() {
  const warning = primaryRunIndexWarning();
  if (warning) return "Artifact root unavailable";
  const activeCount = state.runs.filter((run) => run.active).length;
  if (state.runs.length === 0) return "No runs";
  if (activeCount > 0) return `${state.runs.length} runs / ${activeCount} active`;
  return `${state.runs.length} runs`;
}

function primaryRunIndexWarning() {
  return state.runWarnings.find((warning) => {
    return warning.code === "artifact_root_missing" ||
      warning.code === "artifact_root_not_directory";
  }) ?? null;
}

function setStatus(text) {
  elements.statusLine.textContent = text;
}

function textNode(text) {
  return document.createTextNode(text);
}

function formatStatus(value) {
  if (!value) return "Unknown";
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatPhase(value) {
  if (!value) return "-";
  return value.replace(/_/g, " ");
}

function statusClass(status, active) {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  if (status === "needs_human_review") return "needs-human-review";
  if (active) return "active";
  return "neutral";
}

function isTerminalStatus(status) {
  return status === "passed" || status === "failed" || status === "needs_human_review";
}

function resumeIsTerminal(run) {
  return run?.status === "needs_human_review" ||
    run?.currentPhase === "needs_human_review";
}

function timelineTitle(event) {
  return formatStatus(event.event || "unknown");
}

function formatInputGoalSource(goalSource) {
  if (goalSource?.type === "file") {
    return goalSource.path ? `file: ${goalSource.path}` : "file";
  }
  return "prompt";
}

function formatInputMajorPlanSource(majorPlanSource) {
  if (majorPlanSource?.type === "seed") {
    const source = majorPlanSource.path ? `seeded from ${majorPlanSource.path}` : "seeded";
    const metadata = [formatBytes(majorPlanSource.sizeBytes), majorPlanSource.sha256]
      .filter(Boolean)
      .join(" / ");
    return metadata ? `${source} (${metadata})` : source;
  }
  return "runner";
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatRelativeTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  const timestamp = date.getTime();
  if (Number.isNaN(timestamp)) return value;

  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 30) return "now";
  if (seconds < 90) return "1m";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function formatBytes(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 1024) return `${value} B`;
  const kib = value / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}
