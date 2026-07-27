# Per-Visitor Data Framework — Implementation Spec (FINAL)

**Status:** Finalized (all 6 requirement questions answered 2026-07-24).
**Target branch:** `feat/visitor-data-framework` (new, from `main`).
**Intent:** The framework to display **per-user data on portal pages** — the Instatic equivalent of WordPress + Crocoblock/JetEngine "current user" dynamic tags and "current-user-owned" listing grids. View-only from the portal.

Findings: `PER-VISITOR-DATA.md`. Earlier draft superseded by this document.

---

## Confirmed requirements (from Darren)

| # | Question | Answer |
|---|---|---|
| Q1 | Ownership / access model | **Page access stays group-level (already built).** Per-user is a *separate display layer*: a page may show per-user content alongside group-gated access. |
| Q2 | Read vs write | **View-only from the portal.** Visitors do not create/edit/delete data via the portal. |
| Q3 | Lifecycle | **Flat fields, no status/versioning.** |
| Q4 | Staff two-way updates | Out of scope for this framework. |
| Q5 | Linking | **Implicit auto-stamp** for owned data; custom profile fields are explicit config. |
| Q6 | CRM sync | **Deferred.** Framework only; automated linking later. |

**Two distinct display use-cases to support:**

- **A. Current-visitor profile** — "Welcome back, {name}", "Your school: {schoolName}". Includes **custom visitor profile fields** (e.g. school name) added by the site builder.
- **B. Owned data rows** — a listing of data rows that belong to the logged-in visitor (e.g. "Your tenders"), captured via forms.

---

## Architecture — three pillars

```
PILLAR 1 (foundation): visitor custom profile fields
  ├─ field DEFINITIONS  → site.settings.visitorAuth.profileFields (DataField[] shape)
  ├─ field VALUES       → visitor_users.profile_fields_json (new column, mirrors fields_json)
  └─ admin edit         → Members workspace visitor editor exposes the fields

PILLAR 2: `visitor.current` loop source (use-case A)
  └─ perVisitor source → resolves visitor from session cookie → exposes
      {id, email, displayName, roleName, ...customProfileFields}

PILLAR 3: `visitor.ownedRows` loop source (use-case B)
  ├─ migration 003   → data_rows.visitor_user_id (+ index) + data_tables.capturesVisitorOwner flag
  ├─ form stamping   → server/forms/handler.ts stamps visitor on submit
  └─ perVisitor source → filtered to the resolved visitor's rows
```

Pillars 2 and 3 are both `perVisitor: true` (cookie-derived, `Cache-Control: no-store`, never baked into static HTML). Pillar 2 depends on Pillar 1; Pillar 3 is independent.

---

## Pillar 1 — Visitor custom profile fields

### Schema (`DataField` mirror)
Reuse Instatic's existing `DataField` discriminated union (`src/core/data/schemas.ts:246`) so field types, validation, and admin controls are identical to data-table fields. A visitor profile field set is a `DataField[]` with `id`/`label`/`type`/`required` — e.g. `{ id: 'schoolName', label: 'School name', type: 'text' }`.

### Migration `003_visitor_profile_fields` (PG + SQLite)
```sql
alter table visitor_users
  add column profile_fields_json text not null default '{}';
```
Stores the per-visitor VALUES keyed by field id, mirroring how `data_tables.fields_json` stores field DEFINITIONS. JSON extraction uses existing helpers (`server/db/jsonExtract.ts`).

### Field definitions location
Extend the existing `visitorAuth` site-settings block (`server/visitor-auth/config.ts → DEFAULT_VISITOR_AUTH_CONFIG`):
```jsonc
"visitorAuth": {
  "enabled": false,
  "protectedPrefixes": [],
  "loginPath": "/login",
  "registrationOpen": true,
  "defaultRole": "member",
  "profileFields": []   // ← DataField[] — NEW
}
```
No new table needed; site-builder configures fields in the visitor-auth settings UI (Members section).

### Admin UI
Members workspace visitor editor (`src/admin/pages/members/`) gains edit controls for each configured `profileFields` entry, persisting to `profile_fields_json`. The `VisitorsTable` also gains the **copyable Member ID** column (the CRM identifier — see security note in `PER-VISITOR-DATA.md`).

### Registration (optional, deferred in first increment)
The register endpoint (`server/visitor-auth/handlers.ts`) schema can later accept profile field values. First increment: staff enter them in admin. (View-only portal means no self-edit required now.)

---

## Pillar 2 — `visitor.current` loop source (use-case A)

