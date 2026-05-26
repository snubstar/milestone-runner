import type {
  CheckCommandResult,
  CheckRunnerOptions,
  CheckRunResult,
} from "./check-types.js";

export async function runChecks(options: CheckRunnerOptions): Promise<CheckRunResult> {
  const now = options.now ?? Date.now;

  if (options.checks.length === 0) {
    return {
      ok: true,
      results: [],
      report: "No configured checks.\n",
    };
  }

  const results: CheckCommandResult[] = [];
  for (const check of options.checks) {
    const start = now();
    const commandResult = await options.commandRunner.run({
      ...shellRequestForCheck(check),
      cwd: options.cwd,
    });
    const end = now();

    results.push({
      command: check,
      exitCode: commandResult.exitCode,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      durationMs: Math.max(0, end - start),
      ...(commandResult.error ? { error: commandResult.error } : {}),
    });
  }

  return {
    ok: results.every((result) => result.exitCode === 0),
    results,
    report: formatCheckRunReport(results),
  };
}

export function formatCheckRunReport(results: CheckCommandResult[]): string {
  if (results.length === 0) {
    return "No configured checks.\n";
  }

  const passed = results.every((result) => result.exitCode === 0);
  const sections = [
    "Check results",
    "",
    `Overall: ${passed ? "passed" : "failed"}`,
    "",
  ];

  results.forEach((result, index) => {
    sections.push(
      `## Check ${index + 1}: ${result.command}`,
      "",
      `Exit code: ${formatExitCode(result.exitCode)}`,
      `Duration: ${result.durationMs}ms`,
    );

    if (result.error) {
      sections.push(`Error: ${result.error}`);
    }

    sections.push(
      "",
      "Stdout:",
      formatOutput(result.stdout),
      "",
      "Stderr:",
      formatOutput(result.stderr),
      "",
    );
  });

  return `${sections.join("\n").trimEnd()}\n`;
}

function shellRequestForCheck(check: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: "cmd",
      args: ["/d", "/s", "/c", check],
    };
  }

  return {
    command: "sh",
    args: ["-lc", check],
  };
}

function formatExitCode(exitCode: number | null): string {
  return exitCode === null ? "null" : String(exitCode);
}

function formatOutput(output: string): string {
  const trimmed = output.trimEnd();
  return trimmed.length > 0 ? trimmed : "(empty)";
}
