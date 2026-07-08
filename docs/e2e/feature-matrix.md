# User E2E Feature Matrix

Use this matrix to choose agent-browser audit scope. Rows are user goals. Keep steps concrete enough to run, but avoid implementation details.

## Priority Key

| Priority | Meaning |
|---|---|
| P0 | Must work before any usable release. |
| P1 | Core CMS/editor workflow. |
| P2 | Important product workflow. |
| P3 | Polish, edge case, or later hardening. |

## Automation Key

| Auto | Meaning |
|---|---|
| ✅ | Full Playwright regression coverage in `tests/e2e/`. |
| partial | Playwright covers part of the row; agent-run handles the rest. |
| — | Agent-run only. |

## Core Owner Lifecycle

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| SETUP-001 | P0 | ✅ | Setup | Create the first site and owner account | Clean DB | Open `/admin`, complete setup | User lands in admin/editor with clear success path | confusing labels, weak validation, redirect loops |
| AUTH-001 | P0 | ✅ | Auth | Log out and log back in | Setup complete | Account menu, logout, login | Session ends, login restores access | unclear session state, cookie issues |
| AUTH-003 | P0 | ✅ | Auth | Sign out and invalidate stale tabs | Logged in with another tab sharing the same session | Account menu sign out, then stale tab opens an admin route | Current tab returns to login; stale tab cannot keep browsing authenticated admin routes | route flashes, stale session state, cookie/session mismatch |
| EDIT-001 | P0 | ✅ | Editor | Add visible text to the homepage | Logged in | Open editor, use visible controls | Text appears on canvas and survives reload | hidden controls, no save feedback, data loss |
| EDIT-002 | P1 | ✅ | Editor | Add a button and change its label/link | Logged in | Insert button, edit properties | Button renders with intended label and link | wrong panel labels, focus loss, invalid link handling |
| SAVE-001 | P0 | ✅ | Persistence | Reload after edits | Edited draft | Browser reload | Draft content remains editable | autosave uncertainty, stale state |
| PUB-001 | P0 | ✅ | Publish | Publish homepage | Edited draft | Publish flow | Success feedback appears | no progress state, unclear success/failure |
| PUB-002 | P0 | ✅ | Public Site | Visit published homepage as a visitor | Published site | Open public route | Public page shows published content without admin chrome | draft leakage, missing CSS, broken assets |
| PUB-003 | P1 | ✅ | Draft Safety | Make an unpublished draft change | Published page exists | Edit draft, do not publish, open public route | Public page still shows last published version | draft/public mismatch |
| PUBLISH-002 | P1 | ✅ | Scheduled Publish | Schedule an active page for future publication | Draft page exists | Site toolbar publish menu, Schedule, dashboard | Dashboard shows the scheduled page count and Publish lineup route; scheduler publishes due scheduled rows | wrong active row, timezone conversion, stale dashboard state |

Core owner lifecycle note: `core-owner-lifecycle.e2e.ts` logs in from a clean context, signs out and back in, inserts homepage text, saves and reloads the draft, publishes with step-up, verifies the anonymous public page, then saves a later unpublished draft and verifies the public route still shows the last published text. SAVE-001 mobile coverage in `page-management.e2e.ts` saves an isolated page, switches to 390x844, reloads, reopens the saved page, verifies the saved text, and verifies the narrow toolbar keeps publish actions reachable without document-level horizontal overflow.

PUBLISH-002 note: `page-management.e2e.ts` schedules a newly-created active page from the Site toolbar, then verifies the dashboard Pages widget reports a scheduled page and the Publish lineup lists the scheduled route. `src/__tests__/server/publishScheduler.test.ts` covers the due-row scheduler tick that promotes a scheduled page row to published as the system actor.

## Admin Shell And Account

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| ADMIN-001 | P1 | ✅ | Navigation | Move between Site, Content, Plugins, Users, Account | Logged in | Admin navigation | Active page and breadcrumbs are clear | dead links, unclear active state |
| ADMIN-002 | P2 | partial | Account | Change account profile basics | Logged in | Account page | Step-up prompt appears; changes save and persist | missing feedback, validation copy |
| ADMIN-003 | P2 | ✅ | Admin shell | Use global toolbar actions and account menu | Logged in | Top toolbar from each workspace | Workspace links, Settings, account menu, and publish/open-live actions appear when allowed | stale active route, clipped toolbar, unavailable settings/account actions |
| ADMIN-004 | P2 | ✅ | Settings | Manage global settings and local editor preferences | Logged in | Toolbar Settings from Dashboard and narrow viewport | General, Shortcuts, Publishing, and Preferences render; preference changes persist locally; corrupt storage falls back; mobile layout stays contained | site-settings load errors, corrupt localStorage, clipped controls |
| ADMIN-005 | P2 | partial | Admin shell | Recover from workspace layout, notification, dialog, and boundary edge cases | Logged in | Shared workspace shell and UI primitives | Layout storage falls back safely, notifications announce and dismiss correctly, destructive actions use app dialogs, and error boundaries isolate failures | corrupt localStorage, stale toasts, native dialogs, boundary drift, mobile panel overlap |
| ACCOUNT-003 | P2 | partial | Security | Change account password and verify old credentials stop working | Logged in | Account security plus login | Form validation is specific; password change requires step-up; old password is rejected and new password works | shared credential restoration, other-session revocation, autocomplete |
| AUTH-002 | P1 | partial | Auth | Complete MFA challenge after password login | MFA enabled owner | Login, enter authenticator or recovery code | Session reaches admin; recovery-code login consumes one code | pending-session escalation |
| AUTH-004 | P2 | partial | Auth | Review active devices and sign out other sessions | Two owner browser sessions | Account Active devices | Current session remains active; other sessions are revoked and redirected to login on next request | stale devices, step-up copy, individual revoke errors |
| ACCOUNT-004 | P2 | partial | Security | Enable MFA, sign in with TOTP, regenerate recovery codes, and disable MFA | Logged in | Account security plus login | MFA gates login and recovery-code controls work without leaving account locked down | clock skew, invalid-code copy, recovery-code burn/reuse |
| ACCOUNT-005 | P2 | partial | Security | Configure step-up prompt window | Logged in | Account security | Step-up window change requires confirmation, persists after reload, and can be restored | disabled-mode side effects, stale window status, mobile controls |
| AUTH-006 | P2 | partial | Auth | Review recent failed, locked, rate-limited, and successful sign-in activity | Failed, locked, rate-limited, and successful account attempts | Account sign-in history | Activity table shows the attempts, a recent failed-count badge, and suspicious activity banner | stale audit rows, proxy/IP variance, table overflow |
| USERS-001 | P2 | ✅ | Users | Manage a non-owner user lifecycle | Owner logged in | Users page | User can be created, edited, suspended, reactivated/reset, deleted, and login access follows status/deletion | role confusion, unsafe defaults, stale sessions |
| USERS-002 | P2 | partial | Users | Create, edit, and delete a custom role | Owner logged in | Users Roles tab | Custom role appears with selected capabilities, updates after edit, and is removed after delete | built-in role protection, duplicate/zero-cap roles, role-in-use semantics |
| USERS-003 | P2 | partial | Users | Review the admin audit log | User-management event exists | Users Audit tab | Audit feed renders readable event titles, actor attribution, details, and timestamps | stale labels, hidden audit data, table overflow |

ADMIN-002 note: display-name editing and mobile step-up cancel/no-op are automated with the step-up prompt (canonical spreadsheet row ACCOUNT-001), and `/me` profile API edges cover step-up denial, trimmed email save, the 160-character display-name boundary, invalid payloads, and duplicate normalized email rejection in `src/__tests__/server/accountSecurity.test.ts`. Avatar upload/removal plus unsupported, oversized, and mobile layout avatar feedback are automated (canonical spreadsheet row ACCOUNT-002) in `account.e2e.ts`; empty multipart upload, idempotent missing-avatar removal, and elected storage-adapter failure are covered in `src/__tests__/server/accountSecurity.test.ts`. Browser email editing uses the same step-up-gated Profile form but stays lower-level/API-covered so the shared owner login email remains stable during the E2E suite.

