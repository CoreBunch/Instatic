---
name: release
description: How Instatic is released, and what an agent must check before letting a release go out. Releases fire on a pushed `v*` tag and are fully automated by GitHub Actions. Covers the pre-tag preparation PR, building the changelog from merged PRs, the tag push, what Actions does afterwards, and the ordering rule that security advisories publish last. Use this skill when a maintainer asks to cut, prepare, or publish a release, when a version needs bumping, when a changelog section needs creating, or when checking whether main is releasable.
---

# Releasing Instatic

The version lives in `package.json` and releases are **tag-triggered**. `.github/workflows/release.yml` fires on `v*.*.*`, and everything it publishes is built from whatever `main` looked like at that tag. There is no undo: a pushed tag builds and pushes images to GHCR and creates a GitHub Release. Get `main` right first.

The full maintainer reference is [`docs/deployment/release-workflow.md`](../../../docs/deployment/release-workflow.md). This skill is the agent's operating procedure around it; when the two disagree, the doc wins and this file needs updating.

## Never tag without being asked

Cutting a release is the maintainer's decision, not an inference from "the work looks done". Prepare, present, and wait. Pushing a tag is the single most irreversible action in this repo.

## Step 1 — Establish the release range and version

```bash
git tag --sort=-version:refname | head -3 # last shipped
grep -m1 '"version"' package.json
head -12 CHANGELOG.md
```

The latest release tag is the lower bound. The release preparation covers everything merged into `main` after that tag and nothing still sitting in an open PR.

Ask the maintainer for the version if it was not supplied. Never invent the number: patch versus minor is a judgement about impact, and it is theirs.

## Step 2 — Build the changelog from merged PRs

Changelog authoring happens here, not in feature or fix PRs. Start from the PRs merged into `main` since the latest release tag. Use GitHub's merged-PR data as the roster and reconcile it with the commit range so direct commits or unusual merge strategies cannot disappear.

```bash
git log v<last>..origin/main --oneline
gh pr list --state merged --base main --limit 200 \
  --json number,title,body,mergedAt,url,labels,mergeCommit
```

For every PR whose merge commit falls in that range, inspect the PR body and the merged diff. Record either its changelog entry or the concrete reason it has no user-visible release impact. Account for direct commits in the range the same way. Internal refactors, test-only changes, documentation, CI, and dependency bumps with no user-visible effect normally earn no entry.

### How to write an entry

The changelog is read by people deciding whether to upgrade, not by the people who wrote the code. A PR body argues a change to a reviewer; a changelog entry tells a user what is different. They are different documents, and pasting the first into the second is the failure mode to avoid.

**One or two sentences per entry. Hard limit.** A fix gets one sentence for what was broken and is now fixed. A feature gets one sentence for what it does, and at most a second for the part a user would otherwise have to discover. If an entry needs more than that, the detail belongs in the feature doc under `docs/`, and the entry can point there.

Write one entry per user-visible outcome, not necessarily one per PR: a PR that fixes two unrelated symptoms gets two entries, and a feature split across three PRs gets one.

What belongs in an entry:

- The symptom a user recognises. "A device that signed in seconds ago could read as hours old", not "SQLite writes `YYYY-MM-DD HH:MM:SS` and V8 parses that shape as local time".
- What they can now do, in the words they would use for it. "Share a preview link with someone who has no admin account."
- Plain nouns from the product, not from the codebase. Panels, pages, plugins, publishing. Not modules, comparators, adapters, or relays.

What never belongs:

- Root-cause mechanics, function and file names, internal type or module names, migration IDs, capability strings, test counts, line counts.
- The engineering argument for the approach taken, alternatives rejected, or why the change was scoped as it was.
- Anything a user cannot see, act on, or verify.

Use past tense for what was fixed and present tense for what the product now does. Name and credit security advisories when applicable; those entries may run longer, because a GHSA is read by someone assessing exposure and needs the affected surface and the precondition stated.

Before committing the section, reread it as a user who has never seen the code. Any sentence that only makes sense if you have is a sentence to cut.

Create the new dated section at the top of `CHANGELOG.md` and order its headings:

1. `### Features`
2. `### Bug fixes`
3. `### Security`
4. `### Other changes`

Omit empty headings. Put behavior changes and user-visible maintenance that are neither features nor fixes under `Other changes`. If an undated section remains from the former rolling-changelog workflow, treat it only as input: rebuild the release section from the merged-PR roster and remove duplicates or entries for unmerged work.

## Step 3 — The preparation PR

One PR, titled `chore(release): prepare <version>`, containing exactly:

| File | Change |
|---|---|
| `CHANGELOG.md` | add the complete dated release section built from merged PRs: `## <version> - <YYYY-MM-DD>` |
| `package.json` | `version` bumped to match |
| `docs/deployment/README.md` | version-pinned image tag |
| `docs/deployment/docker-image.md` | version-pinned image tag |
| `docs/deployment/railway.md` | version-pinned image tag |

Those three docs deliberately pin a semver image tag and go stale silently, which is why they are listed rather than left to memory. The Render blueprints stay on `:latest`; `scripts/build-release-bundle.ts` rewrites the bundle copies to the semver tag automatically.

Nothing else belongs in this PR. Merge it before tagging so the tag points at a commit describing the release it is.

## Step 4 — Tag, once approved

```bash
git checkout main && git pull
git tag v<version>
git push origin v<version>
```

Actions then runs `bun run build`, `bun test`, `bun run lint`, builds the `Dockerfile`, pushes `ghcr.io/corebunch/instatic` at `<semver>`, `<major>.<minor>` and `latest`, creates the GitHub Release, and uploads `instatic-<version>-release-bundle.tar.gz` plus the per-platform `instatic-server-<version>-<platform>.tar.gz` server artifacts.

Watch it. A tag whose verify job fails has still moved the tag, so the fix is a new patch version rather than a retag.

## Step 5 — After the image is published

When the non-versioned template configuration changed, copy the two Render blueprints into their template repositories as root `render.yaml`:

```txt
corebunch/instatic-render-sqlite
corebunch/instatic-render-postgres
```

## Security advisories publish last

The release workflow fires **only on tags**. A GHSA published before its fix is tagged and imaged announces a vulnerability that users cannot yet upgrade away from. Order is: prepare, tag, wait for the image to appear on GHCR, then publish the advisory.

GHSA metadata for this repo uses `ecosystem: other` and names the GHCR image, not an npm package.

## Before you present the release

1. `main` is green on the gate from `run-and-test`.
2. The changelog section is dated, built from every PR merged since the latest release tag, grouped with features before bug fixes, and contains no unmerged work.
3. Every entry is one or two sentences, in product words, with no root-cause mechanics or internal names. Reread the section as a user who has never seen the code.
4. `package.json` matches the version.
5. The three deployment docs pin the new tag.
6. Any security advisory is drafted but **not** published.
7. A maintainer has said to tag it.
