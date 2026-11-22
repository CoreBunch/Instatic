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
├── mail.ts                — link building, queueing the email
├── mailTemplates.ts       — the member emails as templates (reworded in Email → Templates)
├── service.ts             — the flows; no HTTP
├── handlers.ts            — /_instatic/members/* : request parsing, redirects, JSON, cookies
├── apps/                  — sign-in for apps (see "Sign-in for apps")
│   ├── protocol.ts        — issuer, paths, scope parsing
│   ├── store.ts           — apps, requests, grants, codes, tokens (all SQL) and `memberAppRealm`
│   ├── handler.ts         — /_instatic/members/oauth/* and the discovery document
│   ├── scopes.ts          — the scopes on offer: built-in ones and those active plugins declare
│   └── approval.ts        — the member's answer, and what the approval page shows
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

Sign-in for apps adds five tables in migration `038_member_apps`:

| Table | Holds |
|---|---|
| `member_apps` | the apps the owner registered: name, `redirect_uris_json`, `scopes_json`, `deleted_at` |
| `member_app_requests` | a sign-in request waiting for the member's answer: SHA-256 of its id and of the browser marker, the checked parameters, `expires_at`, `decided_at` |
| `member_app_grants` | one approval of one app by one member: `scope`, `expires_at`, `revoked_at`, `last_used_at` |
| `member_app_codes` | SHA-256 of one-time authorization codes |
| `member_app_tokens` | SHA-256 of access and refresh tokens, `kind`, `expires_at`, `revoked_at` |

Migration `039_member_app_devices` adds `device_jkt` and `device_name` to `member_app_requests` and `member_app_grants`.

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
| `logout` | | signed in; a form with only a submit button |
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
| `apps/approve` | `request`, `decision` | signed in; answers an app's sign-in request (see "Sign-in for apps") |
| `apps/disconnect` | `connection` | signed in; signs one app out of the member's account |
| `GET me` | | `{ member }` or `{ member: null }`, `no-store` |
| `GET export` | | the member's own data as a download |

Error codes are the `MEMBER_ERROR_CODES` list in `@core/members`.

## Security rules

**Cookie.** `__Host-instatic_member` on https (`Secure`, `Path=/`, no `Domain`), `instatic_member` on loopback http. `HttpOnly; SameSite=Lax`. Only the name matching the request's security context is read.

**Sessions.** 32 random bytes, stored as SHA-256. 90 days absolute, 30 days idle, both checked in the lookup query together with "not revoked" and "member is active". Suspending a member or signing out ends access on the next request.

**CSRF.** Every POST needs an `Origin` that is one of the site's origins, and a same-origin `Sec-Fetch-Site` when the browser sends one. No GET changes anything, signing out included: it is a POST like every other action, so a link, an image or a prefetch cannot sign a member out. Changing a password or email and deleting the account also need the current password (or, for a passwordless member, a sign-in within the last 15 minutes).

**Enumeration.** A sign-in for an unknown address still pays one argon2 verification. Requests that send email decide their answer first and hand the email to the mail queue without waiting (`queueMemberMail`), so rendering and delivery add nothing to the response time. (A request for a known address still issues a token, which one for an unknown address does not.) The queue sends it straight away and retries a temporary failure; see [email](email.md).

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
| `appSignIn` | an app's sign-in request is answered `temporarily_unavailable` |
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
3. **The rule is checked again on the route that actually resolved**, before rendering. That check decides; it does not depend on how the path was spelled. For an entry route the table's rule is found by the table's id (`rowRouteRules` in `accessGate.ts`), never by its route base or slug: those are strings the owner can change while the index is cached, and the entry route itself resolves against the live route base. For a page it is `pageRouteRules`; an entry template's target (table slugs) is resolved to table ids when the rules are built, and a target that names no live table (renamed, deleted) is locked, so a template's fragments never turn public because a slug moved. The publish bake and background re-renders decide from the same two functions. When several rules apply to one request (a page and its table, a template's table and the route a fragment claims), every one must pass (`decideAccess`), and a hiding rule wins over a telling one.
3a. **A change on `main` that can move routes drops what was cached for the old shape.** Changing a table's route base or slug, or deleting it, in the Data workspace, and a branch merge into `main` or its undo (which can move, delete or restore entries, pages and tables), call `routeVisibilityChanged` (`server/publish/tableAccess.ts`): every baked page is removed and the publish version is bumped, the same steps as an access change. Pages render live until the next publish. Pinned for merges by `branchMergeRouteAccess.test.ts` (an entry moved to a members-only table, an entry deleted, the undo of a merge that opened one, and a declined request, which changes nothing). Pinned by `tableRouteAccess.test.ts`: after such a change a visitor who is not signed in never gets a protected entry, before or after the next publish, and not even when the cached index was never told.
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
- A token action (`password/reset`, `invite/accept`, `verify`, `link/confirm`, `email/confirm`) carries a hidden `token` input that the runtime fills from the page's `?token=`. That one value needs the script: a render has no request to read the address from, so with scripts off these forms post an empty token and are answered `invalid_token`.
- After signing in, `?next=` (a site-relative path only) wins, then the form's redirect. Signing in, out or deleting with no redirect reloads the page.
- Signing out is the `logout` action: a form with no fields, only its submit button. Its catalogue entry has an empty `successMessage`, because the page reloads or moves on and the form goes with the member, so "Add …" inserts an error message and the button and no success message.

**Member bindings.** The `member` binding source: `{member.email}`, `{member.profile.<fieldId>}`, `{member.tagList}`. Empty for a signed-out visitor, so `{member.profile.name|there}` reads well for both. Values are data: they go through the same escaping as every other binding.

**Show-when rules.** Any element can be limited to signed-in members, signed-out visitors, or members holding a tag (the "Show to" control in the element's Visibility view, whose tab carries a dot while a rule is set). The rule is the `showWhen` prop (`ShowWhenSchema`, `readShowWhen`, `showWhenAllows` in `@core/members`). It is applied on the server: an element a visitor may not see is not in their HTML. A rule that cannot be read shows the element to nobody. It hides one element and protects nothing else; protecting a page is the access rule. The fragment and list endpoints, which render one node on request, check the rules above that node along the render path (`showWhenPathsTo` in `src/core/publisher/showWhenGate.ts`), so a child of a limited element cannot be fetched on its own. The path goes through Visual Components: a list inside a component is under the component's own elements and under the reference that placed it, and slot content is under the outlet it fills. A node on no render path is given to nobody. So is a component node whose rule is bound to a component parameter: the value differs per placement, and the endpoints do not work it out. A page is rendered inside the site-wide layouts, at their outlet, so its elements are also under whatever rule sits above the outlet there (`layoutRulesAbove`). That only closes the direct fetch: a limited element that holds the outlet is itself fetched as a fragment, and a fragment is rendered from the layout alone, without the page, so the content comes out empty for everyone. The same holds for an entry template's outlet. The "Show to" control is therefore disabled on an element that holds the outlet, with a note pointing to page access, which is the way to limit content.

**Show-if conditions.** Beside "Show to", the Visibility view has "Show if": render the element only when a query parameter of the address (`?commerce=plan_changed`) or a field of the loop item or entry (`currentEntry.<name>`) is, is not, has a value, or is empty. It is a separate prop, `showIf` (`ShowIfSchema`, `readShowIf`, `showIfAllows` in `@core/templates`); an element renders only when both its show-when rule and its show-if condition pass, and an unreadable condition (an empty name, say) hides it. The test runs in `renderNode` against the render context. A query condition makes the node request-dependent (detection rule 2c in [publisher](publisher.md)), so it becomes a hole cached per query string, never per visitor; a field condition is known when the page is baked and runs once per loop iteration. A show-if condition is not about the visitor and protects nothing (anyone can add a query string), so `showWhenPathsTo` and the fragment and list endpoints do not consider it beyond the node they render. The list endpoint renders later pages of an infinite list with the route frame of `pagePath` (the loop runtime sends the page's path and query), so query conditions and `{route.query.*}` tokens there read the same query as the first page. Names allow letters, digits, `.`, `-` and `_` (no brackets, so `filter[status]` cannot be tested); values are matched against own properties only. A query condition on an element that holds the page or entry outlet makes that element a hole rendered from the composed page, so the page content inside it loads after the page; the control's hint says so. The name and value fields save on blur or Enter, and a pending edit is saved to its own element when another one is selected. The editor canvas shows the element regardless, as it does for show-when rules.

**Access controls.** Page settings has an Access group (`AccessRuleEditor`), and a protected page carries a lock in the Site explorer. Changing a page's rule needs `site.structure.edit` (`pageDiff.ts`). A page is also a row, so the generic row paths (Data and Content workspaces, version restore, plugin content calls, AI content tools) put the stored rule back through `keepPageStructuralCells` (`server/writePolicy/pageStructuralCells.ts`): leaving `access` out of a row save does not open the page. The same guard keeps the page's `seo` head settings unless the caller holds `site.structure.edit`. Duplicating a page copies its rule. A table's rule is edited in the Data workspace (Access section of a post type's settings) through `GET` / `PUT /admin/api/cms/data/tables/:id/access`: main branch only, `canManageTable`, step-up, audited as `data.table.access`.

### How member-dependent content is rendered

A node that uses a member binding or a show-when rule is different for every visitor, so it never reaches the static slot or the shared cache:

- On a **public page** it becomes a hole (detection Rule 5 in [publisher](publisher.md)). `/_instatic/hole/<id>` sees that the fragment depends on the member (`subtreeDependsOnMember`), resolves the visitor, renders with the member in the context and answers `private, no-store`. The loop endpoint does the same for a list whose items show member data.
- On a **protected page**, which is rendered per request anyway, the member is put in the render context (`TemplateRenderDataContext.member`) and these nodes render in place, with no fragment round trip.

`member` in the context has three states: a frame (signed in), `null` (signed out) and absent (a render for nobody in particular: a baked page, a shared-cache render, a branch preview). Absent behaves as signed out.

## Managing members in the admin

**Users → Site members** (`src/admin/pages/users/tabs/MembersTab.tsx`) sits beside Admin users, Roles and Audit. A user with `members.read` or `members.manage` can open the Users page for this tab alone (`canAccessUsersWorkspace`).

Admin users and Site members share the searchable `AccountDirectory` in `src/admin/pages/users/components/`. Selecting a row opens its inspector beside the list, or in a drawer on narrow screens. The row stays highlighted while its inspector is open. Member access tags and account facts appear first. Expand sessions, connected apps or activity for details. Account actions appear directly in the inspector. Deleting a user or member asks for confirmation.

The API is `server/handlers/cms/members.ts` under `/admin/api/cms/members`. It decides who may call and audits the call; every query on the member tables stays in `server/members/admin.ts` (the split is gated by `members-admin-split.test.ts`).

| Method | Path | What it does | Needs |
|---|---|---|---|
| GET | `/members?q=&status=&tag=&offset=` | One page of 50, plus counts by status and the tags in use | read or manage |
| GET | `/members/:id` | Profile, tag grants, sessions, connected apps, newest 50 events | read or manage |
| POST | `/members/invite` | Create an invited member and email a link | manage |
| POST | `/members/:id/suspend`, `/unsuspend` | Block or restore sign-in | manage |
| POST | `/members/:id/sign-out` | End every session | manage |
| GET | `/members/:id/export` | Everything held about the member, plugins' sections included, as a download | manage |
| DELETE | `/members/:id/apps/:grantId` | Sign the member out of one app | manage |
| POST / DELETE | `/members/:id/tags` | Grant a tag (source `admin`, optional end) / withdraw one source's grant | manage |
| DELETE | `/members/:id` | Anonymise, as the member's own delete does | manage + step-up |
| GET / PUT | `/members/settings` | Sign-up mode, profile fields, link pages | read / manage + step-up |

- **Status** for the admin is `active`, `pending` or `suspended`. `pending` is an account that is not usable yet (no password and an unconfirmed address): someone invited who has not accepted, someone who signed up and has not opened the confirmation link, or someone a plugin gave an account (`api.cms.members.ensure`, event `created_by_plugin`). A sign-in link or a password reset works for a pending member and confirms the address. A deleted member is not listed.
- **Invitations** are a single-use link, delivered one of two ways (`delivery` in the request). `email` (the default) mails it and needs outgoing email (`memberMailAvailable`). `link` mails nothing and returns the link in the response for the admin to pass on by hand; it needs only a known public address (`linkAvailable` in the settings response). So a site with no connector can still invite: the dialog's button becomes "Create invitation link" and the link is shown once in `InvitationLinkDialog`, never stored and sent `no-store`. With email set up, "Create a link instead" is offered beside "Send invitation". Only a site that does not know its public address has the button disabled, with the reason. A link handed over this way proves nothing about who owns the address: whoever opens it sets the password, and the account then counts as confirmed on the admin's word. That is why asking for the link needs step-up, the dialog says to send it only to that person, and the audit entry records `delivery`. Inviting an address with a pending invitation makes a fresh link; an address that already has an account is refused. The link opens the owner's `invite` page and lasts 7 days; with no such page set, invitations are off (see "No built-in member pages").
- **Suspension** takes effect on the next request (`findMemberSession` requires an active member). Sessions and unused tokens are also ended for good, so restoring a member does not bring an old session back.
- **Search** matches the address and the profile text. `%` and `_` are plain characters.
- **Settings** are validated beyond the schema: field ids must be unique and must not be a name the member forms use (`email`, `password`, `token`, `request`, `decision`, `connection`, `currentPassword`, `newPassword`). A link page must be a site path.
- **Audit:** `member.invite`, `member.create` (a plugin gave an address an account; no actor, `pluginId` in the metadata), `member.suspend`, `member.unsuspend`, `member.signout`, `member.export`, `member.app.disconnect`, `member.delete`, `member.tag.grant`, `member.tag.revoke`, `member.settings.update`, each with the member's address in the metadata, since the audit trail cannot look a member up by id.

The binding picker lists one `member.profile.<id>` entry per profile field (`loadMemberProfileFields`); an editor who may not read member settings gets the built-in list.

## Plugins

A plugin reaches members through `api.cms.members`, member routes and member events, each behind its own permission (`members.read`, `members.write`, `members.tags`). The plugin-facing contract is in [plugin-system](plugin-system.md) → "Site members". What matters on this side:

- **Who the member is, is resolved by the host** on the public plugin mount (`server/plugins/publicRoutes.ts`) and handed to the plugin as a plain record. A plugin never holds a session cookie, and the admin mount never identifies a member.
- **A plugin can create a member without email** (`ensure`): pending, no password, nothing sent, one member per address however many calls overlap. Core keeps no record of deleted members (the row is anonymised), so a deleted person's address gets a fresh account; a plugin that must prevent that keeps its own record and listens for `member.deleted`.
- **Tags a plugin grants carry its id as the source**, and it can withdraw only those. This is how a shop grants paid access without being able to remove what an administrator gave.
- **A member's page reaches only plugins that may read members.** The `publish.html` filter runs on public pages as before. A page rendered for one member on a protected route can hold that member's data, so `applyPublishedHtmlPipeline` passes it (`forMember`) only to filters of plugins granted `members.read`; a plugin holding `cms.hooks` alone is passed over for that render. Declared frontend assets are still added to every page.
- **Events** are emitted from the functions every path goes through (`createMember`, `markMemberVerified`, `startSession`, `grantMemberTag`, `anonymizeMember`) by `emitMemberHook` in `server/members/hooks.ts`, without waiting for listeners.

## Sign-in for apps

An app (Instatic Desktop, later a premium plugin) signs a member in with OAuth 2.1 authorization code + PKCE and learns who they are and which tags they hold. It is a second realm on the shared OAuth engine (`server/oauth/`, see [`mcp-connectors.md`](mcp-connectors.md)), with its own tables and token prefix (`imem_`), so a member token and an admin MCP token can never stand in for each other.

**Apps are registered by the owner** (Users → Site members → Apps: name, redirect addresses, scopes). The dialog (`MemberAppsDialog.tsx`) lists them with their client id and warns while no published "Approve an app" page is chosen. The API is `GET /admin/api/cms/members/apps` (`members.read`), `POST` and `DELETE …/apps/:id` (`members.manage` plus step-up, audited as `member.app.create` and `member.app.delete`); removing an app signs everyone out of it. There is no self-registration: anyone could otherwise register a look-alike and ask members to approve it. Clients are public (no secret). The client id is not a secret.

**Issuer** is `<public origin>/_instatic/members`; it is also the `resource` every token is bound to. Its discovery document is at `/.well-known/oauth-authorization-server/_instatic/members`.

| Endpoint | What it does |
|---|---|
| `GET /_instatic/members/oauth/authorize` | Checks the app, its redirect address, PKCE (S256 only) and scopes, stores the request, and sends the browser to the owner's approval page with `?request=<id>`; a signed-out visitor goes through the sign-in page first (`?next=`). An unregistered app or address gets a plain 400 in the browser, never a redirect. |
| `POST /_instatic/members/apps/approve` | The member's answer: an ordinary member form action (cookie, same-origin) with `request` and `decision` (`allow` or `deny`). The answer goes back to the app's address with a one-time `code` or `error=access_denied`, plus `state` and `iss`. A post without a decision is refused with `invalid_input`, never taken as an approval. |
| `POST /_instatic/members/oauth/token` | Code exchange and refresh. Form-encoded, needs `client_id` and `resource`. A sign-in bound to a device also needs a `DPoP` proof from that device's key; a proof on the code exchange binds a sign-in that is not bound yet. |
| `POST /_instatic/members/oauth/revoke` | The app signs out: revokes the grant behind an access or refresh token of that app. A sign-in bound to a device also needs a `DPoP` proof from that device's key. |
| `GET /_instatic/members/oauth/userinfo` | By access token: `{ id, serverTime }`, with `email`, `emailVerified`, `name` under the `profile` scope and `tags: [{ tag, expiresAt }]` under `access`. A tag held from several sources lasts as long as its longest grant. |

**The approval screen is the owner's page.** Member settings has a slot "Approve an app" (`appSignIn`); without a published page there, `authorize` answers `temporarily_unavailable`. The page uses the form action "Approve an app" and the bindings `{member.appRequest.name}`, `{member.appRequest.access}`, `{member.appRequest.returnsTo}` and `{member.appRequest.device}` (the device name the app gave; the app's own word, so word the page accordingly). Those values are read from the stored request named in the page address (`memberAppRequestFrame`), never from the address itself.

The form posts the request id back in a hidden `request` input. On a page that is rendered for the member (a members-only page, which the approval page should be), the server writes the id of the waiting request into that input after the render (`stampAppRequestId` in `server/members/apps/approval.ts`, called from `publicRenderer.ts`), so the form works with scripts off. Only an id that matched a stored, unanswered request is written. On a page open to everyone the HTML is shared, so the input is empty there and the runtime fills it from the address, as it does for an emailed link's token.

The form asks a yes-or-no question, so it has two buttons, Allow and Cancel, and each carries its answer as the button's own `name` and `value` (`decision=allow`, `decision=deny`; `choice` in `MEMBER_FORM_ACTIONS`). A browser sends a button's value only when that button is pressed, with or without scripts, and the form runtime adds the pressed button the same way. The setup panel's Add button inserts both, and counts a button without the answer as missing. `base.submit` has `name` and `value` props for this.

Two show-when rules exist for this page: "Members an app is asking to sign in" (`appAsking`) and "Members no app is asking for" (`noAppAsking`), so the form can be hidden and an explanation shown when the page is opened without a request. Later pages of a list read the same sign-in request from the page address carried in `pagePath`.

Member settings warns when the chosen page is open to everyone (`membersOnly` on the page option): on a members page a signed-out visitor is sent to sign in and comes back; on an open page they can do nothing.

**Device keys.** A native app cannot keep a client secret, so a refresh token is only as safe as the file it sits in. An app can therefore bind its sign-in to a key pair it keeps in the OS keychain (DPoP, RFC 9449; `server/oauth/dpop.ts`). What the binding covers is the sign-in itself: the code, the refresh token and signing out. Access tokens are not bound (see below).

- The app sends the key's thumbprint as `dpop_jkt` on `authorize` (RFC 7638, base64url SHA-256), and may send `device_name` (`cleanDeviceName`: one line, control and invisible formatting characters removed, at most 60 characters). Both are stored with the request and copied to the grant on approval.
- When a sign-in is bound. Either at approval, from `dpop_jkt`, in which case the code is given only to that key; or at the code exchange: a grant approved without `dpop_jkt` whose code is exchanged with a valid `DPoP` proof is bound to that proof's key in the same transaction (`keyShownAtExchange`). So an app that sends proofs is bound whether or not `dpop_jkt` reached the server. An exchange without a proof leaves the grant unbound for good: a proof on a later refresh does not bind it. `dpop_jkt` is still worth sending, because it is what stops a stolen code from being exchanged by another key.
- A bound grant answers only its key. The code exchange and every refresh must carry a `DPoP` header: a JWT with header `{ typ: "dpop+jwt", alg, jwk }` and claims `{ jti, htm, htu, iat }`, signed with the device key. `alg` is `EdDSA` (Ed25519) or `ES256` (P-256, what hardware keystores offer); key coordinates must be canonical base64url, so one key has one thumbprint, and an Ed25519 key at one of the small-order points is refused (it has no private half, yet a fixed signature verifies under it). The proof must name this request's method and address, be within 5 minutes of the server clock, and not have been seen before (an in-memory replay cache). A bad proof answers `invalid_dpop_proof`.
- Nothing ends a bound sign-in without its key. A refresh token shown without the key is refused and the grant is left alone (the check comes before reuse detection); a spent code replayed without the key revokes nothing; and `revoke` acts on a bound grant only with a proof from its key, while answering 200 either way. So a copied refresh token or code neither works nor signs the real device out.
- A refresh whose answer was lost can be retried. If the app sends a refresh, the server rotates, and the answer never arrives (a timeout, the laptop going to sleep), the app still holds a refresh token the server has spent. For a bound grant, a spent refresh token presented again with a proof from the grant's key, no more than 60 seconds after it was spent (`REFRESH_RETRY_GRACE_MS` in `server/oauth/grants.ts`, counted from the rotation that spent it), is answered with a new pair. Every other live token of the grant is revoked first, so whatever the lost answer carried stops working, and the grant itself stays. All the ordinary checks still apply (`client_id`, `resource`, scope, expiry), and the grant must be live: a sign-in ended by sign-out, disconnect, suspension or anything else is not brought back. After 60 seconds the same request is reuse and revokes the grant. Without the key nothing changes: the token is refused and nothing is revoked. A grant with no key has no retry; reuse revokes it at once.
- One sign-in per device: when a code is exchanged, the member's earlier grants of the same app for the same key are revoked. It happens at the exchange, not at the approval, because only the exchange has seen a proof from the key; a sign-in address that merely names someone's key ends nothing. Different devices are separate grants, each listed with its name.
- Access tokens stay bearer tokens: `userinfo` asks for no proof, so a copied access token works for whoever holds it until it expires (at most 1 hour) or the grant ends. It only reads. What a copy cannot do is last: staying signed in needs the refresh token and the key. An app without a device key works as before.
- There is no offline mode: an app learns what a member holds by asking `userinfo`, and decides for itself how long to trust the last answer.

**Scopes.** The built-in ones are `profile` and `access`. A plugin adds its own by declaring `appScopes` in its manifest; each becomes `plugin:<pluginId>:<name>` and lets an app call that plugin's member routes that name it (see [plugin system](plugin-system.md) → "Apps"). `listAvailableMemberAppScopes()` (`server/members/apps/scopes.ts`) is the one list: the built-in scopes plus those of active plugins granted `members.read`. It feeds the Apps dialog's picker (`availableScopes` in the list response), the check when an app is registered, the check at `authorize` (a scope whose plugin is gone answers `invalid_scope`), and the words on the approval page (`memberAppScopeText`: for a plugin scope, core's fixed words, the plugin's name between quotation marks it cannot contain, then the plugin's description, `Through the plugin “Shop”: See your purchases`, both cleaned by `plainLine`; a name that is blank or repeats a built-in scope's text gives way to the plugin id; a manifest whose description is blank or repeats a built-in scope's text is refused at install). The discovery document lists the built-in scopes only: which plugins a site runs is not public. Removing a plugin revokes the grants that carried its scopes and takes them off the apps, in the transaction that deletes the plugin. Updating one does the same for each scope it removed or reworded (`withdrawnPluginAppScopeNames`), since the member agreed to the old words; scopes that read the same keep their grants. An Allow counts only for what is still on offer when it is pressed: if a scope went away while the member was deciding, the app is sent back `invalid_scope`.

**Connected apps.** A member sees and ends their own app sign-ins on a page the owner builds; there is no built-in screen.

- The loop source `members.apps` (`src/core/loops/sources/memberApps.ts`) lists the signed-in member's live approvals: `name`, `device`, `connectedOn` / `lastUsedOn` (a date, `YYYY-MM-DD`), `connectedAt` / `lastUsedAt` (ISO) and `id`. It is `perVisitor`, so the list is a fragment fetched for the member who is looking and never cached; a signed-out visitor gets no items. The source reads the member from `ctx.request.member`, which `sourceRequestFor` (`server/publish/loopSourceRequest.ts`) gives every `perVisitor` source from the visitor's own session; a plugin's per-visitor source gets it only with `members.read`, as before.
- The form action "Disconnect an app" (`apps/disconnect`) goes inside the list, one form per row. Its hidden field `connection` is filled from the row (`{currentEntry.id}`); the setup panel's Add button inserts it. The approval must belong to the member who posts, so an id from someone else's list does nothing. Set the form to redirect to its own page so the list is fresh afterwards.
- A form shows its messages in the ones inside it and in the ones elsewhere on the page that name its form id. A form repeated in a list shares its id with every row, so when that id occurs more than once on the page a row that holds messages uses only its own (`formMessages` in `formRuntimeJs.ts`).
- In the admin, the member detail panel lists the same approvals with a Disconnect button (`members.manage`, audited as `member.app.disconnect`).
- When a member allows an app, they are emailed the template `member.app_connected` ("App signed in", variable `{app.name}`). Refusing sends nothing.
- Member activity records `app_connected`, `app_disconnected` and `app_disconnected_by_admin`.

**Rules.**
- Redirect addresses match exactly, except that a loopback IP literal matches on any port (a native app listens on whatever port it gets).
- A code lasts 5 minutes and works once. Presenting it a second time while it is still unexpired also revokes the grant it created; for a sign-in bound to a device, only when the replay holds the key. A used code presented after it expired is refused and revokes nothing. An access token lasts 1 hour. An approval lasts 90 days; the refresh token rotates on every use, and presenting a used one revokes the whole grant (for a sign-in bound to a device, see the retry and the key rules under "Device keys").
- Approval is asked on every sign-in. A native app cannot prove which app it is, so a remembered approval could be reused by another program.
- A request is answered once, within 10 minutes, and only from the browser the app opened (a marker cookie set by `authorize`, stored hashed with the request). An approval address passed to someone else does nothing in their browser. A marker is 32 hex characters and nothing else is read as one. `authorize` keeps the browser's marker when it presents exactly one well-formed marker, so a request waiting in another tab still works; otherwise it sets a new one and never sends the presented value back.
- A request that carries the marker cookie more than once is refused, even when one of the values matches. The site always sets the cookie with the same name, path and attributes, so a browser never holds two of its own: a second one was planted (from a sibling subdomain, or over plain http where the name has no `__Host-` prefix). Accepting whichever value matches would let someone add their own marker beside the member's and have the member approve a request that person opened.
- Tokens stop working on the next request once the member is suspended or deleted. A password reset or change, an email change, a suspension, "sign out everywhere" and removing the app all revoke the grants. Deleting the account deletes its grants, codes and tokens.
- Core gives an app token nothing but reads: no member action (profile, password, email, delete) accepts one. A plugin route answers one only when the plugin opened that route to apps.
- Rate limits are per IP (`memberAppLimits`).
- The approval page (any page opened with `?request=`) is sent `X-Frame-Options: DENY`, and it and the sign-in hop before it get the token-page referrer policy.
- Rows that can never be used again are deleted when a sign-in starts (`sweepExpiredMemberAppRows`): expired requests, codes, tokens and grants. A revoked refresh token stays until it would have expired, since seeing it again is how reuse is detected.

Try it: `bun run demo:members` registers a demo app and prints the command for `scripts/member-app-demo.ts`, a terminal client that signs in with a device key, reads the member, refreshes and signs out. Read it as the reference for writing an app.

## Deleting and exporting

`delete` anonymises: the row stays with a placeholder address and `status = 'deleted'`, and sessions, tokens, tags, profile and event IP/user-agent are removed, along with the member's app sign-ins (grants, codes and tokens, and so the device names apps gave). The address is free to register again. `GET export` returns the account, profile, tags, live sessions, connected apps (`connectedApps`: app name, device, connected at, last used at), activity, and `plugins`: one entry per installed plugin that declares `memberDataExport`, with its section or the reason it could not be included (not running, failed, late). An administrator with `members.manage` downloads the same export from the member's detail panel ("Download data", `GET /admin/api/cms/members/:id/export`, saved as `member-<id>-data.json`, audited as `member.export`). Both go through `exportMemberDataWithPlugins` (`server/plugins/host/memberExport.ts`): plugins are asked together under one 20-second deadline, one export per member runs at a time, the member's own download is limited to 3 an hour and an administrator's to 30, and a request the browser marks as cross-site is refused.

Deleting a member emits `member.deleted` to the plugins listening at that moment. A plugin erases or anonymises its data about the member then, keeping only what it must by law. A plugin that was not running catches up with `api.cms.members.deletedSince(cursor)`, which pages through `members.deleted_at` (see [plugin-system](plugin-system.md) → "Site members").

## Try it: the demo site

```sh
bun run demo:members        # add `-- --skip-build` to reuse the last admin build
```

`scripts/members-demo.ts` builds the admin, creates a fresh SQLite database under `.tmp/`, seeds and publishes a small site, and serves it on `http://127.0.0.1:3040` (`DEMO_PORT` changes the port). It prints the owner and member accounts it created. Emails are captured: read them under Email → Activity.

The site (`scripts/lib/membersDemoSite.ts`) is thirteen ordinary editor pages: home, join, sign in, forgot password, the pages the emailed links open (confirm, new password, sign-in link, new address, invitation), an account page, a members area, a pro lounge and the page for approving an app. `membersDemoSettings()` names each of them, by page id, in the member settings, which is what switches the features on. Every form is a `base.form` in Members mode completed by `memberFormFragment`, the function behind the editor's "Add …" button; the header's links use show-when rules, and its sign-out is a member form with the Sign out action, an error message and a button styled as a link; the account page prefills from member bindings and lists the member's connected apps, each with a Disconnect form. Open any page in the editor to see how it is put together.

It is a development tool: fixed passwords, loopback only, and a database that is wiped on every start. `membersDemoSite.test.ts` keeps the pages publishable and correctly gated. The sign-in page also carries the "Email me a link" form. The E2E suite seeds the same pages under an address prefix of its own (`buildMembersDemoPages(prefix)`, printed by `scripts/e2e-members-seed.ts`).

## Tests

- `src/__tests__/server/memberApps.test.ts` — sign-in for apps end to end: the authorize checks, the member's answer and its browser binding, code exchange, refresh rotation and reuse, `userinfo`, device-bound sign-ins (binding at approval and at the exchange, the retry of a lost refresh), every way access ends, export and account deletion, the connected-apps list, disconnecting, and the new-app email. Runs on SQLite and Postgres.
- `src/__tests__/server/members.test.ts` — every flow, on SQLite and (with `DB=postgres`) Postgres.
- `src/__tests__/server/membersAdmin.test.ts` — the admin API: capability and step-up gates and every route (SQLite). The queries behind it run on Postgres too through the `admin queries` cases in `members.test.ts`.
- `src/__tests__/server/pluginAppRoutes.test.ts` — apps on plugin member routes: manifest `appScopes`, a route opening itself to apps, what a token reaches and what the handler is told, the scopes the owner can give and the words the member reads, what an update or a removal withdraws, and that no `Authorization` scheme hands a handler an app's token.
- `src/__tests__/server/pluginMembers.test.ts` — plugins: the public mount, member routes, `cms.members`, member events, and the permission each needs.
- `src/__tests__/server/loopSourceMember.test.ts` — the member a per-visitor loop source is given on first and later pages, inside components and nested lists, through a real plugin; and that a shared source, a shared fragment and the static slot never carry a member.
- `src/__tests__/server/membersDemoSite.test.ts` — the demo site: its pages parse, publish, and are open or closed to the right visitors.
- `src/__tests__/architecture/members-admin-split.test.ts` — the split.
- `src/__tests__/server/pluginRouteCookies.test.ts` — cookie stripping.
- `tests/e2e/members-editor.e2e.ts` (MEMBER-001), `members-admin.e2e.ts` (MEMBER-002), `members-account.e2e.ts` (MEMBER-003: sign-up, profile, tag page, export, password change, emailed sign-in link, reset, email change, deletion) and `members-plugin.e2e.ts` (MEMBER-004: a plugin's member routes) — the same flows in a browser, against published pages.
- `tests/e2e/members-apps.e2e.ts` (MEMBER-005) — an app signs a member in: the owner registers it, the member approves on the owner's page, the app exchanges the code, reads the member and signs out.
- `src/__tests__/server/membersAccessGate.test.ts` — the gate: static slot, render cache, path spellings, the uploads route, fragments, table rules.
