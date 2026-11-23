# Manager API

A token-gated HTTP API inside the Instatic server that lets a supervising
manager (Instatic Desktop) move a full instance in and out of a running
server and manage its database snapshots. It is what makes a remote site
(Railway first) controllable from the desktop app the same way a local one is.

The server half lives in `server/manager/`. The reference client is Instatic
Desktop; the wire format below is the contract between the two, so change
both together.

## Goals

- **Push**: copy a local site to a remote server as an exact copy (database,
  uploads, users, plugins, encrypted secrets).
- **Pull**: copy a remote site down to a local one, same fidelity.
- **Snapshots**: create, list, download, delete and restore database snapshots
  on the remote, with the same semantics as local snapshots.
- **Resumable and incremental**: every transfer works in small chunks and
  re-sends only what changed, so it survives Railway's edge limits (an upload
  must finish within 5 minutes) and flaky connections.
- **Host-agnostic**: nothing here knows about Railway. Any Instatic server
  reachable over HTTP(S) with the token set can be managed.

## Non-goals (v1)

- Provisioning, version switching, domains, logs. Those are the host's job
  (Railway GraphQL API), driven by the desktop app.
- Site-bundle (ZIP export/import) transfer. That is a separate, existing
  feature; this API does not use it and there is no fallback route to it.
- Media held by non-local storage adapters (S3 and similar). Their rows travel
  in the database; their bytes stay where they are.

## Enabling and authentication

| Env var | Meaning |
|---|---|
| `INSTATIC_MANAGER_TOKEN` | Enables the API. Must be at least 32 characters; shorter values disable it with a boot warning. |
| `INSTATIC_MANAGER_DIR` | Working directory for snapshots and staging. Default: `manager/` beside the SQLite database file (for Postgres: beside `UPLOADS_DIR`, so set it explicitly when the volume is mounted on `UPLOADS_DIR` itself rather than on its parent). It must be on persistent storage and must **not** be inside `UPLOADS_DIR`, which is served publicly. |

The API refuses to operate (`503 misconfigured`) when the layout could expose
or destroy data: the manager directory inside `UPLOADS_DIR` or the reverse,
or the SQLite database inside either of them. The database, the uploads and
the manager directory may be on different filesystems; moves fall back to a
copy when a rename is not possible.

- Every request carries `Authorization: Bearer <token>`, compared in constant
  time.
- Unset token, or a wrong one: **404** on the whole namespace, same as the
  existing `/_instatic/shutdown` endpoint. The API is invisible on servers
  that did not opt in.
- No cookies, no session, so no CSRF surface. The token is equivalent to full
  ownership of the instance: the desktop app generates it (32 random bytes,
  base64url), sets it as a host variable, and keeps it in the OS keychain.
- Remote use is HTTPS only (Railway terminates TLS). The desktop client
  refuses plain HTTP for non-loopback hosts.

## Conventions

- Base path: `/_instatic/manager/v1`. The namespace is exclusive: unknown
  paths under it return 404, never fall through.
- JSON bodies validated with TypeBox on the server; the client validates
  responses too (existing rule for IPC payloads).
- Errors: `{ "error": "<code>", "message": "<human text>" }` with a matching
  HTTP status. Codes are listed per endpoint.
- One lock covers every operation that changes state. Heavy ones (snapshot
  create and restore, opening and committing a transfer) do not queue: a
  second one gets `409 busy`. Chunk uploads and aborts wait their turn, so
  two requests never write the same item at once.
- An empty request body means "use the defaults". A body that is present but
  invalid is `400 bad-request`, never a silent fallback to the defaults.
- File paths are relative to the uploads root, `/`-separated, never start with
  `/`, never contain `..`, `.`, empty segments, backslashes or NUL. Symlinks
  are never followed: they are skipped when listing, and a path that passes
  through one is refused on download and in a transfer manifest.
- Hashes are lowercase hex SHA-256.

## Endpoints

### `GET /info`

```jsonc
{
  "apiVersion": 1,
  "version": "0.0.22",              // server version (package.json)
  "database": { "kind": "sqlite", "sizeBytes": 1843200 },
  "migrations": ["0001_init", "…"], // applied migration ids, in order
  "uploads": { "sizeBytes": 73400320, "fileCount": 412 },
  "secretKeyFingerprint": "a1b2c3d4",
  "needsSetup": false,
  "pendingRestore": false,           // a restore is staged for the next boot
  "restoreError": null,              // why the last boot could not finish applying it
  "transfer": null                   // or { id, committed, expiresAt }
}
```

