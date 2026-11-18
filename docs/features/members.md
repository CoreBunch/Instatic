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
| `GET sign-in` | `next` | bare fallback sign-in page, used when no login page is assigned |

Error codes are the `MEMBER_ERROR_CODES` list in `@core/members`.

## Security rules

**Cookie.** `__Host-instatic_member` on https (`Secure`, `Path=/`, no `Domain`), `instatic_member` on loopback http. `HttpOnly; SameSite=Lax`. Only the name matching the request's security context is read.

**Sessions.** 32 random bytes, stored as SHA-256. 90 days absolute, 30 days idle, both checked in the lookup query together with "not revoked" and "member is active". Suspending a member or signing out ends access on the next request.

**CSRF.** Every POST needs an `Origin` that is one of the site's origins, and a same-origin `Sec-Fetch-Site` when the browser sends one. Changing a password or email and deleting the account also need the current password (or, for a passwordless member, a sign-in within the last 15 minutes).

**Enumeration.** A sign-in for an unknown address still pays one argon2 verification. Requests that send email decide their answer first and send in the background (`queueMemberMail`), so timing does not differ.

**Sign-up and pre-hijacking.** The member row is created with no password. The hash travels in the confirmation token and applies only when the link is opened in the browser that signed up (matched by the `instatic_member_signup` cookie, `__Host-` prefixed on https so a sibling subdomain cannot plant one, and ignored when it appears twice). Opened anywhere else, the link still confirms the address and signs in, with no password set. So a stranger who signs up with someone else's address never gets their password onto the account, even if the owner opens the email.

**No hard lockout.** Limits are sliding windows per IP, per IP+email, per email and per recipient (`limits.ts`); an account is never locked. Sign-in limits are reserved before the password is checked, so a burst of requests cannot slip under them, and given back when the sign-in works. The per-email limit counts failures from everywhere, so anyone can run it out; after that, an address that has not tried the email before gets one of five further attempts an hour, which keeps the owner's password usable without giving a guesser with many addresses more than those five. Emails are limited per recipient both per kind and overall. Whatever a stranger uses up, the owner keeps a way in: the last sign-in or reset link sent stays valid, because a refused request issues no new token.

**Links in emails** are built from `configuredPublicOrigin()`. With none configured they are built only for a request from this machine (loopback peer and loopback host); otherwise the action fails with `email_unavailable`. The `Host` header is never used.