ADMIN-003 note: `admin-navigation.e2e.ts` now verifies the global toolbar trailer on Dashboard, account menu actions, Open Live root fallback, Content selected-entry deep-linking to `/posts/<slug>`, clearing the entry target after leaving Content, and 390px toolbar-trailer containment. Workspace navigation is covered in the same file, account-menu logout/session invalidation is covered by the core owner lifecycle and `auth.e2e.ts`, Settings behavior is covered under ADMIN-004, and publish affordances are exercised by publish/content specs.

ADMIN-004 note: `admin-navigation.e2e.ts` opens Settings from the Dashboard non-editor route, verifies General, Shortcuts, Publishing, and Preferences sections, writes Auto-save, Auto-save delay, Theme, UI density, and UI text size through real controls, verifies reload persistence, verifies corrupt localStorage fallback, and checks 390px containment. DEF-20260623-ADMIN004-01 fixed a phone-width overflow where Preferences controls extended beyond the viewport; `SettingsModal.module.css` now switches to a single-column mobile shell with stacked preference rows.

ADMIN-005 note: focused Bun coverage spans workspace layout storage fallback/merge behavior, ToastProvider alert/status/dismiss behavior, ConfirmDeleteProvider alertdialog commit gating, no-native-dialog architecture enforcement, and error-boundary placement/root-callback gates. DEF-20260623-ADMIN005-01 fixed the Toast barrel so bus consumers can import `dismissToast` through the canonical `@ui/components/Toast` entrypoint. DEF-20260623-ADMIN005-02 fixed content left-panel mobile overflow after persisted desktop resizing. DEF-20260623-ADMIN005-03 fixed content right-settings mobile overflow when both sidebars are open after persisted desktop resizing. Dashboard, media, plugin, and admin-navigation E2E specs exercise route-level layout and toast surfaces; injected route-failure exploratory review remains future coverage.

USERS-001 note: non-owner user creation, step-up protection, edit, suspend, activate, password reset, delete, suspended-login denial, post-delete session invalidation, and deleted-login denial are automated in `users.e2e.ts`.

AUTH-003 note: account-menu logout/login is covered in the core owner lifecycle, and `auth.e2e.ts` automates stale-tab session invalidation by cloning a live session into a second browser context, signing out in the first, then verifying the stale context is forced back to Admin Login on the next authenticated admin route without the stale Site route logging the module-inserter Unauthorized preference-load error. The same spec covers 390px mobile account-menu containment and sign-out reachability. `authSessionEdgeCases.test.ts` covers a repeated stale `POST /logout` returning `{ ok: true }`, clearing the cookie again, and leaving `/me` unauthorized.

ACCOUNT-003 note: password form validation, exact-minimum local validation, mobile password card/dialog layout, step-up-gated password rotation, old-password rejection, new-password login, and shared owner credential restoration are automated in `account.e2e.ts`; multi-session revocation and autofill variants remain lower-level or future browser coverage.

AUTH-002 note: TOTP MFA login, mobile MFA challenge layout, empty-code required-field validation, wrong-code feedback, recovery-code login burn, and recovery-code reuse rejection are automated in `account.e2e.ts`; pending-cookie API denial, expired pending-session rejection, and unknown pending-cookie rejection are covered in `accountSecurity.test.ts`.

AUTH-004 note: active-device listing, step-up-gated sign-out-everywhere-else, and mobile Active devices table containment are automated in `account.e2e.ts` with a second browser context; individual-device revoke, current-session rejection, cross-user guard, unknown session ids, and only-current `logout-all` are covered by focused Bun tests in `authSessions.test.ts` and `authSessionEdgeCases.test.ts`.

ACCOUNT-004 note: MFA enable, invalid setup-code feedback, empty/wrong MFA login-code feedback, TOTP login, recovery-code login burn/reuse rejection, recovery-code regeneration through MFA step-up, disable, mobile setup-dialog containment, and mobile MFA login-challenge containment are automated in `account.e2e.ts`; QR rendering failure fallback to manual setup is covered in `src/__tests__/admin/accountPage.test.tsx`.

ACCOUNT-005 note: step-up window change, reload persistence, restoration to the default window, and mobile step-up control/dropdown layout are automated in `account.e2e.ts`; disabled-mode bypass behavior, invalid option rejection, and configured step-up expiry timestamps are covered in `src/__tests__/server/accountSecurity.test.ts`; expired-window sensitive-action rejection is covered in `src/__tests__/server/authStepUp.test.ts`; browser API-failure display and stale-window re-prompt timing remain future coverage.

AUTH-006 note: failed-password plus successful-login activity rendering and disposable-account lockout/rate-limit browser flows are automated in `account.e2e.ts`; locked-event and rate-limited suspicious-banner rendering is also covered in `src/__tests__/admin/accountPage.test.tsx`; proxy-attributed IP variants and mobile table-overflow review remain future account-security coverage.

USERS-002 note: custom role create/edit/delete lifecycle and mobile role-management layout are automated in `users.e2e.ts`; duplicate slug create/update, zero-capability roles, unknown-capability normalization, built-in delete protection, and role-in-use delete protection are covered in `src/__tests__/server/roleManagementEdges.test.ts`.

USERS-003 note: user-create audit activity rendering and mobile audit-table containment are automated in `users.e2e.ts`; focused Bun coverage in `src/__tests__/server/auditLogEdges.test.ts` verifies `audit.read` permission enforcement, GET-only handling, ignored query params, newest-100 ordering, malformed metadata fallback, soft-deleted user labels, and deleted-role metadata fallback; `src/__tests__/users/usersAdmin.test.tsx` covers empty feed and API error states; `src/__tests__/users/auditFormat.test.ts` verifies emitted auth/data/plugin/AI action titles and future-action humanization.

## Dashboard

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| DASH-001 | P1 | ✅ | Dashboard | Review site metrics and operational status widgets | Logged in | `/admin/dashboard` | Default first-party widget grid renders, dynamic widgets leave loading state, range/customize controls respond, and mobile layout stays contained | stale skeletons, missing capability-gated widget data, mobile header overflow |
| DASH-002 | P2 | ✅ | Dashboard | Customize the dashboard grid | Logged in | Customize, Add block, drag/resize | Widgets can be added, removed, moved, resized, and persisted per user | overlap, invalid drops, preference corruption, drag friction |
| DASH-003 | P2 | ✅ | Onboarding | Follow onboarding tasks from the dashboard | New/local site | Dashboard onboarding panel | Setup facts drive progress/tasks, dismiss persists, and actions route to workspaces | stale facts, inaccessible target route, mobile task layout |

DASH-001 note: `dashboard.e2e.ts` verifies the default owner dashboard route, Overview controls, Today/7d range tab state, Customize/Add block controls, all nine default first-party widgets, loaded dynamic widget states, SQLite storage labeling, static status/domain rows, and 390px mobile containment. DEF-20260623-DASH001-01 fixed the mobile Overview header overflow by stacking/wrapping the controls below 760px. PUBLISH-002 also verifies dashboard scheduled-page count and Publish lineup behavior after scheduling a page.

DASH-002 note: `dashboard.e2e.ts` verifies customize mode, the Block library, adding the built-in AI usage widget, server-backed `dashboard-layout` preference persistence, reload restoration, grid drag move, right-edge resize, drag-to-library removal, final reload absence, and 390px customize/library containment. DEF-20260623-DASH002-01 fixed invalid nested buttons in Block library live previews by rendering preview widget chrome in edit mode.