The server learns to report its own version here; today a running instance is
version-anonymous.

### Snapshots

A snapshot is one consistent copy of the SQLite database, taken with
`VACUUM INTO` (safe against a live server in WAL mode). It does not include
uploads, exactly like local snapshots. Files live in
`<manager dir>/snapshots/<version>-<unixts>.db`; the file name is the id.

| Method and path | Purpose |
|---|---|
| `GET /snapshots` | List: `[{ id, version, createdAt, sizeBytes, sha256 }]`, newest first |
| `POST /snapshots` | Create. No body. Returns the snapshot entry (`201`). |
| `GET /snapshots/:id` | Download the file. Supports `Range`. |
| `DELETE /snapshots/:id` | Delete. `404 unknown-snapshot` if it does not exist. |
| `POST /snapshots/:id/restore` | Stage the snapshot as the next database, then restart (see Apply). Body `{ "restart"?: boolean, "revokeSessions"?: boolean }`, both default `true`. Returns `202`. |

Errors: `404 unknown-snapshot`, `409 busy`, `507 no-space` (free space is
checked before the copy is written). Restore also
answers `409 schema-newer` for a snapshot taken on a newer release than the
running server, and `422 bad-database` for one that fails its integrity
check.

`DELETE /pending-restore` cancels a staged restore (snapshot or committed
transfer) that has not been applied yet and removes what was staged for it.
Live data is not touched. `404 no-pending-restore` when nothing is staged.

`revokeSessions` clears browser sessions, MCP OAuth codes and tokens, and paired CLI credentials and pending approvals from the restored copy. Service account definitions remain available for pairing. A snapshot predates every sign-out and revocation made
since it was taken, so restoring it unchanged would make those credentials
valid again; with the default, everyone signs in again after a restore.

`restart: false` stages the restore and leaves it for the next boot. That is
the downgrade path: stage the old snapshot, then let the host redeploy the
older image; the older server applies it on boot.

### Sign-in links

Lets a manager open the site's admin without a password, and without keeping
one.

| Method and path | Purpose |
|---|---|
| `POST /login-links` | Mint a one-time sign-in link for the site owner. No body. Returns `201 { "path": "/_instatic/manager/v1/login/<token>", "expiresAt": "…" }`. `409 needs-setup` when the site has no owner yet. |
| `GET /login/<token>` | Opened by a **browser**, so it carries no bearer token: the link token is its credential. Starts a session for the owner and answers `302` to `/admin`. A wrong, used or expired link is `404`. |

The link works once and for 60 seconds. Tokens are held in memory only, as
hashes, so a restart forgets them. The owner is the earliest active user with
the owner role. The session is fully signed in, MFA included: the manager
token already allows replacing the whole database, so a second factor would
protect nothing here. The sign-in is recorded as `login.success` with
`method: "manager-link"` in the audit log.

### Files (read side, used by pull and by incremental push)

| Method and path | Purpose |
|---|---|
| `GET /files` | List every file under the uploads root: `{ files: [{ path, sizeBytes, sha256 }] }`. Hashes are computed streaming and cached by `(path, size, mtime)`; the cache is persisted in the manager directory so it survives the restart every push ends in. Committing a transfer records the verified hashes of the uploaded files under the paths they are about to be moved to, so the next push does not begin by re-reading them. `?hash=0` skips hashing for a quick listing. |
| `GET /files/<path>` | Download one file. Supports `Range`. `404 unknown-file` if it has gone. |

### Transfers (write side: push a full instance)

A transfer uploads a new database and the set of uploads the instance should
end up with, into a staging area, then swaps them in atomically on restart.
Nothing live is touched until commit.

**1. Open** `POST /transfers`

```jsonc
{
  "source": {
    "version": "0.0.22",
    "migrations": ["0001_init", "…"],
    "secretKeyFingerprint": "a1b2c3d4"
  },
  "database": { "sizeBytes": 1843200, "sha256": "…" },
  "files": [{ "path": "fonts/x.woff2", "sizeBytes": 20480, "sha256": "…" }]
}
```

Response (`201`):

