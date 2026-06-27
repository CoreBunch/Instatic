# Auth and Access

The full authentication and authorization surface — login, sessions, MFA, capabilities, roles, lockout, step-up, CSRF defense, CORS.

Every state-changing CMS request goes through one auth funnel: parse the session cookie, look up the user, check the required capability. There's no per-handler bespoke auth code — the helpers in `server/auth/authz.ts` are the only auth surface a handler should call.

---

## TL;DR

- **Sessions** are token-cookie based. Cookie name: `SESSION_COOKIE_NAME` (`instatic_admin_session`). Tokens are hashed before storage; the cookie carries the raw token.
- **Capabilities** are the access model. 36 `CoreCapability` strings defined in `src/core/capabilities.ts` (`@core/capabilities`). Roles are sets of capabilities. Handlers gate on capability, not role.
- **`requireCapability(req, db, 'site.read')`** is the canonical handler entrypoint. Returns the `AuthUser` or a 401/403 `Response`.
- **MFA (TOTP)** is per-user opt-in. TOTP seeds are encrypted at rest with `INSTATIC_SECRET_KEY`; recovery codes are one-way hashes. Sessions for MFA-enrolled users are `pending_mfa` until verified, then become `active`. Failed MFA codes go through `mfaRateLimit` AND increment the per-account lockout counter — the same counter the password step uses. A locked account is rejected at the MFA step before any code is checked.
- **Step-up auth** gates sensitive actions (delete user, revoke another device, sign out all) unless the user disables it on Account -> Security. The default window is 15 minutes; users can configure 5, 15, 30, or 60 minutes.
- **Lockout** kicks in after 5 failed logins. Exponential backoff capped at 24 hours.
- **CSRF defense in depth.** State-changing methods must come from a matching `Origin`. `SameSite=Lax` covers the rest.
- **CORS** is dev-only. Production is same-origin behind Caddy.

---

## Where the code lives

```text
src/core/capabilities.ts   — CORE_CAPABILITIES (the canonical list), CoreCapability type (@core/capabilities)

server/auth/
├── authz.ts          — requireAuthenticatedUser, requireCapability, requireAnyCapability, requireStepUp
├── capabilities.ts   — imports/re-exports CORE_CAPABILITIES; owns SYSTEM_ROLES, FORCE_SYNC_ROLE_IDS, runtime guards
├── sessions.ts       — createSession, findUserBySessionHash, rotateSessionToken, MFA gates, step-up timer
├── stepUpPolicy.ts   — step-up modes and allowed window lengths
├── tokens.ts         — SESSION_COOKIE_NAME, hashSessionToken
├── mfa.ts            — generateTotpSecret, verifyTotpCode, recovery codes
├── totpSecrets.ts    — encrypt/decrypt persisted TOTP seeds
├── lockout.ts        — evaluateFailedAttempt, evaluateLockState
├── rateLimit.ts      — RateLimiter + loginRateLimit / loginPerIpRateLimit / mfaRateLimit
├── security.ts       — isStateChangingMethod, originAllowed, configurePublicOrigins, publicOriginIsHttps, stampSocketIp, clientIp, DEV_ORIGIN_ALLOWLIST
└── deviceLabel.ts    — UA → friendly device name for the sessions panel
```

Handler endpoints: `server/handlers/cms/auth.ts`, `server/handlers/cms/me.ts`, `server/handlers/cms/setup.ts`, `server/handlers/cms/users.ts`, `server/handlers/cms/roles.ts`.

---

## The session lifecycle

```text
POST /admin/api/cms/auth/login  { email, password }
    │
    ▼
verify password    ← Argon2id against users.password_hash
    │
    ├─→ rate-limited via loginRateLimit (per-email + per-IP)
    ├─→ failed attempt → lockout.evaluateFailedAttempt → exponential backoff
    │
    ▼
createSession(user, deviceLabel, ip)
    │
    ├─→ generate raw token
    ├─→ insert `sessions` row with id_hash = hashSessionToken(rawToken)
    │   carries: user_id, expires_at, device_label, last_ip, last_seen_at,
    │            pending_mfa = userHasMfaEnabled, step_up_expires_at = null
    │
    ▼
Set-Cookie: instatic_admin_session=<rawToken>; HttpOnly; Secure; SameSite=Lax; Path=/admin
    │
    ▼
(user enters MFA code if enrolled)
    │
    ▼
POST /admin/api/cms/auth/mfa/verify  { code }
    │
    ├─→ evaluateLockState(user.lockedUntil) → if locked: 429 Retry-After
    ├─→ rate-limited via mfaRateLimit (per-IP)
    │
    ▼
decrypt encrypted TOTP seed and verifyTotpCode(seed, code), or matchRecoveryCode
    │
    ├─→ fail → recordFailedLoginAttempt → evaluateFailedAttempt → may trigger lockout
    │
    ▼
rotateSessionToken → mfaPassedAt := now
    │
    ▼
session is now ACTIVE; subsequent /admin/api/cms/* requests succeed
```