DASH-003 note: `dashboard.e2e.ts` verifies onboarding progress from clean E2E state (2/5: identity and first page complete, framework active, plugin/team not started), all five step labels/actions, the Settings modal action, workspace routes for New page/Browse plugins/Add members, 390px mobile containment, and server-backed dismiss persistence through `dashboard-layout`.

## Capabilities And Access Control

Full scenario descriptions and per-persona checks live in `docs/e2e/capabilities.md`.

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| CAP-001 | P0 | ✅ | Workspaces | Verify a limited user only reaches granted workspaces | Custom limited role | Login and direct URLs | Allowed workspaces render; disallowed workspaces do not expose data | route flashes, stale nav, unclear denial |
| CAP-002 | P0 | ✅ | Site Editor | Verify content/style/structure editor personas cannot cross edit modes | Three custom roles | Editor actions and save/reload | Each persona can only complete its edit class | enabled-but-failing controls, accidental structure/style writes |
| CAP-003 | P0 | ✅ | Step-Up | Verify sensitive actions require fresh password entry | Sensitive-action roles | Publish, install, delete, replace import | Cancel/wrong password do not mutate; correct password proceeds | side effects before step-up, generic auth errors |
| CAP-004 | P1 | partial | Data/Media | Verify data and media operation splits | Seeded table and asset | Browse/mutate affordances per persona | Read/write/replace/delete/import/export remain separate | destructive actions exposed too broadly |
| CAP-005 | P1 | ✅ | Plugins/AI | Verify plugin and AI capability splits | Test plugin and AI personas | Plugins page and AI assistant surfaces | Read/config/lifecycle/install/schedule/pack and chat/provider/audit/write-tool exposure stay separate | schedule mutation or pack re-sync leaks, AI write tools for chat-only users |

CAP-001 note: limited workspace isolation is automated in `users.e2e.ts`. The regression creates a custom role with Site and Media access, signs in as that limited user, verifies the toolbar exposes Media while hiding Content and Users, and verifies a direct `/admin/users` navigation redirects away without rendering the Users workspace. The same spec now covers a 390px limited-user toolbar: Site and Media remain reachable, denied Content/Users affordances stay absent, the toolbar has no document-level horizontal overflow, and the Account menu entry remains reachable.

CAP-002 note: site edit-mode capability boundaries are automated in `capabilities.e2e.ts`. The regression creates content-only, style-only, and structure-only site-editor roles, verifies each persona can complete its permitted edit class, and verifies controls outside that edit class stay unavailable instead of failing only after click.

CAP-003 note: publish step-up is exercised in every publishing spec (`core-owner-lifecycle.e2e.ts` and others), user creation cancel/wrong/correct-password step-up, expired-window re-prompt, and 390px mobile dialog containment are automated in `users.e2e.ts`, MFA-enabled user-create step-up is automated in `account.e2e.ts`, plugin JSON-manifest install/uninstall plus destructive CMS-bundle replace import step-up are automated in `capabilities.e2e.ts`, and secondary user-delete, role-delete, step-up-policy, and individual-session revoke gates are covered in `src/__tests__/server/stepUpSecondaryActions.test.ts`.

CAP-004 note: data read/manage/import/export, content row-move gating, permitted content row moves, and media read/write/replace/delete affordance plus happy-path coverage are automated in `capabilities.e2e.ts`.

CAP-005 note: plugin read/install/configure/lifecycle affordance splits, installed-plugin schedule read vs lifecycle controls, pack re-sync install gating, site-editor AI chat rail gating, and AI provider-manager/auditor tab splits are automated in `capabilities.e2e.ts`. AI write-tool filtering is automated in `ai.e2e.ts` with a downgraded `ai.chat` persona whose fake-provider request contains read tools and omits mutating tools.

## Page And Site Management

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| PAGE-001 | P1 | ✅ | Pages | Create a new page | Logged in | Site/page navigation | Page appears with editable title and slug | duplicate slug handling, title focus |
| PAGE-002 | P1 | ✅ | Pages | Rename and open a page | Multiple pages | Page actions | Navigation and public/open actions use the new slug | stale URL, broken context menu |
| PAGE-003 | P2 | ✅ | Pages | Delete a page safely | Multiple pages | Page actions | Clear confirmation or undo path, no broken selection | accidental destructive action |
| PAGE-004 | P2 | ✅ | Pages | Switch between pages after unsaved edits | Multiple pages | Edit then navigate | User understands save state and does not lose work | silent data loss |

Page management note: `page-management.e2e.ts` creates disposable pages from the Site Explorer, verifies new pages appear and open in the canvas, renames a page through the context menu, deletes a page through the confirmation dialog, and switches away from and back to an unsaved edited page before saving/reloading to prove draft state is retained.

## Visual Builder

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| BUILDER-001 | P1 | ✅ | Insert | Add common modules: container, text, image, button | Logged in | Module picker | Modules appear where expected | insertion ambiguity, bad empty states |
| BUILDER-002 | P1 | ✅ | Selection | Select canvas nodes and edit properties | Page with modules | Canvas and properties panel | Selection is obvious and property edits apply | lost selection, wrong node edited |
| BUILDER-003 | P1 | ✅ | DOM Panel | Reorder nodes in the tree | Page with nested modules | DOM panel drag/drop | Canvas order matches tree order | impossible drop targets, bad affordance |
| BUILDER-004 | P1 | partial | Canvas Drag | Reorder nodes directly on canvas | Page with modules | Canvas drag/drop | Drop target and final order are clear | jumpy drag, scroll/zoom conflict |
| BUILDER-005 | P1 | ✅ | Undo/Redo | Undo and redo edits | Edited page | Toolbar/shortcuts | State moves predictably backward/forward | partial undo, UI desync |
| BUILDER-006 | P2 | ✅ | Styling | Apply spacing, color, and typography | Selected node | Properties and class controls | Visual result matches settings | token label confusion, no preview |
| BUILDER-007 | P2 | ✅ | Breakpoints | Edit mobile/tablet/desktop variants | Page with content | Breakpoint selector | Variant changes are scoped and understandable | accidental global change, clipped UI |
| BUILDER-008 | P2 | partial | Formatted content | Render formatted post content | Content entry with rich body | Content outlet or text bindings | Formatting persists and publishes cleanly | binding confusion, sanitization surprises |
| SITE-005 | P1 | ✅ | Module Picker | Search and insert a non-favorite module from the full picker | Fresh page | Add to canvas → Search modules → keyboard insert → Recent | Search filters module items, Enter inserts the selected module, Recent records it, and the list/grid view preference persists | search mismatch, keyboard insertion, stale recents, preference corruption |
| SITE-018 | P1 | ✅ | Templates | Author a post template with data bindings | Posts collection exists | Site panel → New template → binding picker → publish post | Canvas previews currentEntry title/body and the public post route renders the published row through the custom template | seeded-template priority, unresolved tokens, missing outlet, save/publish ordering |
| SITE-019 | P1 | ✅ | Saved Layouts | Save and reuse a styled layout subtree | Page with authored section | Layer context menu → Save as layout → Module inserter → Layouts → manage menu → publish | Layout validation is inline, saved layout insertion preserves content/styles, rename/delete manage the saved item only, and already-inserted content persists and publishes | stale page selection, mobile category labels, context-menu layering, duplicate names |
| SITE-017 | P1 | ✅ | Visual Components | Convert authored content into a reusable component with editable slot fills | Page with editable node | Componentize, add slot outlet, fill slot, save, publish | Public route includes component body and slot fill without editor slot labels | component/page save ordering, slot lock friction, stale refs |

Visual builder note: `visual-builder.e2e.ts` inserts notch and picker modules, searches the full module picker and inserts by keyboard while verifying Recent/list-view persistence, drags a picker module into a canvas Container target, selects layers, edits text/button props, reorders layers from the DOM panel and canvas drag handle, exercises undo/redo buttons and shortcuts with redo-branch clearing and reload reset, validates locked slot-instance structure while allowing slot content insertion, applies spacing/color/typography controls, verifies tablet-width insertion, authors a post template with currentEntry bindings, validates and manages saved layouts, and publishes a freshly componentized page with filled slot content.

