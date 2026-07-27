# Architecture Decisions: Instatic Members

**Project:** Instatic Members — Visitor Authentication Fork  
**Date:** 2026-07-22  
**Source:** `Instatic/` at commit `960fdaa` (v0.0.11)  
**PRD:** `PRD.md` | **Review:** `PRD-REVIEW.md`

---

## Resolved Design Decisions

These decisions are **final** — they were validated against the Instatic source code and the PRD review. If any needs revisiting, it requires a new review cycle.

### D1: Middleware insertion point — inside the try/catch in `server/index.ts`

**Context:** The PRD originally showed the middleware running before `handleServerRequest` outside the try/catch. PRD review finding C1 identified this as a crash risk.

**Decision:** Insert the visitor auth middleware call **inside** the existing `try` block, immediately before `handleServerRequest`. This ensures:
- Middleware errors get caught by the existing error handler (generic 500 + security headers)
- The 302 redirect response gets CORS headers and `applySecurityHeaders`
- Consistent with every other response in the server

**Code sketch (`server/index.ts`):**
```typescript
try {
  const authResponse = await visitorAuthMiddleware(req, pathname, db)
  if (authResponse) return applySecurityHeaders(authResponse, pathname)

  const res = await handleServerRequest(req, { db, staticDir, uploadsDir, databaseUrl })
  for (const [k, v] of Object.entries(cors)) { res.headers.set(k, v) }
  return applySecurityHeaders(res, pathname)
} catch (err) { ... }
```

**Impact:** +3 lines (import, call, early return) instead of the original +10 estimate. Simpler and safer.

---

### D2: Visitor auth routes go at position 4 in the routes array

**Context:** PRD review finding H1. The routing table is a flat `routes[]` array with first-match-wins semantics. Visitor API routes (`/api/visitor/*`) must be reachable without hitting admin auth gates.

**Decision:** Insert `tryServeVisitorRoutes` at position 4 in `server/router.ts`, immediately after `tryServeAi` and before `tryServeCmsApi`. 

**Rationale:** While `/api/visitor/*` wouldn't match the `/admin/api/cms/*` prefix checked by `tryServeCmsApi`, placing visitor routes early ensures they're always reachable regardless of future admin route changes. Defense in depth.

**Code sketch (`server/router.ts`):**
```typescript
const routes: readonly RouteHandler[] = [
  tryServeHealth,
  tryServeMcp,
  tryServeAi,
  tryServeVisitorRoutes,  // ← NEW (position 4)
  tryServeCmsApi,
  // ... rest unchanged
]
```

---

### D3: Shared utility imports are acceptable — gate test bans admin auth *state*, not utilities

**Context:** PRD review finding H2. The PRD said "visitor auth never imports from `server/auth/*`" but also wanted to reuse `hashSessionToken()` and `RateLimiter`.

**Decision:** Visitor auth MAY import these specific functions/classes from `server/auth/`:
- `hashSessionToken` from `server/auth/tokens.ts`
- `createSessionToken` from `server/auth/tokens.ts`
- `sessionExpiry` from `server/auth/tokens.ts`
- `RateLimiter` from `server/auth/rateLimit.ts`
- `isStateChangingMethod` from `server/auth/security.ts`
- `originAllowed` from `server/auth/security.ts`

The architecture gate test verifies that visitor auth **never imports**:
- `server/auth/sessions.ts` (admin session management)
- `server/auth/middleware.ts` (admin auth middleware)
- `server/auth/index.ts` (admin auth barrel — pulls in everything)
- `server/repositories/users.ts` (admin user repository)
- Any file under `server/handlers/cms/` that handles admin login

**Rationale:** `hashSessionToken`, `RateLimiter`, and security header utilities are pure functions with no admin-specific state. They're utility code that happens to live in the auth directory. Importing them doesn't create a runtime coupling to the admin auth system.

---

### D4: Prefix matching (not glob) for `protectedPrefixes`

**Context:** PRD review finding H4. The PRD said "glob matching" but Instatic uses simple prefix matching everywhere.

**Decision:** `protectedPrefixes` entries are path prefixes. A prefix `/members` matches:
- `/members` (exact)
- `/members/` (trailing slash)
- `/members/dashboard` (sub-path)
- `/membership` ← **also matches** (prefix, not segment)

To protect only an exact path, the prefix must end with a segment boundary. The simplest approach: the prefix `/members/` only matches paths starting with `/members/` (not `/membership`). Document this in the admin UI tooltip.