### On every request

```text
cookie instatic_admin_session=<token>
    │
    ▼
hashSessionToken(token)
    │
    ▼
findUserBySessionHash(db, hash)
    │
    ├─→ no row → 401 Unauthorized
    ├─→ row, pending_mfa = true → 401 { error: 'mfa_required' }
    └─→ row, active → AuthUser { id, email, capabilities, ... }
```

One hydrating SELECT (`USER_JOINED_COLUMNS`, shared with the `users` repository) builds the `AuthUser`. The follow-up `sessions.last_seen_at` touch is **debounced** to at most once per session per ~30s (in-memory tracker) — the idle timeout is 30 days, so the staleness is irrelevant and the per-request write is no longer a hot path. A handler resolves the session exactly once per request and reuses that `AuthUser`; it never calls a second guard that re-hydrates it.

Sessions rotate (the raw token changes, the row stays) on a cadence to limit blast radius of a leaked cookie — `rotateSessionToken(...)` is called by the cookie-touching paths.

### Logout

`POST /admin/api/cms/auth/logout` -> `revokeSessionByHash(db, hash)` -> `Set-Cookie: instatic_admin_session=; Max-Age=0`.

### Multi-device

Users can list active sessions and revoke them individually. `revokeOtherSessions(...)` revokes everything except the calling session — gated by step-up auth.

---

## Capabilities

40 core capabilities. The canonical list is in `src/core/capabilities.ts` (`@core/capabilities`) as an `as const` array; `CoreCapability` is derived from it via `typeof CORE_CAPABILITIES[number]`:

```ts
// src/core/capabilities.ts — source of truth
export const CORE_CAPABILITIES = [
  'dashboard.read', 'site.read',
  'site.structure.edit', 'site.content.edit', 'site.style.edit',
  'pages.edit', 'pages.publish',
  'content.create', 'content.edit.own', 'content.edit.any',
  'content.publish.own', 'content.publish.any', 'content.manage',
  'media.read', 'media.write', 'media.replace', 'media.delete',
  'runtime.dependencies', 'storage.elect', 'storage.migrate',
  'plugins.read', 'plugins.configure', 'plugins.install', 'plugins.lifecycle',
  'users.manage', 'roles.manage', 'audit.read',
  'data.custom.tables.read', 'data.custom.tables.manage',
  'data.system.tables.read', 'data.system.tables.manage',
  'data.rows.move', 'data.export', 'data.import',
  'ai.chat', 'ai.tools.write', 'ai.providers.manage', 'ai.audit.read',
  'seo.read', 'seo.manage',
] as const

export type CoreCapability = typeof CORE_CAPABILITIES[number]
```

### Site-editing split

The site editor's permission surface is split three ways:

| Capability               | What it permits                                                                |
|--------------------------|--------------------------------------------------------------------------------|
| `site.structure.edit`    | Add / remove / move / duplicate / rename nodes; pages, VCs, class registry     |
| `site.content.edit`      | Modify content-typed props on existing nodes (text, image src/alt, link href)  |
| `site.style.edit`        | Modify CSS classes, style overrides, breakpoints, framework tokens             |

The "Client" role has only `site.content.edit` (a copy-editor surface — no structure, no styling). The "Admin" role has all three.

`SITE_WRITE_CAPABILITIES = ['site.structure.edit', 'site.content.edit', 'site.style.edit']` — convenience set the save handler accepts. Granular diff validation enforces which kinds of changes are actually allowed once inside.

### Content publishing split

