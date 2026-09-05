# Site branches

Edit the whole site — pages, components, layouts, data rows, tables, and the
shell — on a private copy, share it as a preview link, and merge it back into
main with a three-way review. Publishing only ever happens on main.

---

## TL;DR

- A **branch** is a full copy of the site's content under a branch id. `main` is the live site and always exists.
- Every content row keeps its **logical id** on every branch. The physical primary key is `physicalId(branchId, logicalId)` — the logical id itself on main, `<branch>:<logical>` elsewhere (`src/core/branches/ids.ts`). Nothing in stored JSON changes shape between branches.
- The **request scope** decides which branch a CMS request reads and writes: the `X-Instatic-Branch` header, resolved once in `server/handlers/cms/index.ts` into a `BranchScope` (`server/branches/scope.ts`) and threaded into every repository call. Publishing, scheduling, public routes, forms, plugins, the dashboard, and headless MCP reads pin `MAIN_SCOPE`.
- The admin tab's active branch lives in `useBranchStore` (`src/admin/state/branchStore.ts`), persisted per tab in `sessionStorage` (`instatic-active-branch`, seeded from `?branch=`). The store registers the header with `@core/http`, and the Site / Content / Data workspaces remount on a switch.
- **Publish and schedule are disabled on a branch** with the reason inline (`useBranchPublishGate`); the server answers `409` if a request slips through.
- **Preview links** (`/_instatic/preview/<token>`) set an HttpOnly cookie; while it names a live link, every public GET renders the branch's draft with a banner (`server/publish/branchPreview.ts`).
- **Merge** (branch → main) and **Update** (main → branch) are the same three-way merge over `site_branch_bases` (`server/branches/merge.ts`): field-level where both sides moved different fields, a reviewer decision where they moved the same one. An update never writes main.
- **Merge review** (`/admin/branches/:id/review`) is where merging happens: one row of tiles per planned change, its comment thread beside it — pages as before/after renders with the changed nodes outlined, entries as field tables, tables as schemas, files as line diffs — each with its own comment thread; anyone with `site.read` can ask for a merge, comment, and read the plan, a branch manager declines or merges from the page's footer.
- **Version history** lists a row's published versions and restores one into the draft on the active branch (`data_row_versions`, `GET/POST …/data/rows/:id/versions`).
- Capabilities: `site.branches.create` forks a branch and covers the branches you forked (rename, delete, update from main, preview links); `site.branches.manage` covers every branch plus merging into main and declining a request, and does not fork on its own. Owner and Admin hold both. The one rule is `canActOnBranch` in `@core/branches`, used by the server gates and the UI alike. Audit: `branch.*`, `version.restore`.

---

## Where the code lives

```
src/core/branches/
├── ids.ts             MAIN_BRANCH_ID, id pattern, slugify, physicalId / logicalIdOf
├── schemas.ts         SiteBranch, BranchPreview, MergePlan, request/response envelopes
├── access.ts          canActOnBranch / canMergeBranches — who may act on a branch (server gates + UI)
├── threeWayMerge.ts   mergeJson(base, ours, theirs) — the pure JSON three-way merge
└── index.ts           barrel (gated: no deep imports)

server/branches/
├── scope.ts           BranchScope, MAIN_SCOPE, resolveBranchScope(req, db), BRANCH_HEADER
├── contentHash.ts     rowContent / tableContent / siteContent / fileContent projections + hashes + schemas
├── entities.ts        collectBranchEntities — shell, files, tables, rows as one keyed map
├── changeDetail.ts    describeChange — per-change detail for the review (fields, page tree diff, file text)
├── fork.ts            forkBranch — copy shell, tables, rows; record bases (one transaction)
├── deleteBranch.ts    deleteBranch — rows, tables, shell, collab docs, registry row
├── merge.ts           planBranchMerge / applyBranchMerge / undoBranchMerge (merge + update directions)
├── review.ts          merge requests, comments, branch content hash (stale detection), last merge
└── previewLinks.ts    tokens, cookie, resolvePreviewCookie, entry/exit paths

server/repositories/
├── branches.ts        site_branches registry
├── branchBases.ts     site_branch_bases — base hash + content per entity
├── branchPreviews.ts  site_branch_previews — hashed tokens, one active link per branch
├── branchReviews.ts   site_branch_merge_requests + site_branch_review_comments
└── branchMerges.ts    site_branch_merges — one record per apply with every entity's before-images; undo reads it

server/handlers/cms/branches.ts   /admin/api/cms/branches[/…] endpoints
server/publish/branchPreview.ts   render a branch draft for a public URL
server/publish/branchPreviewAssets.ts  in-memory runtime bundles for previews
server/publish/branchReviewRender.ts   one page as main or the branch renders it, node ids stamped
server/publish/publicRoutes.ts    dispatcher tail: preview link, public route, 404

src/admin/state/branchStore.ts            active branch, registry, switcher UI state, publish gate
src/admin/shared/BranchSwitcher/          chip + palette, context strip, manage / delete / update dialogs
src/admin/pages/branches/                 the merge review page (rows of tiles, page compare, threads)
src/admin/shared/VersionHistoryDialog/    published versions + restore
src/admin/spotlight/commands/branches.ts  Switch / Create / Manage / Switch to main
src/admin/spotlight/providers/branchesProvider.ts  "Switch to <branch>" rows
```

