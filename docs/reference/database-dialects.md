# Database Dialects

How the CMS runs the same repository code against both Postgres and SQLite, what the rules are, and where the boundaries sit.

The CMS supports **Postgres** (production, multi-author teams, horizontal scale) and **SQLite** (single-VPS self-host, smallest ops footprint). They're selected by `DATABASE_URL` — same image, same code, same migrations IDs. Three rules keep this working.

---

## TL;DR

- **One `DbClient` interface** (`server/db/client.ts`). Two adapters: `postgres.ts` (via `Bun.sql`) and `sqlite.ts` (via `bun:sqlite`).
- **Repositories are dialect-naive.** They use ANSI-standard SQL only. The five Postgres-isms are banned. Gated by `db-postgres-isms.test.ts`.
- **JSON columns end in `_json`.** The SQLite adapter auto-parses on read and auto-stringifies on write. Gated by `db-json-column-naming.test.ts`.
- **Migrations are split per dialect.** `migrations-pg.ts` and `migrations-sqlite.ts` carry identical migration IDs in the same order. Parity gated by `migration-parity.test.ts`.
- **Adding a migration** means editing both files. **Adding a JSON column** means naming it `<something>_json`.

---

## The three rules

### Rule 1 — Repositories are dialect-naive

Files under `server/` that import `DbClient` use **only ANSI-standard SQL** that works on both engines. Five specific Postgres-isms are banned:

| Forbidden                          | Reason                                                 | Use instead                                    |
|------------------------------------|--------------------------------------------------------|------------------------------------------------|
| `now()` in DML                     | SQLite has no `now()`                                  | `current_timestamp`                            |
| `::int` (PG cast syntax)           | SQLite doesn't recognize `::`                          | `cast(x as integer)` (rarely needed — Bun's drivers infer types) |
| `::jsonb`                          | SQLite has no JSONB                                    | Use `_json` columns; both adapters handle the conversion |
| `any($N::...)`                     | PG-specific array binding                              | Compose an `in (?, ?, ?)` list in JS           |
| `distinct on`                      | PG-specific                                            | Window-function subquery (`row_number() over (...)`) |

Gated by `src/__tests__/architecture/db-postgres-isms.test.ts` — scans every file under `server/` that imports `DbClient` and rejects any of the patterns above.

The two migration files (`migrations-pg.ts`, `migrations-sqlite.ts`) are explicitly allowlisted because that's where dialect-specific DDL lives by design.

### Rule 2 — JSON columns end in `_json`

Every column intended to store JSON has a name ending in `_json`. This is a hard convention, not a suggestion.

The SQLite adapter (`server/db/sqlite.ts`) exploits it:

- **On read** — any column whose name ends in `_json` and whose value is a non-empty string is auto-`JSON.parse`d. Repositories receive a `Record<string, unknown>`, not a string.
- **On write** — any plain object or array passed via tagged-template interpolation is auto-`JSON.stringify`d.

Result: repository code is identical across dialects:

```ts
await db`update site set settings_json = ${settingsObject} where id = ${id}`
//                                       ▲
//                       object → JSONB on PG, object → TEXT on SQLite (auto-stringified)

const { rows } = await db<SiteRow>`select id, settings_json from site`
// rows[0].settings_json is `Record<string, unknown>` in both dialects
```

Gated by `src/__tests__/architecture/db-json-column-naming.test.ts`:

1. Every `jsonb`-typed column in `migrations-pg.ts` has a name ending in `_json`.
2. Every such column appears in `migrations-sqlite.ts` declared as `text`.

### Rule 3 — Migrations are split per dialect with identical IDs

`server/db/migrations-pg.ts` and `server/db/migrations-sqlite.ts` each export a `Migration[]`:

```ts
type Migration = {
  id:    string       // e.g. '0042-add-media-folders'
  label: string
  sql:   string       // dialect-specific DDL
}
```

The two arrays must have **identical IDs in the same order**. Each migration has the same **semantic effect** on both engines — just expressed in each dialect's DDL.

| Postgres                 | SQLite              | Used for                                |
|--------------------------|---------------------|-----------------------------------------|
| `jsonb`                  | `text`              | JSON payloads                           |
| `timestamptz`            | `text`              | Timestamps (stored as ISO 8601 in SQLite) |
| `bytea`                  | `blob`              | Binary blobs                            |
| `bigint`                 | `integer`           | Large integers                          |
| `boolean`                | `integer`           | Booleans (`0` / `1` in SQLite)          |
| `distinct on (...)`      | `row_number() over (...)` subquery | "Latest per group" queries |