| Capability                | What it permits                                                  |
|---------------------------|------------------------------------------------------------------|
| `content.create`          | Create new draft rows                                            |
| `content.edit.own`        | Edit rows where `author_user_id = me`                            |
| `content.edit.any`        | Edit any row                                                     |
| `content.publish.own`     | Publish own rows                                                 |
| `content.publish.any`     | Publish any row                                                  |
| `content.manage`          | Full content admin — manage tables, fields, all rows             |

Pages and the page roster are gated by `pages.edit` / `pages.publish` separately.

---

## Roles

Four system roles, defined in `SYSTEM_ROLES`:

| Role    | id        | Capabilities                                                                 | Special     |
|---------|-----------|------------------------------------------------------------------------------|-------------|
| Owner   | `owner`   | All `CORE_CAPABILITIES`                                                      | Owner-only `roles.manage`. Resyncs on every boot via `syncSystemRoles(db)`. |
| Admin   | `admin`   | All except `roles.manage`                                                    | Force-resynced on every boot. Hand-edits restored at next boot. |
| Client  | `client`  | `dashboard.read`, `site.read`, `site.content.edit`, `media.read`, `data.custom.tables.read` | Editable    |
| Member  | `member`  | (none)                                                                       | Editable    |

`listRoles(db)` returns the built-ins in rank order (`owner`, `admin`, `client`, `member`), followed by custom roles alphabetized by name. Custom roles can be created via `roles.manage` (Owner-only). Roles are persisted in the `roles` table with `capabilities_json: CoreCapability[]`.

### System role auto-sync

The **Owner** and **Admin** roles are force-resynced from `SYSTEM_ROLES` on every server boot (`syncSystemRoles(db)` in `server/repositories/roles.ts`, called by `server/index.ts`). Owner gets the full `CORE_CAPABILITIES` set; Admin gets its explicit list (all capabilities except `roles.manage`). This guarantees that adding a new capability to the codebase propagates to both roles at next boot — no existing Owner or Admin account is ever stranded on a stale grant list.

Client and Member are seeded once and left editable; they do not auto-update on boot.

---

## Handler patterns

### `requireAuthenticatedUser(req, db)`

Used by endpoints that just need a logged-in user with no capability check (e.g. `GET /me`).

```ts
const user = await requireAuthenticatedUser(req, db)
if (user instanceof Response) return user
// user: AuthUser
```

### `requireCapability(req, db, 'site.read')`

The canonical capability gate.

```ts
const user = await requireCapability(req, db, 'site.read')
if (user instanceof Response) return user
// 401 if not authenticated, 403 if missing capability, AuthUser otherwise.
```

### `requireAnyCapability(req, db, SITE_WRITE_CAPABILITIES)`

When any of a set of capabilities is sufficient.

```ts
const user = await requireAnyCapability(req, db, SITE_WRITE_CAPABILITIES)
if (user instanceof Response) return user
// AuthUser has at least one of: site.structure.edit, site.content.edit, site.style.edit
```

### `requireStepUp(req, db, user, options?)`

Gates sensitive actions on the user's step-up policy. It takes the **already-resolved `AuthUser`** (no re-authentication) and returns `Response | null`: a 401 when the step-up window is stale, `null` to proceed.

```ts
const user = await requireCapability(req, db, 'users.manage')
if (user instanceof Response) return user
const stepUp = await requireStepUp(req, db, user)
if (stepUp) return stepUp
// User has either disabled step-up, or has re-entered their password inside
// their configured step-up window — and the session was resolved only once.
```

---

## Step-up auth

Sensitive actions (delete user, revoke another device, sign out all devices, change owner email, regenerate MFA, mutate Data table schemas, replace-import a site bundle) call `requireStepUp(req, db, user)` in `server/auth/authz.ts`, passing the user the handler already resolved. When `users.step_up_auth_mode = 'required'`, the current session must have `sessions.step_up_expires_at > now()`. The default policy is required with a 15-minute window; Account -> Security can change the mode to `disabled` or set `users.step_up_window_minutes` to 5, 15, 30, or 60.

The Account -> Security policy endpoint (`PATCH /admin/api/cms/me/security/step-up`) calls `requireStepUp(req, db, user, { policy: 'always' })`, so changing the policy itself still requires a fresh password even when normal sensitive-action step-up is disabled.