---

## The model

### Ids

| Term | Value |
|------|-------|
| Branch id | `/^[a-z0-9][a-z0-9.-]{0,63}$/` — never contains `:`; `main` is reserved |
| Logical id | The id content code sees everywhere (page ids in trees, `rowId` in collab, row ids in the API) |
| Physical id | `physicalId(branchId, logicalId)`: the logical id on main, `` `${branchId}:${logicalId}` `` elsewhere |
| Site shell logical id | `default` (`SITE_SHELL_LOGICAL_ID`) — physical `default` on main, `<branch>:default` elsewhere |

`branch_id` and `logical_id` are columns on `site`, `data_tables`, and `data_rows`. `logical_id` is a **generated column** (SQLite virtual, Postgres stored) derived from `id` and `branch_id`, so no insert can get it wrong. The physical-id scheme exists in exactly one place (`src/core/branches/ids.ts`) and the gate `branch-scope-repositories.test.ts` keeps it there.

Every repository statement that binds a physical id ALSO pins `branch_id` to the scope (the hydrated row select appends the predicate itself). On main the physical id equals the logical id, so without that predicate a main-scoped call could reach a branch row through its `<branch>:<logical>` key — e.g. publish a branch row as main's. `branchScope.test.ts` pins this down.

Foreign keys stay physical, so main's rows, versions, redirects, and media references are untouched by branching. Branch rows point at branch tables; deleting a branch deletes its rows and tables outright (nothing on main references them).

### Scope

`BranchScope { branchId }` is an explicit parameter on every repository function that touches a branched table (gated). The CMS dispatcher resolves it once:

```ts
const scope = await resolveBranchScope(req, db)   // MAIN_SCOPE, or 400 / 404 { code: 'branch_not_found' }
```

Paths that only make sense for the live site pass `MAIN_SCOPE`: publishing, the scheduler, public routes, forms, plugin content hooks (`content.entry.*` emitters return early off main), the dashboard, and MCP headless reads. The AI tool context carries `branch` from the chat request so editor-side AI reads follow the tab. The export download is a form POST that cannot carry the header, so it names the branch in its body (`ExportRequest.branchId`, resolved by `resolveBranchScopeById`).

### Collab

Doc ids carry the branch: `page:<branch>:<rowId>`, `component:<branch>:<rowId>`, `layout:<branch>:<rowId>`, and one `site:<branch>` shell doc per branch (`src/core/collab/docIds.ts`). The relay keeps a roster per branch and refuses docs for unknown branches (`BranchGoneError`, admission in `server/collab/relayBranches.ts`). Deleting a branch calls `relay.forgetBranch(branchId)` FIRST: the id is tombstoned (refused even while its registry row still exists), its queued resets are dropped, and its resident docs are evicted; the rows are then deleted on the collab-aware write lane. A socket that rebinds meanwhile receives a `FRAME_RESET` with reason `gone`, which the client answers by leaving the branch (`fallBackToMain`) instead of rebinding. `rememberBranch` lifts the tombstone when the id is forked again, or when the delete transaction failed after tombstoning — and, still under the tombstone, drops every stored document of the branch so the next open reseeds from its rows: a reset dropped while it was tombstoned (an HTTP save, a data-workspace edit) may have left a blob behind the rows. If that purge fails (the database outage that failed the delete) the branch stays refused and the next open retries it. Sockets still bound to a forgotten branch keep their ref counts held, exactly as across a reset, so their late closes never evict a doc reopened after the revival. The tab that asked for the deletion (or for a merge that deletes) expects that `gone`: it leaves the branch quietly and reports once, from its own request. The editor binding mints ids through `collabBranchId()` (`src/admin/pages/site/store/slices/site/collabBranch.ts`), set by `usePersistence` before the site loads; a branch switch clears the store's site first so nothing renders or edits under the wrong branch while the new one loads.

