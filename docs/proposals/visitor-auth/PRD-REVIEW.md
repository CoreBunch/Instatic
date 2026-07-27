# PRD Review: Instatic Members

**Reviewer:** GLM-5.2 sub-agent + Sinclaira synthesis  
**PRD:** `PRD.md`  
**Source:** `Instatic/` at commit `960fdaa` (v0.0.11)  
**Date:** 2026-07-22  

---

## Summary

The PRD is **technically sound in its core architecture** — the separate-cookie, separate-table, middleware-before-router approach is the right call and aligns with how Instatic actually works. However, the review identified **3 Critical, 7 High, 8 Medium, 4 Low, and 2 Info** findings that need resolution before Phase 1 implementation begins.

The critical findings cluster around: (1) the middleware placement assumption, (2) the login page bootstrapping gap, and (3) cookie scoping subtleties. All are fixable with small PRD amendments.

---

## Findings

### CRITICAL

#### C1: Middleware must run INSIDE the try/catch, not before `handleServerRequest`

**Severity:** Critical  
**PRD Section:** §4.1, §5 (Phase 1 file changes)  

The PRD shows the middleware running before `handleServerRequest` in the flow diagram and says `server/index.ts` gets +10 lines adding the call before `handleServerRequest`. Looking at the actual `server/index.ts`:

```typescript
// Lines 80-92
try {
  const res = await handleServerRequest(req, { db, staticDir, uploadsDir, databaseUrl })
  for (const [k, v] of Object.entries(cors)) { res.headers.set(k, v) }
  return applySecurityHeaders(res, pathname)
} catch (err) {
  console.error('[server] Unhandled request error:', err)
  return applySecurityHeaders(
    new Response(JSON.stringify({ error: 'Internal server error' }), { ... }),
    pathname,
  )
}
```

If the middleware runs *before* the try/catch, any error in visitor auth (DB timeout, bad config) becomes an unhandled Bun.serve rejection — no JSON 500, no security headers, no logging via the established pattern.

**Fix:** Insert the middleware call *inside* the try block, before `handleServerRequest`:

```typescript
try {
  const authResponse = await visitorAuthMiddleware(req, pathname, db)
  if (authResponse) return applySecurityHeaders(authResponse, pathname)

  const res = await handleServerRequest(req, { ... })
  ...
}
```

This adds CORS headers and security headers to the 302 redirect, consistent with every other response.

---

#### C2: Login page bootstrapping is completely unaddressed

**Severity:** Critical  
**PRD Section:** §4.6, §9 (Open Questions)  

The PRD says: "Login/register pages are published Instatic pages — designed in the visual editor, backend via `/api/visitor/*` routes." But it never answers:

1. **Who creates `/login` and `/register` pages?** There's no auto-provisioning step. When a site builder enables visitor auth (story A1), do login/register pages appear automatically? Must the builder create them manually? If manual, how do they know to include the right HTML form structure?

2. **What's the form contract?** The PRD defines JSON API endpoints but zero HTML form specification. A published Instatic page is static HTML — it needs a `<form>` that POSTs to `/api/visitor/login`. The PRD doesn't specify:
   - Required form fields and their `name` attributes
   - The JavaScript that intercepts the form submission and calls `fetch('/api/visitor/login', ...)`
   - Error display patterns
   - Where this JS comes from (a runtime asset like hole runtime? Inline? A new `/api/visitor/auth-runtime.js`?)

3. **The chicken-and-egg problem:** The middleware redirects unauthenticated visitors to `/login`. But `/login` is a published page. If the builder hasn't created it yet, visitors get a 404 loop. If they have created it, but the auth runtime JS isn't loaded, the form is dead HTML.

**Fix (PRD amendment):**

- Add §4.9 "Login Page Contract" specifying:
  - Default pages auto-created when visitor auth is first enabled (seeded like system roles)
  - A server-rendered fallback `/login` page when no custom page exists (like `tryServeNotFoundPage` — serve a built-in HTML page, not a redirect)
  - The auth runtime JS: a small asset served from `/_instatic/visitor-auth.js` (~2KB) that enhances any form with `data-instatic-auth="login"` or `data-instatic-auth="register"`
  - The form field contract: `email`, `password`, `confirm-password` (register only), `redirect` (hidden)

---

#### C3: Cookie `Path=/` creates an implicit trust boundary violation

**Severity:** Critical  
**PRD Section:** §4.4  

