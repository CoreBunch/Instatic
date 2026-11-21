---
name: instatic-user-e2e
description: Run user-facing Instatic E2E audits with a real browser and disposable local data. Use when asked to test the app as a user, run an agent-browser pass, perform a fresh-install smoke test, audit UX friction, verify setup/login/edit/publish/public-page flows, retest E2E issues, or update the Instatic E2E protocol and feature matrix.
---

# Instatic User E2E

## Overview

Use this skill to operate Instatic like a real user through the browser, record product-quality findings, and keep durable run logs. This is not a replacement for `bun test`; it covers the gaps that unit, API, architecture, and happy-dom tests cannot see.

## Core Rule

Treat browser-observed behavior as primary evidence. Use code, database, API, or localStorage inspection only to reset the environment, unblock the run, or triage an issue already observed through the UI.

## Required References

- Read `docs/e2e/protocol.md` before running or changing the protocol.
- Read `docs/e2e/feature-matrix.md` before choosing scenarios.
- Use `docs/e2e/run-log-template.md` when writing a new run log.
- Use available browser tooling for browser control.

## Default Scope

If the user does not name a scope, run the Core Owner Lifecycle:

1. Fresh install setup.
2. Owner login/logout.
3. Open the editor.
4. Create or edit a page.
5. Add and style basic content.
6. Save/reload persistence check.
7. Publish.
8. Visit the public page as a non-admin user.

## Environment Setup

Prefer an isolated SQLite database and upload directory for each run:

```sh
DATABASE_URL=sqlite:./.tmp/e2e-agent.db \
UPLOADS_DIR=./.tmp/e2e-uploads \
bun run dev
```

Before deleting data, verify the target is disposable:

- Safe: `.tmp/e2e-*`, `.tmp/dev.db`, temporary uploads under `.tmp/`.
- Unsafe without explicit user instruction: production-looking Postgres URLs, non-temporary upload directories, checked-in fixtures.

If ports are busy, inspect them and avoid killing processes you did not start unless the user explicitly gave control of the running app. When possible, use the already-running local app and log the DB/reset limitation.

## Run Workflow

1. Record repo state: current branch, HEAD SHA, and whether the worktree is dirty.
2. Select scenario rows from `docs/e2e/feature-matrix.md`.
3. Reset only disposable data for the run.
4. Start or identify the local app URL, usually `http://localhost:5173/admin`.
5. Use the browser as a user. Prefer visible labels and accessible names over test IDs or internal selectors.
6. Capture screenshots at the required proof points in `docs/e2e/protocol.md`, plus any time a visual issue or confusing state appears.
7. Log every scenario result in `docs/e2e/runs/YYYY-MM-DD-<scope>.md`.
8. File issues inside the run log before investigating implementation details.
9. Summarize blockers, top issues, and recommended next fixes.

## Finding Rules

Report more than hard failures. Include:

- Bugs.
- UX friction.
- Wrong, missing, or misleading labels.
- Missing loading, saving, success, or error feedback.
- Accessibility blockers visible through keyboard or snapshot use.
- Visual overlap, clipping, layout jumps, and responsive breakage.
- Data loss, unexpected persistence, or draft/public leakage.
- Performance stalls that a normal user would notice.

Severity:

- `P0`: data loss, security exposure, or app-wide unusability.
- `P1`: blocks a core user journey.
- `P2`: user-visible defect or serious friction with a workaround.
- `P3`: polish, wording, low-risk visual issue, or minor friction.

Scenario results:

- `Pass`: user goal completed cleanly.
- `Pass with friction`: goal completed, but the experience needs product attention.
- `Fail`: user goal did not complete.
- `Blocked`: run could not proceed due to environment or upstream blocker.
- `Needs retest`: fix landed or result was inconclusive.
- `Product question`: behavior may be intentional, but needs a decision.

## Issue Format

Use this shape in run logs:

```md
### E2E-YYYYMMDD-01: Short Title

- Severity: P1
- Category: Bug
- Feature: Publish
- Status: Open
- Scenario: PUB-001
- Environment: local SQLite, Chrome, desktop 1440x900
- Evidence: screenshot path, URL, console/network note if relevant

Steps:
1. ...
2. ...

Expected:
...

Actual:
...

Notes:
...
```

## Boundaries

- Do not turn this into low-level Playwright-style assertion writing unless the user asks to promote a stable scenario into automation.
- Do not skip logging because an issue seems obvious.
- Do not mark a scenario as passed based only on API/database state.
- Do not fix findings during the same audit unless the user explicitly asks for a fix pass.
- Do not reset or rewrite unrelated worktree changes.