```text
User clicks "Delete user X"
    │
    ▼
Handler calls requireStepUp(req, db, user)   // user already resolved
    │
    ├─→ user.stepUpAuthMode = disabled
    │       → return null (proceed)
    ├─→ check sessions.step_up_expires_at > now()
    │       → yes: return null (proceed)
    │       → no:  return 401 { error: 'step_up_required' }
    │
    ▼
Client shows step-up dialog:
    │
    ▼
POST /admin/api/cms/auth/step-up { password }
    │
    ▼
verify password → sessions.step_up_expires_at := now() + users.step_up_window_minutes
    │
    ▼
Client retries the sensitive action — step-up gate now passes.
```

The `<StepUpProvider>` in `src/admin/shared/StepUp/` mounts in `AuthenticatedAdmin` so the dialog is available across all workspaces.

---

## MFA (TOTP)

`server/auth/mfa.ts` implements TOTP per RFC 6238:

```ts
generateTotpSecret(bytes = 20) → base32-encoded secret
totpProvisioningUri({ secret, label, issuer }) → otpauth://...
verifyTotpCode(secret, code, now = Date.now()) → boolean
```

Recovery codes (one-time):

```ts
generateRecoveryCodes(count = 10) → string[]      // display once, hash before storing
hashRecoveryCode(code) → string
findMatchingRecoveryCodeHash(code, hashes) → matchingHash | null
```

### Enrollment flow

1. User visits `/admin/account` → "Enable MFA".
2. Server: `generateTotpSecret()`, stores it temporarily, returns `{ secret, otpauthUrl }`. Client renders the provisioning URI as a QR code (SVG) in the browser.
3. User scans the QR code or enters the manual setup key in their authenticator, then enters the first 6-digit code.
4. Server: `verifyTotpCode` → on success, persist secret on user row, mark `mfa_enabled = true`, generate 10 recovery codes.
5. Server returns the recovery codes once (shown to the user, never returned again).

From now on, login is two-step: password → `pending_mfa` session → TOTP code → active session.

### Rate-limiting

`mfaRateLimit` — per-IP bucket (10 attempts / 10 minutes). The key is `clientIp(req) ?? 'unknown'`. `clientIp(req)` uses the socket peer by default and trusts `X-Forwarded-For` only when that peer matches `TRUSTED_PROXY_CIDRS`. Hitting the limit returns 429.

