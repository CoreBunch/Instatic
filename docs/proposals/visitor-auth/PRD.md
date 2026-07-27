# PRD: Instatic Members — Visitor Authentication & Member Areas for Instatic CMS

**Project:** Instatic Members  
**Fork of:** [CoreBunch/Instatic](https://github.com/CoreBunch/Instatic) (v0.0.11)  
**Date:** 2026-07-22  
**Status:** Draft v2 (amended per PRD-REVIEW findings C1–C3, H1–H7, M1–M8, L1–L4)  
**Owner:** Darren / dazzakiller  

---

## 1. Problem Statement

Instatic is a self-hosted visual CMS that publishes clean, fast static HTML/CSS. Its authentication system is exclusively for **CMS administrators** — visitors cannot log in, register, or access protected content. This limits Instatic to brochure/marketing/blog/portfolio sites and excludes any use case requiring user accounts, member areas, or protected content.

WordPress, which Instatic aims to improve upon, supports these use cases natively via user registration, role-based access, and member-only content. For Instatic to be a viable replacement for a broader set of sites, it needs visitor-facing authentication.

### What This PRD Does NOT Cover

- Admin auth changes (the existing 38-capability system is untouched)
- E-commerce, payments, or subscriptions (separate concern)
- OAuth/social login providers (Phase 3+)
- Plugin-visitor auth (Phase 3+)
- Replacing or modifying the static publisher for protected content baking

---

## 2. Goals

- **G1:** Site visitors can register, log in, and manage their own accounts
- **G2:** Entire pages can be marked as members-only via the admin UI
- **G3:** Sections within a page can be gated by visitor role (public teaser, members-only body)
- **G4:** Authenticated visitor identity is available for personalisation ("Welcome back, Darren")
- **G5:** Visitor auth is completely separate from admin auth — zero runtime coupling
- **G6:** 95%+ of published pages remain static files served directly from disk (no perf regression)
- **G7:** The fork minimises core changes to ease upstream rebasing

### Non-Goals

- Multi-factor authentication for visitors (future enhancement)
- Visitor self-service password reset via email (Phase 2 — requires email config)
- Per-user content rendering (beyond what gated holes provide)
- Integration with external identity providers (Auth0, Clerk, Supabase)
- Visitor account deletion / GDPR right-to-be-forgotten (Phase 2 — separate user story V8)
- Visitor avatars (Phase 2 — story V4 clarified below)

---

## 3. User Stories

### Visitor (Public-Facing)

| ID | Story | Phase |
|----|-------|-------|
| V1 | As a visitor, I can register with email + password | 1 |
| V2 | As a visitor, I can log in and log out | 1 |
| V3 | As a visitor, I see a "Sign in" prompt when accessing members-only content | 1 |
| V4 | As a logged-in visitor, I can see my name on the site (avatar deferred to Phase 2) | 1 |
| V5 | As a logged-in visitor, I can access members-only pages | 1 |
| V6 | As a logged-in visitor, I can see gated sections that unauthenticated visitors cannot | 2 |
| V7 | As a visitor, I can request a password reset | 2 |
| V8 | As a visitor, I can delete my account and all my data | 2 |

### Site Builder (Admin-Facing)

| ID | Story | Phase |
|----|-------|-------|
| A1 | As a site builder, I can enable/disable visitor auth globally in site settings | 1 |
| A2 | As a site builder, I can mark specific pages as "members only" | 1 |
| A3 | As a site builder, I can design the login/register pages in the visual editor | 1 |
| A4 | As a site builder, I can view and manage visitor user accounts | 1 |
| A5 | As a site builder, I can create visitor roles (member, admin, custom) | 1 |
| A6 | As a site builder, I can wrap any page section with an "auth gate" and choose which roles can see it | 2 |
| A7 | As a site builder, I can see how many registered visitors the site has | 1 |

---

## 4. Technical Architecture

### 4.1 Overview

```
Browser → Bun.serve.fetch
  │
  ├─ stampSocketIp(req, ...)
  ├─ OPTIONS → 204 + CORS headers
  │
  └─ try {
       │
       ├─ visitorAuthMiddleware(req, pathname, db)     ← NEW (inside try/catch)
       │   ├─ read site.settings.visitorAuth (in-memory cached)
       │   ├─ enabled === false? → null (pass through)
       │   ├─ skip /_instatic/, /admin/, /health, /api/visitor/, /uploads/
       │   ├─ no protectedPrefix match? → null (public page)
       │   ├─ check session (in-memory cache, 5-min TTL → DB fallback)
       │   ├─ no session? → 302 /login?redirect=<path> (or built-in fallback HTML)
       │   └─ valid session? → null (pass through)
       │
       └─ handleServerRequest(req, runtime)
           ├─ [4] tryServeVisitorRoutes               ← NEW
           │       └─ /api/visitor/* → visitor auth handlers
           ├─ tryServeCmsApi          → /admin/api/cms/* (admin auth, unchanged)
           ├─ ... existing routes ...
           ├─ tryServeStaticAsset    → /_instatic/* (CSS, JS, hole runtime)
           ├─ tryServePublicRoute
           │       ├─ Layer A: disk artefact (static HTML, ~0.7ms)
           │       ├─ Layer B: LRU cache
           │       └─ 404 / not-found template
           └─ tryServeNotFoundPage
     } catch (err) → 500 (with security headers)
```

**Key change from v1:** The middleware runs **inside** the existing `try` block in `server/index.ts`, before `handleServerRequest`. This ensures middleware errors are caught by the existing error handler (generic 500 + security headers), and the 302 redirect gets `applySecurityHeaders` + CORS treatment like every other response.

### 4.2 Design Principles

1. **Separate systems by cookie name, not cookie path.** Visitor auth uses cookie `instatic_visitor_session`; admin auth uses `instatic_admin_session`. These are different names — admin routes only read the admin cookie, visitor middleware only reads the visitor cookie. The admin cookie has no explicit `Path=` attribute (it defaults to `/`); the visitor cookie also uses `Path=/` because visitors need it on all public pages. Isolation is guaranteed by **different cookie names and different middleware**, not by cookie path scoping.

2. **Reuse utility functions, ban admin state imports.** Visitor auth MAY import these specific stateless utilities from `server/auth/`:
   - `hashSessionToken`, `createSessionToken`, `sessionExpiry` from `server/auth/tokens.ts`
   - `RateLimiter` class from `server/auth/rateLimit.ts`
   - `isStateChangingMethod`, `originAllowed`, `publicOriginIsHttps` from `server/auth/security.ts`
   
   Visitor auth MUST NOT import from: `server/auth/sessions.ts`, `server/auth/middleware.ts`, `server/auth/index.ts`, `server/repositories/users.ts`, or any CMS handler. The architecture gate test enforces this specific ban list.

3. **Auth is request-time.** The publisher (`src/core/publisher/`) is not modified. Auth-gated content uses the existing hole mechanism. Static pages remain static files on disk.

4. **Minimal core diff.** Core files are modified by ~20 lines total in Phase 1 (down from the original +25 estimate thanks to the simpler middleware insertion). All visitor auth logic is in new files.

### 4.3 Database Schema

#### `visitor_users`

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| `id` | text | PK, nanoid | |
| `email` | text | NOT NULL | |
| `email_normalized` | text | NOT NULL | Lowercase, trimmed. Unique via separate index (see below) |
| `password_hash` | text | NOT NULL | Argon2id via Bun.password.hash |
| `display_name` | text | NOT NULL DEFAULT '', CHECK(length <= 200) | |
| `role_id` | text | NOT NULL, FK→visitor_roles(id) | |
| `status` | text | NOT NULL DEFAULT 'active' | CHECK: 'active' \| 'suspended' |
| `failed_login_count` | integer | NOT NULL DEFAULT 0 | |
| `locked_until` | text | NULL | ISO 8601 |
| `created_at` | text | NOT NULL | ISO 8601 |
| `updated_at` | text | NOT NULL | ISO 8601 |
| `deleted_at` | text | NULL | Soft delete |

**Indexes:** Separate `CREATE UNIQUE INDEX visitor_users_email_active_idx ON visitor_users (email_normalized) WHERE deleted_at IS NULL` — not a table constraint, because partial unique indexes must be separate `CREATE INDEX` statements for SQLite compatibility.

#### `visitor_sessions`

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| `id_hash` | text | PK | SHA-256 of session token |
| `user_id` | text | NOT NULL, FK→visitor_users(id) CASCADE | |
| `created_at` | text | NOT NULL | |
| `last_seen_at` | text | NOT NULL | Debounced 30s (mirrors admin session pattern) |
| `expires_at` | text | NOT NULL | 90-day absolute expiry |
| `revoked_at` | text | NULL | |
| `ip_address` | text | NULL | |
| `user_agent` | text | NULL | |
| `device_label` | text | NOT NULL DEFAULT '' | UA parsing deferred to Phase 2; empty string is valid |

**Indexes:** `visitor_sessions_user_idx` on `(user_id, last_seen_at DESC)`

#### `visitor_roles`

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| `id` | text | PK | |
| `name` | text | NOT NULL UNIQUE | e.g., 'member', 'admin', 'editor' |
| `capabilities_json` | text | NOT NULL DEFAULT '[]' | JSON array. Known simplification (M2): junction table deferred until role queries become complex. |
| `is_system` | integer | NOT NULL DEFAULT 0 | |
| `created_at` | text | NOT NULL | |
| `updated_at` | text | NOT NULL | |

**Seeded roles:** `member` (default for new registrations), `admin` (full access)

#### `visitor_login_attempts`

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| `id` | text | PK | |
| `attempted_at` | text | NOT NULL | |
| `email_normalized` | text | NULL | |
| `ip_address` | text | NULL | |
| `user_agent` | text | NULL | |
| `user_id` | text | NULL, FK→visitor_users(id) SET NULL | |
| `result` | text | NOT NULL | CHECK: 'success' \| 'bad_password' \| 'no_user' \| 'locked' \| 'rate_limited' |

**Indexes:** `visitor_login_attempts_ip_idx`, `visitor_login_attempts_email_idx`

**Cleanup (M1):** Rows older than 90 days are purged by a periodic job (daily, piggybacks on the heartbeat tick or a dedicated cron).

### 4.4 Session & Security

**Cookie:** `instatic_visitor_session`
- `Path=/; HttpOnly; Secure; SameSite=Lax`
- `Secure` flag set when `publicOriginIsHttps()` returns true (reuses existing `server/auth/security.ts` function)
- Token: 32 random bytes (base64url-encoded)
- Storage: SHA-256 hash of token as `id_hash` (never store raw token)
- Expiry: 90-day absolute, 30-day idle
- Rotation: on password change

**In-memory session cache (H5):**
- `Map<string, CachedSession>` keyed by `id_hash`, 5-minute TTL
- On session validation: cache hit → return immediately (no DB); cache miss → DB query → cache result
- On session revoke/logout: delete from cache
- **Trade-off:** Stale revocation takes up to 5 minutes to propagate. Acceptable for member areas (not banking).

**Rate limits (reuse `RateLimiter` class from `server/auth/rateLimit.ts`):**

| Limiter | Key | Limit | Window |
|---------|-----|-------|--------|
| `visitorLoginRateLimit` | `<ip>\|<email>` | 5 | 15 min |
| `visitorLoginPerIpRateLimit` | `<ip>` | 30 | 10 min |
| `visitorRegisterPerIpRateLimit` | `<ip>` | 3 | 60 min |
| `visitorForgotPerIpRateLimit` | `<ip>` | 3 | 60 min |
| `visitorForgotPerEmailRateLimit` | `<email>` | 1 | 15 min |

**Lockout (reuse `evaluateFailedAttempt` pattern from `server/auth/lockout.ts`):**
- 5 failed attempts → exponential backoff (15min → 30min → 1h → 2h → 4h → 8h → ... → 24h cap)
- Per-account, not per-IP

**Password hashing:** `Bun.password.hash(password, { algorithm: 'argon2id' })` — same as admin

**Password policy (M3):** Minimum 8 characters. Frontend enforces before submission; server validates and rejects shorter passwords with `422`.

### 4.5 API Endpoints

All mounted at `/api/visitor/*` via a new `tryServeVisitorRoutes` handler in the router at **position 4** (after `tryServeAi`, before `tryServeCmsApi`). Defense-in-depth: placing visitor routes before the admin CMS API ensures they're reachable regardless of future admin route prefix changes.

**CSRF protection (H6):** All state-changing endpoints (POST/PATCH/DELETE) apply `isStateChangingMethod` + `originAllowed` from `server/auth/security.ts` (same pattern as `handleCmsRequest` in `server/handlers/cms/index.ts`). `PUBLIC_ORIGIN` must be configured for production deployments (same prerequisite as admin auth). Safe methods (GET) are not checked.

#### `POST /api/visitor/register`

Create a visitor account.

| | |
|---|---|
| **Auth?** | None |
| **CSRF** | Origin check |
| **Rate limit** | 3/hour per IP |

**Request:**
```json
{ "email": "user@example.com", "password": "secret123", "displayName": "Darren" }
```

| Field | Required | Validation |
|-------|----------|------------|
| `email` | Yes | Valid email, max 254 chars |
| `password` | Yes | Min 8 chars |
| `displayName` | No | Max 200 chars, defaults to '' |

**Responses:**

| Status | Body | When |
|--------|------|------|
| 201 | `{ "id": "...", "email": "...", "displayName": "...", "role": "member" }` | Success |
| 403 | `{ "error": "registration_closed" }` | `visitorAuth.registrationOpen === false` |
| 409 | `{ "error": "email_taken" }` | Email already registered (active, non-deleted) |
| 422 | `{ "error": "validation_failed", "details": { "password": "Password must be at least 8 characters" } }` | Validation error |
| 429 | `{ "error": "rate_limited", "retryAfterMs": 3600000 }` | Rate limit exceeded |

#### `POST /api/visitor/login`

Authenticate and create a session.

| | |
|---|---|
| **Auth?** | None |
| **CSRF** | Origin check |
| **Rate limit** | 5/15min per (ip,email), 30/10min per IP |

**Request:**
```json
{ "email": "user@example.com", "password": "secret123" }
```

**Responses:**

| Status | Body | When |
|--------|------|------|
| 200 | `{ "id": "...", "email": "...", "displayName": "...", "role": "member", "capabilities": [...] }` | Success (sets `Set-Cookie: instatic_visitor_session=...`) |
| 401 | `{ "error": "invalid_credentials" }` | Bad email or password |
| 401 | `{ "error": "account_locked", "retryAfterMs": 900000 }` | Account locked (exponential backoff) |
| 401 | `{ "error": "account_suspended" }` | User status is 'suspended' |
| 403 | `{ "error": "visitor_auth_disabled" }` | `visitorAuth.enabled === false` |
| 429 | `{ "error": "rate_limited", "retryAfterMs": 600000 }` | Rate limit exceeded |

#### `POST /api/visitor/logout`

Revoke session and clear cookie.

| | |
|---|---|
| **Auth?** | Visitor session |
| **CSRF** | Origin check |

**Responses:**

| Status | Body | When |
|--------|------|------|
| 204 | (empty) | Success. `Set-Cookie: instatic_visitor_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax` |
| 401 | `{ "error": "unauthorized" }` | No valid session |

Client-side JS handles post-logout navigation (`window.location = '/'`).

#### `GET /api/visitor/me`

Return current visitor's profile.

| | |
|---|---|
| **Auth?** | Visitor session |

**Response (200):**
```json
{ "id": "abc123", "email": "user@example.com", "displayName": "Darren", "role": "member", "capabilities": ["content.read"] }
```

**Error (401):** `{ "error": "unauthorized" }`

#### `PATCH /api/visitor/me`

Update display name or email.

| | |
|---|---|
| **Auth?** | Visitor session |
| **CSRF** | Origin check |

**Request:**
```json
{ "displayName": "New Name" }
```

| Field | Updatable | Notes |
|-------|-----------|-------|
| `displayName` | Yes | Max 200 chars |
| `email` | Yes (Phase 2) | Requires email verification |

**Responses:** 200 (updated profile), 401, 422 (validation)

#### `POST /api/visitor/forgot`

Request a password reset email. (Phase 2 — requires email config.)

| | |
|---|---|
| **Auth?** | None |
| **CSRF** | Origin check |
| **Rate limit** | 3/hour per IP, 1/15min per email |

**Request:** `{ "email": "user@example.com" }`

**Responses:** 200 (always — prevents email enumeration), 429

#### `POST /api/visitor/reset`

Reset password with token. (Phase 2.)

| | |
|---|---|
| **Auth?** | None (token in body) |
| **CSRF** | Origin check |

**Request:** `{ "token": "...", "password": "newpass123" }`

**Responses:** 200 (success), 401 (invalid/expired token), 422

#### `GET /api/visitor/gate/<nodeId>`

Check if visitor can access gated content. (Phase 2.)

| | |
|---|---|
| **Auth?** | Optional (anonymous gets fallback) |

**Response:** HTML fragment (real content if authorized, fallback/teaser if not). `Cache-Control: no-store`.

### 4.6 Site Settings Schema

Visitor auth configuration lives in the existing `site.settings_json` column (JSONB on PG, text on SQLite). The `visitorAuth` key is read by the middleware on each request (in-memory cached, refreshed on publish like other site settings).

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

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Global toggle. When false, middleware passes through all requests. `/api/visitor/*` routes return 403. Active sessions are NOT revoked (visitors keep browsing until session expires). |
| `protectedPrefixes` | string[] | `[]` | Path prefixes that require authentication. Prefix matching, not glob (see §4.6.1). |
| `loginPath` | string | `"/login"` | Where unauthenticated visitors are redirected. |
| `registrationOpen` | boolean | `true` | When false, `POST /api/visitor/register` returns 403. |
| `defaultRole` | string | `"member"` | Role ID assigned to new registrations. |

#### 4.6.1 Prefix Matching Semantics

Each entry in `protectedPrefixes` is a path prefix. The matching rule is:

```
pathname === prefix || pathname.startsWith(prefix + '/') || pathname.startsWith(prefix + '?')
```

This means:
- `/members` protects `/members` (exact) and `/members/anything` (sub-paths)
- `/members` does NOT protect `/membership` (no `/` separator)
- `/vip-page` protects ONLY `/vip-page` (exact) and `/vip-page?query=1`
- To protect a directory tree, use a trailing slash: `/members/` protects `/members/`, `/members/dashboard`, etc.

No glob library needed — consistent with Instatic's existing `pathname.startsWith(...)` pattern used throughout the router.

### 4.7 Middleware (`server/visitor-auth/middleware.ts`)

```
visitorAuthMiddleware(req, pathname, db):
  1. Read visitor auth config from site.settings.visitorAuth (in-memory cache)
  2. If visitorAuth.enabled === false → return null (pass through)
  3. Skip if pathname starts with: /_instatic/, /admin/, /health, /api/visitor/, /uploads/
  4. Match pathname against protectedPrefixes[] (prefix matching per §4.6.1)
  5. If no match → return null (public page, pass through)
  6. Parse instatic_visitor_session cookie
  7. If no cookie or invalid/expired/revoked session:
     a. Check if a published page exists at visitorAuth.loginPath
     b. If yes → 302 redirect to /login?redirect=<current path>
     c. If no published page → return built-in fallback login HTML (200 Response)
  8. If valid session (from in-memory cache or DB) → return null (authenticated, pass through)
```

### 4.8 Auth-Gated Holes (Phase 2)

**New node property:** `authGate` on `base.container` module
- Values: `none` (default), `member`, `admin`, or any visitor role name
- Set in the editor Properties panel when a container is selected

**Publisher extension:**
1. New rule in `dynamicDetection.ts`: if `node.props.authGate && node.props.authGate !== 'none'` → mark as gated
2. New render path in `renderNode.ts`: emit `<instatic-gated>` placeholder (not `<instatic-hole>`)
3. The placeholder contains the "fallback" content (baked at publish time — this is what unauthenticated visitors see)
4. The `data-instatic-roles` attribute lists required roles

**Server endpoint:** `/_instatic/gate/<nodeId>?v=<version>`
- Route handler `tryServeGate` inserted at **position 8** in the routes array (after `tryServeHole`, before `tryServeModuleJsAsset`) — keeps hole-related endpoints together and before `tryServeStaticAsset` which would otherwise claim the `/_instatic/` namespace
- Parse `instatic_visitor_session` cookie
- If no valid session → return fallback HTML (`Cache-Control: no-store`)
- If valid session, check user's role against `data-instatic-roles`
- If authorised → render the full node subtree (reusing hole rendering pipeline)
- If unauthorised → return fallback HTML (`Cache-Control: no-store`)

**Runtime extension (~200 bytes):** The existing hole runtime gains a second `querySelectorAll('instatic-gated[data-instatic-gate]')` observer. Same fetch/swap logic as holes, different endpoint URL (`/_instatic/gate/<id>?v=<version>`). The gated runtime is part of the same `hole-runtime.js` file — no separate script tag needed.

**CSP impact:** None. The runtime is served from `self` (same-origin fetch). Gated holes are `no-store` so no caching concerns.

### 4.9 Login Page Contract (C2)

**Problem:** The middleware redirects unauthenticated visitors to `/login`, but that page must exist. There's a chicken-and-egg problem when visitor auth is first enabled and no login page has been created yet.

**Two-tier resolution:**

1. **Primary:** Check if a published page exists at the configured `loginPath` (default `/login`). If yes, serve it normally through the existing `renderPublicResolution` path (Layer A/B/C). The builder designs this page in the visual editor with any layout they want.

2. **Fallback:** If no published page exists at the login path, the middleware returns a **built-in login page** directly as a 200 Response (~3KB HTML, minimal styling). This is NOT a redirect — it's served inline. The built-in page includes:
   - A login form with `data-instatic-auth="login"`
   - A link to `/register` (if registration is open)
   - A link to `/forgot` (Phase 2)
   - The auth runtime script tag: `<script type="module" src="/_instatic/visitor-auth.js" defer></script>`

**Why a built-in fallback instead of auto-creating a published page?** Pages in Instatic are snapshots with tree structures stored in `data_rows`. Auto-creating a properly-structured page requires understanding the full publisher pipeline. The server-rendered fallback is simpler and doesn't pollute the content model.

### 4.10 Auth Runtime JS (`/_instatic/visitor-auth.js`)

A small client-side script (~2-3KB) served from the `/_instatic/` asset namespace. Served by `tryServeStaticAsset` (existing handler) or baked into the publish slot. Follows the same pattern as the hole runtime (`hole-runtime.ts` — a self-contained IIFE with zero dependencies).

**Behaviour:**
1. Find all forms with `data-instatic-auth` attribute
2. Intercept `submit` events via `addEventListener('submit', ...)`
3. Prevent default, validate client-side (min password length), call the appropriate `/api/visitor/*` endpoint via `fetch`
4. On error: display in a `.instatic-auth-error` element within the form
5. On success: redirect to the `redirect` query param or `/`
6. On page load: scan for `[data-instatic-auth-show]` and `[data-instatic-auth-hide]` elements; show/hide based on whether the visitor has a valid session (checked via `GET /api/visitor/me` with `catch` fallback)

**Form field contract:**

| Attribute | Required fields |
|-----------|---------------|
| `data-instatic-auth="login"` | `email`, `password`, hidden `redirect` |
| `data-instatic-auth="register"` | `email`, `password`, `confirm-password`, `displayName` (optional), hidden `redirect` |

### 4.11 Visitor Personalisation via perVisitor Loops

Instatic already supports `perVisitor: true` loop sources with `ctx.request.cookies`. After Phase 1, a loop source can read the `instatic_visitor_session` cookie, validate it, and return visitor-specific data. This enables:
- "Welcome back, {name}" on any page
- Role-specific navigation items
- "Your recent orders" sections

This requires NO changes to the loop system — it already works. A custom plugin or a built-in `visitor.data` loop source would use `ctx.request.cookies['instatic_visitor_session']` to look up the visitor and return personalised fields.

---

## 5. File Changes

### Phase 1 (Page-Level Auth)

#### New Files

| File | Purpose |
|------|---------|
| `server/visitor-auth/middleware.ts` | Route protection + session validation + built-in fallback login page |
| `server/visitor-auth/sessions.ts` | Session CRUD + in-memory cache (5-min TTL, mirrors admin's debounce pattern) |
| `server/visitor-auth/handlers.ts` | API endpoint handlers (register, login, logout, me, forgot, reset) |
| `server/visitor-auth/repositories.ts` | DB operations for visitor_users, visitor_sessions, visitor_login_attempts |
| `server/visitor-auth/rateLimits.ts` | RateLimiter instances for visitor auth |
| `server/visitor-auth/types.ts` | TypeScript interfaces (VisitorUser, VisitorSession, VisitorRole) |
| `server/publish/visitorAuthRuntime.ts` | Builds the `visitor-auth.js` asset string (follows `HOLE_RUNTIME_JS` pattern) |

#### Modified Files

| File | Change | Approx Lines |
|------|--------|-------------|
| `server/index.ts` | Add `import` + `visitorAuthMiddleware()` call inside try block, before `handleServerRequest` | +3 |
| `server/router.ts` | Add `tryServeVisitorRoutes` at position 4 in `routes[]` array | +5 |
| `server/db/migrations-pg.ts` | Add migration `002_visitor_auth`: create 4 tables + indexes + seed roles | +65 |
| `server/db/migrations-sqlite.ts` | Same migration for SQLite dialect | +65 |
| `server/publish/publicRouter.ts` | Pass visitor user info through to render context (for perVisitor personalisation) | +5 |

**Total core diff: ~143 lines across 5 files (all additions, no modifications to existing logic)**

### Phase 2 (Auth-Gated Holes)

#### New Files

| File | Purpose |
|------|---------|
| `server/handlers/cms/gate.ts` | `/_instatic/gate/<nodeId>` endpoint |
| `server/visitor-auth/gateHelpers.ts` | Session validation for gate endpoint |

#### Modified Files

| File | Change | Approx Lines |
|------|--------|-------------|
| `server/router.ts` | Add `tryServeGate` at position 8 | +1 |
| `src/core/publisher/dynamicDetection.ts` | Add Rule 5: `authGate` property classification | +15 |
| `src/core/publisher/renderNode.ts` | Add `renderGatedPlaceholder()` branch | +20 |
| `server/publish/holeRuntime.ts` | Add `<instatic-gated>` observer to runtime (~200 bytes) | +10 |
| `src/modules/base/container/index.ts` | Add `authGate` prop definition | +5 |
| `src/admin/pages/site/canvas/properties/` | Auth gate UI in Properties panel | +50 |

**Total core diff: ~101 lines across 6 files**

---

## 6. Migration Strategy (Upstream Rebase)

Instatic is v0.0.11 and APIs shift before 1.0. Our fork strategy:

1. **Pin to v0.0.11** — create a `fork/v0.0.11` branch from current main
2. **Isolate changes** — all visitor auth code in `server/visitor-auth/`, all new files, minimal core edits
3. **Track upstream** — add CoreBunch/Instatic as `upstream` remote, rebase quarterly
4. **Conflict surface** — only `server/index.ts`, `server/router.ts`, and migration files can conflict
5. **Architecture gate tests** — add tests in `src/__tests__/architecture/visitor-auth-isolation.test.ts` that verify visitor auth never imports from: `server/auth/sessions.ts`, `server/auth/middleware.ts`, `server/auth/index.ts`, `server/repositories/users.ts`, or any CMS handler

**Migration numbering (L4):** Our migration is named `002_visitor_auth` (not `021` as in v1 — the upstream uses a single `001_baseline` consolidated migration, so appending `002_` is the correct pattern). If upstream adds their own `002_*` migration before our next rebase, we rename to `003_visitor_auth` and update the migration ID.

---

## 7. Security Considerations

| Concern | Mitigation |
|---------|------------|
| Session token in DB | SHA-256 hash stored, raw token only in cookie (same as admin) |
| Password storage | Argon2id (same as admin) |
| Brute force | Rate limiting (5/15min per email, 30/10min per IP) + exponential lockout |
| CSRF on login/register | `isStateChangingMethod` + `originAllowed` from `server/auth/security.ts` — same pattern as admin CMS handler. `PUBLIC_ORIGIN` must be configured for production. |
| Session fixation | Regenerate session token on login (don't accept pre-existing tokens) |
| Cookie theft | HttpOnly, Secure (when `publicOriginIsHttps()`), SameSite=Lax |
| Visitor→admin escalation | Different cookie names, different middleware, different DB tables. Visitor middleware only reads `instatic_visitor_session`. Admin routes only read `instatic_admin_session`. No shared session lookup code. |
| Gated content in HTML source | Auth-gated holes are server-rendered — content is NOT in the static HTML. The baked placeholder is the fallback/teaser. Real content only exists in server memory. |
| Cache poisoning | Gated holes and auth'd pages always use `Cache-Control: no-store` |
| Static export bypass | Document that member areas require the Bun server process. Static export (`published/` dir) has no auth. |
| Password reset spam | Rate limited: 3/hour per IP, 1/15min per email. Always returns 200 to prevent email enumeration. |

---

## 8. Performance Impact

| Path | Before | After |
|------|--------|-------|
| Public page (no auth enabled, 95% of traffic) | ~0.6ms (disk read) | ~0.6ms (middleware reads cached config → enabled=false → null, negligible) |
| Public page (auth enabled, page not protected) | ~0.6ms | ~0.7ms (+ config lookup + cookie parse, returns null) |
| Protected page (authenticated, warm session cache) | N/A | ~0.8ms (cache lookup + disk read) |
| Protected page (authenticated, cold cache) | N/A | ~1.5ms (DB session lookup + disk read) |
| Protected page (unauthenticated) | N/A | 302 redirect (~0.3ms) or 200 fallback HTML (~0.5ms) |
| Gated hole (authenticated) | N/A | ~5-10ms (first request, hole render) |
| Gated hole (unauthenticated) | N/A | ~0ms (baked placeholder, no fetch) |
| Visitor API (/api/visitor/login) | N/A | ~50ms (argon2id verify) |

**Key insight:** 95% of pages remain Layer A static files served directly from disk. Auth adds ~0.1ms to the hot path (cached config lookup + cookie parse that returns null for unprotected pages). The in-memory session cache means most authenticated requests skip the DB entirely.

---

## 9. Open Questions

1. **Email delivery for password reset?** Phase 2 needs email config. Use site settings for SMTP, or defer to Phase 3 with plugin integration.
2. **Admin UI for visitor management?** Phase 1 provides API only. Admin UI (list users, edit roles, revoke sessions) is Phase 1 stretch goal or Phase 2.
3. **Social login (Google, GitHub)?** Deferred to Phase 3. The separate-cookie architecture makes this straightforward to add later.
4. **Should visitor roles be editable in the admin UI?** Yes, Phase 1 — simple CRUD on the `visitor_roles` table.
5. **Merge upstream?** Long-term, if CoreBunch is interested, we can propose this as a PR. Short-term, maintain as a fork.

---

## 10. Success Metrics

- [ ] Visitor can register, log in, log out via API
- [ ] Protected pages return 302 redirect when unauthenticated
- [ ] Protected pages serve normally when authenticated
- [ ] Built-in fallback login page works when no custom login page is published
- [ ] Auth-gated sections show fallback for unauthenticated, real content for authenticated
- [ ] Public pages have zero measurable performance regression (<0.1ms)
- [ ] Admin auth system is completely untouched (all existing tests pass)
- [ ] New visitor auth code passes its own test suite
- [ ] Architecture gate test confirms visitor auth never imports banned admin auth modules
- [ ] Lockout and rate limiting work correctly for visitor login
- [ ] Session is properly scoped (visitor session cookie never read by admin middleware)
- [ ] In-memory session cache reduces DB queries for repeated authenticated requests
- [ ] CSRF origin check works on all state-changing visitor endpoints
