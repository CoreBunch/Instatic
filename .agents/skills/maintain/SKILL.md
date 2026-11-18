---
name: maintain
description: What every change to Instatic owes the codebase beyond the code itself. Which docs to read before touching an area, which doc must be updated when you change it, which registries (E2E feature matrix, architecture tests) must be kept in step, and what "done" means here. Read this before starting any fix, feature, or refactor in Instatic, and again before opening the PR to check nothing was left behind. Companion to run-and-test, which covers booting and testing the project, and release, which builds the changelog from merged PRs when a release is prepared.
---

# Maintaining Instatic

Read this **before** starting a change, not after. Half of what it asks for is cheaper to do while the code is fresh than to reconstruct later.

`run-and-test` covers booting, driving and testing the project. This skill covers everything else a change owes: docs, registries, gates.

## Read before you change

`CLAUDE.md` at the root is the rulebook and wins over everything. Then read the doc for the area you are touching. Instatic's docs are genuinely accurate, so reading first is faster than reverse-engineering.

| You are touching | Read first |
|---|---|
| Anything, for orientation | `docs/architecture.md` |
| Admin or editor UI | `docs/editor.md`, `docs/design.md` |
| Server, routing, handlers | `docs/server.md` |
| Publishing, baked output, caches | `docs/features/publisher.md` |
| Content or data workspaces | `docs/features/content-workspace.md`, `docs/features/data-workspace.md` |
| Plugins, sandbox, manifests | `docs/features/plugin-system.md` |
| AI, agent, MCP | `docs/features/agent.md`, `docs/features/mcp-connectors.md` |
| Page tree, mutations, nodes | `docs/reference/page-tree.md` |
| DB access or migrations | `docs/reference/database-dialects.md` |
| Validation at a boundary | `docs/reference/typebox-patterns.md` |
| Shared UI primitives | `docs/reference/ui-primitives.md` |
| Hooks and memoization | `docs/reference/react-compiler.md` |
| A structural gate test | `docs/reference/architecture-tests.md` |

`docs/README.md` is the index when the table above does not cover it.

## Update the doc in the same change

**A doc that describes what you just changed is now wrong.** Fix it in the same commit. Not a follow-up, not a TODO. These docs are trusted precisely because they have stayed accurate.

`docs/CONVENTIONS.md` is the meta-doc and governs how to write them. Its rules in short:

- Two readers, in this order: **coding agents**, then humans skimming. Agents need concrete file paths, code shapes, and invariants.
- **If a sentence does not help one of those two make a decision or correct a misunderstanding, delete it.**
- Three doc types, and the folder decides which: top-level `docs/*.md` (system-wide, long-lived, rare additions, propose before adding), `docs/features/*.md` (one per user-recognisable capability), `docs/reference/*.md` (rules and patterns).
- Docs describe **what exists**, never what is planned, considered, or in flight. In-flight work belongs in `docs/plans/`.

Adding a whole new top-level doc is a decision, not a reflex. Propose it rather than creating one.

## Release notes are release work

Keep `CHANGELOG.md` out of every PR except the release-preparation PR. A feature or fix PR's existence does not guarantee that it will land in the next release.

The `release` skill owns the changelog. When preparing a release, it derives the release section from the PRs actually merged since the latest release tag.

## Registries that must stay in step

- **New E2E coverage** — register in `docs/e2e/feature-matrix.md` (row plus a note saying what the spec actually drives) and `docs/e2e/feature-validation.tsv` (14 columns). Next free ID in the family: `CONTENT-`, `ADMIN-`, `AI-`, `DASH-`.
- **A moved structural boundary** — the gate tests in `src/__tests__/architecture/` are the rule, not a suggestion. When your change legitimately moves a boundary, update the gate test in the same change and explain why in the PR. Never weaken a gate to make a diff pass.
- **A new allowlist entry** — several gates carry allowlists with `§` justifications (`button-primitive-usage.test.ts`, `boundary-validation.test.ts`). Adding an entry means writing its justification.
- **A schema change** — a new additive migration in **both** `migrations-pg.ts` and `migrations-sqlite.ts` with the same ID and the same semantic effect. Live installations run the migration runner on every pull, so nothing destructive, and never rewrite a committed migration.

## Verify

Use `run-and-test` for the gate. Run it once at the end, and read the exit codes rather than piping them into `tail`.

## Done means

1. The code works and you have watched it work.
2. The gate passes, run per `run-and-test`, with exit codes read directly.
3. Every doc describing what you changed is updated in the same change.
4. `CHANGELOG.md` is unchanged; the release-preparation PR owns release notes.
5. Any registry your change touches is updated: E2E matrix, architecture gate, allowlist, migrations.
6. Anything you could not verify is stated plainly in the PR rather than glossed over.
