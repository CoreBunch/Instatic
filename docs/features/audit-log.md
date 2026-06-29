# Audit Log

The audit log — every meaningful admin action records a row in `audit_events`. Authentication, content writes, plugin lifecycle, role changes. Surfaced in the dashboard's Activity widget and the Audit admin page.

The audit log is **append-only** — events are never updated or deleted. They're the trail for "who did what when".

---

## TL;DR

- Storage: `audit_events` table.
- Repo: `server/repositories/audit.ts` — `createAuditEvent(...)`, `listAuditEvents(...)`.
- Schema: `AuditAction` is a closed TypeBox literal union — every event kind is enumerated. Adding a new kind = adding a new literal.
- Handler: `server/handlers/cms/audit.ts` — `GET /admin/api/cms/audit` (gated by `audit.read`).
- Consumer side: the Dashboard's Activity widget + the Users → Audit tab.
- Users audit formatter: `src/admin/pages/users/utils/audit.ts` renders known
  actions as readable titles and humanizes future dotted action ids instead of
  exposing raw action strings.
- Metadata is a `Record<string, string | number | boolean | null | string[]>` — flat, JSON-safe, no nested objects.

---

## Where the code lives

```text
server/repositories/audit.ts        — AuditAction enum, createAuditEvent, listAuditEvents
server/handlers/cms/audit.ts        — GET /admin/api/cms/audit (audit.read capability)
src/admin/pages/dashboard/widgets/ActivityWidget.tsx   — feed display
src/admin/pages/users/utils/audit.ts                   — Users → Audit title/detail formatting
```

---

## The `AuditAction` enum

Every event has a typed `action` string. The closed union is the source of truth — adding an action means editing the schema.

| Group           | Actions                                                                                   |
|-----------------|-------------------------------------------------------------------------------------------|
| Authentication  | `login.success`, `login.failure`, `login.locked`, `login.unlocked`, `login.rate_limited`, `logout` |
| Users           | `user.create`, `user.update`, `user.delete`, `user.suspend`, `password.change`            |
| Roles           | `role.create`, `role.update`, `role.delete`, `role.assign`                                |
| Data            | `data.table.create`, `data.table.update`, `data.table.delete`, `data.row.create`, `data.row.update`, `data.row.delete`, `data.row.publish`, `data.row.schedule`, `data.row.schedule.cancel`, `data.row.status`, `data.row.move`, `data.author.assign` |
| Publishing      | `publish`                                                                                 |
| Plugins         | `plugin.install`, `plugin.update`, `plugin.enable`, `plugin.disable`, `plugin.delete`, `plugin.pack.install`, `plugin.settings.update` |
| AI              | `ai.credential.created`, `ai.credential.updated`, `ai.credential.deleted`, `ai.credential.tested`, `ai.default.updated`, `ai.default.cleared`, `ai.chat.started`, `ai.chat.completed`, `ai.chat.failed`, `ai.mcp_connector.created`, `ai.mcp_connector.revoked` |

If you add a new action that fits an existing group, append to the union. New groups (e.g. media-related audit) extend the same union.

---

## The `AuditEvent` shape

```ts
interface AuditEvent {
  id:           string             // nanoid
  action:       AuditAction        // closed enum
  actorUserId:  string | null      // who did it; null for system events
  targetId:     string | null      // what was affected (user id, row id, plugin id, …)
  targetKind:   string | null      // 'user' | 'row' | 'plugin' | …
  metadata:     AuditMetadata      // flat record of supplementary fields
  ip:           string | null      // client IP at the time of the event
  userAgent:    string | null
  createdAt:    string             // ISO datetime
}
```

`metadata` is **strictly flat**:

```ts
type AuditMetadata = Record<string, string | number | boolean | null | string[]>
```

No nested objects. The constraint keeps audit queries cheap and lets the UI render any event without recursive walking. If you need richer structure, encode it as separate flat keys (`row.tableId`, `row.fromStatus`, `row.toStatus`).

### Common metadata keys

| Action group         | Common metadata fields                                                            |
|----------------------|-----------------------------------------------------------------------------------|
| `login.*`            | `email`, `failureReason?`, `attemptCount?`                                        |
| `user.*`             | `email`, `displayName`, `roleSlug`                                                |
| `role.*`             | `slug`, `name`, `capabilities?`                                                   |
| `data.row.*`         | `tableId`, `tableSlug`, `slug`, `status?`, `fromStatus?`, `toStatus?`             |
| `publish`            | `pageId`, `slug`, `routeBase?`                                                    |
| `plugin.*`           | `pluginId`, `version`, `permissions?`                                             |
| `ai.credential.*`    | `providerId`, `authMode`, `displayLabel`; `tested` adds `ok`, `modelCount`, `error?` |
| `ai.default.updated` | `scope`, `credentialId`, `modelId`, `auto?` (true when seeded at credential create) |
| `ai.default.cleared` | `scope` |
| `ai.chat.*`          | `scope`, `conversationId`, `providerId`, `modelId`; `completed`/`failed` add `promptTokens`, `completionTokens`, `costUsd?` |

These aren't enforced by the schema (any flat key is valid) — they're conventions to keep the UI consistent.

---

## Writing an event

```ts
import { createAuditEvent } from '../repositories/audit'

await createAuditEvent(db, {
  action:      'data.row.publish',
  actorUserId: user.id,
  targetId:    row.id,
  targetKind:  'row',
  metadata:    {
    tableId:   row.tableId,
    tableSlug: 'posts',
    slug:      row.slug,
    fromStatus: 'draft',
    toStatus:   'published',
  },
  ip:        clientIp(req),
  userAgent: req.headers.get('user-agent'),
})
```