The parity gate (`src/__tests__/architecture/migration-parity.test.ts`) compares the two arrays element-by-element and fails the build if IDs drift.

---

## The adapter interface

`server/db/client.ts`:

```ts
export type Dialect = 'postgres' | 'sqlite'

export interface DbResult<Row> {
  rows: Row[]
  rowCount: number
}

export interface DbClient {
  <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>>

  unsafe<Row>(sql: string, params?: unknown[]): Promise<DbResult<Row>>
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>

  readonly dialect: Dialect
}
```

`DbClient` is callable as a **tagged template**:

```ts
const { rows } = await db<{ id: string }>`select id from users where email = ${email}`
```

Interpolations are bound as parameters — never string-concatenated. The Postgres adapter emits `$1, $2, …`; the SQLite adapter emits `?` placeholders.

### Selecting the adapter

`server/db/index.ts → createDbClient(DATABASE_URL)`:

| `DATABASE_URL`           | Adapter      |
|--------------------------|--------------|
| `sqlite:<path>`          | SQLite       |
| `file:<path>`            | SQLite       |
| `<path>.db` (bare)       | SQLite       |
| `postgres://...`         | Postgres     |
| `postgresql://...`       | Postgres     |

For SQLite, the parent directory of the DB file is created automatically.

### Adapter behaviors at the boundary

**`server/db/sqlite.ts` does four things the Postgres adapter doesn't need to:**

1. `toBindable(value)` converts JS values for SQLite parameter binding:
   - Plain object / array → `JSON.stringify` (stored as `TEXT`)
   - `Date` → ISO 8601 string
   - `Uint8Array` / Buffer → pass through (stored as `BLOB`)
   - `boolean` → `1` / `0`
   - `null` / `undefined` → `null`
   - Everything else → pass through
2. On read, columns ending in `_json` whose value is a non-empty string are auto-`JSON.parse`d.
3. Pragmas set at boot: `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL`, `busy_timeout = 5000`.
4. **Transaction serialization.** `bun:sqlite` uses one shared synchronous connection, but a transaction callback can `await` async work while its `BEGIN` is still open. Two concurrent `db.transaction()` calls would cause the second `BEGIN` to throw "cannot start a transaction within a transaction", and the implied `ROLLBACK` would silently abort the first transaction's writes. The adapter prevents this with a promise chain (`txChain`): each `.transaction()` call queues behind the previous one and only issues `BEGIN` after the prior transaction has fully settled. Callers don't need to do anything — it's automatic.

The Postgres adapter relies on `Bun.sql`'s native handling of `jsonb` columns and parameter binding — JS objects sent to `jsonb` columns are stored as JSONB and read back as `Record<string, unknown>` automatically.

**`server/db/postgres.ts`** additionally resolves `rowCount` from `result.count` (Bun's per-command row count from PostgreSQL's CommandComplete tag) rather than `result.length`. For non-RETURNING writes (UPDATE / DELETE / INSERT), Postgres streams the affected-row count in its CommandComplete tag rather than returning data rows, so `result.length` is always 0 for those statements. `result.count` captures the CommandComplete count, giving `rowCount` the same semantics as the SQLite adapter's `info.changes`. Falls back to `result.length` if the property is absent.

---

## Cookbook

### Adding a new migration

1. **Pick an ID.** Migrations are sorted by ID. Use a zero-padded prefix or a date prefix that sorts: `0042-…`, `20260501-…`.
2. **Add to `server/db/migrations-pg.ts`:**
   ```ts
   {
     id: '0042-add-subscribers',
     label: 'Add subscribers table',
     sql: `
       create table subscribers (
         id text primary key,
         email text not null unique,
         metadata_json jsonb not null default '{}',
         created_at timestamptz not null default current_timestamp
       );
     `,
   },
   ```
3. **Add to `server/db/migrations-sqlite.ts`** — same ID and label, dialect-translated DDL:
   ```ts
   {
     id: '0042-add-subscribers',
     label: 'Add subscribers table',
     sql: `
       create table subscribers (
         id text primary key,
         email text not null unique,
         metadata_json text not null default '{}',
         created_at text not null default current_timestamp
       );
     `,
   },
   ```
