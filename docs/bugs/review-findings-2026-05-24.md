# Outstanding Bugs Found on 2026-05-24

Review scope: current repository state at `/Users/federicoborsotti/Desktop/onthecomingera`.

## Findings

### Dashboard dry-run fails for valid large goal files

Status: fixed on 2026-05-24. Dashboard dry-run completion now captures up to 8 MiB while long-running live process diagnostics keep the 64 KiB cap. Regression coverage was added in `tests/unit/dashboard-run-launcher.test.ts`.

`goalFileMaxBytes` allows goal files up to 1 MiB, and the dry-run JSON report includes the full goal text. Dashboard dry-runs collect CLI stdout with a 64 KiB cap before parsing the JSON report. A valid large goal therefore gets truncated and returns `502 launch_report_malformed` or `resume_report_malformed`.

Relevant code:

- `src/inputs/initial-inputs.ts`: `goalFileMaxBytes`
- `src/cli/dry-run.ts`: dry-run report includes `details.goal`
- `src/dashboard/cli-process.ts`: `maxCapturedOutputBytes = 64 * 1024` and bounded stdout capture
- `src/dashboard/run-launcher.ts`: parses the bounded stdout as CLI JSON
- `src/dashboard/run-resumer.ts`: parses the bounded stdout as CLI JSON

Reproduction used during review: launching a dashboard dry-run with an 80 KiB goal file returned:

```json
{
  "ok": false,
  "statusCode": 502,
  "code": "launch_report_malformed",
  "message": "CLI dry-run JSON report was missing or malformed."
}
```

### Resume panel can show stale dry-run results for another run

Status: fixed on 2026-05-24. Resume result rendering now records the run id for dry-run, error, and started messages, and clears the result when the selected run changes or the visible result belongs to another run.

`renderResumeControls()` hides the result when no run is selected or when the selected run is terminal, but it does not hide or clear `resumeResult` when switching to a different resumable run that has no cached dry-run result. A previous run's resume dry-run result can remain visible for the newly selected run.

Relevant code:

- `dashboard/public/app.js`: `renderResumeControls()`

### Host validation blocks valid `--host 0.0.0.0` and likely IPv6 usage

Status: fixed on 2026-05-24. Host validation now normalizes bracketed IPv6 hostnames, accepts loopback names for loopback binds, and accepts IP-literal hosts plus localhost for wildcard binds while continuing to reject arbitrary DNS hostnames.

The dashboard CLI documents `--host`, but `hostIsAllowed()` only allows the literal configured host except for `127.0.0.1` and `localhost`. When the server binds to `0.0.0.0`, a normal request using `Host: 127.0.0.1:<port>` is rejected with `403 host_forbidden`. IPv6 loopback also appears fragile because URL host parsing returns a bracketed host while the configured host is compared literally.

Relevant code:

- `src/dashboard/server.ts`: dashboard usage text for `--host`
- `src/dashboard/server.ts`: `hostIsAllowed()`
- `src/dashboard/server.ts`: `hostForUrl()`

Reproduction used during review: starting the dashboard with `host: "0.0.0.0"` and requesting `/api/bootstrap` via `127.0.0.1` returned `403`.

### Milestone summaries contain hardcoded wrong text

Status: fixed on 2026-05-24. Implementation summaries now interpolate the active milestone id in the remaining-review sentence, with regression coverage for milestone 1 and milestone 2 summaries.

Every implementation summary ends with `Milestone 5 must review the diff and decide whether fixes are required.`, regardless of the active milestone or current workflow naming. This is misleading generated output.

Relevant code:

- `src/implementation/implementation-workflow.ts`: `formatMilestoneSummary()`

## Verification

Commands run during review:

```sh
npm run test:build
npm run typecheck
npm run build
```

Results:

- `npm run test:build` passed: 455 tests.
- `npm run typecheck` passed.
- `npm run build` passed.

`npm run test:real-codex` was not run because it depends on the external real Codex runner.