Audit writes are **fire-and-forget**: the handler doesn't `await` them in a way that would block the response. Errors log with `[audit]` prefix; they don't propagate to the user (a failed audit doesn't break the user's action).

### When to record

Record an event whenever an admin action **changes persisted state** in a way an auditor would want to see. As a rule of thumb:

- **Write** events (create / update / delete) — yes.
- **Authentication boundary** — yes.
- **Permission / role change** — yes.
- **Plugin lifecycle** — yes.
- **Read events** — usually no, unless gating policy or compliance requires it.
- **Scheduled jobs firing** — log with `[scheduler]` prefix instead; audit is for **admin actions**.

A typed action (`data.row.publish`) is preferable to a generic `data.row.update` when the semantic matters for filtering / search.

---

## Reading events

`listAuditEvents(db, limit)` returns the most-recent N events. The handler is `GET /admin/api/cms/audit`:

```ts
GET /admin/api/cms/audit?limit=100&action=publish

→ {
    events: [{
      id, action, actorUserId, targetId, targetKind, metadata, ip, userAgent, createdAt,
      actor: { id, email, displayName },   // joined user info
    }, ...]
  }
```

The handler gates on `audit.read`. The Dashboard's Activity widget uses the same data with `limit=10`.

Filters (planned, not all implemented yet):

- `?action=<action>` — only events of one kind
- `?actorUserId=<id>` — only events by one user
- `?since=<ISO>` — only events after a timestamp
- `?targetId=<id>` — only events about one target

---

## UI surfaces

| Surface                             | What it shows                                                  |
|-------------------------------------|----------------------------------------------------------------|
| Dashboard → Activity widget         | Latest 10 events with actor monogram + action + when           |
| `/admin/audit` (admin page)         | Full table with filters (planned)                              |

The Dashboard widget collapses repeated actions ("3 posts published" instead of three rows) when the same actor performs the same action on adjacent targets within a short window. This is purely display logic — the underlying events are stored individually.

---

## Schema migration

`audit_events` schema (one table, two migrations IDs identical across PG / SQLite per `migration-parity.test.ts`):

```sql
create table audit_events (
  id              text primary key,
  action          text not null,
  actor_user_id   text references users(id) on delete set null,
  target_id       text,
  target_kind     text,
  metadata_json   jsonb not null default '{}',          -- text in SQLite
  ip              text,
  user_agent      text,
  created_at      timestamptz not null default current_timestamp,
  -- indexes:
  -- (created_at desc) for the recency feed
  -- (action, created_at desc) for action-filtered queries
  -- (actor_user_id, created_at desc) for actor-filtered queries
);
```

The `metadata_json` column ends in `_json` per the convention. See [docs/reference/database-dialects.md](../reference/database-dialects.md).

---

## Cookbook

### Record a publish event

```ts
await createAuditEvent(db, {
  action:      'publish',
  actorUserId: user.id,
  targetId:    page.id,
  targetKind:  'page',
  metadata:    { slug: page.slug, routeBase: table.routeBase ?? '' },
  ip:          clientIp(req),
  userAgent:   req.headers.get('user-agent'),
})
```

### Add a new action kind

1. Append the literal to `AuditActionSchema` in `server/repositories/audit.ts`.
2. Add a typical-metadata-keys row to the table in this doc.
3. Call `createAuditEvent(...)` at the right write site.
4. Add or verify friendly labels in the Dashboard Activity widget and the Users
   audit formatter. `src/__tests__/users/auditFormat.test.ts` should cover
   emitted action families and future-action fallback behavior.

The closed union catches typos at compile time — a misspelled `'datas.row.publish'` is a type error.

### Filter the activity feed by action

The Dashboard widget already filters internally — see the widget for the pattern. The full audit page (planned) will surface filters via the URL.

### Audit a plugin lifecycle event

The plugin host calls `createAuditEvent(db, { action: 'plugin.install', ... })` when a plugin is installed (and the matching actions for update / enable / disable / delete). Plugin authors don't write audit events directly — the host does on their behalf at lifecycle boundaries.

If a plugin needs its own per-plugin event log, use `api.cms.storage.collection(...)` and `api.cms.hooks.emit(...)` — that data isn't an admin audit record, it's plugin-owned activity.

---

## Forbidden patterns

| Pattern                                                                | Use instead                                                   |
|------------------------------------------------------------------------|---------------------------------------------------------------|
| Nested objects in `metadata`                                            | Flat keys. Use `row.tableId` not `row: { tableId }`.          |
| Updating an existing `audit_events` row                                | Append-only. Add a new event if you need a correction.        |
| Filtering events by free-text search across `metadata_json`            | Add a specific indexed column or a typed action               |
| Logging events that should be `console.error`                          | `[<module>] error: ...` for errors. Audit is for user actions.|
| Recording read events that aren't compliance-required                  | Reads are noisy. Don't record unless the policy says you must.|
| `console.log` to "leave a trail"                                       | Use `createAuditEvent` if it's a real audit event             |
| Blocking the user's response on the audit write                        | Fire-and-forget — audit failure shouldn't kill the action     |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview
- [docs/server.md](../server.md) — repository patterns
- [docs/features/auth-and-access.md](auth-and-access.md) — auth events
- [docs/features/content-storage.md](content-storage.md) — `data.row.*` events
- [docs/features/dashboard.md](dashboard.md) — Activity widget surface
- [docs/reference/database-dialects.md](../reference/database-dialects.md) — `_json` column naming
- Source-of-truth files:
  - `server/repositories/audit.ts` — `AuditActionSchema`, `createAuditEvent`, `listAuditEvents`
  - `server/handlers/cms/audit.ts` — `GET /admin/api/cms/audit`
  - `src/admin/pages/dashboard/widgets/ActivityWidget.tsx` — feed display
