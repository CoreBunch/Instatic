# Members

Site members are people who sign up and log in on the **published site**. They are not admin users: different tables, a different cookie, no capabilities, and code that shares nothing with the admin auth funnel except stateless primitives.

Core is headless here. It provides accounts, sessions and actions; the site owner builds the login, register and account pages in the editor and points their forms at these endpoints.

---

## TL;DR

- **Endpoints** live under `/_instatic/members/*` (`server/members/handlers.ts`). Every action is one POST that answers a plain HTML form with a `303` redirect and a script with JSON.
- **No built-in pages.** Core serves no sign-in page and no page for an emailed link. Each is a page the owner builds and chooses in the member settings; a feature whose page is not set, or not published, is not there.
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
| `logout` | | for scripts; a page uses the sign-out link below |
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
| `GET logout` | `?to=<site path>` | the sign-out link: signs out, then `303` to `to` (default `/`) |
| `GET me` | | `{ member }` or `{ member: null }`, `no-store` |
| `GET export` | | the member's own data as a download |

Error codes are the `MEMBER_ERROR_CODES` list in `@core/members`.

## Security rules

**Cookie.** `__Host-instatic_member` on https (`Secure`, `Path=/`, no `Domain`), `instatic_member` on loopback http. `HttpOnly; SameSite=Lax`. Only the name matching the request's security context is read.

**Sessions.** 32 random bytes, stored as SHA-256. 90 days absolute, 30 days idle, both checked in the lookup query together with "not revoked" and "member is active". Suspending a member or signing out ends access on the next request.

**CSRF.** Every POST needs an `Origin` that is one of the site's origins, and a same-origin `Sec-Fetch-Site` when the browser sends one. The sign-out link is the one GET that changes anything; it carries no `Origin`, so it acts only on a click made on a page of this site: `Sec-Fetch-Site: same-origin` as a document navigation that is not a prefetch, or a same-site `Referer` when the browser sends no `Sec-Fetch-Site`. Anything else, including a link opened from an email, only redirects. Changing a password or email and deleting the account also need the current password (or, for a passwordless member, a sign-in within the last 15 minutes).

**Enumeration.** A sign-in for an unknown address still pays one argon2 verification. Requests that send email decide their answer first and send in the background (`queueMemberMail`), so timing does not differ.

**Sign-up and pre-hijacking.** The member row is created with no password. The hash travels in the confirmation token and applies only when the link is opened in the browser that signed up (matched by the `instatic_member_signup` cookie, `__Host-` prefixed on https so a sibling subdomain cannot plant one, and ignored when it appears twice). Opened anywhere else, the link still confirms the address and signs in, with no password set. So a stranger who signs up with someone else's address never gets their password onto the account, even if the owner opens the email.

**Token pages.** A page opened from an emailed link has a live token in its address. It is sent `Referrer-Policy: same-origin` (`TOKEN_PAGE_REFERRER_POLICY`), so no request to another site carries the address. `no-referrer` would be wrong here: a browser then submits the page's own form with `Origin: null`, and the member endpoints refuse a POST that does not name the site's origin.

**No hard lockout.** Limits are sliding windows per IP, per IP+email, per email and per recipient (`limits.ts`); an account is never locked. Sign-in limits are reserved before the password is checked, so a burst of requests cannot slip under them, and given back when the sign-in works. The per-email limit counts failures from everywhere, so anyone can run it out; after that, an address that has not tried the email before gets one of five further attempts an hour, which keeps the owner's password usable without giving a guesser with many addresses more than those five. Emails are limited per recipient both per kind and overall. Whatever a stranger uses up, the owner keeps a way in: the last sign-in or reset link sent stays valid, because a refused request issues no new token.

**Links in emails** are built from `configuredPublicOrigin()`. With none configured they are built only for a request from this machine (loopback peer and loopback host); otherwise the action fails with `email_unavailable`. The `Host` header is never used.

**No built-in member pages.** Core serves no sign-in page and no page for an emailed link. Every one is a page the owner builds in the editor and chooses in `member_settings.pages` (`login`, `afterLogin`, `verify`, `reset`, `magic`, `invite`, `emailChange`). A setting holds the page's **id**, not its address, so renaming a page never breaks a link. `server/members/pages.ts` turns the ids into live addresses (`resolveMemberPagePaths`, `getMemberPagePaths`): only a published page has one, and it is the published slug, not the draft's. A feature whose page is not set, deleted or not published is simply not there:

| Page not set | What does not happen |
|---|---|
| `login` | a protected page with `onDeny: login` answers "not found" to a signed-out visitor (`denyResponse` returns null) |
| `verify` | `signup` answers `not_available` (404) |
| `reset` | `password/forgot` answers `not_available` |
| `magic` | `link/request` answers `not_available` |
| `emailChange` | `email/change` answers `not_available` |
| `invite` | the admin and plugin invite calls are refused (409 / an error naming the missing page); the Invite button is disabled with the reason |

`not_available` is decided from the settings and the published pages alone, before any address is looked up, so it is the same answer for every address (`linkPageMissing` in `service.ts`, `memberLinkPage` in `mail.ts`). Signing in with a password needs no emailed link and works on any page that holds a sign-in form.

**Page pickers.** The settings response carries `pageOptions` (`listMemberPageOptions`): every ordinary page with its draft address, its live address (null while unpublished) and the member form actions found on it. A caller with `members.manage` therefore sees the title and address of every page, unpublished ones included, without holding a site capability; that is accepted, since choosing these pages is that role's job. Member settings shows one page picker per setting, and `memberPageState` (`@core/members`) reads how the chosen page stands: `unset`, `missing` (deleted), `unpublished`, `no_form` (the form in `MEMBER_PAGE_FORM_ACTIONS` for that setting was not found on the page itself) or `ready`. `missing` blocks saving, and the server refuses an id that is not a page; `unpublished` and `no_form` are warnings. The Members tab uses `memberPageIsLive` for the Invite button and the sign-up notice, the same rule the server applies.

`afterLogin` is where a member who just signed in goes when nothing else says where: the `signed_in` answer carries it as `landing`. The form runtime uses `?next=` first, then the form's own redirect, then `landing`, and otherwise reloads the page; a plain form with no `_success` is redirected to it.

**Emailed links never act on GET.** They open the owner's page for that link, whose form POSTs the token (`?token=` is filled in by the form runtime). Mail scanners that follow links do not use them up. A page whose address carries a token is sent `Referrer-Policy: same-origin` (`TOKEN_PAGE_REFERRER_POLICY`).

**Plugins never see Instatic's cookies.** `server/sessionCookies.ts` removes every `instatic_` cookie (admin session, member session, sign-up nonce, branch preview); plugin route handlers (`routeIo.ts`) and per-visitor loop sources (`handlers/cms/hole.ts`) get the visitor's cookies with those removed. Who the member is reaches plugin code only as a plain record resolved by the host: `ctx.member` on a route, and `ctx.request.member` on a per-visitor loop source, both only for a plugin holding `members.read`. A source that is not per-visitor is never told, and gets no cookies either; the request is built per source in `server/publish/loopSourceRequest.ts`.

## Protected pages and tables