SITE-005 note: full module picker coverage is automated in `visual-builder.e2e.ts`. The desktop regression opens Add to canvas, verifies Grid view, searches `button`, inserts Button with Enter, verifies the Button layer, reopens Recent to find the inserted item, switches to List view, closes/reopens, and verifies the persisted view preference. The drag regression filters for Text, drags the picker item into the center of an existing canvas Container, verifies the inside drop preview, edits the inserted Text, and verifies it renders inside the Container. The 390px mobile regression verifies the Add to canvas dialog, Search modules field, Modules/Recent category buttons, and filtered Button item stay viewport-contained without page-level horizontal overflow, then inserts Button with Enter and verifies the Layer row. Lower-level module-inserter suites cover corrupted localStorage fallback, recent dedupe, server-backed favorites, disabled/hidden module availability, and responsive category accessible names.

BUILDER-005 note: undo/redo history is automated in `visual-builder.e2e.ts`. The regression creates and reloads a disposable page to prove clean loaded history state, inserts Text, uses Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z to undo/redo the visible layer, uses the notch Undo button, inserts Container to prove Redo is cleared by a new edit, then saves/reloads and verifies the saved Container persists while transient history controls reset.

BUILDER-007 note: breakpoint-scoped selector styles are automated in `visual-builder.e2e.ts`; the regression verifies desktop/mobile canvas frame separation and published CSS at default and 360px visitor widths.

BUILDER-008 note: rich-body bold/italic persistence and public entry-template rendering are automated in `content.e2e.ts`; custom binding confusion, media/unsafe HTML sanitization, and visual typography review remain agent-run or lower-level.

SITE-017 note: `visual-builder.e2e.ts` componentizes a Text node, adds a Slot Outlet in VC mode, returns to the page, inserts Text into the locked generated slot, saves, publishes, and verifies an anonymous visitor sees both component body and slot fill while editor-only slot labels/component names stay absent. DEF-20260623-SITE017-001 fixed the page/component incremental-save ordering bug by writing component rows before page rows.

SITE-018 note: `visual-builder.e2e.ts` creates a high-priority Posts template from the Site panel, sets Template settings to Post types/Posts, inserts `{currentEntry.title}` through the binding picker, verifies synthetic canvas preview for title/body, saves and publishes the template snapshot, publishes a post, and verifies an anonymous `/posts/<slug>` visitor route renders the custom template with the published row data and no unresolved tokens. `content.e2e.ts` extends the binding coverage by adding a custom Posts field, inserting `{currentEntry.<customField>}` from the binding picker, verifying canvas preview resolution, publishing the template, and verifying the public post route resolves the custom value.

SITE-019 note: `visual-builder.e2e.ts` saves a styled Container subtree as a layout, verifies blank and duplicate-name validation, confirms the Layouts category remains reachable at 390px, inserts the saved layout into another page with its captured class styling, renames and deletes the saved layout from the inserter manage menu, saves/reloads, publishes, and verifies anonymous public output. DEF-20260623-SITE019-001 fixed stale node selection on `addPage`; DEF-20260623-SITE019-002 fixed count-only mobile category buttons; DEF-20260623-SITE019-003 fixed the saved-layout manage menu z-index under the spotlight inserter.

## Site Runtime And Code

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| SITE-014 | P1 | partial | Dependencies | Declare runtime packages for site scripts and plugin modules | Site script or module with package import | Dependencies panel and runtime resolve endpoint | Missing imports are visible, safe dependencies resolve into a lock/importmap, and cached package files serve under `/_instatic/runtime/cache` | unsafe package names, stale lock/importmap, install failures, traversal-shaped cache paths |
| SITE-016 | P1 | ✅ | Preview/Live | Compare the current draft with the live public route | Page has a published version and a later saved draft | Publish actions → Preview page; toolbar → Open live page | Preview iframe shows the current draft while the live route opens the last published output without admin chrome | draft/public leakage, stale live path, popup target, mobile overlay reachability |

SITE-014 note: focused Bun coverage spans the dependency panel, auto-resolve hook, client envelope validation, runtime handler normalization, module dependency/importmap filtering, script import analysis, runtime config, site runtime build, dependency resolver/cache, package importmap/server, and runtime asset publish injection. `tests/e2e/runtime-dependencies.e2e.ts` covers browser authoring of a site script import, Dependencies-panel missing package Add, live `canvas-confetti` registry/cache resolution, save/publish, public importmap emission, browser loading of the emitted `/_instatic/runtime/cache/...` package URL, and a 390px mobile path that authors a missing import, opens Dependencies, verifies no horizontal overflow, and confirms the Add action is reachable. Live registry/install failure UX permutations remain operator-run.

SITE-016 note: `tests/e2e/preview-live.e2e.ts` creates a disposable page, publishes version A, saves draft version B without publishing, verifies the Preview page overlay iframe renders draft B, verifies the toolbar Open live page popup still serves published version A without editor chrome, and repeats preview opening at 390px to confirm the overlay remains reachable without document overflow. Template-target and Content-entry live-path permutations remain lower-level or future browser coverage.

## Public Serving

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| PUBLIC-003 | P1 | partial | Assets | Load published CSS, runtime JS, dependency packages, and media assets | Published site with generated assets | Visitor page plus `/_instatic/*` asset URLs | Content-hashed CSS/runtime assets and package-cache files serve with correct content types, immutable caching where safe, exclusive namespaces, and public media redirect behavior | stale hashes, malformed module/package paths, DB fallback leaks, signed redirect caching, browser/CDN cache behavior |
| PUBLIC-004 | P1 | partial | Dynamic Fragments | Render looped and request-dependent public content without rebuilding whole pages | Published site with loop or dynamic island content | Visitor page plus `/_instatic/hole/*` hydration | Static shells contain hole placeholders/runtime, fragments render against current publish version and originating route query, per-visitor holes bypass cache, and infinite loops register their runtime | stale publish versions, missing node ids, query cache collisions, cookie leakage, IntersectionObserver/lazy-load behavior |

PUBLIC-003 note: focused Bun coverage verifies external CSS link generation and stale/malformed CSS 404s, DB-backed and disk-baked runtime asset serving, module-JS bundle injection and route validation, runtime package importmap/cache/server behavior, full-router ownership of runtime cache package URLs, runtime script injection safety, and signed media redirect architecture. `tests/e2e/forms.e2e.ts` records browser-loaded published asset responses for hashed `/_instatic/css/*.css` and `/_instatic/module-js/base.form.js`, including 200 status and expected content types. `tests/e2e/media.e2e.ts` records browser-loaded `/uploads/` PNG responses from published pages and verifies the image decodes. CDN cache behavior, runtime package browser authoring, real mobile network/device permutations, and live signed-storage adapters remain operator-run.

PUBLIC-004 note: focused Bun coverage verifies dynamic-node detection rules, loop render semantics, loop data prefetch, static-shell baking with hole runtime, hole runtime lazy/eager fetching, hole fragment stale-version/missing-node/cache behavior, per-query and per-visitor dynamic plugin islands, form token stamping in fragments, and full-router ownership of hole runtime/fragment URLs. `tests/e2e/public-dynamic-fragments.e2e.ts` now authors a route-query text hole, publishes it, verifies the baked shell contains `<instatic-hole>` plus the hole runtime, observes browser responses for `/_instatic/hole-runtime.js` and `/_instatic/hole/*`, and confirms desktop and 390px mobile visitors hydrate distinct `route.query` values without admin chrome or horizontal overflow. Placeholder-backed real-browser IntersectionObserver timing and live external loop-source failures remain operator-run.