New file `src/core/loops/sources/visitorCurrent.ts`:
```ts
export const VisitorCurrentSource: LoopEntitySource = {
  id: 'visitor.current',
  label: 'Current visitor',
  perVisitor: true,                    // cookie-dependent, no-store, never baked
  filterSchema: {},                    // no filters — identity is always the session
  orderByOptions: [],
  fields: [
    { id: 'id', label: 'Member ID' },
    { id: 'displayName', label: 'Display name' },
    { id: 'email', label: 'Email' },
    { id: 'roleName', label: 'Role' },
    // + one field per configured profileField (built dynamically)
  ],
  async fetch(ctx): Promise<LoopFetchResult> {
    const visitor = await resolveVisitorFromCookie(ctx.db, ctx.request?.cookies)
    if (!visitor) return { items: [], totalItems: 0 }   // anonymous → nothing renders
    return {
      items: [{
        id: visitor.id,
        fields: {
          id: visitor.id,
          displayName: visitor.displayName,
          email: visitor.email,
          roleName: visitor.roleName,
          ...visitor.profileFields,   // spread custom fields: schoolName, etc.
        },
      }],
      totalItems: 1,
    }
  },
  preview() { return [] },
}
```
Usage in a loop: `<instatic-loop data-source-id="visitor.current">…{currentEntry.schoolName}…</instatic-loop>`. For single-value display ("Welcome, {name}"), wrap in a loop with one child.

---

## Pillar 3 — `visitor.ownedRows` loop source (use-case B)

### Migration `004_visitor_owned_data` (PG + SQLite)
```sql
alter table data_rows
  add column visitor_user_id text references visitor_users(id) on delete set null;
create index if not exists data_rows_table_visitor_idx
  on data_rows (table_id, visitor_user_id, updated_at desc);
alter table data_tables
  add column captures_visitor_owner integer not null default 0;
```
`captures_visitor_owner` is a per-table opt-in (not every table stamps visitors).

### Form stamping (`server/forms/handler.ts`)
After validation, before `createDataRow`:
```ts
const visitor = await resolveVisitorFromCookie(db, req.headers.get('cookie'))
const stamp = table.capturesVisitorOwner && visitor ? { visitorUserId: visitor.id } : {}
const row = await createDataRow(db, { tableId: table.id, cells, slug: '', ...stamp })
```

### Loop source
New file `src/core/loops/sources/visitorOwnedRows.ts` — mirrors `dataRows.ts` but the SQL `WHERE` adds `and data_rows.visitor_user_id = <resolved visitor id>`. `perVisitor: true`. Render inside an auth-gated hole.

---

## Security invariants (architecture-gate tested)

New test `src/__tests__/architecture/visitor-data-isolation.test.ts`:

1. Both visitor loop sources obtain visitor identity **exclusively** from a session-cookie resolver — never from `ctx.request.query`, `ctx.request.path`, or any filter value.
2. No visitor-facing handler/endpoint accepts `visitorUserId`/`userId`/`ownerId`/`id` as a request parameter that influences a read filter.
3. `createDataRow` (form path) stamps `visitorUserId` only from the resolved session, never from the submitted body.
4. Admin handlers reading cross-visitor are explicitly allowlisted.

(Defence-in-depth: visitor IDs are nanoid — 21 chars, ~126 bits, unguessable, non-sequential — but cookie-derived identity is the load-bearing IDOR guard.)

---

## File changes

### New files
- `src/core/loops/sources/visitorCurrent.ts` — Pillar 2 source.
- `src/core/loops/sources/visitorOwnedRows.ts` — Pillar 3 source.
- `server/visitor-auth/visitorData.ts` — `resolveVisitorFromCookie`, profile-field read helpers.
- `src/__tests__/architecture/visitor-data-isolation.test.ts` — security gate.

### Modified files
- `server/db/migrations-{pg,sqlite}.ts` — migrations `003` + `004`.
- `server/visitor-auth/config.ts` — `profileFields` in default config + schema.
- `server/visitor-auth/types.ts` — `VisitorUser.profileFields`.
- `server/visitor-auth/repositories.ts` — read/write `profile_fields_json`.
- `src/admin/pages/members/` — profile-field editor + Member ID column.
- `src/core/loops/sources/index.ts` — register the two new sources.
- `server/forms/handler.ts` — stamp visitor on submit (+~15 lines).
- `server/repositories/data/rows/mutations.ts` — `createDataRow` accepts optional `visitorUserId`.
- `src/core/data/schemas.ts` — `DataRow.visitorUserId`, `DataTable.capturesVisitorOwner`.

**Estimate: ~250 lines across 4 new + ~10 modified files.** All additive; no changes to existing behaviour (anonymous form submits still work; sites without profile fields are unaffected).

---

## Implementation order

1. **Branch** `feat/visitor-data-framework` from `main`. ✅
2. **Pillar 1:** migration `025` + `profileFields` config + type/repository plumbing + admin editor + Member ID column. ✅ migration/types/repositories/config done + typechecks; admin editor + Member ID column pending.
3. **Pillar 2:** `visitor.current` source + register it. ✅ done + typechecks + registered (visible via MCP `site_list_loop_sources`).
4. **Pillar 3:** migration `026` + form stamping + `visitor.ownedRows` source. ⏳ next.
5. **Security gate test** (covers pillars 2 & 3). ⏳ pending.
6. Build + typecheck + existing tests green. ✅ `tsc -b` passes after each pillar.

Committed: `29f4595 feat(visitor-data): Pillars 1 & 2`.