**Emailed links never act on GET.** They open a page (the owner's, from `member_settings.pages`, or `linkPage.ts`) whose button POSTs the token. Mail scanners that follow links do not use them up.

**Plugins never see Instatic's cookies.** `server/sessionCookies.ts` removes every `instatic_` cookie (admin session, member session, sign-up nonce, branch preview); plugin route handlers (`routeIo.ts`) and per-visitor loop sources (`handlers/cms/hole.ts`) get the visitor's cookies with those removed.

## Protected pages and tables

A page carries an optional `access` rule (`AccessRuleSchema` in `@core/members`, stored as the page row's `access` cell). A data table carries one in `data_tables.access_json`, covering all of its entry routes. Templates are not protectable: the route they wrap decides.

| Level | Who gets in | `onDeny` |
|---|---|---|
| `public` (no rule) | anyone | |
| `members` | any signed-in member | `login` or `hide` |
| `tags` | a signed-in member holding any one of `tags` | `login` or `hide` |

`login` sends a signed-out visitor to the assigned login page (or the bare `/_instatic/members/sign-in`) with `?next=`; a signed-in member without the tag gets a `403`. `hide` answers exactly like a route that does not exist.

How it is enforced (`server/publish/accessGate.ts`):

1. **A protected route is never stored where a request is answered without asking.** It is not baked to the static slot (`publishSite.ts`, `bakeDataRows.ts`, `publishRow.ts`) and never enters the render cache.
2. **The publish-time access index** (`getAccessIndex`, one load per publish version) lists protected page slugs and table route bases. A page's rule is written into its published version's cells for this (`persistSitePublish`). `renderPublicResolution` consults it first, so a protected path skips both cache layers.
3. **The rule is checked again on the route that actually resolved**, before rendering. That check decides; it does not depend on how the path was spelled. When several rules apply to one request (a page and its table, a template's table and the route a fragment claims), every one must pass (`decideAccess`), and a hiding rule wins over a telling one.
4. **Fragments are gated like their page.** `/_instatic/hole/<id>` and `/_instatic/loop/<id>` apply the owning page's rule (and, for a hole, the rule of the route in `u`), and are never cached for a protected page.
5. **`/uploads/published/…` is never served.** The static slot lives under the uploads folder; `isPublishedSlotUploadPath` in `server/router.ts` blocks it on the resolved file path.

Everything rendered behind a rule is sent `Cache-Control: private, no-store`.

**Fail closed.** A stored rule that cannot be read becomes `LOCKED_ACCESS` (nobody, hidden), never public (`parseAccessRule`).

**When a rule takes effect.** A page's rule is page content: it applies on publish. A table's rule is a live setting: `setTableAccess` (`server/publish/tableAccess.ts`) removes every baked page from the static slot (the table's rows may be listed anywhere) and bumps the publish version, so it applies on the next request. Pages render live until the next publish bakes them again.

**Lists follow the same rules.** A loop never shows what the visitor could not open by its address. Every public render hands loop sources a `closed` set (`ClosedContent` in `@core/loops/types`, built by `closedContentFor`): `data.rows` returns nothing for a closed table and, when aimed at the Pages table, leaves closed pages out; `site.pages` leaves closed pages out. A baked page, a cached render and a shared fragment are rendered as for a signed-out visitor. Only a protected route, rendered per request, is rendered with the member's tags, so a members page can list what that member may open. Admin previews pass no `closed` set and show everything. Plugin loop sources do not receive it; a plugin that lists its own protected data must check access itself.

## Building member pages in the editor

Four primitives; none of them needs custom code.

**Member forms.** `base.form` has a third mode, `member`, with a `memberAction` prop. The catalogue is `MEMBER_FORM_ACTIONS` in `src/core/members/formActions.ts`: one entry per action with its endpoint path, fields, whether it needs an emailed token and whether it needs a signed-in member. The form setup panel offers the action and an "Add …" button that inserts the missing labelled inputs, messages and submit button (`memberFormFragment`).

- Published, it is a real `<form method="post" action="/_instatic/members/<action>">`, so it works with scripts off (the endpoint answers a form post with a redirect). An unknown action falls back to `login`, never to another path (`memberFormActionPath`).
- With scripts on, the form runtime (`formRuntimeJs.ts`, one script for CMS and member forms) submits in place as JSON. An error about one field marks that control `aria-invalid` and goes to a `base.form-message` with `kind: error` and `fieldName` set to that field, or to the form's general error message.
- A token action (`password/reset`, `invite/accept`, `verify`, `link/confirm`, `email/confirm`) carries a hidden `token` input that the runtime fills from the page's `?token=`.
- After signing in, `?next=` (a site-relative path only) wins, then the form's redirect. Signing in, out or deleting with no redirect reloads the page.

**Member bindings.** The `member` binding source: `{member.email}`, `{member.profile.<fieldId>}`, `{member.tagList}`. Empty for a signed-out visitor, so `{member.profile.name|there}` reads well for both. Values are data: they go through the same escaping as every other binding.

**Show-when rules.** Any element can be limited to signed-in members, signed-out visitors, or members holding a tag (the "Show to" control in the element's Attributes view). The rule is the `showWhen` prop (`ShowWhenSchema`, `readShowWhen`, `showWhenAllows` in `@core/members`). It is applied on the server: an element a visitor may not see is not in their HTML. A rule that cannot be read shows the element to nobody. It hides one element and protects nothing else; protecting a page is the access rule.

**Access controls.** Page settings has an Access group (`AccessRuleEditor`), and a protected page carries a lock in the Site explorer. Changing a page's rule needs `site.structure.edit` (`pageDiff.ts`). A table's rule is edited in the Data workspace (Access section of a post type's settings) through `GET` / `PUT /admin/api/cms/data/tables/:id/access`: main branch only, `canManageTable`, step-up, audited as `data.table.access`.

### How member-dependent content is rendered

A node that uses a member binding or a show-when rule is different for every visitor, so it never reaches the static slot or the shared cache:

- On a **public page** it becomes a hole (detection Rule 5 in [publisher](publisher.md)). `/_instatic/hole/<id>` sees that the fragment depends on the member (`subtreeDependsOnMember`), resolves the visitor, renders with the member in the context and answers `private, no-store`. The loop endpoint does the same for a list whose items show member data.
- On a **protected page**, which is rendered per request anyway, the member is put in the render context (`TemplateRenderDataContext.member`) and these nodes render in place, with no fragment round trip.

`member` in the context has three states: a frame (signed in), `null` (signed out) and absent (a render for nobody in particular: a baked page, a shared-cache render, a branch preview). Absent behaves as signed out.

## Deleting and exporting

`delete` anonymises: the row stays with a placeholder address and `status = 'deleted'`, and sessions, tokens, tags, profile and event IP/user-agent are removed. The address is free to register again. `GET export` returns the account, profile, tags, live sessions and activity.

## Tests

- `src/__tests__/server/members.test.ts` — every flow, on SQLite and (with `DB=postgres`) Postgres.
- `src/__tests__/architecture/members-admin-split.test.ts` — the split.
- `src/__tests__/server/pluginRouteCookies.test.ts` — cookie stripping.
- `src/__tests__/server/membersAccessGate.test.ts` — the gate: static slot, render cache, path spellings, the uploads route, fragments, table rules.