A page carries an optional `access` rule (`AccessRuleSchema` in `@core/members`, stored as the page row's `access` cell). A data table carries one in `data_tables.access_json`, covering all of its entry routes. Templates are not protectable: the route they wrap decides.

| Level | Who gets in | `onDeny` |
|---|---|---|
| `public` (no rule) | anyone | |
| `members` | any signed-in member | `login` or `hide` |
| `tags` | a signed-in member holding any one of `tags` | `login` or `hide` |

`login` sends a signed-out visitor to the owner's sign-in page (`pages.login`) with `?next=`. With no sign-in page set there is nowhere to send them, and the route answers like one that does not exist. A signed-in member who lacks the tag also gets "not found": signing in again would not help, and core has no page of its own to say so. `hide` answers "not found" to everyone who may not open the route.

How it is enforced (`server/publish/accessGate.ts`):

1. **A protected route is never stored where a request is answered without asking.** It is not baked to the static slot (`publishSite.ts`, `bakeDataRows.ts`, `publishRow.ts`) and never enters the render cache.
2. **The publish-time access index** (`getAccessIndex`, one load per publish version) lists protected page slugs and table route bases. A page's rule is written into its published version's cells for this (`persistSitePublish`). `renderPublicResolution` consults it first, so a protected path skips both cache layers.
3. **The rule is checked again on the route that actually resolved**, before rendering. That check decides; it does not depend on how the path was spelled. When several rules apply to one request (a page and its table, a template's table and the route a fragment claims), every one must pass (`decideAccess`), and a hiding rule wins over a telling one.
4. **Fragments are gated like their page.** `/_instatic/hole/<id>` and `/_instatic/loop/<id>` apply the owning page's rule (and, for a hole, the rule of the route in `u`), and are never cached for a protected page.
5. **`/uploads/published/…` is never served.** The static slot lives under the uploads folder; `isPublishedSlotUploadPath` in `server/router.ts` blocks it on the resolved file path.

Everything rendered behind a rule is sent `Cache-Control: private, no-store`.

**Fail closed.** A stored rule that cannot be read becomes `LOCKED_ACCESS` (nobody, hidden), never public (`parseAccessRule`).

**When a rule takes effect.** A page's rule is page content: it applies on publish. A table's rule is a live setting: `setTableAccess` (`server/publish/tableAccess.ts`) removes every baked page from the static slot (the table's rows may be listed anywhere) and bumps the publish version, so it applies on the next request. Pages render live until the next publish bakes them again.

**Other ways a rule is written.** A page's rule is a cell, so it is forked, compared and merged with the rest of the page on a branch, and seeded into the page's co-editing document with the other page fields. A table's rule exists on the main branch only and is not part of a branch. Site export and import carry both; an import keeps stored rules and only adds (see [site-transfer.md](site-transfer.md) → "Access rules").

**Lists follow the same rules.** A loop never shows what the visitor could not open by its address. Every public render hands loop sources a `closed` set (`ClosedContent` in `@core/loops/types`, built by `closedContentFor`): `data.rows` returns nothing for a closed table and, when aimed at the Pages table, leaves closed pages out; `site.pages` leaves closed pages out. A baked page, a cached render and a shared fragment are rendered as for a signed-out visitor. Only a protected route, rendered per request, is rendered with the member's tags, so a members page can list what that member may open. Admin previews pass no `closed` set and show everything. Plugin loop sources do not receive it; a plugin that lists its own protected data must check access itself.

## Building member pages in the editor

Four primitives; none of them needs custom code.

**Member forms.** `base.form` has a third mode, `member`, with a `memberAction` prop. The catalogue is `MEMBER_FORM_ACTIONS` in `src/core/members/formActions.ts`: one entry per action with its endpoint path, fields, whether it needs an emailed token and whether it needs a signed-in member. The form setup panel offers the action and an "Add …" button that inserts the missing labelled inputs, messages and submit button (`memberFormFragment`).

- Published, it is a real `<form method="post" action="/_instatic/members/<action>">`, so it works with scripts off (the endpoint answers a form post with a redirect). An unknown action falls back to `login`, never to another path (`memberFormActionPath`).
- With scripts on, the form runtime (`formRuntimeJs.ts`, one script for CMS and member forms) submits in place as JSON. An error about one field marks that control `aria-invalid` and goes to a `base.form-message` with `kind: error` and `fieldName` set to that field, or to the form's general error message.
- A token action (`password/reset`, `invite/accept`, `verify`, `link/confirm`, `email/confirm`) carries a hidden `token` input that the runtime fills from the page's `?token=`.
- After signing in, `?next=` (a site-relative path only) wins, then the form's redirect. Signing in, out or deleting with no redirect reloads the page.

**Member bindings.** The `member` binding source: `{member.email}`, `{member.profile.<fieldId>}`, `{member.tagList}`. Empty for a signed-out visitor, so `{member.profile.name|there}` reads well for both. Values are data: they go through the same escaping as every other binding.

**Show-when rules.** Any element can be limited to signed-in members, signed-out visitors, or members holding a tag (the "Show to" control in the element's Visibility view, whose tab carries a dot while a rule is set). The rule is the `showWhen` prop (`ShowWhenSchema`, `readShowWhen`, `showWhenAllows` in `@core/members`). It is applied on the server: an element a visitor may not see is not in their HTML. A rule that cannot be read shows the element to nobody. It hides one element and protects nothing else; protecting a page is the access rule. The fragment and list endpoints, which render one node on request, check the rules above that node along the render path (`showWhenPathsTo` in `src/core/publisher/showWhenGate.ts`), so a child of a limited element cannot be fetched on its own. The path goes through Visual Components: a list inside a component is under the component's own elements and under the reference that placed it, and slot content is under the outlet it fills. A node on no render path is given to nobody. So is a component node whose rule is bound to a component parameter: the value differs per placement, and the endpoints do not work it out. A page is rendered inside the site-wide layouts, at their outlet, so its elements are also under whatever rule sits above the outlet there (`layoutRulesAbove`). That only closes the direct fetch: a limited element that holds the outlet is itself fetched as a fragment, and a fragment is rendered from the layout alone, without the page, so the content comes out empty for everyone. The same holds for an entry template's outlet. The "Show to" control is therefore disabled on an element that holds the outlet, with a note pointing to page access, which is the way to limit content.

**Access controls.** Page settings has an Access group (`AccessRuleEditor`), and a protected page carries a lock in the Site explorer. Changing a page's rule needs `site.structure.edit` (`pageDiff.ts`). A page is also a row, so the generic row paths (Data and Content workspaces, version restore, plugin content calls, AI content tools) put the stored rule back through `keepPageAccess` (`server/writePolicy/pageAccessCell.ts`): leaving `access` out of a row save does not open the page. Duplicating a page copies its rule. A table's rule is edited in the Data workspace (Access section of a post type's settings) through `GET` / `PUT /admin/api/cms/data/tables/:id/access`: main branch only, `canManageTable`, step-up, audited as `data.table.access`.

### How member-dependent content is rendered

A node that uses a member binding or a show-when rule is different for every visitor, so it never reaches the static slot or the shared cache:

- On a **public page** it becomes a hole (detection Rule 5 in [publisher](publisher.md)). `/_instatic/hole/<id>` sees that the fragment depends on the member (`subtreeDependsOnMember`), resolves the visitor, renders with the member in the context and answers `private, no-store`. The loop endpoint does the same for a list whose items show member data.
- On a **protected page**, which is rendered per request anyway, the member is put in the render context (`TemplateRenderDataContext.member`) and these nodes render in place, with no fragment round trip.

`member` in the context has three states: a frame (signed in), `null` (signed out) and absent (a render for nobody in particular: a baked page, a shared-cache render, a branch preview). Absent behaves as signed out.

## Managing members in the admin

**Users → Site members** (`src/admin/pages/users/tabs/MembersTab.tsx`) sits beside Admin users, Roles and Audit. A user with `members.read` or `members.manage` can open the Users page for this tab alone (`canAccessUsersWorkspace`).

The API is `server/handlers/cms/members.ts` under `/admin/api/cms/members`. It decides who may call and audits the call; every query on the member tables stays in `server/members/admin.ts` (the split is gated by `members-admin-split.test.ts`).

| Method | Path | What it does | Needs |
|---|---|---|---|
| GET | `/members?q=&status=&tag=&offset=` | One page of 50, plus counts by status and the tags in use | read or manage |
| GET | `/members/:id` | Profile, tag grants, sessions, newest 50 events | read or manage |
| POST | `/members/invite` | Create an invited member and email a link | manage |
| POST | `/members/:id/suspend`, `/unsuspend` | Block or restore sign-in | manage |
| POST | `/members/:id/sign-out` | End every session | manage |
| POST / DELETE | `/members/:id/tags` | Grant a tag (source `admin`, optional end) / withdraw one source's grant | manage |
| DELETE | `/members/:id` | Anonymise, as the member's own delete does | manage + step-up |
| GET / PUT | `/members/settings` | Sign-up mode, profile fields, link pages | read / manage + step-up |

- **Status** for the admin is `active`, `pending` or `suspended`. `pending` is an account that is not usable yet (no password and an unconfirmed address): someone invited who has not accepted, or someone who signed up and has not opened the confirmation link. A deleted member is not listed.
- **Invitations** are a single-use link, delivered one of two ways (`delivery` in the request). `email` (the default) mails it and needs outgoing email (`memberMailAvailable`). `link` mails nothing and returns the link in the response for the admin to pass on by hand; it needs only a known public address (`linkAvailable` in the settings response). So a site with no connector can still invite: the dialog's button becomes "Create invitation link" and the link is shown once in `InvitationLinkDialog`, never stored and sent `no-store`. With email set up, "Create a link instead" is offered beside "Send invitation". Only a site that does not know its public address has the button disabled, with the reason. A link handed over this way proves nothing about who owns the address: whoever opens it sets the password, and the account then counts as confirmed on the admin's word. That is why asking for the link needs step-up, the dialog says to send it only to that person, and the audit entry records `delivery`. Inviting an address with a pending invitation makes a fresh link; an address that already has an account is refused. The link opens the owner's `invite` page and lasts 7 days; with no such page set, invitations are off (see "No built-in member pages").
- **Suspension** takes effect on the next request (`findMemberSession` requires an active member). Sessions and unused tokens are also ended for good, so restoring a member does not bring an old session back.
- **Search** matches the address and the profile text. `%` and `_` are plain characters.
- **Settings** are validated beyond the schema: field ids must be unique and must not be a name the member forms use (`email`, `password`, `token`, `currentPassword`, `newPassword`). A link page must be a site path.
- **Audit:** `member.invite`, `member.suspend`, `member.unsuspend`, `member.signout`, `member.delete`, `member.tag.grant`, `member.tag.revoke`, `member.settings.update`, each with the member's address in the metadata, since the audit trail cannot look a member up by id.

The binding picker lists one `member.profile.<id>` entry per profile field (`loadMemberProfileFields`); an editor who may not read member settings gets the built-in list.

## Plugins

A plugin reaches members through `api.cms.members`, member routes and member events, each behind its own permission (`members.read`, `members.write`, `members.tags`). The plugin-facing contract is in [plugin-system](plugin-system.md) → "Site members". What matters on this side:

- **Who the member is, is resolved by the host** on the public plugin mount (`server/plugins/publicRoutes.ts`) and handed to the plugin as a plain record. A plugin never holds a session cookie, and the admin mount never identifies a member.
- **Tags a plugin grants carry its id as the source**, and it can withdraw only those. This is how a shop grants paid access without being able to remove what an administrator gave.
- **A member's page reaches only plugins that may read members.** The `publish.html` filter runs on public pages as before. A page rendered for one member on a protected route can hold that member's data, so `applyPublishedHtmlPipeline` passes it (`forMember`) only to filters of plugins granted `members.read`; a plugin holding `cms.hooks` alone is passed over for that render. Declared frontend assets are still added to every page.
- **Events** are emitted from the functions every path goes through (`createMember`, `markMemberVerified`, `startSession`, `grantMemberTag`, `anonymizeMember`) by `emitMemberHook` in `server/members/hooks.ts`, without waiting for listeners.

## Deleting and exporting

`delete` anonymises: the row stays with a placeholder address and `status = 'deleted'`, and sessions, tokens, tags, profile and event IP/user-agent are removed. The address is free to register again. `GET export` returns the account, profile, tags, live sessions and activity.

## Try it: the demo site

```sh
bun run demo:members        # add `-- --skip-build` to reuse the last admin build
```

`scripts/members-demo.ts` builds the admin, creates a fresh SQLite database under `.tmp/`, seeds and publishes a small site, and serves it on `http://127.0.0.1:3040` (`DEMO_PORT` changes the port). It prints the owner and member accounts it created. Emails are captured: read them under Email → Activity.

The site (`scripts/lib/membersDemoSite.ts`) is twelve ordinary editor pages: home, join, sign in, forgot password, the pages the emailed links open (confirm, new password, sign-in link, new address, invitation), an account page, a members area and a pro lounge. `membersDemoSettings()` names each of them, by page id, in the member settings, which is what switches the features on. Every form is a `base.form` in Members mode completed by `memberFormFragment`, the function behind the editor's "Add …" button; the header's links use show-when rules, and its sign-out is a `base.link` with On click set to "Sign the member out" (`memberSignOutHref`), since signing out needs no form; the account page prefills from member bindings. Open any page in the editor to see how it is put together.

It is a development tool: fixed passwords, loopback only, and a database that is wiped on every start. `membersDemoSite.test.ts` keeps the pages publishable and correctly gated. The sign-in page also carries the "Email me a link" form. The E2E suite seeds the same pages under an address prefix of its own (`buildMembersDemoPages(prefix)`, printed by `scripts/e2e-members-seed.ts`).

## Tests

- `src/__tests__/server/members.test.ts` — every flow, on SQLite and (with `DB=postgres`) Postgres.
- `src/__tests__/server/membersAdmin.test.ts` — the admin API: capability and step-up gates and every route (SQLite). The queries behind it run on Postgres too through the `admin queries` cases in `members.test.ts`.
- `src/__tests__/server/pluginMembers.test.ts` — plugins: the public mount, member routes, `cms.members`, member events, and the permission each needs.
- `src/__tests__/server/loopSourceMember.test.ts` — the member a per-visitor loop source is given on first and later pages, inside components and nested lists, through a real plugin; and that a shared source, a shared fragment and the static slot never carry a member.
- `src/__tests__/server/membersDemoSite.test.ts` — the demo site: its pages parse, publish, and are open or closed to the right visitors.
- `src/__tests__/architecture/members-admin-split.test.ts` — the split.
- `src/__tests__/server/pluginRouteCookies.test.ts` — cookie stripping.
- `tests/e2e/members-editor.e2e.ts` (MEMBER-001), `members-admin.e2e.ts` (MEMBER-002), `members-account.e2e.ts` (MEMBER-003: sign-up, profile, tag page, export, password change, emailed sign-in link, reset, email change, deletion) and `members-plugin.e2e.ts` (MEMBER-004: a plugin's member routes) — the same flows in a browser, against published pages.
- `src/__tests__/server/membersAccessGate.test.ts` — the gate: static slot, render cache, path spellings, the uploads route, fragments, table rules.
