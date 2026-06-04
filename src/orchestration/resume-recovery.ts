export type ResumeRecoveryMode =
  | "none"
  | "repair_failed"
  | "recheck_failed"
  | "retry_failed";

export const resumeRecoveryModes = new Set<ResumeRecoveryMode>([
  "none",
  "repair_failed",
  "recheck_failed",
  "retry_failed",
]);

export type ActiveResumeRecoveryMode = Exclude<ResumeRecoveryMode, "none">;

export function actionForResumeRecoveryMode(
  mode: ActiveResumeRecoveryMode,
): string {
  switch (mode) {
    case "repair_failed":
      return "repair_failed_milestone";
    case "recheck_failed":
      return "recheck_failed_milestone";
    case "retry_failed":
      return "retry_failed_milestone";
  }
}

export function flagForResumeRecoveryMode(
  mode: ActiveResumeRecoveryMode,
): string {
  switch (mode) {
    case "repair_failed":
      return "--repair-failed";
    case "recheck_failed":
      return "--recheck";
    case "retry_failed":
      return "--retry-failed";
  }
}