**Implementation:** `pathname.startsWith(prefix) || pathname === prefix` (handles trailing slash edge case).

---

### D5: In-memory session cache with 5-minute TTL

**Context:** PRD review finding H5. Every protected page request would otherwise hit the DB for session validation.

**Decision:** Add an in-memory `Map<string, CachedSession>` with a 5-minute TTL. On session validation:
1. Check cache by `id_hash` (the cookie token's SHA-256 hash)
2. Cache hit + not expired → return cached session (no DB query)
3. Cache miss → DB query → store in cache

On session revoke (logout, password change, admin action): delete from cache.

**Trade-off:** Stale revocation takes up to 5 minutes. Acceptable for member areas (not banking). Document in security considerations.

**Impact on performance table:** Protected page (warm session) drops from ~1.5ms to ~0.8ms (cache lookup + disk read, no DB).

---

### D6: Login page — server-rendered fallback when no custom page exists

**Context:** PRD review finding C2. The chicken-and-egg problem of redirecting to `/login` when no login page exists.

**Decision:** The middleware's 302 redirect target is configurable (`site.settings.visitorAuth.loginPath`, default `/login`). Two-tier login page resolution:

1. **Primary:** Check if a published page exists at the login path. If yes, serve it normally through `renderPublicResolution` (Layer A/B/C).
2. **Fallback:** If no published page exists, the middleware serves a built-in HTML login page directly (inline HTML, ~3KB, minimal styling). This is NOT a redirect — the middleware returns a 200 Response with the login form HTML.

The built-in page includes the auth runtime script tag (`<script src="/_instatic/visitor-auth.js"></script>`) and a form with `data-instatic-auth="login"`.

**Why not auto-create pages in the database?** Because pages in Instatic are snapshots with tree structures, not simple rows. Auto-creating a properly-structured page requires understanding the full publisher pipeline. The server-rendered fallback is simpler and doesn't pollute the content model.

---

### D7: Visitor auth runtime JS — served from `/_instatic/visitor-auth.js`

**Context:** PRD review finding C2. Login/register forms need client-side JavaScript.

**Decision:** A single JS file (~2-3KB) served from the existing `/_instatic/` asset namespace. It:
- Finds all forms with `data-instatic-auth` attribute
- Intercepts `submit` events
- Calls the appropriate `/api/visitor/*` endpoint
- Handles errors (displays them in a `.instatic-auth-error` element within the form)
- On success, redirects to the `redirect` query param or `/`
- Updates the page state (shows/hides elements based on `data-instatic-auth-show` / `data-instatic-auth-hide`)

This follows the same pattern as the hole runtime (`/_instatic/hole-runtime.js`) — a small enhancement script that makes static HTML interactive.

---

### D8: `site.settings.visitorAuth` schema

**Context:** PRD review finding H3. The PRD didn't specify the settings structure.

**Decision:**
```json
{
  "visitorAuth": {
    "enabled": false,
    "protectedPrefixes": [],
    "loginPath": "/login",
    "registrationOpen": true,
    "defaultRole": "member"
  }
}
```

- `enabled`: Global toggle. When false, middleware passes through, `/api/visitor/*` returns 403.
- `protectedPrefixes`: Array of path prefix strings (see D4).
- `loginPath`: Where unauthenticated visitors are redirected. Default `/login`.
- `registrationOpen`: When false, `POST /api/visitor/register` returns 403.
- `defaultRole`: Role ID assigned to new registrations.

This is read from the database on each request (cached in-memory, refreshed on publish like other site settings).

---

### D9: Logout returns 204 with cookie clear

**Context:** PRD review finding H7.

**Decision:**
```
POST /api/visitor/logout
→ 204 No Content
→ Set-Cookie: instatic_visitor_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax
```
No response body. Client-side JS handles navigation.

---

### D10: Cookie path is `Path=/` — isolation via cookie name, not path

**Context:** PRD review finding C3. The PRD claimed cookie path differences as a security mechanism.

**Decision:** Visitor session cookie uses `Path=/` because visitors need it on all public pages. Admin session cookie may use `Path=/` or `Path=/admin` (to be verified). Isolation is guaranteed by **different cookie names** (`instatic_visitor_session` vs `instatic_admin_session`), not by cookie path.

The PRD's security table (§7) should say: "Visitor and admin sessions use different cookie names and are validated by different middleware. Admin routes (`/admin/*`) only read `instatic_admin_session`; visitor middleware only reads `instatic_visitor_session`." Remove any claim that cookie `Path` provides isolation.

---

### D11: Auth-gated hole endpoint at position 8 in routes array

**Context:** PRD review finding M7. Phase 2 `/_instatic/gate/<nodeId>` would conflict with `tryServeStaticAsset`.

**Decision:** `tryServeGate` (Phase 2) goes at position 8, right after `tryServeHole`. This keeps hole-related endpoints together and before the static asset handler.

---

### D12: Migration uses separate `CREATE INDEX` for partial unique constraint

**Context:** PRD review finding M4. `UNIQUE ... WHERE ...` as a table constraint doesn't work on SQLite.

**Decision:** Both migration files use:
```sql
-- Table constraint (non-unique, allows the index to do the work)
email_normalized TEXT NOT NULL,

-- Separate index (works on both PG and SQLite)
CREATE UNIQUE INDEX visitor_users_email_active_idx
  ON visitor_users (email_normalized)
  WHERE deleted_at IS NULL;
```

---

## File Map

### New Files (Phase 1)

```
server/visitor-auth/
├── middleware.ts      # Route protection + session validation + fallback login page
├── sessions.ts        # Session CRUD + in-memory cache (D5)
├── handlers.ts        # API endpoint handlers
├── repositories.ts    # DB operations (visitor_users, visitor_sessions, visitor_login_attempts)
├── rateLimits.ts      # RateLimiter instances
└── types.ts           # TypeScript interfaces

server/publish/
└── visitorAuthRuntime.ts  # Builds the visitor-auth.js asset (D7)
```

### Modified Files (Phase 1)

```
server/index.ts                          # +3 lines (D1)
server/router.ts                         # +5 lines (D2)
server/db/migrations-pg.ts               # +60 lines (D12)
server/db/migrations-sqlite.ts           # +60 lines (D12)
server/publish/publicRouter.ts           # +5 lines (pass visitor info to render context)
```

### New Files (Phase 2)

```
server/handlers/cms/gate.ts              # /_instatic/gate/<nodeId> endpoint (D11)
server/visitor-auth/gateHelpers.ts       # Session validation for gate
```

### Modified Files (Phase 2)

```
server/router.ts                         # +1 line (tryServeGate at position 8)
src/core/publisher/dynamicDetection.ts   # +15 lines (Rule 5: authGate)
src/core/publisher/renderNode.ts         # +20 lines (renderGatedPlaceholder)
server/publish/holeRuntime.ts            # +10 lines (instatic-gated observer)
src/modules/base/container/index.ts      # +5 lines (authGate prop)
```

---

## Request Flow (Updated)

```
Browser → Bun.serve.fetch
  │
  ├─ stampSocketIp(req, ...)
  ├─ OPTIONS → 204 + CORS headers
  │
  └─ try {
       │
       ├─ visitorAuthMiddleware(req, pathname, db)     ← NEW (D1)
       │   ├─ visitorAuth.enabled === false? → null (pass through)
       │   ├─ skip /_instatic/, /admin/, /health, /api/visitor/, /uploads/
       │   ├─ no protectedPrefix match? → null (public page, pass through)
       │   ├─ no session cookie? → 302 /login?redirect=<path> (or fallback HTML)
       │   └─ valid session (cache D5 or DB)? → null (pass through)
       │
       └─ handleServerRequest(req, runtime)
           ├─ [4] tryServeVisitorRoutes               ← NEW (D2)
           │       └─ /api/visitor/* → visitor auth handlers
           ├─ tryServeCmsApi          → /admin/api/cms/* (admin auth)
           ├─ ... existing routes ...
           ├─ [18] tryServePublicRoute
           │       ├─ Layer A: disk artefact (static HTML)
           │       ├─ Layer B: LRU cache
           │       └─ Layer C: live render
           └─ tryServeNotFoundPage
     } catch (err) → 500
```

---

## Upstream Rebase Conflict Surface

Files that could conflict during an upstream rebase:

| File | Conflict Risk | Resolution Strategy |
|------|---------------|-------------------|
| `server/index.ts` | Low — adding 3 lines in a stable area (inside try, before handleServerRequest) | Manual merge, obvious placement |
| `server/router.ts` | Low — inserting one entry in routes array | Insert at position 4 after rebase |
| `server/db/migrations-pg.ts` | Medium — upstream may add migration 021 | Rename to 022+ if upstream collides |
| `server/db/migrations-sqlite.ts` | Medium — same as PG | Same as PG |
| `server/publish/publicRouter.ts` | Low — small addition to render context | Manual merge |

All other changes are in **new files** — zero conflict risk.
