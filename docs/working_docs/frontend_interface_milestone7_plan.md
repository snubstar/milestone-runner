# Frontend Interface Milestone 7 Plan

## Milestone

Milestone 7: Optional Dependency Packaging

## Goal

Keep the dashboard optional and dependency-light while making local dashboard
usage obvious to operators.

## Packaging Decision

The first dashboard remains static HTML/CSS/JS served from `dashboard/public/`.
Do not add a frontend build tool for this milestone.

Rationale:

- The current UI does not require bundling, transpilation, routing, or a component
  framework.
- The dashboard backend currently uses Node built-ins plus existing project
  modules only.
- Adding frontend or backend dependencies now would make the optional dashboard
  harder to install and reason about without improving the user workflow.

## Scope

1. Keep root dependencies unchanged.
2. Keep `dashboard/public/index.html`, `dashboard/public/styles.css`, and
   `dashboard/public/app.js` as static browser assets.
3. Keep `src/dashboard/*` inside the existing TypeScript build because it has no
   dashboard-only third-party runtime dependencies.
4. Keep `npm run dashboard` as the only dashboard-specific package script unless
   a separate build or test command becomes necessary.
5. Document dashboard usage in `docs/how-to.md`.
6. Verify the normal CLI build/test path still works without any browser tooling.

## Non-Goals

- Do not add React, Vite, Next.js, Tailwind, or another frontend build system.
- Do not add dashboard-only backend dependencies.
- Do not introduce a separate `dashboard/package.json` or dashboard-specific
  `tsconfig` yet.
- Do not change dashboard API behavior, launch behavior, resume behavior, or UI
  interaction behavior.
- Do not make ordinary CLI users read dashboard-specific setup before they can
  run the orchestrator.

## Implementation Steps

1. Inspect `package.json`.
   - Confirm `dependencies` remains absent or unrelated to dashboard packaging.
   - Confirm `devDependencies` are still limited to existing project build/test
     needs.
   - Confirm the only required dashboard script is:
     - `dashboard`: `npm run build && node dist/dashboard/server.js`

2. Inspect dashboard imports.
   - Confirm `src/dashboard/*.ts` imports only Node built-ins, existing project
     modules, and dashboard-local modules.
   - Confirm `dashboard/public/app.js` uses browser APIs directly and does not
     import package-managed frontend modules.

3. Update `docs/how-to.md`.
   - Add a dashboard section after the CLI-focused run instructions, not before
     them.
   - Include:
     - `npm run dashboard`
     - default URL: `http://127.0.0.1:3737`
     - local bind behavior and operator token behavior at a high level
     - optional server flags:
       - `--port <port>`
       - `--host <host>`
       - `--artifact-root <path>`
       - `--static-root <path>`
       - `--cli-path <path>`
     - note that dashboard launch and resume use the same built CLI entrypoint
       as terminal runs.
     - note that dashboard failures do not block terminal CLI usage.

4. Avoid adding package scripts unless needed.
   - Do not add `dashboard:build`; there is no separate dashboard build.
   - Do not add `dashboard:test`; dashboard tests already run through the normal
     unit test build.

5. Run verification.
   - `npm run typecheck`
   - `npm run test:build`
   - `npm run build`
   - `npm run dashboard -- --help`

## Acceptance Criteria

- `docs/how-to.md` explains how to start and configure the dashboard.
- Existing CLI instructions remain first-class and valid.
- `package.json` does not introduce frontend tooling or dashboard-only
  dependencies.
- `npm run build` and `npm run typecheck` do not require a browser build.
- The CLI-only install/build path remains clean.
- Dashboard startup remains explicit through `npm run dashboard`.

## Review Checklist

- No new third-party dependency was added for Milestone 7.
- No dashboard documentation interrupts the basic CLI workflow.
- Dashboard usage docs mention localhost scope and token-protected mutating
  endpoints without exposing implementation details unnecessarily.
- Verification commands pass.