## Base Modules

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| MODULE-001 | P1 | partial | Layout Modules | Render body, outlet, and container structure cleanly | Page or template tree | Body/container/outlet render paths | Body children publish with no wrapper, container emits safe semantic tags and attrs, and outlet emits a content region around bound HTML | invalid custom tags, void tags, missing outlet body, editor-only wrappers |
| MODULE-002 | P1 | partial | Content And Media Modules | Render common content and media modules cleanly | Page tree with common modules | Text/list/link/button/image/SVG/video render paths | Common modules emit semantic sanitized HTML, safe URLs/media attributes, inline SVG markup, and accessible labels where authored | unsafe URLs, SVG scripts/events, empty media, blank list lines, new-tab rel |
| MODULE-003 | P1 | partial | Loop Module | Render repeated data/page content dynamically | Page tree with `base.loop` and source data | Loop module contract, publisher render interceptor, prefetch, dynamic detection | Loop defaults and source props resolve safely, children repeat per item with currentEntry/parentEntry bindings, empty/missing sources are safe, and infinite mode registers the runtime | missing source, stale data, nested loops, invalid tags, request-dependent sources |
| MODULE-004 | P1 | partial | Form Control Modules | Compose CMS-native and custom forms from real page nodes | Page tree with form/control modules | Form module contracts, snapshots, validation, runtime, public endpoint, canvas suppression, settings panel | Form controls render semantic HTML, escaped attrs/text stay safe, CMS forms emit runtime JS, public submissions validate, and canvas interactions select nodes instead of submitting/editing fields | duplicate fields, unsafe attrs, invalid patterns, public payload abuse, formId mismatch |
| MODULE-005 | P1 | partial | Visual Component And Slot Modules | Reuse component definitions with editable slot fills | Visual Component definition and page ref | Component-ref/slot module contracts, publisher inlining, slot sync, recursion guard, canvas/editor-store flows | Component refs inline definitions with prop overrides and slot content, transparent slot nodes do not leak wrapper markup, slot instances stay locked structurally, and recursive components are blocked | missing components, empty/default slots, nested refs, slot rename/reorder/delete, locked slot edits |

MODULE-001 note: body pass-through render and iframe-body editor identity, container semantic tag/attribute/void-tag behavior, and outlet content-region fallback/bound HTML are covered by focused Bun tests in `src/__tests__/base-modules.test.ts` and `src/modules/base/outlet/__tests__/outlet.render.test.ts`; browser insertion, full template-composition permutations, permission variants, and responsive authored-layout review remain agent-run.

MODULE-002 note: text/list/link/button/image/video render contracts were already covered in `src/__tests__/base-modules.test.ts`; this row now also covers `base.svg` conformance, publisher-boundary SVG sanitization, accessible label escaping, editor-preview sanitization, and HTML-import SVG mapping through focused Bun tests. Browser insertion/edit/publish permutations, permission variants, media-picker SVG/image/video combinations, and responsive authored-layout review remain agent-run.

MODULE-003 note: loop module conformance/defaults/tag fallback are covered in `src/__tests__/base-modules.test.ts`; publisher iteration, currentEntry/parentEntry isolation, empty/missing data, and infinite runtime injection are covered in `src/__tests__/publisher/loopRender.test.ts`; prefetch and request-dependent detection are covered in `src/__tests__/server/loopPrefetch.test.ts` and `src/__tests__/server/dynamicDetection.test.ts`. Browser insertion, dynamic property-panel editing, permission variants, stale-data UX, and responsive repeated-layout review remain agent-run.

MODULE-004 note: all exported form modules are covered by module conformance plus semantic render, publisher-boundary escaping, and formId normalization tests in `src/__tests__/forms/formModules.test.ts`; snapshots, settings analysis, validation, canvas suppression, form preview, runtime emission, public endpoint security, and the form settings panel are covered by focused Bun suites under `src/__tests__/forms/`, `src/__tests__/canvas/`, `src/__tests__/publisher/`, `src/__tests__/server/publicForms.test.ts`, and `src/__tests__/panels/formSettingsPanel.test.tsx`. Browser insertion, full edit/save/publish/public submission, permission variants, and mobile form composition remain agent-run.

MODULE-005 note: component-ref, slot-outlet, and slot-instance module contracts are covered in `src/__tests__/base-modules.test.ts`; publish-behavior dispatch and schema-derived defaults are covered in `src/__tests__/module-engine/moduleConsolidation.test.ts`; publisher inlining, prop overrides, slot content/defaults, missing components, hidden nodes, sanitization, and nested refs are covered in `src/__tests__/publisher/visualComponentRef.test.ts` and `src/__tests__/publisher/publishWithComponents.test.ts`; slot sync, recursion/data-layer gates, editor-store reconciliation, persistence healing, canvas slot reactivity/editing, slot-instance lockdown, and placement architecture are covered by focused Bun suites under `src/__tests__/core/`, `src/__tests__/editor-store/`, `src/__tests__/persistence/`, `src/__tests__/integration/`, `src/__tests__/canvas/`, `src/__tests__/dom-panel/`, and `src/__tests__/architecture/`. Browser conversion, slot fill, save, and publish are covered by SITE-017 in `visual-builder.e2e.ts`; permission variants and mobile component editing remain agent-run.

## Forms

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| FORM-001 | P1 | partial | Authoring | Compose CMS-native forms from visual modules | Page tree with form modules | Form setup panel and canvas | Form/control modules render semantic controls, bind fields to valid tables, and emit CMS runtime JS only when needed | missing target table, duplicate names, canvas native-submit suppression, mobile public layout |
| FORM-002 | P1 | partial | Public Submission | Submit a published CMS-native form securely | Published page with CMS form | Visitor form plus `/_instatic/form/*` endpoints | Runtime obtains a one-time challenge, submits same-origin values, validates fields, creates a data row, and renders success/error feedback | missing Origin, forged page token, reused/expired challenge, fast bot submit, invalid values, rate limits |

FORM-001 note: form module conformance, semantic render contracts, field snapshots, settings analysis, compatible field binding, canvas native-control suppression including submit buttons, form-preview parent lookup, and setup-panel target-table/missing-field/preview behavior are covered by focused Bun tests under `src/__tests__/forms/`, `src/__tests__/canvas/`, and `src/__tests__/panels/formSettingsPanel.test.tsx`; `tests/e2e/forms.e2e.ts` now covers browser creation of a target data table, form authoring, save, publish, public submit, and admin data-row verification. Permission variants and mobile authoring-panel layout remain agent-run.

FORM-002 note: focused Bun coverage verifies full-router ownership of public form URLs, same-origin/page-token challenge issuance, one-time challenge submission, oversized payload handling, rate limits, target-table guards, field validation, form runtime challenge prefetch/submit delegation, and page-token stamping. `tests/e2e/forms.e2e.ts` covers browser success feedback, persisted data-row creation, mobile too-fast error feedback, real-clock min-submit retry, and mobile public-page overflow checks. Honeypot, rate-limit, and invalid-field browser permutations remain lower-level or future coverage.

## Media

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| MEDIA-001 | P1 | ✅ | Uploads | Upload an image and place it on a page | Logged in | Image/media control | Image previews in editor and public page | broken preview, path leakage |
| MEDIA-002 | P2 | ✅ | Uploads | Try unsupported file upload | Logged in | Media control | User gets clear validation feedback | vague errors, security footguns |
| MEDIA-003 | P2 | ✅ | Media Library | Reuse an uploaded asset | Existing upload | Media picker | Asset can be selected without re-upload | missing search, stale thumbnails |
| MEDIA-004 | P2 | partial | Metadata | Edit media metadata | Uploaded asset | Media page viewer | Title, filename, alt text, caption, and tag changes persist after reload | invalid filename, bulk edit, mobile viewer |
| MEDIA-005 | P2 | partial | Lifecycle | Replace, trash, restore, and purge an asset | Uploaded asset | Media page viewer and Trash folder | Replacement updates asset binary/name, trash hides active asset, restore returns it, purge removes it from Trash | unsupported replacement, asset-in-use, confirmation safety, permissions |
| MEDIA-006 | P2 | partial | Storage | Review built-in media storage settings | Clean/local install | Media Storage panel | Local disk backs every role, local sharp delegate is selected, empty adapter/delegate states are clear, no migration/test actions appear without external adapters or backlog | external adapter verify/elect, migration progress, delegate plugins, permissions |
| MEDIA-007 | P2 | partial | Presentation | Serve sanitized SVG media and public image assets | Uploaded SVG asset | Media upload and public `/uploads` URL | Unsafe SVG vectors are stripped before storage/serving while safe geometry remains accessible | raster variant ladder, missing variant fallback, external signed URLs, responsive attrs |