### Fork

`POST /admin/api/cms/branches { name, id?, fromBranchId? }` runs `forkBranch`: it flushes the relay first (so open editors' latest edits are in the rows) and then, on the collab-aware write lane, runs one transaction copying the shell (seq reset), every non-deleted table, and every non-deleted row (`scheduled` becomes `draft` — only main publishes). The **bases** — `{ kind, logicalId, contentHash, content }` of the projections in `contentHash.ts` — are recorded from MAIN's content at fork time whatever the branch was forked from, because merges and updates always compare against main: a branch forked off another branch sees the parent's additions as its own pending changes. Media, plugins, users, versions, and redirects are shared with main and never copied. Collab blobs are not copied — the relay seeds a branch doc from its row JSON on first open.

---

## The UI

Everything lives in the shared toolbar (`src/admin/pages/site/toolbar/Toolbar.tsx`), so it is present on every admin route:

- **Chip** (`BranchChip`) next to the site brand — always icon-only, tinted with the branch accent off main (the context strip right above it carries the name, so the chip does not repeat it). Opens a palette: search first (Enter switches to the first match, or starts creating when nothing matches), then *Current* and *Recent* (main first, then by `updatedAt`), then *Create branch…* (an in-place form: name → slug preview, start from main or the current branch) and *Manage branches…*.
- **Context strip** (`BranchContextStrip`) above the toolbar while on a branch, painted `--bg-surface-2` with the identity tint (`pillAccent(branch.id)`) on the icon and name only. Actions: *Share preview* / *New preview link*, *Review merge…* (*Request merge…* without `site.branches.manage`; both only open the review page, where the footer carries the actual merge, and the button is hidden while on `/admin/branches/…`) — every other strip action is also available to the branch's creator, not only managers, and a menu with *Update from main…*, *Rename…*, *Revoke preview link*, *Switch to main*, *Delete branch*.
- **Manage dialog** (`ManageBranchesDialog`) — search by name or id, open, rename inline, delete, create.
- **Update dialog** (`UpdateBranchDialog`) — the update plan grouped by Site / Tables / entries per table, `New` / `Changed` / `Removed` badges, a two-way choice per conflict. Merging has no dialog: it happens on the review page (below).
- **Delete** always confirms (`DeleteBranchDialog`) and steps up.
- **Publish controls** on a branch: the site Publish button, the Content and Data publish groups, the data grid's row menu and bulk bar, and the Content settings status select all disable with `BRANCH_PUBLISH_REASON` inline. The Spotlight `editor.publish` command hides on a branch.
- **Spotlight**: group `branches` — *Switch branch…*, *Create branch…*, *Switch to main*, *Manage branches…*; typing a branch name lists *Switch to <name>*.
- **Branch gone**: a `404 { code: 'branch_not_found' }` on any request drops the tab back to main with a toast (`registerApiErrorListener` in `@core/http`).

---

## Preview links

| Endpoint | Gate | Effect |
|----------|------|--------|
| `POST /admin/api/cms/branches/:id/preview` | `canActOnBranch` (manager, or the creator of this branch) | Issues a new token (retiring the previous one) and returns `{ url, preview }`. Only the SHA-256 is stored. |
| `GET …/preview` | `site.read` | `{ preview }` — the active link's metadata, or `null`. |
| `DELETE …/preview` | `canActOnBranch` | Revokes. |
| `GET /_instatic/preview/<token>` | public | Validates, sets `instatic_branch_preview` (HttpOnly, SameSite=Lax, Path=/, 30 days) and redirects to `/`. A dead token clears the cookie instead. |
| `GET /_instatic/preview/exit` | public | Clears the cookie. |

While a request carries a live cookie, `tryServePublicRoute` hands the URL to `renderBranchPreview`, which mirrors the editor's runtime preview rather than the publish path: the page (or entry template, for `/<route-base>/<slug>` rows on the branch) is composed from the branch's draft, loops read the branch's DRAFT rows (post types have no published versions off main — `fetchPublishedDataRowItems({ drafts: true })` skips only `unpublished` rows), request-dependent nodes render inline with the request in hand (`publishPage({ dynamicNodes: 'inline' })`) instead of becoming holes hydrated from main, CSS is inlined, runtime scripts are bundled on demand and served from memory under `/_instatic/assets/preview/<build>/…`, plugin frontend assets are injected, and no publish hook fires. Responses are `no-store` + `noindex` with a fixed banner ("Previewing branch … — not live" + exit link). A path the branch does not have falls through to the 404 page, never to main's published page.

---

## Merge and update

Both directions run `planBranchMerge(db, branchId, direction)` over three snapshots per entity — the base (from `site_branch_bases`), `into`, and `from`:

| Situation | Outcome |
|-----------|---------|
| Only `from` moved | Applied (`create` / `update` / `delete`) |
| Only `into` moved | Nothing to do |
| Both moved, different fields | `mergeJson` merges field by field (`src/core/branches/threeWayMerge.ts`) |
| Both moved, same field | Conflict at that path — the reviewer picks `into` or `from` for the whole entity |
| Deleted on one side, changed on the other | Conflict (`(deleted)`) |

Row content is `{ tableId, cells, slug }` — **never `status`**: a merge changes drafts, not what is live. The site content is `{ name, shell }` without id, timestamps, **or files**; every site file is an entity of its own (`file:<file id>`, content = the file minus id and timestamps), so two people editing different files never conflict and a file conflict names the file. The merged shell is re-validated with `validateSite` before it is saved; file writes read the shell, replace or drop the one file, and save it back. Table content is the schema fields.

Every planned change carries `detail` (`server/branches/changeDetail.ts`, schema `MergeChangeDetailSchema`): changed fields as display text with `before` (the receiving side) and `after`, a node-level tree diff (`added` / `changed` / `removed` ids with labels) for rows whose `body` is a node tree — two nodes compare as the editor would load them (`parsePageNode`, children excluded), so a row written through the data API with empty or missing style maps does not read as changed; the label is the node's editor name when it has one, else its module — the schema field statuses for a table, and both texts for a file. It is computed from the same projections the merge compares, so the review never disagrees with the plan.

`applyBranchMerge` flushes the relay, re-plans against live data (an unresolved conflict aborts before any write), then in one transaction writes each result to `into`. A **merge** also mirrors the result onto the branch so both sides agree afterwards, and the base becomes the result. An **update** never writes main: the branch takes the result and the base becomes main's content as of the update, so the branch's own changes stay pending. Entities identical on both sides whose base is stale move their base forward too, so a later edit on one side is not reported as a conflict. Row writes use the repositories with `collabInternal`; after commit the row/shell write notifications fire (open editors reset and reload) and, when main received rows, the `content.entry.*` plugin hooks fire for them. Table creates run before rows and restore a soft-deleted table under the same id; table deletes run last and abort the merge (`MergeApplyError`) when the table still has rows.

Endpoints: `GET|POST /admin/api/cms/branches/:id/merge` and `…/update`. `GET` (the plan) needs `site.read` — the review page shows it to whoever can read the site; `POST …/merge` needs `site.branches.manage`; `POST …/update` needs `canActOnBranch` (a manager, or the branch's creator); both step up. `POST` body: `{ resolutions?: Record<key, 'into' | 'from'>, deleteBranch?: boolean }` → `{ plan, branchDeleted }`; unresolved conflicts answer `409 { code: 'merge_conflicts', keys }`. A successful merge closes the branch's open merge request as `merged`.

**Undo.** Every apply is recorded in `site_branch_merges` (migration `029_site_branch_merges`, `server/repositories/branchMerges.ts`): per touched entity, its before-image on the target, on the branch (a merge mirrors), and in the bases, plus the hash of what was written. `POST …/merge/undo` and `…/update/undo` (same gates and step-up as the apply) reverse the latest apply that has not been undone: the target goes back to before, the bases with it, and after a merge the branch too — for every entity still holding the merged content, so an edit made on the branch since is kept. It is refused with `409 { code: 'merge_undo' }` when the *target* moved since the apply; an undo never silently discards work that landed after a merge. Undoing a merge reopens the request it answered. A merge that deleted the branch records nothing (there is nothing to restore into), which is why the review's *Delete branch after merging* defaults to off. The response is `{ merge, restoredCount }`; the apply's envelope carries the `merge` record (`null` when the branch was deleted) so the client can offer *Undo* right away.

---

## Merge review

`/admin/branches/:id/review` (`src/admin/pages/branches/BranchReviewPage.tsx`, workspace `branchReview`, gated by `site.read`) is the review. Opening it switches the tab to the branch. It loads the merge plan and the review state together and renders rows of tiles on the workspace canvas (house surfaces, no borders; a thread tile beside what it discusses):

- **The request row** — the open or last merge request (who, note, state badge: *Awaiting review* / *Changes requested* / *Merged* / *Withdrawn*, a `TagPill` with a state `tone`), with the general conversation beside it and a row of fact tiles (changes by kind, conflicts left, freshness, what merging does). Without a request it offers *Request merge…*.
- **One row per change**, its kind (*Page*, *Entry*, *Table*, *File*) and action (*new* / *changed* / *removed*) as badges in the card head, with the thread tile on the left (comments keyed by the change's `key`, an always-present composer) and the change on the right: a page (`row` in the `pages` table) as **before/after frames**, an entry as a field table, a table as its schema, the shell as a settings table, a file as a line diff (`@core/utils/lineDiff`). A change with conflicts carries a strip with *Keep main* / *Take branch* (managers only).
- **The decision row** — the decline note, the merge outcome, or the wait.
- **The footer** — managers: *Delete branch after merging* (off by default; on, the merge cannot be undone and the label says so), *Decline…* (open request only; a note is required) and *Merge N changes*, disabled with the count while conflicts are undecided. Merging asks first (`useConfirmAction`, the confirm primitive in its non-destructive tone; *Update from main…* asks the same way), then runs the step-up-gated `POST …/merge`; the success toast carries an *Undo* action, and while the review state's `lastMerge` is set the footer shows *Undo merge* beside the merge button (`POST …/merge/undo`, step-up gated). The page stays on the review after a merge so the undo is at hand; it leaves for the site only when the branch was deleted. Requesters: *Withdraw request*; everyone else: *Request merge…*.

Page frames: `GET /admin/api/cms/branches/:id/review/render?row=<page row id>&side=main|branch` (`site.read`) returns the page's HTML composed like the branch preview (template chain, draft loops, inlined CSS, `dynamicNodes: 'inline'`) with `annotateNodeIds` on, so every node's root element carries `uid="<composed node id>"`; no runtime scripts are bundled. Both sides read DRAFT rows in their loops (`prefetchLoopData({ drafts: true })`, an explicit switch on `SourceFetchContext`): a merge compares main's draft with the branch's draft, and main's *published* versions are what visitors see, not what the merge writes over — without this a post-type loop rendered its cards on the branch and nothing on main. The page fetches the HTML through `apiTextRequest` and hands it to an `<iframe sandbox="allow-same-origin">` as `srcdoc` (scripts stay off). After load, the frame is measured and every `uid` is mapped back to its page node through `composedNodeSourceId` (`@core/templates`; template composition prefixes ids with `c0_` and `t<i>_`), then the nodes the plan's tree diff lists are outlined in place — one node inside a loop is outlined once per item. Highlights come from the diff, never from guesses. Modes: side by side, swipe (one frame clipped over the other; drag anywhere on the stack, or use the range below it with the keyboard), and the plain change list, where a changed node reads `Changed text: “old” → “new”` from the diff's per-node `details` (`server/branches/changeDetail.ts`: scalar props are quoted, structured ones and node fields are named). Field changes are labelled by field (`Title`, `Slug`, `SEO title`, `SEO description`, `Featured media`), and a cleared field keeps its old value in view. Row content is compared with empty cells normalized (`compactCells` in `contentHash.ts`: absent, `null`, and `""` are the same empty cell), so rows written by different paths never read as changed.

Requests and comments (`server/branches/review.ts`, `server/repositories/branchReviews.ts`, migration `028_site_branch_reviews`): `site_branch_merge_requests` (one open per branch; `content_hash` of every branch entity at request time, so the page can say when the branch moved on) and `site_branch_review_comments` (keyed by branch and `entity_key`, `''` for the request itself; they outlive a declined request). Both cascade with the branch.

| Endpoint | Gate | Effect |
|----------|------|--------|
| `GET /admin/api/cms/branches/:id/review` | `site.read` | `{ branch, request, comments, contentHash, lastMerge }` (`lastMerge`: the newest merge into main not yet undone, or `null`) |
| `POST …/review/request` | `site.read` | Opens a request `{ note }`; `409 merge_request_open` while one is open |
| `POST …/review/withdraw` | requester or `site.branches.manage` | Closes it as withdrawn |
| `POST …/review/decline` | `site.branches.manage` | Closes it as declined; `{ note }` required |
| `POST …/review/comments` | `site.read` | `{ entityKey, body }` → `{ comment }` |
| `GET …/review/render?row=&side=` | `site.read` | The page HTML for one side, `no-store`, `noindex` |

Audit: `branch.review.request`, `branch.review.withdraw`, `branch.review.decline`, `branch.review.comment`, next to `branch.merge`.

---

## Version history

`GET /admin/api/cms/data/rows/:id/versions` lists `data_row_versions` for the row (newest first, with the publisher's name). `POST …/versions/:versionId/restore` runs that version's `cells` through the `content.entry.cells` filter, derives the slug the way a draft save does (`409` when another row now owns it), writes the row's **draft on the request's branch**, emits `content.entry.updated` on main, and records `version.restore`. Nothing is published by restoring. The dialog (`VersionHistoryDialog`) is reachable from the Site editor's publish menu (active page) and the Content toolbar's publish menu (selected entry).

---

## Cookbook

### Call a repository from a handler

```ts
export async function handleFooRoutes(req: Request, db: DbClient, scope: BranchScope) {
  const rows = await listDataRows(db, scope, 'posts')   // the tab's branch
  const live = await listDataRows(db, MAIN_SCOPE, 'posts') // explicitly the live site
}
```

### Keep an operation main-only

Return `409` with the standard message the way `branchOnlyResponse(scope)` in `server/handlers/cms/data/rows.ts` does before doing work, and gate the control in the UI with `useBranchPublishGate()` so it never reaches the server.

### Add a new branched table

Add `branch_id text not null default 'main'` and the generated `logical_id` to the table in both migration files, make every repository function on it take `BranchScope`, bind `physicalId(...)` in its SQL, add the table to `snapshotScope` in `server/branches/merge.ts` and to `forkBranch` / `deleteBranch`, and extend the gate test's table list.

---

## Forbidden patterns

- Computing `` `${branch}:${id}` `` anywhere but `src/core/branches/ids.ts`.
- A repository on `site`, `data_tables`, or `data_rows` without a `BranchScope` parameter, or raw SQL on those tables outside `server/repositories`, `server/branches`, and `server/db` that ignores `branch_id`.
- Publishing, scheduling, or baking artefacts for a scope other than main.
- Storing a preview token in plain text, or granting preview access from anything but the cookie's token lookup.
- Merging `status` or timestamps — only content moves between branches.
- Rendering a review frame with scripts enabled, or loading it by navigation instead of `srcdoc` (the frame must never carry the admin session as a page).

---

## Related

- [`site-shell.md`](site-shell.md) — collab document model
- [`content-storage.md`](content-storage.md) — the branched tables
- [`publisher.md`](publisher.md) — the public render path a preview mirrors
- [`../reference/capabilities.md`](../reference/capabilities.md) — `site.branches.create`, `site.branches.manage`
- [`audit-log.md`](audit-log.md) — `branch.*`, `branch.review.*`, `version.restore`
