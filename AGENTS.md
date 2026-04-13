# Repo-Specific Agent Rules

This document defines repository-level execution rules.

Global workflow governance (WIP limits, clarification protocol,
assumptions policy, complexity gate, contract governance)
is defined in the workspace root AGENTS.md.

If conflict exists:
- Root AGENTS.md governs workflow and process.
- This file governs tooling, commands, and repo-specific constraints.

---

# 1. Repository Overview

Name: cadenza-demo-2
Purpose: Multi-service IoT demo/mock project for exercising distributed Cadenza flows.
Owner Domain: Demo environment (non-authority; may contain outdated examples).

Boundaries:
- Do NOT modify other repos from here.
- Cross-repo changes must follow workspace multi-repo discipline.
- This repo should not be used as source of truth for runtime/schema contract design.

---

# 2. Local Development Commands

Use these canonical commands. Do not invent alternatives.

## Install

```bash
npm --prefix database install
npm --prefix database/iot-db-service install
npm --prefix frontend install
npm --prefix runner install
npm --prefix services/telemetry-collector install
npm --prefix services/anomaly-detector install
npm --prefix services/predictor install
npm --prefix services/alert-service install
```

## Build

```bash
npm --prefix database run build
npm --prefix database/iot-db-service run build
npm --prefix frontend run build
npm --prefix runner run build
npm --prefix services/telemetry-collector run build
npm --prefix services/anomaly-detector run build
npm --prefix services/predictor run build
npm --prefix services/alert-service run build
```

## Test

Not configured at repo root right now (no unified automated test script).

## Typecheck

```bash
npm --prefix database exec tsc --noEmit -p tsconfig.json
npm --prefix database/iot-db-service exec tsc --noEmit -p tsconfig.json
npm --prefix frontend run typecheck
npm --prefix runner exec tsc --noEmit -p tsconfig.json
npm --prefix services/telemetry-collector exec tsc --noEmit -p tsconfig.json
npm --prefix services/anomaly-detector exec tsc --noEmit -p tsconfig.json
npm --prefix services/predictor exec tsc --noEmit -p tsconfig.json
npm --prefix services/alert-service exec tsc --noEmit -p tsconfig.json
```

## Format

Not configured as a unified repo-level formatter command.

## Docker Demo Run

```bash
docker-compose up --build
```

For local debugging, prefer targeted rebuilds:

```bash
docker compose build <service>
docker compose up -d --force-recreate <service>
docker compose logs --tail 100 <service>
```

Prefer this over `docker compose up -d --build <service>` when iterating. Splitting build and recreate keeps the output much smaller and makes it easier to verify whether the rebuilt image actually got picked up.

The releaseable default is npm-published packages, not vendored tarballs.

When local cross-repo debugging requires temporarily switching back to vendored local `@cadenza.io/core` or `@cadenza.io/service`, do not pack/copy them manually. Use the guard scripts instead:

```bash
node scripts/local-cadenza-core.mjs sync
node scripts/local-cadenza-core.mjs verify
node scripts/local-cadenza-core.mjs rebuild <service>
node scripts/local-cadenza-service.mjs sync
node scripts/local-cadenza-service.mjs verify
node scripts/local-cadenza-service.mjs rebuild <service>
```

The scripts:
- run `npm pack` in the sibling `cadenza` / `cadenza-service` repo after a fresh build
- refresh every demo package that depends on the corresponding vendored tarball
- update each affected `package-lock.json`
- refresh installed `node_modules` with `npm ci --ignore-scripts` when present
- verify tarball and lockfile integrity before rebuild

For low-token debugging, prefer the cheapest proof loop:

```bash
docker compose up -d --build <service> > /tmp/<service>-build.log 2>&1
tail -n 40 /tmp/<service>-build.log
docker logs <container> 2>&1 | rg '<pattern>'
```

If CI uses a specific command, prefer that command.

# 3. Pre-PR Checklist (Repo-Specific)

## Before opening PR:

- [ ] Install succeeds for touched package(s)
- [ ] Typecheck passes for touched package(s)
- [ ] Build passes for touched package(s)
- [ ] No console logs left in committed code
- [ ] No commented-out code
- [ ] No debug artifacts

If this repo exposes contracts:

- [ ] Contract changes propagated per workspace rules

# 4. Environment & Configuration

Required environment variables observed in source/docker config:

- `CADENZA_DB_ADDRESS`: Address of CadenzaDB service.
- `CADENZA_DB_PORT`: Port of CadenzaDB service.
- `PUBLIC_ORIGIN`: Public per-service origin used for browser-reachable transport registration.
- `NUXT_PUBLIC_CADENZA_BOOTSTRAP_URL`: Public browser bootstrap URL used by the Nuxt frontend.
- `NUXT_PUBLIC_APP_ORIGIN`: Public frontend origin for local demo links and runtime config.
- `VITE_CADENZA_DB_BOOTSTRAP_URL`: Build-time browser bootstrap URL used by the `cadenza-ui` console image.
- `WEATHER_API_KEY`: Optional weather API key for predictor enrichment.
- `TRAFFIC_MODE`: Runner traffic mode (`low`/`high`).
- `DEVICE_COUNT`: Number of simulated devices.
- `DATABASE_ADDRESS`: Full Postgres connection string for DB services. For local Docker Compose, include `sslmode=disable`.
- `DATABASE_PORT`: Database port metadata kept in local env files.
- `DATABASE_USER`: DB user metadata kept in local env files.
- `DATABASE_PASSWORD`: DB password metadata kept in local env files.
- `DATABASE_NAME`: Intended DB name for the service; current runtime still derives DB names internally in some cases.
- `IOT_DB_SERVICE_ADDRESS`: IoT DB service host (used by some services).
- `IOT_DB_SERVICE_PORT`: IoT DB service port.

Local dev setup notes:

- This is a demo/mock stack; Docker Compose is the primary runnable path.
- Local browser access goes through the edge reverse proxy on `*.localhost`.
- The demo can include multiple browser-facing apps behind the edge proxy, including `frontend.localhost` and `console.localhost`.
- Some services/components may be outdated or intentionally simplified for demo traffic.

Never hardcode secrets.

Never commit .env files.

# 5. Testing Rules

Test expectations:

- Add focused tests only when stabilizing demo logic that is still actively used.
- For quick demo iteration, prioritize build + runtime smoke checks.

# 6. Contract Responsibilities

This repo is not a contract authority.

- If demo changes expose contract mismatches, raise issues in authority repos (`cadenza`, `cadenza-service`, `cadenza-db`).

# 7. Logging & Observability

- Demo logs can be verbose during local runs.
- Remove unnecessary debug noise before merging persistent changes.
- Avoid logging secrets.
- Keep high-volume flags such as `CADENZA_DB_TASK_DEBUG` disabled by default.
- During cross-repo debugging, prefer the published-package baseline unless the task specifically requires unpublished sibling-repo changes.
- If unpublished sibling-repo changes are required, use the local tarball helper scripts and keep `vendor/` artifacts untracked.
- If a runtime flow is shared across services, debug `cadenza-db-service` plus one representative service first instead of the full stack.
- Prefer direct SQL snapshots of `cadenza_db` over broad log streaming when checking sync convergence.
- Keep temporary traces scoped to one service or one failing flow and remove them once the branch is understood.

# 8. Performance & Safety Constraints

- Keep demo load parameters bounded (`TRAFFIC_MODE`, `DEVICE_COUNT`).
- Avoid unbounded fan-out in test/mock loops.
- Ensure background schedulers have clear stop/restart behavior.

# 9. Repo-Specific Anti-Patterns

Do NOT:

- Promote demo-only patterns as production guidance.
- Treat this repo as canonical for service/database contracts.
- Introduce new dependencies without clear demo need.

# 10. Documentation Discipline

If you modify:

- Docker topology
- Active demo services
- Runtime assumptions

Update:

- README.md
- This Agents.md
- Relevant demo docs/scripts
- See [docs/demo-lessons.md](./docs/demo-lessons.md) for topic-grouped lessons from the March 2026 stabilization work.

# 11. Execution Principle

Within this repo:

- Prefer clear, reproducible demo behavior over feature breadth.
- Prefer small changes that keep the stack runnable.
- If uncertain, trigger clarification per root policy.

## What I have learned in this discussion

- The repo now includes a Nuxt frontend that SSR-loads with the SSR inquiry bridge and then hydrates into a direct browser Cadenza runtime.
- The repo can also include the sibling `cadenza-ui` React console as a separate browser-facing service behind the same edge proxy.
- Browser-reachable demo services declare explicit public transports and are exposed locally through a Caddy proxy on `*.localhost`.
- The demo intentionally runs two `TelemetryCollectorService` instances so duplicate-instance routing is exercised on a high-traffic service.
- The runner remains internal-only and should not be treated as a browser-facing service.
- Demo-specific stabilization and debugging lessons are recorded in [docs/demo-lessons.md](./docs/demo-lessons.md).

When in doubt: stop and ask.

# Agents Notes: cadenza-demo-2

## What I have learned

- This repo is a multi-service IoT demo environment using Cadenza services.
- It is composed of multiple package roots (`database`, `runner`, and several `services/*`).
- Primary value is integration/demo traffic simulation, not contract authority.

## Current status assumptions

- Some parts are outdated and should be treated as mock/test scaffolding.
- Contract correctness should be validated against authority repos, not inferred from this demo.

## What I will keep learning in this discussion

- Which demo services are still actively used.
- Which flows should remain for automation smoke tests.
- How to reduce maintenance burden for outdated demo components.
