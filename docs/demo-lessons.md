# cadenza-demo-2 Lessons

This note captures lessons specific to `cadenza-demo-2` after the March 2026 stabilization work.

Use it alongside the workspace-level reference [/Users/emilforsvall/.codex/worktrees/5807/cadenza-workspace/docs/references/cadenza-development-lessons.md](/Users/emilforsvall/.codex/worktrees/5807/cadenza-workspace/docs/references/cadenza-development-lessons.md). The workspace reference explains general Cadenza practice; this file explains what is special about this demo.

## Sources

- [../README.md](../README.md)
- [../Agents.md](../Agents.md)
- [/Users/emilforsvall/.codex/worktrees/5807/cadenza-workspace/docs/decisions/2026-03-14-authority-sync-stabilization.md](/Users/emilforsvall/.codex/worktrees/5807/cadenza-workspace/docs/decisions/2026-03-14-authority-sync-stabilization.md)
- [/Users/emilforsvall/.codex/worktrees/5807/cadenza-workspace/docs/decisions/2026-03-15-frontend-socket-routing-and-runner-boundary.md](/Users/emilforsvall/.codex/worktrees/5807/cadenza-workspace/docs/decisions/2026-03-15-frontend-socket-routing-and-runner-boundary.md)
- [/Users/emilforsvall/.codex/worktrees/5807/cadenza-workspace/docs/decisions/2026-03-18-runtime-validation-debug-policy.md](/Users/emilforsvall/.codex/worktrees/5807/cadenza-workspace/docs/decisions/2026-03-18-runtime-validation-debug-policy.md)

## Demo Architecture And Intended Use

- This demo validates a distributed IoT flow across multiple Cadenza services, not only isolated service behavior.
- `cadenza-db-service` is the metadata authority service. `iot-db-service` is the business data service.
- The frontend has two modes:
  - SSR through the server-side inquiry bridge
  - a direct browser Cadenza runtime after hydration
- Browser-reachable services register public transports and are exposed through `edge` on `*.localhost`.
- `scheduled-runner` stays internal-only. It is part of the ingest path but not part of the browser transport surface.
- Manual browser emit and scheduled runner ingest exercise the same core ingest pipeline. When one fails, check the shared responder and sync path first.

## Bootstrap And Convergence Lessons

- `cadenza-db-service` should start first and get a short settle window before the other services.
- Clean-slate validation matters in this repo because stale authority rows can hide whether a fix is real.
- Browser-facing failures in this demo are often downstream symptoms of service-registry or bootstrap-sync problems rather than frontend-only bugs.
- The most useful authority checks during convergence are:
  - `service`
  - `service_instance`
  - `service_instance_transport`
  - `task`
  - `signal_to_task_map`
  - `intent_to_task_map`
- A healthy clean boot should show:
  - service instances for the active services
  - responder maps for `iot-telemetry-ingest`
  - frontend runtime reaching `browser runtime live`
- The scheduled runner should start its real loop from the local ready signal, not from mid-bootstrap meta activity.
- Bootstrap graph sync in this demo is sensitive to stale packaged images. A service can look “rebuilt” locally while still running an older bundled `@cadenza.io/service` inside the container.

## Frontend And Ingest Checks

- The frontend can look healthy while authority sync is still broken. Always verify responder availability, not only page rendering.
- The fastest proof loop for the browser path is:
  - load `http://frontend.localhost`
  - confirm `browser runtime live`
  - click `Emit telemetry intent`
  - confirm `telemetry` and `health_metric` row counts increase
- The scheduled runner is still a useful parallel signal because it exercises the same `iot-telemetry-ingest` responder path without involving the browser.
- `alert=0` is currently not the same class of issue as the earlier bootstrap and responder failures. Treat it as a business/tuning follow-up unless the alert service path itself breaks.

## Local Package And Docker Workflow

- This demo is highly sensitive to mixed local tarballs. One stale vendored `@cadenza.io/service` tarball can produce misleading runtime symptoms.
- When iterating locally against unreleased workspace packages:
  - run `yarn build`
  - run `npm pack`
  - wait for `npm pack` to finish
  - copy the tarball into the touched demo packages
  - refresh each touched lockfile
  - rebuild only the affected services
- Keep that chain serial. Do not overlap tarball refresh, lockfile update, image build, and container recreate.
- Prefer targeted rebuilds:
  - `docker compose build <service>`
  - `docker compose up -d --force-recreate <service>`
- Prefer file-backed build logs or short tailed logs over long streaming sessions.
- If a runtime symptom and the source code disagree, inspect the installed bundle inside the built image or running container before changing code again.
- During demo debugging, the real truth is often the package inside the container, not the repo checkout.

## Low-Token Debugging Workflow

- Use the smallest representative loop that still proves the shared path.
- For sync and authority issues, start with:
  - `cadenza-db-service`
  - one affected service such as `telemetry-collector` or `iot-db-service`
- Prefer direct SQL snapshots over broad log streaming when checking convergence.
- Use temporary traces only when the SQL snapshot leaves one specific unanswered question.
- Scope each temporary trace to one service, one flow, or one environment flag, and remove it as soon as the branch is understood.
- When Docker gets unstable, stop widening the loop. Rebuild one service, prove one path, and only then expand again.

## Runtime Stability Lessons

- Demo-local `SIGTERM` handlers can silently bypass the shared graceful shutdown path. If the runtime owns shutdown, app services should not fight it with their own exit logic.
- For graceful stop and restart behavior, a direct awaited authority update is more reliable than a fire-and-forget shutdown signal.
- Residual authority noise after bootstrap is often easier to isolate by checking whether it continues after a short quiet window. Some startup errors are only transient leftovers from earlier passes.
- Not all remaining noise after a fix means the same bug still exists. In this demo, resolving one blocker repeatedly exposed a narrower one behind it, so the right next move was usually to identify the new sample set instead of retuning the old fix.

## Current Non-Blocking Notes

- `alert` generation is still a follow-up area and should not be used as the first indicator of bootstrap health.
- Some residual runtime noise can appear later in runner logs without blocking the main ingest and prediction writes.
- If the browser path regresses, verify authority rows and responder maps before changing frontend code.