MEDIA-004 note: viewer metadata edits for title, filename, alt text, caption, and tags are automated in `media.e2e.ts`; the same spec now covers 390px mobile viewer containment, metadata control reachability, upload-queue close reachability, and mobile metadata edits. Invalid filename handling, bulk edit, and permission-gate variants remain lower-level or future browser coverage.

MEDIA-005 note: replace, soft-delete, restore, and purge happy path is automated in `media.e2e.ts`; the same spec now covers 390px mobile replace dialog containment, media item context-menu delete reachability, Trash navigation, restore, and the shared ContextMenu portal regression. Unsupported replacement, asset-in-use/public reference behavior, confirmation/safety review, and permission variants remain lower-level or future browser coverage.

MEDIA-006 note: clean-install built-in storage panel coverage is automated in `media.e2e.ts`; the same spec now covers 390px mobile panel containment, built-in role combobox reachability, delegate and empty-adapter scroll reachability, close-control reachability, and no horizontal overflow. External adapter verify/elect flows, migration backlog/progress, delegate plugin election, and storage.migrate permission variants remain lower-level, fixture-backed, or future browser coverage.

MEDIA-007 note: unsafe SVG upload sanitization and public `/uploads` serving are automated in `media.e2e.ts`; raster variant ladder/srcset, missing variant fallback, external signed URL expiry, media batch resolution, and responsive image attrs remain lower-level or future browser coverage.

## Content CMS

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| CONTENT-001 | P1 | ✅ | Workspace | Browse collections and entries | Logged in | Content page | Collections and entry rows load and can be selected | empty collections, stale deep links |
| CONTENT-002 | P1 | ✅ | Entries | Create and edit an entry draft | Logged in | Content page | Entry saves with title/body/status and persists | editor mismatch, missing status feedback |
| CONTENT-003 | P2 | partial | Rich body | Edit rich body content with slash menu, media, and tokens | Existing entry | Body editor | Structured body edits save and render cleanly | lazy editor failure, sanitization surprises |
| CONTENT-004 | P1 | ✅ | Publishing | Publish or expose post content where supported | Existing post | Content toolbar/status controls | Content appears only where intended | draft leakage, unclear publish model |
| CONTENT-005 | P2 | partial | Live preview | Preview an entry inside its site template | Existing entry and template | Content live mode | Preview matches current draft/template context | missing template, stale draft/public state |
| CONTENT-006 | P2 | partial | Collections | Create/update collection field settings | Logged in | Content collections/settings | Field changes are reflected in the entry editor | destructive schema changes, step-up friction |
| CONTENT-007 | P2 | partial | AI | Use the content AI assistant panel | AI chat permission | Content AI panel | No-provider guidance or chat flow is understandable | provider failure, write-tool permission leaks |
| CONTENT-008 | P1 | ✅ | Custom fields | Edit custom post fields and use them in Site templates | Logged in | Data Posts fields → Content settings → Site binding picker → publish post route | Custom field appears in the Content entry settings panel, persists after reload, is offered as a scoped currentEntry binding, resolves in canvas preview, and renders on the public post route | stale table metadata, unresolved custom tokens, save/publish ordering |

CONTENT-003 note: slash-menu Heading 2 and Data token placeholder insertion with save/reload persistence are automated in `content.e2e.ts`; media picker insertion and sanitization edge cases remain lower-level or future browser coverage.

CONTENT-005 note: draft title/body rendering through the seeded entry template in Live mode is automated in `content.e2e.ts`; missing-template error handling, stale public-state comparison, and mobile live-canvas checks remain future browser coverage.

CONTENT-006 note: content built-in field toggles are automated in `content.e2e.ts`; custom field-schema edge cases and destructive collection deletion remain covered by lower-level tests or future browser expansion.

CONTENT-007 note: no-provider setup guidance in the content AI assistant is automated in `content.e2e.ts`; provider-backed conversation, streaming, and write-tool flows remain future browser coverage.

CONTENT-008 note: `content.e2e.ts` adds a custom text field to the system Posts table through the Data inspector, edits that field in the Content settings sidebar, saves and reloads the entry, publishes the post, inserts the custom field from the Site builder binding picker into a Posts template, verifies the canvas preview resolves the value, publishes the template, and verifies an anonymous `/posts/<slug>` route renders the custom value without unresolved tokens. Non-text custom field editor variants remain lower-level or future matrix expansion.

## AI Workspace

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| AI-001 | P1 | partial | Providers | Manage provider credentials and discover provider models | Logged in | AI Providers tab | Ollama credential can be created, listed as a safe credential projection, skipped for auto-defaulting when offline, and deleted cleanly | live provider model tests, masked key updates, default credential deletion |
| AI-002 | P1 | partial | Defaults | Set default credential/model per AI scope | Credential with models | AI Defaults tab | A scope saves the intended credential/model pair, reloads with the saved selection resolved, and can clear the default so the credential can be deleted | no credentials, deleted credential, stale model list, all-scope coverage |
| AI-003 | P2 | partial | Conversations | Continue saved AI conversations per scope | AI chat permission and configured default | AI assistant history | Saved Site chats can be listed, reloaded, and deleted from the history popover | cross-user access, deleted credential, title update, empty history |
| AI-004 | P2 | partial | Chat | Stream scoped AI replies and tool-loop events | Configured provider/default | Site/content AI assistant | Prompt sends to a fixture-backed local provider, streamed text renders, and text-only usage persists for audit | provider SSE failure, aborts, empty prompt, large context, write-tool UI |
| AI-005 | P2 | partial | Tool Bridge | Return browser-executed tool results to the AI runtime | Active tool request | Browser bridge + `/ai/tool-result` | Browser `read_document` tool result correlates to the pending request and resumes the model loop | lost tab, timeout, duplicate result, malformed ids, write tools |
| AI-006 | P2 | partial | Audit | Review AI usage rollups by user/scope/model/day | Usage generated by chat | AI Audit tab/dashboard widget | Audit tab renders model, scope, token, and daily rollups from a real streamed chat turn | empty usage, deleted labels, bad timezone, dashboard widget, mobile table |
| AI-007 | P2 | partial | Drivers | Use provider REST drivers without SDK lock-in | Mocked or local provider | AI runtime/provider drivers | Direct drivers map messages/tools, stream events, usage, model catalogues, context windows, and prices without provider SDKs | malformed SSE, rate limits, unknown pricing |

AI-001 note: Ollama base-URL credential create/list/delete and offline auto-default guarding are automated in `ai.e2e.ts`; live provider model tests, credential update/masking, default reassignment, and mobile layout remain lower-level or future browser coverage.

AI-003 note: Site assistant conversation creation, new-chat reset, history reload, message rehydration, active conversation delete, and empty-history feedback are automated in `ai.e2e.ts`; API title update, cross-user ownership denial, stale credential recovery, multi-conversation disambiguation, content/data/plugin scopes, and mobile layout remain future coverage.

AI-004 note: site assistant streaming against a fixture-backed local Ollama-compatible server is automated in `ai.e2e.ts`; write-tool/tool-loop UI, abort/error recovery, and content/data/plugin provider-backed permutations remain future coverage.