In addition, failed codes feed the per-account lockout counter (see [Lockout](#lockout)). A correct code submitted after the account is locked is still rejected — the lockout check runs before code verification.

---

## Lockout

`server/auth/lockout.ts` implements exponential backoff for repeated authentication failures.

```text
Failed attempts:  1   2   3   4   5    6      7       8      9        10
Lock duration:    -   -   -   -   15m  30m    1h      2h     4h       8h    ... cap 24h
```

`LOCKOUT_THRESHOLD = 5` — locks kick in after 5 failed attempts.

**The lockout counter is shared across both authentication steps.** `evaluateFailedAttempt(...)` is called on every failed password attempt (in `handleLogin` and `handleStepUp`) AND on every failed MFA code (in `handleMfaVerify`). This means a distributed attacker who already holds the correct password cannot grind the TOTP step indefinitely — failed MFA codes eat the same budget as failed passwords.

`evaluateLockState(...)` is called before each attempt — at the password step in `handleLogin`, and at the MFA step in `handleMfaVerify` (before any code is evaluated). A locked account returns 429 with a `Retry-After` header.

Lockouts are per-account (keyed on `users.id`), not per-IP. The IP rate limit (`loginPerIpRateLimit`) guards against a single address sweeping many accounts; the per-account lockout guards against the same account being attacked from many IPs.

---

## Rate limits

`server/auth/rateLimit.ts` exports three pre-configured limiters:

| Limiter                | Key                      | Limit       | Window     |
|------------------------|--------------------------|-------------|------------|
| `loginRateLimit`       | `<ip>\|<email>` tuple    | 5 attempts  | 15 minutes |
| `loginPerIpRateLimit`  | `<ip>`                   | 30 attempts | 10 minutes |
| `mfaRateLimit`         | `<ip>`                   | 10 attempts | 10 minutes |

`RateLimiter` is a token bucket. Use `RateLimiter.consume(key)` — returns `{ allowed, retryAfterMs }`.

---

## CSRF defense

State-changing methods (`POST/PUT/PATCH/DELETE`) require the request's `Origin` header to match a configured public origin (or a dev allowlist entry). Implemented in `server/handlers/cms/index.ts`:

```ts
if (isStateChangingMethod(req.method) && !originAllowed(req)) {
  return jsonResponse({ error: 'Forbidden: invalid origin' }, { status: 403 })
}
```

The expected origin is derived **only** from the configured public origin set at boot via `configurePublicOrigins(config.publicOrigins)` — `PUBLIC_ORIGIN`, auto-detected from `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN` on those platforms. This decouples CSRF from proxy trust: a TLS-terminating edge that hands the container plain HTTP is handled by configuring the public origin, not by trusting `X-Forwarded-Host` / `X-Forwarded-Proto`. `TRUSTED_PROXY_CIDRS` is independent and only attributes the real client IP for audit logs and rate-limit keys. When no public origin is configured, the check falls back to the inbound `Host` header. Multiple origins (platform domain + custom domain) are accepted from a comma-separated `PUBLIC_ORIGIN`. The same `originAllowed(req)` check guards the AI handlers and the public form endpoints.

`SameSite=Lax` on the session cookie covers the typical CSRF surface; this check closes the same-site-different-subdomain edge case.

`DEV_ORIGIN_ALLOWLIST` allows `http://localhost:5173`, `http://localhost:3001`, and `http://127.0.0.1:5173` so dev-time cross-origin from Vite to the API works.

---

## CORS

Production is **same-origin** (the admin SPA, API, and published pages all serve from one Bun process behind Caddy). The fetch handler in `server/index.ts` only emits CORS headers when the request's `Origin` is on `DEV_ORIGIN_ALLOWLIST`:

```ts
function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !DEV_ORIGIN_ALLOWLIST.includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
}
```

A misconfigured `VITE_ALLOWED_ORIGIN` can never silently open the API up because the function returns `{}` for unknown origins.

---

## Cookbook

### Gate a new handler

Each handler group uses the shared `runRouteTable` dispatcher (`server/handlers/cms/routeTable.ts`). Declare a flat route table, one entry per `(method, path)`, and call `runRouteTable`:

```ts
async function handleListSubscribers(req: Request, db: DbClient, _params: RouteParams): Promise<Response> {
  const user = await requireCapability(req, db, 'content.manage')
  if (user instanceof Response) return user
  // ... read
}

async function handleCreateSubscriber(req: Request, db: DbClient, _params: RouteParams): Promise<Response> {
  const user = await requireAnyCapability(req, db, ['content.create', 'content.manage'])
  if (user instanceof Response) return user
  // ... write
}

const SUBSCRIBERS_ROUTES: readonly Route<[]>[] = [
  { method: 'GET',  pattern: `${CMS_API_PREFIX}/subscribers`, handler: handleListSubscribers },
  { method: 'POST', pattern: `${CMS_API_PREFIX}/subscribers`, handler: handleCreateSubscriber },
]

export async function handleSubscribersRoutes(req: Request, db: DbClient): Promise<Response | null> {
  return runRouteTable(req, db, SUBSCRIBERS_ROUTES)
}
```

`runRouteTable` handles 404 vs 405 correctly in one place: a path that matches but with the wrong method returns 405; no pattern match returns `null` so the next group gets a chance. Do not hand-roll `if (url.pathname !== ...)` or `return methodNotAllowed()` in handler code.

### Add a new capability

1. Append the literal to `CORE_CAPABILITIES` in `src/core/capabilities.ts` (`@core/capabilities`). The `CoreCapability` type updates automatically; the server picks it up via import.
2. If it belongs to the Owner / Admin / Client default sets, add it to the matching entry in `SYSTEM_ROLES` inside `server/auth/capabilities.ts`. Owner + Admin force-sync on next boot.
3. Use `requireCapability(req, db, 'your.new.capability')` in the handler that needs it.
4. Add a `CAPABILITY_META` entry + `CAPABILITY_GROUPS` section in `src/admin/pages/users/utils/capabilities.ts` so the role-edit dialog renders a checkbox. The `capability-picker-coverage.test.ts` gate fails until you do.
5. Existing custom roles will NOT have the new capability until users grant it through the Roles admin page.

### Gate a sensitive action

Resolve the user with `requireCapability` (or `requireAuthenticatedUser`), then add `requireStepUp` on top — it reuses the resolved user, so no second session lookup:

```ts
const user = await requireCapability(req, db, 'users.manage')
if (user instanceof Response) return user
const stepUp = await requireStepUp(req, db, user)
if (stepUp) return stepUp
```

The client sees `401 { error: 'step_up_required' }` and pops the StepUp dialog; on success it retries the action.

### Read who the user is

```ts
const user = await requireAuthenticatedUser(req, db)
if (user instanceof Response) return user

user.id              // string — users.id
user.email           // string
user.capabilities    // CoreCapability[] — flattened from role + grants
```

### Check capability without responding

```ts
if (userHasCapability(user, 'media.manage')) { /* … */ }
if (userHasAnyCapability(user, SITE_WRITE_CAPABILITIES)) { /* … */ }
```

---

## Forbidden patterns

| Pattern                                                          | Use instead                                                |
|------------------------------------------------------------------|------------------------------------------------------------|
| `const user = ...; if (!user) return 401` (ad-hoc auth check)    | `await requireCapability(req, db, '...')`                  |
| Gating on role string (`user.role === 'admin'`)                  | Gate on capability — roles are sets of capabilities        |
| Storing the raw session token in the DB                          | Store `hashSessionToken(rawToken)` — only the cookie carries the raw value |
| Returning `{ error: err.message }` from the login handler        | Return generic message — leaked details help credential stuffing |
| Skipping `originAllowed(req)` on a state-changing endpoint       | The CMS dispatcher already runs the check; don't bypass it |
| Bypassing `mfaRateLimit` for MFA verification                    | Always call `mfaRateLimit.consume(key)` first              |
| Skipping `evaluateLockState` at the MFA step                     | A locked account must be rejected before any code is checked — the per-account lockout covers both the password and MFA steps |
| Failing MFA without calling `evaluateFailedAttempt`              | Failed codes must feed the lockout counter — same as bad passwords |
| Hand-rolling a session timeout in a handler                      | The `sessions` row's `expires_at` is the source of truth   |
| Granting all capabilities to a "superuser" custom role           | Use the Owner role — that's its job. Custom roles should be scoped. |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview (auth funnel in the request lifecycle)
- [docs/server.md](../server.md) — handler patterns, the `requireCapability` flow
- [docs/reference/capabilities.md](../reference/capabilities.md) — full capability matrix + when to add a new one
- Source-of-truth files:
  - `server/auth/authz.ts` — `requireCapability`, `requireAnyCapability`, `requireStepUp`
  - `src/core/capabilities.ts` (`@core/capabilities`) — `CORE_CAPABILITIES`, `CoreCapability` (single source of truth)
  - `server/auth/capabilities.ts` — imports/re-exports `CORE_CAPABILITIES`; owns `SYSTEM_ROLES`, `FORCE_SYNC_ROLE_IDS`, runtime guards
  - `server/auth/sessions.ts` — session lifecycle, MFA gates, step-up timer
  - `server/auth/tokens.ts` — `SESSION_COOKIE_NAME`, `hashSessionToken`
  - `server/auth/mfa.ts` — TOTP + recovery codes
  - `server/auth/lockout.ts` — exponential backoff
  - `server/auth/rateLimit.ts` — `loginRateLimit`, `mfaRateLimit`
  - `server/auth/security.ts` — `originAllowed`, `configurePublicOrigins` (CSRF public origin), `DEV_ORIGIN_ALLOWLIST`, trusted-proxy IP attribution, IP stamping
  - `server/repositories/sessions.ts`, `server/repositories/users.ts`, `server/repositories/roles.ts`, `server/repositories/loginAttempts.ts`
  - `server/handlers/cms/auth.ts`, `me.ts`, `users.ts`, `roles.ts`
- Gate tests:
  - `src/__tests__/architecture/ai-handlers-capability-gated.test.ts`
  - `src/__tests__/architecture/cms-handlers-capability-gated.test.ts`
  - `src/__tests__/architecture/capability-picker-coverage.test.ts`
  - `src/__tests__/architecture/binding-compatibility-coverage.test.ts`
- Regression tests:
  - `src/__tests__/server/requestScopedAuth.test.ts` — verifies the session is hydrated exactly once per request (step-up-gated write: one hydrate, not two) and that `last_seen_at` is debounced to at most one write per session per 30s window.