```jsonc
{
  "id": "tr_9f2c…",
  "committed": false,
  "chunkBytes": 8388608,            // max body size per PUT
  "missing": ["fonts/x.woff2"],     // files the server does not already hold with that hash
  "expiresAt": "2026-11-17T12:00:00Z"
}
```

The server compares `files` with its current uploads; anything already present
with the same hash is reused in place and is not in `missing`. A first publish
sends everything, a re-publish sends only the difference.

Rejected at open:

- `400 bad-request`: the manifest is invalid, lists a path twice, lists a
  path as both a file and a directory, or names a path that passes through a
  symlink on this server.
- `409 busy`: a restore is already staged, or another operation is running.
  An unfinished earlier transfer is replaced by the new one.
- `409 schema-newer`: `source.migrations` contains ids this server does not
  know. Migrations are forward-only, so a newer database cannot run on an
  older server. The manager must bring the remote to the source's version (or
  newer) first.
- `409 secret-key-mismatch`: fingerprints differ, so encrypted rows (AI
  provider keys, TOTP seeds) would be unreadable. Override with
  `"allowSecretKeyMismatch": true`; the normal flow sets the remote's
  `INSTATIC_SECRET_KEY` to the source's before the first deploy.
- `507 no-space`: staging needs `database.sizeBytes` plus the missing files.

**2. Upload** `PUT /transfers/:id/database?offset=<n>` and
`PUT /transfers/:id/files/<path>?offset=<n>`

- Body: raw bytes, at most `chunkBytes`.
- `offset` must equal the bytes already received for that item; otherwise
  `409 offset-mismatch` with `{ "receivedBytes": n }` so the client can
  resync. Re-sending a chunk at an old offset is therefore harmless.
- Only paths listed in `missing` are accepted (`404 not-in-transfer`).

**3. Inspect** `GET /transfers/:id`

Returns per-item `receivedBytes`, so a client that lost its state (app
restart, network drop) resumes without re-uploading.

**4. Commit** `POST /transfers/:id/commit`

Body `{ "restart"?: boolean, "revokeSessions"?: boolean }`, both default
`true`. The server:

1. verifies every item's size and SHA-256 (`422 incomplete` or
   `422 checksum-mismatch`, naming the items);
2. opens the staged database, runs `PRAGMA integrity_check`
   (`422 bad-database`), and re-checks its `schema_migrations` against known
   ids (`409 schema-newer`);
3. with `revokeSessions`, deletes the credentials this server issued from the
   staged database, including browser sessions, MCP OAuth codes and tokens, and CLI credentials and approvals;
4. writes the pending-restore marker (see Apply);
5. responds `202 { "staged": true, "restarting": true }` and exits.

`revokeSessions` exists so logins from the source machine do not become valid
on the public host. Connector tokens an operator created on purpose are site
configuration and travel with the rest of the data.

**5. Abort** `DELETE /transfers/:id` removes the staging area of a transfer
that is not committed yet (`409 committed` afterwards: cancel that with
`DELETE /pending-restore`). Uncommitted transfers also expire 24 hours after
the last chunk.

## Apply (how a restore or transfer takes effect)

The running server holds the database open and caches state in memory
(collab relay, render cache, plugins), so data is never swapped under a live
process. Instead:

1. Commit or restore writes `<manager dir>/pending.json`, flushes collab
   documents (same path as graceful shutdown), and exits with **code 75**.
   The marker says what to do, never where: every path is derived from the
   configured directories when it is applied.
2. The supervisor restarts the process. Code 75 is non-zero, so a
   restart-on-failure policy (Railway's default, Docker's `on-failure` or
   `unless-stopped`) is enough.
3. On boot, **before** the database is opened, the server applies the marker:
   - database: the staged file is brought into the database's own directory
     as `<database file>.incoming` and the marker is rewritten with
     `databaseSwapStarted: true`. The live file is then set aside as
     `<database file>.pre-restore` (one generation, the undo for a bad push),
     `-wal`, `-shm` and `-journal` siblings are removed, and the new file is
     renamed into place. The marker is then rewritten with
     `databaseApplied: true`;
   - uploads (transfers only): files not in the transfer's manifest are
     removed, then the staged files are moved into place;
   - the marker and the staging area are deleted.
4. Normal boot continues: migrations run forward if the server is newer than
   the data.