4. **Run `bun test`** — the parity gate and the JSON-naming gate confirm you got it right.

### Dropping a constraint or altering a table in SQLite (table-rebuild dance)

SQLite doesn't support `ALTER TABLE DROP CONSTRAINT` or `ALTER TABLE DROP COLUMN`. To remove or change a constraint, rebuild the table:

**Postgres** (migration SQL):
```sql
alter table my_table drop constraint if exists my_constraint_name;
```

**SQLite** (migration SQL — the table-rebuild dance):
```sql
pragma defer_foreign_keys = on;

-- 1. Create the new table with the desired final schema.
create table my_table__migr042 (
  id text primary key,
  -- ... same columns, omitting (or changing) the constraint
);

-- 2. Copy all rows.
insert into my_table__migr042 (id, col_a, col_b)
select id, col_a, col_b from my_table;

-- 3. Swap.
drop table my_table;
alter table my_table__migr042 rename to my_table;

-- 4. Re-create indexes that lived on the original table.
create unique index if not exists my_table_unique_idx on my_table (col_a, col_b);
```

`pragma defer_foreign_keys = on` is transaction-scoped — it defers FK enforcement to COMMIT so foreign keys that reference `my_table` don't break during the drop+recreate. SQLite re-enables FK enforcement automatically at COMMIT.

**Exception — parents referenced by `ON DELETE RESTRICT`:** RESTRICT actions fire immediately even under `defer_foreign_keys`, so a populated parent table (e.g. `data_tables`, referenced by `data_rows.table_id`) cannot be dropped mid-rebuild — and renaming it away doesn't help, because since SQLite 3.25 a RENAME always rewrites child FK clauses to follow it. For these rebuilds set `disableForeignKeys: true` on the migration: the runner toggles `PRAGMA foreign_keys` off around that migration's transaction (the pragma is a no-op inside one) and verifies `pragma foreign_key_check` before re-enabling enforcement. SQLite-only — never set it on a PG migration.

The rebuilt table produces the same schema as the updated `CREATE TABLE` statement in the original migration, so the migration is safe to run on both existing and fresh installs.

Examples in the codebase: `migrations-sqlite.ts` migration `006_data_rows_scheduled_publish` (drop status CHECK), `012_ai_drop_provider_check` (drop provider_id CHECK), and `017_layouts_system_table` (widen the data_tables kind CHECK — a RESTRICT-referenced parent, so it uses `disableForeignKeys`).

### Adding a new repository

1. Create `server/repositories/<resource>.ts`.
2. Export typed functions:
   ```ts
   export async function listSubscribers(db: DbClient): Promise<SubscriberRow[]> {
     const { rows } = await db<SubscriberRow>`
       select id, email, metadata_json, created_at
       from subscribers
       order by created_at desc
     `
     return rows
   }
   ```
3. Use ANSI SQL only. No `now()`, no `::jsonb`, no `distinct on`.
4. JSON columns end in `_json` — both adapters handle them.

### Using `db.unsafe()` with dialect-aware placeholders

`db.unsafe()` is reserved for queries that splice a shared column-list constant
into the SQL string (like `USER_JOINED_COLUMNS` in `server/repositories/users.ts`
or `DATA_ROW_COLUMNS`), where the tagged-template API can't be used because the
full SELECT list must be a string literal. In those cases use `placeholder()` from
`server/db/client.ts` for positional parameters so the same SQL works on both
dialects:

```ts
import { placeholder, type DbClient } from '../db/client'

const { rows } = await db.unsafe<SubscriberRow>(
  `select ${SUBSCRIBER_COLUMNS}
   from subscribers
   where id = ${placeholder(db.dialect, 1)}
     and deleted_at is null
   limit 1`,
  [subscriberId],
)
```

`placeholder(db.dialect, N)` returns `$N` on Postgres and `?` on SQLite. Every
parameter position must use it — never concatenate the value directly into the
string. The tagged-template API (`db\`...\``) handles dialect differences
automatically and is preferred; `db.unsafe()` + `placeholder()` is the fallback
for column-list splice scenarios only.

### "Latest per group" (the `distinct on` replacement)