AI-005 note: fixture-backed local Ollama tool-loop coverage is automated in `ai.e2e.ts` for the browser-executed `read_document` path: tool request, browser result POST, provider second turn, completed tool badge, and final assistant text. CAP-005 also verifies request-level write-tool filtering for `ai.chat` without `ai.tools.write`. Mutating write-tool bridge success coverage, timeout/abort UX, duplicate/malformed result handling, permission-denied execution defense, and unknown-tool provider requests remain lower-level or future browser coverage.

AI-006 note: usage generated by the AI-004 site chat is verified in the Audit tab by model, surface, prompt/completion tokens, and daily spend in `ai.e2e.ts`; dashboard widget, range switching, timezone/user permission variants, deleted-label display, and mobile table layout remain future coverage.

AI-007 note: direct driver coverage is automated in `src/__tests__/ai/*Mapping.test.ts` and `src/__tests__/ai/pricing.test.ts`; the OpenRouter path now verifies its own Responses endpoint, bearer auth, native `usage.cost` passthrough, model-list pricing, context windows, and capability mapping. Live provider-network failures, malformed SSE/catalogue bodies, rate-limit UX, unknown-price catalogue misses, and full OpenRouter tool-loop browser permutations remain lower-level or future fixture-backed coverage.

AI-002 note: Data-scope default selection, save feedback, reload persistence, clear feedback, and post-clear credential deletion are automated in `ai.e2e.ts` using an offline Ollama credential and deterministic fallback model list. Site/content/plugin scope permutations, no-credential empty state, stale credential recovery, live model catalogues, permission variants, and mobile layout remain future browser or lower-level coverage.

## Plugins

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| PLUGIN-001 | P1 | partial | Plugins | Upload and activate a valid plugin | Logged in, test plugin manifest/zip | Plugins page | Plugin appears active with clear permissions | scary/unclear permission review |
| PLUGIN-002 | P1 | partial | Plugins | Enable, disable, restart, or uninstall a plugin | Active plugin | Plugins page | UI explains impact and completes safely | orphaned UI, missing cleanup |
| PLUGIN-003 | P2 | partial | Plugins | Edit plugin settings and secrets | Active plugin with settings | Plugins page | Settings save without leaking secret values | settings leaks, generic failures |
| PLUGIN-004 | P2 | partial | Plugins | Use plugin admin pages, resources, and runtime routes | Active plugin | Plugin admin page/resource/runtime route | Plugin feature appears and works | runtime crash, unclear placement |
| PLUGIN-005 | P2 | partial | Plugins | Inspect and control plugin schedules | Active plugin with schedules | Plugin schedule dialog | Schedules list and mutating controls respect permissions | stale paused state, duplicate runs |
| PLUGIN-006 | P2 | partial | Plugins | Install a plugin-provided site pack | Active plugin with pack | Plugins page | Pack content imports with clear feedback | conflicts, partial imports |
| PLUGIN-008 | P2 | ✅ | Plugins | Upload invalid plugin package | Logged in | Plugins page | Error is specific and recoverable | generic failure, stuck upload |

PLUGIN-001 note: JSON manifest review/install step-up is automated in `capabilities.e2e.ts`; ZIP package review/install and activation are exercised by the packaged lifecycle/surfaces fixtures in `plugins.e2e.ts`; malformed ZIP/path-traversal/package-edge coverage remains lower-level or future browser expansion.

PLUGIN-002 note: packaged lifecycle fixture install, disable, runtime route unregistration, enable, runtime route restoration, remove confirmation, uninstall, and post-remove route absence are automated in `plugins.e2e.ts`; parked-error restart, uninstall-hook failure/force-remove, and mobile card layout remain lower-level or agent-run.

PLUGIN-003 note: packaged settings fixture install, non-secret setting persistence, secret value save, reopened `***` masking, and direct settings API no-plaintext projection are automated in `plugins.e2e.ts`; invalid setting payloads, disabled-plugin behavior, and mobile dialog layout remain lower-level or agent-run.

PLUGIN-004 note: packaged ZIP install, permission review, markdown/map/resource/app admin pages, resource create/delete, and an authenticated runtime route are automated in `plugins.e2e.ts`; disabled-plugin, runtime-denied, app-failure, and mobile layout variants remain agent-run or lower-level.

PLUGIN-005 note: packaged schedule fixture install, permission review, schedule inspection, run-now, recent-run display, pause, and resume are automated in `plugins.e2e.ts`; run failure, missing schedule, concurrency, and mobile layout variants remain agent-run or lower-level.

PLUGIN-006 note: packaged site-pack fixture install, permission review, auto-imported page visibility in the Site Explorer/canvas, re-sync, and success feedback are automated in `plugins.e2e.ts`; conflict/error, missing/invalid pack, Visual Component/layout-heavy packs, and mobile variants remain agent-run or lower-level.

PLUGIN-008 note: invalid JSON-manifest upload and recovery with a subsequent valid review are automated in `plugins.e2e.ts`; invalid zip/package fixtures remain covered by lower-level package tests and future fixture-backed browser expansion.

## Responsive And Accessibility Passes

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| A11Y-001 | P1 | ✅ | Keyboard | Complete setup/login with keyboard | Clean/setup DB | Keyboard only | Focus order and submit behavior work | focus traps, invisible focus |
| A11Y-002 | P2 | ✅ | Editor | Navigate main admin shell with keyboard | Logged in | Keyboard only | Core navigation is reachable | custom controls without roles |
| RESP-001 | P2 | ✅ | Responsive | Use admin at tablet width | Logged in | 768px viewport | Main flows remain usable | clipped panels, overlapping text |
| RESP-002 | P2 | ✅ | Responsive | Preview/publish mobile page | Published page | 390px viewport | Public page is readable and styled | overflow, broken media |

RESP-002 note: published public-page mobile smoke coverage is automated in `accessibility.e2e.ts`; deeper multi-module mobile visual review remains agent-run.

A11Y-001 note: keyboard-only login is automated in `accessibility.e2e.ts`. The regression uses anonymous storage after setup, focuses Email, types the owner email, verifies Tab advances to Password, types the password, submits with Enter, and verifies the authenticated admin shell appears.

RESP-001 note: tablet-width admin editor shell coverage is automated in `accessibility.e2e.ts` at 768x1024, verifying the toolbar, canvas root, and account menu trigger remain visible and reachable.

A11Y-002 note: keyboard activation of main admin shell navigation is automated in `accessibility.e2e.ts`; deeper focus-order sweeps remain agent-run.

## Command Palette (⌘K Spotlight)