Every step is idempotent and progress is recorded in the marker, so a crash
mid-apply resumes on the next boot. That covers the swap itself: a run killed
with the new database at `.incoming` finishes from that file, even when the
live database was already set aside, and a run killed after the final rename
but before recording it carries on with the uploads. Nothing in the uploads
tree is touched before the database swap is recorded. A marker with no staged
database, no `.incoming` file and no started swap is discarded, not resumed.

A failure never aborts boot. The reason is kept for `/info.restoreError`, the
marker stays so the next start retries, and the server comes up on the data
it has. A server stuck in a restart loop could not be repaired by its
manager; a running one can be, by pushing again or by
`DELETE /pending-restore`.

`/health` does not answer during apply, which is how the manager knows when
the instance is back: poll `/info` until `pendingRestore` is false, and treat
a non-null `restoreError` as failure.

## Typical flows

| Action | Calls |
|---|---|
| Push a site | Snapshot the source database, hash its uploads, open a transfer on the target, upload what is missing, commit, wait for `/health` |
| Pull a site | `POST /snapshots`, download it, `GET /files`, download the files the local copy lacks |
| Upgrade | `POST /snapshots`, then the host switches the image and redeploys |
| Downgrade | `POST /snapshots/:id/restore` with `restart: false`, then the host deploys the older image |

## Supervisors

A supervisor must restart the server when it exits with code 75. Any
restart-on-failure policy does: Railway's default, and Docker's `on-failure`,
`always` or `unless-stopped`. Without a restart, the staged restore waits for
the next manual start.

## SQLite and Postgres

The interchange format is a SQLite database file on both engines: it is what
a snapshot is, what a transfer uploads as its database, and what a manager
downloads to pull a site. A manager therefore never needs to know which
engine the server runs; `/info` reports it (`database.kind`) for display.

A Postgres server converts on its own side (`server/manager/postgresBridge.ts`):

- **Snapshot, and the undo copy before a restore**: the database is read in
  one `repeatable read` transaction and written out as a SQLite file with the
  same migrations applied.
- **Restore, and a pushed transfer**: the staged SQLite file replaces the
  database in **one transaction**, schema changes included. The tables are
  rebuilt at the migration level the file carries, the rows are copied with
  foreign keys checked once at the end, and the next boot runs any newer
  migrations as usual. A failure leaves the database exactly as it was.

This rests on both engines running the same migrations under the same ids
and ending up with the same tables and stored columns. Only column types
differ, so every value crosses as text and is cast in SQL. So a local SQLite
site can be pushed to a Postgres server and pulled back, and a snapshot taken
on one engine restores on the other.

The undo copy on Postgres is `<manager dir>/pre-restore.db`. It is taken
once per restore and is best effort: if the old database cannot be written
out (it is unreadable, or the disk is full), the restore still runs and no
undo copy is kept. An import waits at most 30 seconds for another session
holding a lock on a table (an open `psql`, a running `pg_dump`); past that it
fails, the server boots on the old data, and the next boot tries again.

## Limits to know

- On Postgres a snapshot, a restore and the undo copy each read or write
  the whole database through the server, row by row. That is fine for the
  sites Instatic targets and slow for a database of many gigabytes; use the
  host's own Postgres backups there.
- A Postgres restore drops and recreates only the tables Instatic owns. It
  needs the rights to do that in the schema the connection uses, which the
  owner of the database has.
- Taking a snapshot, checking a staged database and hashing files that are
  not in the cache are done inside the request. On very large instances the
  first listing after a cold start can take long; the persisted hash cache
  keeps later ones fast.
- Media held by a non-local storage adapter is not transferred: its rows
  travel in the database, its bytes stay in that storage.

## Where the code lives

```text
server/manager/
  config.ts      Env parsing, namespace constants, restart exit code
  handler.ts     Route dispatcher and auth gate
  snapshots.ts   Snapshot files
  transfers.ts   Transfer staging, chunk appends, verification
  pending.ts     Pending-restore marker and boot-time apply
  paths.ts       Every path inside the manager directory
  lock.ts        The one lock for state-changing operations
  loginLinks.ts  One-time sign-in links for the site owner
  database.ts    SQLite copy / inspect helpers (bun:sqlite)
  fsUtil.ts      Safe paths, file walk, hashing, ranged responses
server/version.ts  Server version reported by /info
```

Tests: `src/__tests__/server/managerApi.test.ts`.