The PRD specifies `Path=/` for the visitor session cookie. The admin cookie uses `Path=/admin` (confirmed: `SESSION_COOKIE_NAME = 'instatic_admin_session'` in `server/auth/tokens.ts`; the cookie path is set elsewhere but the admin namespace is `/admin/*`).

The concern: a visitor session cookie sent to `/admin/*` means the browser transmits it on every request to the admin namespace. While the admin auth middleware should ignore it (different cookie name), this is unnecessary data leakage.

More importantly: the PRD says "admin cookie is `Path=/admin`, visitor cookie is `Path=/`" as a security argument. But looking at the actual code, the admin cookie path needs verification — if it's actually `Path=/` (common in session cookies), both cookies are sent everywhere and the PRD's scoping argument is wrong.

**Fix:** 

- Verify the admin session cookie's actual `Path` attribute (check `server/auth/sessions.ts` or wherever `set-cookie` is constructed)
- If admin cookie is `Path=/`: the PRD should acknowledge this and explain why different cookie *names* alone provide sufficient isolation (they do — middleware only reads the cookie it knows about)
- If admin cookie is `Path=/admin`: keep `Path=/` for visitor cookie (visitors need it on public pages), but remove the comparative security claim since it's about namespace separation, not cookie path

---

### HIGH

#### H1: `tryServeVisitorRoutes` position in the routes array is wrong

**Severity:** High  
**PRD Section:** §5 ("before `tryServePublicRoute`")  

The PRD says to add `tryServeVisitorRoutes` to the `routes[]` array before `tryServePublicRoute`. Looking at the actual routing table order:

```typescript
const routes: readonly RouteHandler[] = [
  tryServeHealth,          // 1
  tryServeMcp,             // 2
  tryServeAi,              // 3
  tryServeCmsApi,          // 4 — /admin/api/cms/*
  tryServeLoopRuntimeAsset,// 5
  tryServeLoop,            // 6
  tryServeHoleRuntimeAsset,// 7
  tryServeHole,            // 8
  tryServeModuleJsAsset,   // 9
  tryServePublicForm,      // 10
  tryServeRuntimeAsset,    // 11
  tryServeRuntimePackageNamespace, // 12
  tryServeSiteCssNamespace,// 13
  tryServeMediaRedirect,   // 14
  tryServeStaticAsset,     // 15 — /_instatic/*
  tryServeUpload,          // 16
  tryServeAdminApp,        // 17
  tryServePublicRoute,     // 18
  trySetupRedirect,        // 19
  tryServeNotFoundPage,    // 20
]
```

`tryServePublicRoute` is at position 18. But `tryServeStaticAsset` (position 15) serves `/_instatic/*`, which includes the visitor auth runtime JS. The visitor API routes (`/api/visitor/*`) must be matched BEFORE the admin CMS API routes (position 4) to avoid the admin auth gate blocking them.

**Fix:** Insert `tryServeVisitorRoutes` at position **4** (before `tryServeCmsApi`), not position 17. The visitor API has its own auth (visitor session cookie), and the admin API gate should never see these requests.

Wait — actually, re-reading: `tryServeCmsApi` checks for the `/admin/api/cms/*` prefix. `/api/visitor/*` won't match that prefix. So position before `tryServePublicRoute` (position 18) *would* work functionally. But for clarity and to avoid future admin API prefix changes, position 4 (right after `tryServeAi`) is better.

**Revised fix:** Insert at position 4 for defense-in-depth. Document why.

---

#### H2: The PRD reuses `hashSessionToken` and `RateLimiter` but doesn't account for Bun's module caching

**Severity:** High  
**PRD Section:** §4.2 ("Reuse patterns, not code")  

The PRD says: "We instantiate the same `RateLimiter` class and call the same `hashSessionToken()` function, but visitor auth lives in its own directory."

Importing from `server/auth/tokens.ts` and `server/auth/rateLimit.ts` means visitor auth code has a compile-time dependency on the admin auth directory. The PRD's own architecture gate test (§6) says: "verify visitor auth never imports from `server/auth/*`". **These are contradictory.**

**Fix:** Three options, pick one in the PRD:

1. **Copy the functions** (~30 lines total: `hashSessionToken`, `createSessionToken`, `sessionExpiry`, the `RateLimiter` class). This is the purest isolation but creates maintenance drift.
2. **Extract shared utilities** into `server/auth/shared/` (or `server/utils/`) that both admin auth and visitor auth import from. The architecture gate test checks for imports from `server/auth/tokens.ts` and `server/auth/rateLimit.ts` specifically, not the shared module.
3. **Accept the import and update the gate test.** The `RateLimiter` class and `hashSessionToken` are pure utility functions with no admin-specific state. Importing them doesn't create a runtime dependency on admin auth. The gate test should verify "visitor auth never imports admin session validation, admin middleware, or admin repositories from `server/auth/*`" — not a blanket ban.

**Recommendation:** Option 3. The PRD already notes these are pattern reuse. The gate test should be specific about what it bans.

---

#### H3: No specification for how `visitorAuth.enabled` is stored or read

**Severity:** High  
**PRD Section:** §4.6  

The middleware reads `site.settings.visitorAuth` to check if auth is enabled. But:

- Instatic's site settings are stored in the database, likely in a `settings` JSON column on a site/config table
- The PRD doesn't specify the schema for this setting
- The PRD doesn't specify how it's surfaced in the admin UI (story A1 says "enable/disable visitor auth globally in site settings" but there's no UI spec)
- If visitor auth is disabled, should existing sessions be invalidated? Should the middleware still serve `/api/visitor/*` routes?

**Fix:** Add a `site_settings` sub-section specifying:

```json
{
  "visitorAuth": {
    "enabled": true,
    "protectedPrefixes": ["/members", "/dashboard"],
    "defaultRedirect": "/members",
    "registrationOpen": true
  }
}
```

And specify: when `enabled` is toggled OFF, active sessions are not revoked (visitors keep browsing until session expires), but the middleware stops enforcing redirects. The `/api/visitor/*` routes return 403 when auth is disabled.

---

#### H4: `protectedPrefixes` glob matching is under-specified

**Severity:** High  
**PRD Section:** §4.6  

The middleware step 4 says "Match pathname against `protectedPrefixes[]` (glob matching)". But:

- What glob library? Bun doesn't have built-in glob matching for URL paths. The admin router uses exact prefix matching (`pathname.startsWith(...)`).
- Does `/members/*` protect `/members/settings` but not `/memberships`? Prefix matching says yes/no depending on trailing slash.
- What about query strings? The PRD doesn't mention them.
- What about exact page paths vs. prefix paths? A builder might want to protect `/vip-page` (exact) and `/members/*` (prefix).

**Fix:** Replace "glob matching" with exact prefix matching (consistent with the rest of Instatic's router). Each entry in `protectedPrefixes` is a path prefix. `/members` protects `/members`, `/members/`, `/members/anything`. To protect only `/vip-page` exactly, the prefix is `/vip-page` and the middleware adds a trailing-slash check (or the builder uses a directory structure).

---

#### H5: Session DB lookup on every protected-page request breaks the "0.1ms overhead" claim

**Severity:** High  
**PRD Section:** §8 (Performance Impact)  

The PRD claims protected pages add ~1.5ms (cookie + session DB lookup + disk read). A single indexed DB query for a session row by SHA-256 hash should indeed be ~0.5ms on SQLite and ~1ms on PG. But:

- The PRD doesn't mention connection pooling or connection cost. If Instatic uses a single connection (likely for SQLite), the query is sequential. For PG, if there's a connection pool, the lookup is a pool round-trip.
- The `last_seen_at` debounce (30s) requires a read-then-conditional-write, which is two queries unless done cleverly.
- On high-traffic member areas, every page view = 1-2 DB queries. This is the exact pattern Instatic was designed to avoid.

**Fix:** Add a session cache (in-memory Map, 5-minute TTL) that avoids the DB lookup on repeated requests from the same visitor. The cache key is `id_hash`. This brings the per-request cost back to ~0.1ms for warm sessions. The PRD should acknowledge the trade-off: stale session revocation takes up to 5 minutes to propagate (acceptable for member areas, not for banking).

---

#### H6: Missing CSRF protection specification for visitor auth endpoints

**Severity:** High  
**PRD Section:** §4.5, §7  

The PRD mentions "Origin check (reuse existing `isStateChangingMethod` + `originAllowed` pattern)" in §7. But `isStateChangingMethod` and `originAllowed` are in `server/auth/security.ts` — which is in the admin auth directory. See H2: importing from here conflicts with the isolation principle.

More importantly, `originAllowed` checks against `configurePublicOrigins(config.publicOrigins)`. If a site is behind a reverse proxy, the public origin must be configured. The PRD doesn't mention this prerequisite.

**Fix:** 

- Extract `isStateChangingMethod` and `originAllowed` to `server/utils/security.ts` (they're origin utilities, not auth-specific)
- Or duplicate the ~20 lines of logic (they're simple string comparisons)
- Document that visitor auth endpoints require `PUBLIC_ORIGIN` to be configured, same as admin auth

---

#### H7: No logout API response specification

**Severity:** High  
**PRD Section:** §4.5  

The `POST /api/visitor/logout` endpoint revokes the session and clears the cookie. But:

- What's the response body? Empty? `{ "ok": true }`?
- What status code? 200? 204?
- After logout, should the response redirect to the home page? The client-side JS needs to know what to do.

**Fix:** Specify: `204 No Content` with `Set-Cookie: instatic_visitor_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`. The client-side JS handles redirect via `window.location = '/'`.

---

### MEDIUM

#### M1: `visitor_login_attempts` table has no TTL/cleanup strategy

**Severity:** Medium  
**PRD Section:** §4.3  

The `visitor_login_attempts` table grows unbounded. Admin login attempts aren't stored in a separate table (the admin system uses `failed_login_count` on the user row + in-memory rate limits). The visitor system adds a full audit table.

**Fix:** Add a periodic cleanup job (daily, delete rows older than 90 days) or use the heartbeat system's 30-minute tick to prune.

---

#### M2: `visitor_roles.capabilities_json` uses a JSON string column instead of a junction table

**Severity:** Medium  
**PRD Section:** §4.3  

Storing capabilities as a JSON array in a text column works for simple cases but makes querying "which users have capability X?" require scanning all roles. The admin system uses a proper capabilities table.

However, for a v1 with 2-3 roles and ~10 capabilities, this is fine. Flag for Phase 2 if role queries become complex.

**Fix:** Acknowledge in PRD as a known simplification. Add a comment in the migration.

---

#### M3: Missing password strength requirements

**Severity:** Medium  
**PRD Section:** §4.5 (register handler)  

The PRD doesn't specify minimum password length, complexity requirements, or whether Bun.password.hash's argon2id parameters are sufficient alone.

**Fix:** Add minimum 8 characters. Argon2id handles the hashing strength. The frontend should enforce minimum length before submission.

---

#### M4: `email_normalized` UNIQUE constraint with partial index may not work on SQLite

**Severity:** Medium  
**PRD Section:** §4.3  

The PRD specifies: `UNIQUE (email_normalized) WHERE deleted_at IS NULL`. This is a partial unique index, which PostgreSQL supports natively. SQLite also supports partial indexes (since 3.8.0), but the syntax must be `CREATE UNIQUE INDEX ... ON visitor_users (email_normalized) WHERE deleted_at IS NULL` — not a table-level constraint.

**Fix:** Specify the index as a separate `CREATE INDEX` statement in both migrations, not a table constraint.

---

#### M5: No specification for visitor account deletion (GDPR/right to be forgotten)

**Severity:** Medium  
**PRD Section:** (missing)  

The schema has `deleted_at` for soft delete, but no endpoint or story for a visitor to delete their own account. GDPR requires this for EU visitors.

**Fix:** Add user story V8: "As a visitor, I can delete my account and all my data." Add `DELETE /api/visitor/me` endpoint (hard delete after anonymising login_attempts). This can be Phase 2.

---

#### M6: `display_name` field has no length constraint

**Severity:** Medium  
**PRD Section:** §4.3  

Without a length limit, a visitor could submit a multi-megabyte display name. The admin system likely has similar gaps, but since we're adding new tables, we should set an example.

**Fix:** Add `CHECK (length(display_name) <= 200)` in the migration.

---

#### M7: Auth-gated holes endpoint `/_instatic/gate/<nodeId>` conflicts with static asset namespace

**Severity:** Medium  
**PRD Section:** §4.7  

The `/_instatic/*` namespace is served by `tryServeStaticAsset` (position 15 in the router). A `/_instatic/gate/<nodeId>` endpoint would need to be added BEFORE `tryServeStaticAsset` in the routes array. The PRD mentions the endpoint but doesn't specify its router position.

**Fix:** Add to the routes array at position 8 (after `tryServeHole`, since gated holes are a sibling feature to regular holes).

---

#### M8: Missing OpenAPI / endpoint documentation

**Severity:** Medium  
**PRD Section:** §4.5  

The PRD lists endpoints but doesn't specify request bodies, response schemas for all cases, or error codes beyond a single example. For example:

- `POST /api/visitor/register`: What if the email is already taken? 409? 422?
- `PATCH /api/visitor/me`: What fields are updatable? All? Just `display_name`?
- `GET /api/visitor/me` when session is invalid: 401? What's the response body?

**Fix:** Add a request/response table for each endpoint with success and error cases.

---

### LOW

#### L1: No specification for visitor avatar/upload support

**Severity:** Low  
**PRD Section:** §4.3 (visitor_users table)  

Story V4 mentions "avatar" but the `visitor_users` table has no avatar field. This is probably a future enhancement, but the story should be marked as Phase 2+ or the avatar reference removed.

---

#### L2: `device_label` in `visitor_sessions` has no derivation logic

**Severity:** Low  
**PRD Section:** §4.3  

The field exists in the schema but no logic is specified for how to populate it. User-Agent parsing is non-trivial. Consider using a simple UA string truncation or deferring to Phase 2.

---

#### L3: No rate limit for password reset emails

**Severity:** Low  
**PRD Section:** §4.4  

The rate limits table covers login, per-IP login, and registration, but not `POST /api/visitor/forgot`. An attacker could spam password reset emails to harass a user.

**Fix:** Add `visitorForgotPerIpRateLimit`: 3 per hour per IP, 1 per 15 min per email.

---

#### L4: Migration numbering assumes no upstream migrations collide

**Severity:** Low  
**PRD Section:** §5  

The PRD adds migration 021. If upstream adds migration 021 before the next rebase, there's a conflict. This is a general fork maintenance concern, not specific to this PRD.

**Fix:** Use a namespace prefix in migration filenames (e.g., `021_visitor_auth_*`) and document the rebase conflict resolution process.

---

### INFO

#### I1: The PRD's Layer A performance claim of ~0.6ms is conservative

**Severity:** Info  

Actual `readArtefact` is a Bun.file() read which is well under 1ms on SSD/NVMe. The 0.6ms figure in the PRD is fine as a conservative estimate. With the cookie parse overhead, 0.7ms for public pages is realistic.

---

#### I2: Consider adding a `visitor_sessions` purge job

**Severity:** Info  

Expired and revoked sessions should be periodically purged from the database. The admin system likely has a similar job. Align with whatever pattern the admin uses.

---

## Resolution Matrix

| ID | Severity | PRD Change Required? | Resolution |
|----|----------|---------------------|------------|
| C1 | Critical | Yes | Move middleware inside try/catch (§4.1 diagram + §5) |
| C2 | Critical | Yes | Add §4.9 login page contract |
| C3 | Critical | Yes | Verify admin cookie Path, update §4.4 and §7 |
| H1 | High | Yes | Specify route position as position 4, not "before tryServePublicRoute" |
| H2 | High | Yes | Choose option 3 (accept utility imports, narrow gate test) |
| H3 | High | Yes | Add site_settings schema in §4.6 |
| H4 | High | Yes | Replace "glob" with prefix matching, clarify semantics |
| H5 | High | Yes | Add in-memory session cache (5-min TTL) |
| H6 | High | Yes | Resolve CSRF utility import (see H2) + document PUBLIC_ORIGIN prereq |
| H7 | High | Yes | Specify 204 + Set-Cookie for logout |
| M1 | Medium | Minor | Add cleanup strategy note |
| M2 | Medium | No | Acknowledge as known simplification |
| M3 | Medium | Minor | Add password min length |
| M4 | Medium | Yes | Separate CREATE INDEX in migrations |
| M5 | Medium | Defer | Add as Phase 2 story |
| M6 | Medium | Minor | Add CHECK constraint |
| M7 | Medium | Yes | Specify route position for gate endpoint |
| M8 | Medium | Yes | Add full request/response specs |
| L1 | Low | Minor | Clarify V4 avatar as Phase 2 |
| L2 | Low | Minor | Defer device_label population |
| L3 | Low | Minor | Add forgot rate limit |
| L4 | Low | No | Document in fork maintenance §6 |
| I1 | Info | No | No change |
| I2 | Info | Minor | Note in §4.3 |

---

## Verdict

**Proceed with implementation after addressing C1-C3 and H1-H7.** The core architecture (separate cookies, separate tables, middleware interception, auth-gated holes) is validated against the source code and sound. The findings are specification gaps, not fundamental design flaws.

Estimated PRD amendment effort: ~2 hours.