Full scenario descriptions and per-assertion steps live in `docs/e2e/spotlight.md`.

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| SPOT-001 | P1 | ✅ | Open/Close | Open palette with ⌘K and close with Esc | Logged in | ⌘K → Esc | Palette opens, input focused, Esc closes, focus restored | Focus trap failures; palette fails to open |
| SPOT-002 | P1 | ✅ | Navigation | Type a query and navigate to a workspace | Logged in | Open palette, type, Enter | Correct workspace opened; palette closed | Wrong navigation; palette left open |
| SPOT-003 | P2 | ✅ | Subcommand | Push a scope and pick an item | Site workspace with viewport contexts | Open palette, drill into "Switch viewport →" | Active viewport changes; palette closes | Scope push fails; wrong item selected |
| SPOT-004 | P1 | ✅ | Destructive | Two-Enter confirm flow for a destructive command | Multiple pages exist | Open palette, destructive command, Enter×2 | First Enter shows confirm; second runs | No confirm shown; double-fire |
| SPOT-005 | P2 | ✅ | Destructive timeout | Confirm collapses after 5 s without second Enter | Active confirm state | Wait >5 s | Confirm prompt disappears | Timer off; row stuck |
| SPOT-006 | P1 | ✅ | Empty state | No-match query shows empty state | Logged in | Open palette, type nonsense string | Empty-state UI with quoted query | Empty state missing; wrong empty state |
| SPOT-007 | P2 | ✅ | Context ranking | Duplicate-layer command boosted with node selected | Editor, node selected | Open palette | "Duplicate layer" near top | Command missing; not boosted |
| SPOT-008 | P2 | ✅ | Recents | Recent commands at top on re-open | Run one command | Close and reopen palette | Recent group with prior command visible | Recents not persisted; duplicates |
| SPOT-009 | P2 | ✅ | AI panel context | Open palette from inside the AI assistant panel | AI panel open | Focus a panel control, press ⌘K | Palette opens over the AI panel and Esc restores panel focus | Shortcut swallowed by panel; focus not restored |
| SPOT-010 | P2 | ✅ | Async skeleton | Async provider loading state appears and resolves | Content workspace | Type provider-triggering query | Skeleton rows appear briefly, then results replace them | Skeleton missing, stuck, or replaced by spinner |
| SPOT-011 | P2 | ✅ | Keyboard only | Run a palette command without mouse | Logged in | Open, navigate, run with keyboard | Command runs; focus remains in palette during navigation | Arrow keys scroll page; focus escapes |
| SPOT-012 | P3 | ✅ | Reduced motion | Palette respects reduced-motion preference | Reduced-motion enabled | Open and close palette; drill into a nested scope | No slide animation; opacity-only or instant transition | Motion preference ignored |
| SPOT-013 | P3 | ✅ | High contrast | Palette highlight remains visible in high contrast | High contrast enabled | Open and arrow through results | Highlight row outline and match marks remain legible | Highlight invisible; marks blend |

SPOT-001 through SPOT-013 note: command-palette coverage is automated in `command-palette.e2e.ts`. The 2026-06-23 focused regression exercised open/close, navigation, nested viewport scope, destructive confirmation and timeout, no-match empty state, selected-layer ranking, recents, AI-panel context, async skeletons, keyboard-only execution, reduced motion, and high-contrast styling in one pass after isolating shared E2E auth state.


## Performance And Reliability

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| PERF-001 | P2 | partial | Editor Load | Open editor from cold start | Setup complete | `/admin` | App becomes usable without long blank state | spinner dead ends, console errors |
| PERF-002 | P2 | partial | Publish | Publish a moderately complex page | Page with nested modules/media | Publish | Operation gives feedback and completes | no progress, timeout, duplicate clicks |
| REL-001 | P2 | ✅ | Recovery | Refresh during normal editing | Editing session | Reload | App recovers to a coherent state | corrupt draft, lost selection crash |
| REL-002 | P3 | ✅ | Error Handling | Trigger validation errors intentionally | Various forms | Bad input | Errors are specific and close to fields | global vague errors |

PERF-001 note: Site editor cold-start usability is automated in `performance.e2e.ts`; the smoke opens `/admin/site`, requires ready editor chrome within a generous 20s budget, verifies the loader is gone, and fails on console errors. Detailed performance profiling remains agent-run.

PERF-002 note: moderately-complex publish completion is automated in `performance.e2e.ts`; the smoke creates a page with text, a linked button, and uploaded image media, verifies publish completion within a generous 30s budget, and checks the public route. Deeper profiling and heavier page shapes remain agent-run.

REL-001 note: saved-edit reload recovery for a disposable Site page is automated in `reliability.e2e.ts`; deeper crash/error-boundary recovery remains agent-run.

REL-002 note: page-slug required/reserved validation and recovery in the New Page dialog is automated in `error-handling.e2e.ts`; broader form/error sweeps remain agent-run.

## Configuration And Deployment

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| CONFIG-001 | P1 | partial | Database | Run the CMS on SQLite locally or Postgres when configured | DATABASE_URL set or unset | Server boot / DB helper | SQLite URL forms select the SQLite adapter and migrations, Postgres schemes select the Postgres adapter and migrations, migration IDs stay in lockstep, and repository SQL stays portable | unsupported URLs, missing parent dirs, parity drift, JSON column suffix drift, advisory-lock differences |
| CONFIG-002 | P1 | partial | Runtime | Run dev, Docker, and deployed server config predictably | Local env or compose env | Server/dev scripts | PORT, DATABASE_URL, UPLOADS_DIR, staticDir, health, uploads, and static assets use documented defaults and env overrides | port conflicts, missing uploads dir, static 404s, healthcheck mismatch |
| CONFIG-003 | P1 | partial | Runtime Options | Enforce plugin, media, secret, and dependency config | Plugin manifests / server env | Plugin/runtime/form config | Manifest permissions, network hosts, secrets, media surfaces, and runtime dependencies are validated and enforced | fallback secret durability, wildcard hosts, secret leaks, path traversal |

CONFIG-001 note: `src/__tests__/db/createDbClient.test.ts` covers DATABASE_URL SQLite forms, Postgres schemes, invalid schemes, SQLite parent directory creation, and migration idempotence; `migration-parity`, `db-json-column-naming`, `db-postgres-isms`, SQLite smoke, adapter rowCount, transaction serialization, advisory-lock, statement-cache, dev workflow, and docker config tests cover the surrounding dialect contract. Live Postgres connection failure/recovery remains operator-run.

CONFIG-002 note: `src/__tests__/server/serverConfig.test.ts` covers runtime config defaults and env overrides for PORT, DATABASE_URL, UPLOADS_DIR, STATIC_DIR, trusted proxies, and public origins; `staticAdmin`, `router`, `devWorkflow`, and `dockerConfig` tests cover health, admin/static/uploads serving, dev proxy/ports, Docker image/compose healthchecks, persistent volumes, and production env wiring. Actual port-conflict handling, Caddy TLS issuance, filesystem permission failures, and deployed-platform smoke remain operator-run.

CONFIG-003 note: `src/__tests__/server/formChallengeSecret.test.ts`, `publicForms`, `pluginManifest`, `gatedFetchSsrf`, `pluginVmPermissions`, `pluginSecrets`, `pluginMediaAdapterBoundary`, `runtimeDependencies`, and `server/publish/runtime/__tests__/cacheLayout.test.ts` cover form secret precedence/fallback, public form challenge routing, plugin manifest allowlists/assets/coherence, granted-permission enforcement, SSRF-gated fetch, encrypted plugin settings, media adapter boundary validation, and runtime dependency cache/package serving. Live provider/network permutations, true process-restart durability, and browser UI permutations remain operator-run.

## Security Boundaries

| ID | Priority | Auto | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|:---:|---|---|---|---|---|---|
| SECURITY-001 | P0 | partial | API Security | Keep CMS and AI API mutations protected by origin, capability, and TypeBox request-boundary checks | Authenticated and unauthenticated API callers | `/admin/api/cms/*` and `/admin/api/ai/*` | Forged origins reject before DB access, safe reads reach auth, owned paths return 405 on wrong method, missing capabilities reject before body parse, and malformed JSON/schema bodies return `{ error }` 400s after auth | broad route fuzzing, dev-origin config drift, direct URL/API bypasses |

SECURITY-001 note: focused Bun coverage verifies CMS/AI invalid-origin mutations reject before DB access, including route-shape fuzzing across 76 CMS mutation endpoints and 11 AI mutation endpoints with a throwing DB; configured custom and platform public origins reach the CMS/AI auth boundary; forwarded-host/proto spoofing is rejected at the CMS/AI boundary even from trusted proxy peers; safe CMS reads are not Origin-gated; CMS namespace 405 behavior; CMS/AI capability-before-body ordering; malformed JSON/schema body rejection; route-table semantics; handler capability architecture gates; HTTP boundary-validation gates; origin helper behavior; AI driver isolation; and AI tool capability filtering. Live deployed smoke and browser-observed API error UX remain operator-run.
