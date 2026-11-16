# Members

Site members are people who sign up and log in on the **published site**. They are not admin users: different tables, a different cookie, no capabilities, and code that shares nothing with the admin auth funnel except stateless primitives.

Core is headless here. It provides accounts, sessions and actions; the site owner builds the login, register and account pages in the editor and points their forms at these endpoints.

---

## TL;DR

- **Endpoints** live under `/_instatic/members/*` (`server/members/handlers.ts`). Every action is one POST that answers a plain HTML form with a `303` redirect and a script with JSON.
- **Sign-up is closed by default.** `member_settings.signup_mode` is `closed`, `invite` or `open`.
- **Email confirmation is not optional.** A password only becomes the account's password when the address is proven.
- **Nothing reveals whether an address has an account.** Sign-up, reset and sign-in-link requests all answer `check_email`.
- **Sessions are database rows.** No in-memory cache, so revoking takes effect on the next request.
- **Tags** (`member_tags`) are what access rules and plugins check. Keyed `(member, tag, source)`.
- **Split from admin** is gated by `src/__tests__/architecture/members-admin-split.test.ts`.

---

## Where the code lives

```text
src/core/members/          — TypeBox shapes: settings, profile, CurrentMember, AccessRule (@core/members)
server/members/
├── repository.ts          — members, tags, events, settings (all SQL for those tables)
├── sessions.ts            — member_sessions + the cookie
├── tokens.ts              — single-use emailed-link tokens
├── limits.ts              — rate limits
├── mail.ts                — link building, background send
├── mailTemplates.ts       — the member emails as templates (reworded in Email → Templates)
├── service.ts             — the flows; no HTTP
├── handlers.ts            — /_instatic/members/* : request parsing, redirects, JSON, cookies
└── linkPage.ts            — the bare fallback page for emailed links
```

## Tables (migration `033_members`)

| Table | Holds |
|---|---|
| `members` | email, normalised email (unique among live rows), `password_hash` (null until confirmed, or for passwordless members), `status`, `profile_json` |
| `member_sessions` | SHA-256 of the session token, lifetimes, `revoked_at` |
| `member_tokens` | SHA-256 of emailed-link tokens, `kind`, `payload_json`, `used_at` |
| `member_tags` | `(member_id, tag, source)`, optional `expires_at` |
| `member_events` | per-member security activity (sign-ins, failures, resets) |
| `member_settings` | one row: sign-up mode, profile fields, assigned pages |

`member_settings` is deliberately not in `site.settings_json`: that document is branched and exported.

## Calling an action

```html
<form method="post" action="/_instatic/members/login">
  <input name="email" type="email">
  <input name="password" type="password">
  <input type="hidden" name="_success" value="/account">
  <button>Sign in</button>
</form>
```

- **Form post** (`application/x-www-form-urlencoded`): `303` to `_success` on success, back to the form's page on failure with `?member_error=<code>` and `&member_field=<name>` when one field is at fault. `_error` overrides the failure target. Without `_success`, success returns to the form's page with `?member_ok=<code>`. Redirect targets must be site-relative paths (`safeRedirectPath`).
- **JSON** (`content-type: application/json` or `accept: application/json`): `{ ok: true, code, member? }` or `{ ok: false, error: { code, message, field? } }`.

| Action | Fields | Notes |
|---|---|---|
| `signup` | `email`, `password`, profile fields | answers `check_email` |
| `verify` | `token` | confirmation link; signs in |
| `login` | `email`, `password` | |
| `logout` | | |
| `link/request` | `email` | email a sign-in link |
| `link/confirm` | `token` | signs in; also confirms the address |
| `password/forgot` | `email` | |
| `password/reset` | `token`, `password` | ends every session |
| `invite/accept` | `token`, `password` | |
| `password/change` | `currentPassword`, `newPassword` | signed in; ends other sessions |
| `email/change` | `email`, `currentPassword` | signed in; link goes to the new address |
| `email/confirm` | `token` | |
| `profile` | profile fields | signed in |
| `delete` | `currentPassword` | signed in; anonymises |
| `GET me` | | `{ member }` or `{ member: null }`, `no-store` |
| `GET export` | | the member's own data as a download |

Error codes are the `MEMBER_ERROR_CODES` list in `@core/members`.

## Security rules

**Cookie.** `__Host-instatic_member` on https (`Secure`, `Path=/`, no `Domain`), `instatic_member` on loopback http. `HttpOnly; SameSite=Lax`. Only the name matching the request's security context is read.

**Sessions.** 32 random bytes, stored as SHA-256. 90 days absolute, 30 days idle, both checked in the lookup query together with "not revoked" and "member is active". Suspending a member or signing out ends access on the next request.

**CSRF.** Every POST needs an `Origin` that is one of the site's origins, and a same-origin `Sec-Fetch-Site` when the browser sends one. Changing a password or email and deleting the account also need the current password (or, for a passwordless member, a sign-in within the last 15 minutes).

**Enumeration.** A sign-in for an unknown address still pays one argon2 verification. Requests that send email decide their answer first and send in the background (`queueMemberMail`), so timing does not differ.

**Sign-up and pre-hijacking.** The member row is created with no password. The hash travels in the confirmation token and applies only when the link is opened in the browser that signed up (matched by the `instatic_member_signup` cookie, `__Host-` prefixed on https so a sibling subdomain cannot plant one, and ignored when it appears twice). Opened anywhere else, the link still confirms the address and signs in, with no password set. So a stranger who signs up with someone else's address never gets their password onto the account, even if the owner opens the email.

**No hard lockout, and no lockout by a stranger.** Limits are sliding windows per IP, per IP+email, per email and per recipient (`limits.ts`). An account is never locked. The per-email sign-in limit counts failures from everywhere, so anyone can run it out; a correct password from an address with no failed attempt against that email still gets in. Email limits are counted per recipient and per kind of email, and a refused request issues no new token, so the last link sent stays valid.

**Links in emails** are built from `configuredPublicOrigin()`. With none configured they are built only for a request from this machine (loopback peer and loopback host); otherwise the action fails with `email_unavailable`. The `Host` header is never used.

**Emailed links never act on GET.** They open a page (the owner's, from `member_settings.pages`, or `linkPage.ts`) whose button POSTs the token. Mail scanners that follow links do not use them up.

**Plugins never see Instatic's cookies.** `server/sessionCookies.ts` removes every `instatic_` cookie (admin session, member session, sign-up nonce, branch preview); plugin route handlers (`routeIo.ts`) and per-visitor loop sources (`handlers/cms/hole.ts`) get the visitor's cookies with those removed.

## Deleting and exporting

`delete` anonymises: the row stays with a placeholder address and `status = 'deleted'`, and sessions, tokens, tags, profile and event IP/user-agent are removed. The address is free to register again. `GET export` returns the account, profile, tags, live sessions and activity.

## Tests

- `src/__tests__/server/members.test.ts` — every flow, on SQLite and (with `DB=postgres`) Postgres.
- `src/__tests__/architecture/members-admin-split.test.ts` — the split.
- `src/__tests__/server/pluginRouteCookies.test.ts` — cookie stripping.