Postgres:
```sql
select distinct on (page_id) page_id, snapshot_id, created_at
from snapshots
order by page_id, created_at desc
```

ANSI-portable (works on both):
```sql
select page_id, snapshot_id, created_at
from (
  select page_id, snapshot_id, created_at,
         row_number() over (partition by page_id order by created_at desc) as rn
  from snapshots
) ranked
where rn = 1
```

This is the form the repositories use. The dialect-naive rewrite means the repository is portable; the SQLite migration's JSDoc documents the original `distinct on` for context.

### Reading a JSON column

```ts
const { rows } = await db<{ id: string; settings_json: Record<string, unknown> }>`
  select id, settings_json from site where id = ${id}
`
// rows[0].settings_json is already an object
```

### Writing a JSON column

```ts
await db`update site set settings_json = ${{ theme: 'dark', breakpoints: [...] }}
         where id = ${id}`
// SQLite: auto-stringified.  Postgres: native JSONB binding.
```

### Checking how many rows were affected

```ts
const result = await db`update sessions set revoked = true where user_id = ${userId}`
if (result.rowCount === 0) {
  // no session existed — nothing to revoke
}
```

`rowCount` equals the number of rows affected by a non-RETURNING write, or the number of rows returned by a SELECT / RETURNING query. Both adapters report the same value — do not use `result.rows.length` as a proxy for affected rows.

### Wrapping multi-row writes in a transaction

```ts
await db.transaction(async (tx) => {
  for (const page of pages) {
    await tx`update pages set cells_json = ${page.cells} where id = ${page.id}`
  }
  await tx`insert into audit_log (...) values (...)`
})
```

The callback receives a `DbClient` scoped to the transaction. If it throws, the transaction is rolled back.

---

## Forbidden patterns

| Pattern                                                | Use instead                                                   |
|--------------------------------------------------------|---------------------------------------------------------------|
| `now()` in DML (`server/` files importing `DbClient`)  | `current_timestamp`                                           |
| `cast(x as int)` via `x::int`                          | Drivers usually infer; use `cast(x as integer)` when needed   |
| `where col = any($1::text[])`                          | Build an `in (...)` list in JS                                |
| `select distinct on (col) ...`                         | `row_number() over (partition by ...)` subquery               |
| `column_name jsonb` without the `_json` suffix         | Rename to `column_name_json`                                  |
| Writing a JSON value as `${JSON.stringify(obj)}`       | Pass the object directly — both adapters handle it            |
| Reading a JSON value as a string and then `JSON.parse`ing | Read it as `Record<string, unknown>` — auto-parsed in SQLite, auto-decoded in PG |
| Adding a migration to only one dialect's file          | Mirror it to the other — `migration-parity.test.ts` enforces this |
| Hand-running `db.unsafe(...)` for queryable statements | Use the tagged-template form — `unsafe` is for stored migration blocks |
| DB-level CHECK constraints that enumerate application domain values (e.g. `check (provider_id in ('anthropic', 'openai'))`) | Put the validation at the application boundary via a TypeBox `Type.Union` / `Type.Literal` — see `server/ai/handlers/credentials.ts`. A DB enum that duplicates the list forces a destructive migration (especially on SQLite) every time a new value is added. |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview
- [docs/server.md](../server.md) — server-side flow including DB adapters
- Source-of-truth files:
  - `server/db/client.ts` — `DbClient` interface
  - `server/db/index.ts` — adapter selection by URL
  - `server/db/postgres.ts` — Postgres adapter
  - `server/db/sqlite.ts` — SQLite adapter (with `_json` parse + `toBindable`)
  - `server/db/migrations-pg.ts` — Postgres migrations
  - `server/db/migrations-sqlite.ts` — SQLite migrations
  - `server/db/runMigrations.ts` — runs migrations idempotently at boot
- Gate tests:
  - `src/__tests__/architecture/db-postgres-isms.test.ts`
  - `src/__tests__/architecture/db-json-column-naming.test.ts`
  - `src/__tests__/architecture/migration-parity.test.ts`
  - `src/__tests__/architecture/json-extract-egress.test.ts`
- Regression tests:
  - `src/__tests__/db/adapter-rowcount.test.ts` — cross-dialect `rowCount` contract (affected rows for non-RETURNING writes, returned rows for SELECT / RETURNING)
