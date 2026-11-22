# Changelog

All notable changes to Instatic will be documented here.

This project is pre-1.0. Breaking changes may appear in minor or patch releases until a stable release line exists.

## 0.0.23 - 2026-11-22

Instatic adds site member accounts, transactional email, and reusable site fragments. This release also addresses five security advisories affecting self-hosted installations. Operators with third-party plugins or trusted reverse proxies should review the Security section before upgrading.

### Features

- **Member sites.** Visitors can create accounts, sign in, reset passwords, and manage their profiles on pages you design in the editor. Choose the published pages in Member settings, then restrict pages, collections, or individual elements to signed-in members or people with particular tags.
- **User directory.** Find administrators and site members in one searchable directory. Invite members by email or link, grant time-limited tags, inspect devices and activity, suspend accounts, or sign someone out everywhere.
- **Connected apps.** Members can sign in to an app registered by the site owner, see which access it requests, and disconnect it later. Apps can bind a sign-in to a device and request access to a plugin’s member features with explicit approval.
- **Email workspace.** Connect a mail provider, choose a sender, edit and preview site or plugin email templates, and follow each message in Activity. The delivery queue retries temporary failures and shows which messages are waiting or need attention.
- **Reusable fragments and themes.** Move a section, page, or Visual Component to another site with its styles, media, and table dependencies. Editor plugins can preview an insertion against the destination’s styles or apply a theme in one undoable step.
- **Canvas style inspector.** Adjust gradients, corner radii, and other styles directly on the canvas, and save reusable colors to Framework.
- **Search and social settings.** Page settings now cover search titles, descriptions, canonical URLs, social cards, icons, and structured data, including values brought in by HTML import.
- **Conditional visibility.** Show an element when a URL query parameter, entry field, or loop item field matches a condition, for example a confirmation message after checkout.
- **Mobile workspaces.** Tap the current workspace to switch from a bottom sheet. On portrait phones, the explorer docks below the canvas, inspectors can stay closed while you edit, and branch actions fit beside the branch name.
- **PostgreSQL transfers.** Instatic Desktop and other managers can push, pull, snapshot, and restore PostgreSQL sites, including transfers to and from SQLite. Repeat pushes reuse verified file hashes after a restart.
- **Plugins for member sites.** Plugins can create or link a member without sending an invitation, manage access tags, and show each visitor their own records. A member’s data export can also include records held by plugins and identifies any contribution that could not be retrieved.
- **Plugin integrations.** Operators can review which external script and frame origins a plugin requests. Plugins can handle redirects themselves and, with permission, use the caller’s IP address for per-visitor rate limits.
- **Plugin development.** Plugin records support unique keys and version-checked updates so duplicate deliveries or simultaneous edits are easier to handle.
- Editor plugins can use the same segmented controls, tag pills, and keyboard hints as the admin.

### Bug fixes

- Published lists now reflect entries as they are published, unpublished, or deleted, including changes made by plugins. Dynamic sections and “Load more” lists inside layouts now resolve in the context of the page being viewed.
- Published Visual Components retain responsive variants, dimensions, and alt text when an image is overridden. Media-library background images using automatic sizing now render at their original size.
- Published pages can recover missing runtime packages after a temporary-folder cleanup or container replacement. Browsers also pick up changed form and list scripts after a server upgrade or restart.
- The editing canvas now loads plugin stylesheets, applies submit-button styles to form controls, and leaves intentionally empty text elements empty. Published stylesheets retain classes emitted by modules.
- Matching selectors appear as soon as an element is inserted, long selectors stay inside the Styles panel, and data-binding buttons leave switches and number controls clickable. Resetting zoom to 100% keeps the current canvas area in view.
- Side-by-side branch previews now align at the top, and opening your account in two tabs no longer shows your own cursor as a collaborator. Opening a large collaborative site also does less repeated work during its first sync.
- The dashboard shows the configured domain and actual publishing status. Publish lineup opens the right entry, shows its public path, and flags overdue scheduled items.
- Site Import picks up standalone stylesheets, preserves page-specific CSS, and identifies plugin ZIPs so you can install them through Plugins. Imported pages also keep SVG sprite icons, form and link attributes, and the timing of scripts that run in the document head.
- Re-importing a site now surfaces route and code-file conflicts and reuses matching media. Images in WordPress exports resolve when the archive has an extra enclosing folder.
- Older site bundles that lack a published version import new entries as drafts. Importing over an existing entry respects its live state and cancels a pending schedule.
- Plugin loop sources appear in the editor with sample items and retain their natural order until you choose a sort direction. Publishing warns when a missing plugin leaves a list empty.
- PostgreSQL plugin records now filter and sort by their stored values, including numeric fields. The upgrade repairs existing records where possible and logs any remaining text records that need to be saved again.
- Re-syncing a plugin pack restores a deleted pack page as a draft.
- Imported fragments on fresh sites now get the missing type and spacing scales their design uses.
- Editing a post preserves raw HTML and image URLs, and bold, italic, or struck-through text keeps its formatting beside whitespace.
- Plugin dashboard widgets receive their settings and permissions in the dashboard, Customize view, and Block Library.
- A stalled plugin request now times out without stopping other calls in the worker.
- AI conversations can resume after an interrupted tool call on strict OpenAI-compatible gateways, including DeepSeek.
- Fixed the packaging job that prevented the 0.0.22 release from providing standalone server downloads.

### Security

- **Plugin secrets, 0.0.1–0.0.22.** An enabled plugin listening for settings changes could receive another plugin’s secret values. If an untrusted plugin could have been listening when settings were saved, disable it, upgrade, rotate the affected credentials at their issuer, and update them in Instatic. [Settings disclosure](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-r7cv-2823-gw6j)
- **Plugin hooks, 0.0.1–0.0.22.** A plugin with hook access could read or change entries outside its granted tables and receive unpublished preview HTML, including branch previews from 0.0.20 onward. Review drafts saved while an untrusted plugin with hook access was enabled. [Hook permissions](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-v75q-4pjv-gwx6)
- **Plugin content access, 0.0.1–0.0.22.** A plugin could receive fields from tables it could write but could not read, or move an entry between tables it could write. Review unexpected entry changes and table assignments if an untrusted plugin held these grants. [Content API permissions](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-895v-q9qc-x2mf)
- **Plugin packs, 0.0.1–0.0.22.** Applying a pack could overwrite page or Visual Component drafts outside the plugin’s namespace. Review revisions around untrusted pack installs, upgrades, and re-syncs, including published content if the site was published afterward. [Pack ownership](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-p8jj-gqx8-f9vw)
- **Trusted reverse proxies, 0.0.2–0.0.22.** On affected proxy configurations, requests could be attributed to the wrong client, weakening per-IP limits and audit records. Upgrade and use trusted edge logs when reviewing past IP attribution. [Proxy attribution](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-9jj9-j8wh-jqc4)

### Other changes

- **Plugin compatibility.** The plugin entry-move API has been removed. Plugins that need returned entry fields must have read access to that table, and plugins that listen for their own settings changes must read the new values through their settings API.
- Native OAuth clients can use an available port for a registered loopback IP callback. Reusing an unexpired authorization code now revokes the connection.
- Admin lists share a consistent empty state, and creation actions in the Site and Code explorers use a plus icon. Notifications move above open dialogs so their footer buttons stay accessible.
- Running the development server in one checkout no longer reloads the admin when a different worktree changes.

**Deployment guides** · [Docker](https://github.com/CoreBunch/Instatic/blob/main/docs/deployment/docker-image.md) · [VPS](https://github.com/CoreBunch/Instatic/blob/main/docs/deployment/vps.md) · [Railway](https://github.com/CoreBunch/Instatic/blob/main/docs/deployment/railway.md) · [Render](https://github.com/CoreBunch/Instatic/blob/main/docs/deployment/render.md) · [Backup and restore](https://github.com/CoreBunch/Instatic/blob/main/docs/deployment/backup-restore.md)

## 0.0.22 - 2026-11-16

### Features

- A manager such as Instatic Desktop can now push a complete site to a server, pull it back, take and restore database snapshots, and open the admin through a one-time sign-in link. The API stays off until `INSTATIC_MANAGER_TOKEN` is set; see [`docs/features/manager-api.md`](docs/features/manager-api.md).
- New sites start with three font tokens, `font-heading`, `font-body` and `font-mono`, so imported pages and copied sections can rely on the same font variables. Existing sites are unchanged.
- Site settings > Publishing has a new option that sets the root font size the type and spacing scale assumes. New frameworks from the Core preset turn it on; without it, a scale based on 10px rendered 1.6 times larger than shown.

### Bug fixes

- When plugin pages add entries to the top navigation, the ones that do not fit now move into a "More" menu. They used to push Publish, settings and the account menu out of the window.
- "New post" and Duplicate no longer fail with "a row with slug … already exists". The server now picks the next free slug.
- A visitor who stayed on a page for several minutes before sending a form no longer gets "Form submitted too quickly" on the first try.
- Forms that write to a Select or Multi-select field no longer reject every submission as an invalid option.
- The URL field accepts `tel:` and `sms:` links, so click-to-call and SMS links can be set on links and buttons in the editor.
- A site's own custom properties named like `--radius` or `--text` now render in the canvas with the site's values, as they do on the published page.
- Sections marked as theme-inverted now take the alternate colors, in the canvas and on published pages.
- Collaborators without a display name now show their cursor and selection to others, labelled with their email.
- Opening a large site no longer drops the editor's live connection during the first sync, which left it reconnecting and blocked publishing.
- The upload queue window stays closed when you close it during an upload. It used to reopen immediately.
- Settings shows the current site name and details after a site is imported from Data, instead of the values from before the import.
- "Open site" after an HTML import from Data now opens the imported page in the Site workspace.
- The Preview overlay and the Site panel's hover preview rebuild once the draft stops changing and keep showing the last build meanwhile, instead of blanking on every keystroke.
- Publishing or scheduling a single page now updates the live site. The request used to succeed while visitors still saw the old page or a missing route.
- Publishing a post no longer leaves the dynamic parts of unchanged pages empty. After upgrading, publish the whole site once so pages published by an earlier version pick this up.
- Restoring a site backup brings back the published site as well as the drafts. Collection lists used to come back empty and stale pages stayed visible.
- One invalid property on an element no longer resets the whole element at publish. A link with a bad target used to publish as "Click here" pointing nowhere.
- Published CSS keeps rules that use `:not()`, `:is()` or `:where()` with a class no element carries. They were dropped as unused.
- Published CSS keeps custom properties with underscores or a leading `--_`, and no longer rewrites mixed-case names such as `--brandColor`.
- Elements with a `data-style` or `data-class` attribute keep their real styles and classes when published.
- Links and buttons that carry their own `rel` now publish one merged `rel`. They used to publish two, and the browser ignored the second.
- Images in a post body are no longer stripped when the post is published.
- A custom media field on a post page now publishes as the image address instead of an internal id.
- Loops sorted by a number field now order by value, so 9 comes before 10.
- Site Import keeps `var()` references working when it renames color and font variables, and no longer merges two font variables that differ only in letter case.
- Site Import uploads video files and poster images and points the imported video at them.
- Site Import keeps a class rule that appears twice in a stylesheet at its later position, so the declaration that wins in the browser also wins after import.
- An unclosed `@media` block in one imported `<style>` element no longer swallows the rules of the next one.
- Imported submit buttons keep the icon or image they wrap instead of publishing the word "Submit".
- Imported links with an empty, named or `_top` target now open the way the original did instead of losing their new-tab behavior.
- Imported fonts keep their `font-display` setting.
- Site archives up to the documented 1 GiB limit can be imported. Archives over about 128 MiB were refused.
- A replace import now removes the previous site's media, so importing a second site that ships the same file no longer fails halfway.
- The AI assistant's code tools work when the admin is opened over plain HTTP on a local network.
- AI conversations on Postgres keep their history. Messages were stored unreadable, so the next reply failed.
- Edits sent by an MCP client to the open editor no longer time out or fail partway through a batch.
- The assistant no longer waits on a background tab's slowed timers before taking a page snapshot.

### Security

- MCP connector tokens stopped working only when deleted, not when their owner lost access ([GHSA-95mq-c75h-ffm9](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-95mq-c75h-ffm9)). A personal access token or OAuth connection kept reading and editing the site after its owner was suspended or lost the AI permission. Every MCP request now checks the owner's current account status and role, and authorizing a new connection requires AI access. Reported by [@0xcomrade](https://github.com/0xcomrade).
- An open editor connection kept its access after it should have ended ([GHSA-3w5h-rwwx-mjf8](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-3w5h-rwwx-mjf8)). A user who was suspended, signed out everywhere, or lost editing permissions could keep reading and changing the site through a collaboration socket opened earlier, because access was checked only when the socket opened. The server now rechecks the session and current permissions before applying or delivering anything. Reported by [@0xcomrade](https://github.com/0xcomrade); the permission-removal case was found independently by [@Liam-G](https://github.com/Liam-G).
- Dashboard endpoints returned content details to accounts that could not read the content itself ([GHSA-83pg-4p8c-pv37](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-83pg-4p8c-pv37)). Any signed-in account, including a Member with no permissions, could read page and post counts, storage usage, and the paths, status and scheduled times of unpublished drafts. The dashboard now applies the same permissions as the content it summarises. Reported by [@0xcomrade](https://github.com/0xcomrade).

### Other changes

- Published script bundles are minified.
- Uploads and admin files are revalidated instead of downloaded again on every load, which makes editor previews of image-heavy sites much lighter.
- Each publish removes stored script files of page versions that are no longer live, which keeps the database and backups from growing with every publish.
- Upgraded Happy DOM to 21.0.4, which fixes an upstream advisory in a feature Instatic keeps turned off.

## 0.0.21 - 2026-10-12

### Features

- Plugins can now keep access to the content tables they create. A plugin that creates a table at runtime, such as an importer, declares `@own-created` in its manifest instead of a table name it cannot know in advance, and the install dialog shows that grant to the operator.

### Bug fixes

- Applying or removing a class from the Selectors panel now affects every selected element, not only the last one clicked, and the whole change undoes in one step.
- The `Esc` keycap at the bottom of the Settings panel closes it when clicked. It used to animate and do nothing.
- Importing a site whose stylesheet, script, and image links carry a cache-busting query such as `?v=8f3a1c` now finds those files. They were reported missing and their styles and colour tokens were dropped.
- The dashboard checklist's page step now follows the seeded Home page: it reads "In progress" until a page is published and completes on publish, so a one-page site can finish the checklist and editing Home no longer shows next to "Not started".

### Security

- Closed an authorization gap in author reassignment ([GHSA-m425-wmrc-4v4v](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-m425-wmrc-4v4v)). An editor holding `content.edit.any` but not `data.system.tables.read` could read the full contents of any page or post row, including unpublished drafts and author identity, and change its author through `PATCH /admin/api/cms/data/rows/:id/author`, while reading the same row directly was correctly refused. The endpoint now applies the same table and ownership check as every other row read and write. Reported by [@sriman0707](https://github.com/sriman0707).
- Closed an authorization gap in the AI and MCP content read tools ([GHSA-x5cc-8486-8qqx](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-x5cc-8486-8qqx)). A user or MCP connection holding `ai.chat` and `content.edit.own` could read every other user's drafts and any page or post row through `content_get_document`, `content_list_documents`, and `content_search_documents`, although the same rows were refused on the normal API. The tools now decide access with the same table and ownership rules as the HTTP routes, and the MCP relay enforces the table boundary it was missing. Reported by [@sriman0707](https://github.com/sriman0707) and [@btarr-vc](https://github.com/btarr-vc).
- MCP OAuth discovery no longer trusts the request's `Host` header ([GHSA-hgjv-q732-4phj](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-hgjv-q732-4phj)). On a deployment without `PUBLIC_ORIGIN`, the authorization server, resource, and token URLs in the discovery documents and the `WWW-Authenticate` challenge were built from whatever `Host` an unauthenticated client sent. The issuer now comes only from the configured public origin; without one, OAuth discovery answers 503 and personal access tokens keep working, with loopback development exempt. Set `PUBLIC_ORIGIN` to use remote OAuth connectors (Render and Railway set it automatically). Reported by [@KadirArslan](https://github.com/KadirArslan).

## 0.0.20 - 2026-09-13

### Features

- Added site branches: fork the whole site into a private copy, edit it in the normal editor, and share a preview link with someone who has no admin account. Merging goes through a review page that shows each change with the page rendered before and after, and an editor without merge rights can request a merge instead of making one.
- Added version history for pages and content entries. Every published version is listed with who published it and when, and any one can be restored into the draft.
- The Dependencies panel now browses npm: search for a package, read its README, versions, and known advisories, and install the version you pick.
- Publish errors now name the file. Each code error that blocks a publish is listed with its file and position, and the Explorer badges the scripts and stylesheets at fault instead of only showing a count.

### Bug fixes

- Editing a page no longer wipes its SEO fields, featured image, or plugin data, which were lost on the first edit after they were set.
- Upgrading a plugin no longer breaks the JavaScript on every published page. The old plugin files now stay in place until the next publish rewrites the links to them.
- Publishing keeps CSS classes that only a script switches on, such as an open mobile menu. They were dropped as unused, so the menu worked in the editor and did nothing on the live site.
- Responsive styles no longer invert at publish on sites that mix min-width and max-width breakpoints, where a narrow rule could end up winning on wide screens.
- Imported sites keep their `min()`, `max()`, and `clamp()` sizing instead of losing fluid spacing and typography.
- Times in the admin are correct on SQLite installs running outside UTC, where a device that signed in seconds ago could read as hours old.
- Content lists sort correctly again on SQLite, and the dashboard no longer drops a day from its window.
- Re-uploading a plugin at the same version is treated as a reinstall instead of a first install, so its hooks run in the right order and a failed upload no longer leaves it stuck in an error state.
- The downloadable server builds now start on machines other than the one that built them. Every 0.0.19 artifact exited immediately, so Instatic Desktop could not run that release.
- Sites with runtime scripts can be published from those server builds, which previously could not start the bundler.
- `bun run dev` refuses a Bun older than 1.4.1 with a clear message instead of starting up and leaving the editor unable to connect.

### Other changes

- Instatic runs on Bun 1.4.2. Installing from source needs Bun 1.4.x.

## 0.0.19 - 2026-09-10

### Security

- Closed a server-side request forgery in the media storage write path ([GHSA-9pq7-m5wf-r7f6](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-9pq7-m5wf-r7f6)). A plugin holding only `media.storage.adapter` supplies the step URLs in an upload plan, and the executor streamed the bytes to them with an unguarded `fetch()`, so the grant carried the network reach of `network.outbound` without asking for it: arbitrary `PUT` and `POST` at loopback, private, link-local, and cloud-metadata addresses, with plugin-chosen headers and the validated media bytes as the body. This is the write-side sibling of the media migration SSRF fixed in 0.0.18, which closed the read path and left this one open. Upload plan steps now go through the same SSRF-safe guard as the read path: internal addresses are refused before a connection opens, the connection is pinned to the checked IP, and every redirect hop is re-validated. Reported by [@skeletonsec](https://github.com/skeletonsec).

### Publishing and runtime

- Fixed the runtime dependency package server returning 404 for every package asset on Windows hosts ([GHSA-hwp9-vc7h-gvvf](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-hwp9-vc7h-gvvf)). The containment check that keeps a resolved path inside the cache directory compared against a hard-coded forward slash, but `path.resolve` produces backslashes on Windows, so the check was false for every legitimate path and the endpoint refused all runtime package assets. It fails closed, so nothing was exposed. Containment is now decided with `path.relative()`, which is correct on both separators, and the same helper replaced a prefix comparison in the site-script workspace that carried no separator at all and would have accepted a sibling directory whose name merely began with the root. Reported by [@uziii2208](https://github.com/uziii2208).

## 0.0.18 - 2026-09-01

### Security

- Fixed a stored cross-site scripting hole in server-side richtext sanitization ([GHSA-jg75-xjf8-vvf8](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-jg75-xjf8-vvf8)). DOMPurify ran on happy-dom, which does not implement the DOM's NodeIterator removing steps: when DOMPurify removed a disallowed node mid-walk the iterator detached and the walk stopped, so every sibling after it, including a trailing `<script>`, was emitted unsanitized. Because the richtext profile drops `<img>`, any body carrying an image followed by script triggered it. The server now backs DOMPurify with jsdom, the DOM implementation it documents and tests against. Reported by [@asachs01](https://github.com/asachs01).
- Fixed a stored cross-site scripting hole in the Site editor canvas ([GHSA-7vxr-r5h2-rh76](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-7vxr-r5h2-rh76)). A content author's post body was sanitized for the published page but not for the canvas: the outlet's body binding rendered the markdown to HTML and the canvas injected it through `dangerouslySetInnerHTML` with no sanitizer, so an owner who previewed the entry in the editor ran the author's markup same-origin with `/admin`. Richtext binding results are now sanitized in `resolveDynamicProps`, the resolution step the canvas and the publisher share. Reported by [@Alpastx](https://github.com/Alpastx).
- Fixed a stored cross-site scripting chain in bundle media import ([GHSA-5h25-59wc-mqh9](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-5h25-59wc-mqh9)). A user holding only `data.import` could write an SVG into the served published-asset tree and have it returned, unauthenticated, from the CMS origin as `image/svg+xml` with no Content-Security-Policy, so its script ran in the admin origin. Three defects chained, each fixed on its own: the reserved-subtree denylist in `resolveMediaWriteTarget` tested the raw path, so a leading `./` normalized straight back into `published/` (now tested on the normalized landing path); the byte-level SVG sanitizer was a literal-tag regex a namespace-prefixed `<s:script>` slipped past (now DOMPurify's namespace-aware SVG profile over jsdom); and `/_instatic/assets/*` served any extension with no CSP (now serves only the kinds the publisher emits, with `default-src 'none'` and `nosniff`). Reported by [@w1p3r](https://github.com/w1p3r).
- Hardened the plugin outbound network guard against server-side request forgery ([GHSA-c76p-6v4v-6pg8](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-c76p-6v4v-6pg8), [GHSA-r4rj-5h92-pmjg](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-r4rj-5h92-pmjg), [GHSA-99x9-9h78-8qxr](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-99x9-9h78-8qxr), [GHSA-ffj5-qw5f-m346](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-ffj5-qw5f-m346)). The guard resolved a plugin's fetch target and checked the resolved addresses, then let the runtime re-resolve and connect, so a DNS rebinding between check and connect could reach an internal address; it now pins the connection to the exact IP it validated, keeping the hostname in the `Host` header and the TLS SNI. The IP blocklist was string and prefix matching that missed non-canonical IPv6 loopback spellings and the NAT64, 6to4, and Teredo transition prefixes; it now parses addresses with `ipaddr.js` and allows only globally-routable unicast. Reported by [@N3agu](https://github.com/N3agu), [@Vip3r-MC](https://github.com/Vip3r-MC), [@mdhaiwat](https://github.com/mdhaiwat), and [@tonghuaroot](https://github.com/tonghuaroot).
- Restricted operator-set AI provider base URLs pointing at internal addresses to the owner ([GHSA-886f-pfqc-7gm5](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-886f-pfqc-7gm5)). A user with `ai.providers.manage` but not the owner role could register an OpenAI-compatible or Ollama provider whose base URL resolved to loopback, a private range, or cloud metadata, and have the server fetch it, turning the CMS into an SSRF proxy. Pointing a provider at a local address is how self-hosted local models (Ollama, a LAN LLM) are wired, so it stays available to the owner; a non-owner is now refused an internal base URL when creating or updating a credential. Reported by [@tonghuaroot](https://github.com/tonghuaroot).
- Closed a server-side request forgery in media storage migration ([GHSA-rmm7-wqw2-jwc6](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-rmm7-wqw2-jwc6)). A plugin holding only `media.storage.adapter` supplies the URL the migration reads, and the migration fetched it with an unguarded `fetch()`, so the plugin gained the network reach of `network.outbound` and could point the server at an internal service or cloud metadata. The migration read now goes through the same SSRF-safe guard as plugin fetches: internal addresses are refused and the connection is pinned to the checked IP. Reported by [@uziii2208](https://github.com/uziii2208) and [@thewindghost](https://github.com/thewindghost).
- Required `plugins.configure` to read plugin-owned records ([GHSA-q5j5-qp67-65vf](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-q5j5-qp67-65vf)). Reading a plugin resource's records returns the raw stored payload with no field masking, which can include tokens, customer data, or other operational secrets, but the route gated reads on `plugins.read` — the browse-only capability meant for the plugin list and masked settings. A role holding only `plugins.read` could enumerate and dump the records of any enabled plugin. Reads now require `plugins.configure`, matching the write path. Reported by [@uziii2208](https://github.com/uziii2208) and [@ugvxb](https://github.com/ugvxb).
- Gated system-table row reads on `data.system.tables.read` ([GHSA-x69h-wqp3-28mq](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-x69h-wqp3-28mq)). The table-schema endpoint enforced the system-vs-custom table boundary, but the four row-level reads — list rows, read one row, preview, and cross-table search — gated only on a broad `content.*` capability plus row ownership. A persona granted `content.edit.any` or `content.manage` but deliberately withheld `data.system.tables.read` could read, preview, and search every system-table row, including other authors' unpublished drafts and author identity. Every row read now enforces the same check the schema read does. Reported by [@tonghuaroot](https://github.com/tonghuaroot).
- Fixed privilege escalation through unrestricted user-role assignment ([GHSA-rrpm-wfw7-4q8x](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-rrpm-wfw7-4q8x)). A user manager could assign any non-Owner role, including Admin, to themselves or another user, because the assignment endpoints never checked that the target role's capabilities were a subset of the actor's own. Role assignment now follows a strict delegation rule on both user creation and role change, including self-assignment, and `roles.manage` is reserved for the Owner: role mutations reject it, persisted non-Owner grants are stripped while hydrating authorization state, and an additive migration removes legacy invalid grants. Reported by [@Alpastx](https://github.com/Alpastx).
- Fixed web cache poisoning in the server-island fragment renderer ([GHSA-f29g-gm7f-4925](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-f29g-gm7f-4925)). A fragment's content depends on the originating page URL, whose path drives `route.path`, `route.slug`, and `route.segments`, but the render cache keyed only on the publish version and the page query. An unauthenticated attacker could render a fragment under an arbitrary page path and have it stored as the canonical cached response served to every subsequent visitor of the real page until the next publish. The cache key now includes the page path. Reported by [@wsparks-vc](https://github.com/wsparks-vc).

### Editor, import, and publishing

- Fixed Cancel during a static site import's upload phase closing the wizard while the import kept running and could still commit. Cancelling (or closing the dialog mid-upload) now aborts the remaining uploads, prevents the site commit and draft save, and reports how many files had already reached the Media Library.

## 0.0.17 - 2026-08-30

### AI and integrations

- Fixed adding the Instatic MCP connector on Postgres installations. The dynamic client registration response returned `client_id_issued_at` as a quoted string, because Postgres declares the column `bigint` and returns it as a string to protect precision, so clients that validate the response against RFC 7591 rejected the connector with `expected number, received string`. SQLite installations were unaffected.
- Streamed the MCP editor bridge as `text/event-stream` so buffering reverse proxies flush each record instead of holding the connection, keeping connected agents working against an open Site or Content workspace on proxied installations.
- Added the AI workspace to the shared admin navigation and a Spotlight command, so users holding the AI capabilities can reach AI settings without typing the URL.

### Editor, import, and publishing

- Added TypeScript tooling to Site Editor scripts: strict semantic diagnostics, DOM-aware completions, and hover information from a worker-isolated language service, collected in a compact Problems panel. Publish-time script build errors now come back as an author-actionable error with `file:line:column` diagnostics instead of a silent server error.
- Added a condition to data-row loops so a list can show a subset of a table rather than always its newest rows — pick one of the table's own fields and require it to be checked, unchecked, equal to a value, or to have any value at all. A relation field offers its rows by name instead of asking for an id. The condition applies on the canvas, on published pages, and in the "load more" endpoint, and the item count follows it so pagination never advertises rows the page drops.
- Added the table's own fields to a data-row loop's "Order by" list, so a list can follow a real date, title, or rank stored in the row instead of only the row's built-in columns. Values compare as text, which sorts ISO dates chronologically.
- Let a data-row loop's wrapper carry custom HTML attributes, the same control containers already have, applied identically on the canvas and in published output.
- Interpolated `{tokens}` inside a node's custom HTML attributes at publish time, so data-bound values reach `data-*` and ARIA attributes instead of publishing verbatim.
- Fixed escaped `\{` in token interpolation to emit a literal brace without its backslash, as the escaping syntax always documented.
- Fixed the loop "load more" runtime to read its endpoint from the script tag's attribute — `document.currentScript` is null inside module scripts, so a configured endpoint was never honored.
- Let the New field dialog accept camelCase field ids, matching the camelCase built-in fields it sits beside.
- Stopped the New field dialog crashing on admins served over plain HTTP, where no secure context means `crypto.randomUUID` does not exist.
- Parsed CSS Color-4 space-separated `hsl()` values in framework color tokens, so tokens authored in the modern syntax generate their transparent, shade, and tint variants again.
- Restored Escape dismissal in the Settings modal after focus left the dialog, and while tooltips are open.
- Fixed Command Spotlight so select-type argument options can be chosen with a mouse click, not only with Enter.
- Named every asset reference a site-import archive cannot satisfy: after a punctuation-insensitive retry against the archive's file list, each remaining media reference emits an `unresolved-asset` warning ranked first in the import log instead of disappearing silently.
- Kept a newly created entry's title in the Content sidebar when the entries list was still loading — a request race left a nameless row.

### Content and publishing

- Fixed the SEO title and SEO description fields on a post so they reach the published page. Both were editable in the Content settings panel but never emitted anything: an entry's `<title>` always showed its plain title, and no description tag was written at all. An authored value now drives `<title>` / `<meta name="description">` and outranks the site-wide Meta Title and Meta Description, on the published page and in the Content editor's Live preview alike. The on-page `{page.title}` and `{currentEntry.title}` bindings keep rendering the entry's real title.
- Interpolated `{currentEntry.*}`, `{page.*}`, and `{site.*}` tokens in the published meta title and description, so per-entry SEO values written as token patterns resolve at publish time instead of appearing verbatim in the `<head>`.

### Platform and maintenance

- Let Railway and Render platform auto-detection survive an invalid `PUBLIC_ORIGIN` value: an unparseable origin list now falls through to auto-detection instead of silently degrading the origin check to an empty allowlist.
- Gave `DbClient` a `close()` on both database adapters and wired it into file-backed test teardown, clearing the Windows test failures caused by SQLite handles outliving their temp directories.
- Scaffolded plugin server entries now import the SDK through the same specifier as every other template, so a freshly scaffolded plugin type-checks inside the monorepo.
- Mapped U+0000 to U+FFFD in `escapeCssIdentifier`, matching the `CSS.escape` specification it vendors.
- Moved HTML tag and attribute rendering helpers into the engine so `src/core` never imports from `src/modules`, now gated by an architecture test.

## 0.0.16 - 2026-08-11

### Media and integrations

- Added an MCP `media_upload` tool so connected agents can upload images through the authenticated media pipeline.
- Allowed published pages to load media from approved cross-origin sources without being blocked by the generated Content Security Policy.

### Content and publishing

- Resolved custom media fields to usable URLs when rendering collection rows in loops.
- Reused the full schema composer when creating content collections, bringing collection setup in line with custom data-table creation.

## 0.0.15 - 2026-08-11

### Collaboration, AI, and integrations

- Added real-time collaborative editing with continuous CRDT persistence, per-document undo, reconnect recovery, generation-aware resets, transport health checks, and clear user feedback when an edit cannot reach the relay.
- Adopted the stateless MCP protocol and hardened authoring so connector writes wait for a writable editor, preserve authored structure, and cannot report changes that were never persisted.
- Made AI colour-palette installation atomic so complete token batches land together or fail visibly.

### Editor and data

- Added hover previews to Site explorer rows and a **Used** filter to the Selectors panel.
- Let every floating editor panel clear docked sidebars, polished context menus and data-binding controls, and rebuilt shared tabs with consistent keyboard and ARIA behavior.
- Protected mandatory post-type title and slug fields from destructive table updates and repaired those fields when an earlier update removed them.

### Publishing and runtime

- Surfaced runtime-script build diagnostics in the Code editor and publish flow so authored script failures identify the affected file and source location.
- Made collaborative persistence and publishing deterministic across resets, imports, route rosters, selector styles, and site-document ordering.
- Scoped entry-route runtime assets to the template that renders them and stopped author bindings from exposing internal user objects or account email addresses.
- Prefetched resolved media metadata for bound images so published output includes accessibility text, responsive variants, and intrinsic dimensions.
- Made published routes answer `HEAD` like `GET`, allowing uptime monitors and link checkers to recognize healthy pages.

### Import reliability

- Scaled large CSS catalogue imports and reported invalid, unresolved, empty, or unsortable loop definitions instead of silently publishing missing or incorrectly ordered content.

## 0.0.14 - 2026-07-25

### Security

- Fixed a URL-scheme filter bypass in `isSafeUrl()` ([GHSA-pqcp-872g-gmp8](https://github.com/CoreBunch/Instatic/security/advisories/GHSA-pqcp-872g-gmp8)). The guard normalised input with `String.prototype.trim()`, which does not strip U+0000–U+0008 or U+000E–U+001F, while browsers strip the whole U+0000–U+0020 range before reading a URL scheme. A `javascript:` URL behind a leading control character was therefore reported safe and emitted verbatim into `href` / `src` / `action` attributes. Reported by [@overgrowncarrot1](https://github.com/overgrowncarrot1).
- Replaced the three-entry scheme denylist with an allowlist (`http`, `https`, `mailto`, `tel`, `sms`, plus all relative forms) read through a scheme extractor that follows the WHATWG stripping rules, so the guard cannot disagree with the browser that resolves the value.
- Consolidated three divergent URL guards into one. The plugin-SDK `safeUrl` was a weaker copy that a plain leading space defeated and that never blocked `data:` at all; the editor input gate now shares the same scheme extractor. An architecture test fails the build if a fourth copy appears.

## 0.0.13 - 2026-07-24

### Editor, import, and publishing

- Added a dedicated Page settings dialog so authors can edit page slugs directly.
- Restored contrast for editor switches and canvas mode controls.
- Preserved node inline styles in image previews and hid empty canvas chrome for ambient style rules.
- Rendered imported SVG sizing and presentation styles on the canvas root so editor previews match published output.
- Preserved safe SVG fragment references through Super Import, editor rendering, and publishing so circular text paths remain visible and animated.

### Platform and maintenance

- Updated Sharp to its patched release.
- Restored function-level coverage reporting for Fallow health checks.

## 0.0.12 - 2026-07-24

### AI and integrations

- Redesigned AI provider settings around clearer provider and connection management.
- Added OAuth authorization for MCP connectors, including scoped authorization, token lifecycle handling, and hardened protocol validation.

### Editor, content, and publishing

- Rendered loop output in page preview so preview mode matches authored loop content.
- Preserved in-progress decimal values in number controls instead of replacing valid partial input while editing.
- Kept responsive admin navigation aligned to the left at narrow widths.
- Fixed new custom data tables retaining their selected table kind instead of always becoming plain data tables.
- Fixed composed templates so published pages, entries, and entry previews use the rendered page or entry title rather than the wrapping template title.

## 0.0.11 - 2026-07-11

### AI and integrations

- Added multi-image AI conversations with paste and picker flows, compact galleries and previews, private history persistence, model capability checks, and optional Save to Media actions.
- Added a compact context meter with remaining-context, token, cache, cost, and model-pricing details.
- Made render snapshots faithfully capture authored backgrounds and breakpoint-specific layouts without changing the visible canvas state.
- Expanded `site_apply_css` with explicit merge, replace, property-removal, and delete operations, preserved `!important` priorities, and an Anthropic-compatible provider schema.
- Expanded MCP connectors with headless document listing, scoped Site and Content workspace bridges, and explicit capability-gated publishing after saved draft edits.

### Editor, content, and publishing

- Added a light admin theme and UI text-size preferences alongside the existing density setting.
- Added editors for custom content fields, including structured, media, and relation values, directly in the Content settings panel.
- Added middle-mouse canvas panning and improved Layers visibility, scrolling, and empty-container presentation.
- Derived font-weight choices from installed variants, tolerated malformed stored font settings, and fixed stale selection or focus after undo, redo, and assistant-panel interactions.

### Import and publishing

- Imported YouTube iframes and HTML `<video>` elements as native Video modules, preserving playback and accessibility settings.
- Optimized media-library background images into responsive variant fallbacks and `image-set()` output in both the editor and published CSS.
- Made whole-site saves transactional with explicit deletes and a serialized save queue, preventing partial or interleaved saves before publishing.

### Security and data safety

- Hardened custom HTML attributes and tags against stored script injection by rejecting dangerous URL schemes, `srcdoc`, and unsafe embedded elements.
- Applied shared magic-byte, MIME, extension, SVG-sanitization, traversal, and reserved-path validation to JSON and archive media imports.
- Added `base-uri 'self'` and `object-src 'none'` to the admin Content Security Policy.

### Platform and reliability

- Fixed Postgres JSON text-column hydration and made static publish-slot swaps reliable on Windows.
- Made Windows development startup use the active Bun runtime with safer Vite launching and stale-port recovery.
- Recovered interrupted AI browser-tool turns as terminal, retryable failures instead of leaving conversations stuck or replaying malformed history.
- Cleaned up disconnected MCP, editor, and plugin streams and bounded orphaned connection lifetimes so abandoned connections cannot exhaust the development proxy.

## 0.0.10 - 2026-07-01

### AI and integrations

- Added an OpenAI-compatible AI provider for custom base URL endpoints.

### Import, editor, and publishing

- Fixed imported module scripts so their npm dependencies install correctly.
- Aligned canvas and Layers panel keyboard shortcuts.
- Let modules declare Content Security Policy sources, so published `base.video` YouTube embeds render correctly.
- Fixed empty-folder explorer operations so they apply without showing the "0 paths" dialog.

## 0.0.9 - 2026-07-01

### AI and integrations

- Redesigned the AI assistant panel message stream: agent tool calls render as compact rows with a per-tool icon, a human-readable label, and status, with consecutive calls grouped under one turn.
- Added inline previews to tool calls — colour-token swatches for palette updates, and the captured screenshot for render-snapshot.
- Auto-titled conversations from the first prompt instead of "New conversation", and gave each message turn an avatar and a relative timestamp.
- Fixed the AI panel dropping the selected model when starting a new chat, and surfaced conversation delete/load failures as toasts.

### Editor and framework

- Added a body context menu when right-clicking empty space on the canvas.

## 0.0.8 - 2026-07-01

### Editor and framework

- Unified Core Framework management into one tabbed panel with a declarative Full / Variables / None manager.
- Consolidated Layers, Site, Code, and Media into one Explorer panel, including a dedicated Code tab and refreshed media browsing.
- Added canvas support for dragging media assets directly from the Media workspace.
- Fixed onboarding framework import defaults and retained pending site reloads so imported framework changes appear in the editor without a hard refresh.
- Fixed canvas mouse-wheel behavior so normal wheel scrolling stays vertical and Shift+wheel pans sideways.
- Kept the highlighted Spotlight result scrolled into view during keyboard navigation.

### AI and integrations

- Made AI token tools more tolerant of model-authored argument aliases for framework typography and spacing updates.

### Security

- Added central security response headers for admin and upload routes.
- Revalidated and sanitized imported archive media, including SVG payloads, before writing them to disk.
- Added expiry timestamps for MCP connector tokens, with existing tokens backfilled to a 90-day grace period.

## 0.0.7 - 2026-06-29

### AI & integrations

- Added MCP connectors so external AI clients can use the CMS tool surface through scoped connector tokens.

### Design and onboarding

- Imported Core Framework defaults from onboarding so new sites start with the selected design system values in place.

### Security

- Hardened sanitizers and regular expressions flagged by CodeQL.

### Documentation and deployment

- Replaced the README hero screenshot with a YouTube-linked introductory video thumbnail.
- Added README guidance explaining that image-based installs update by redeploying the latest image.

## 0.0.6 - 2026-06-26

### AI & agent tooling

- Added runtime code asset tools for agents so generated or edited runtime assets can be managed through the same agent workflow.

### Site import, export, and transfer

- Fixed site export downloads in environments where blob-backed responses were unreliable.
- Streamed site transfer bundles and unified the import review flow around the transfer archive path.
- Reused the CMS media client across site import code paths.

### Templates, content, and publishing

- Fixed dynamic data resolution inside outlet previews.
- Stopped auto-creating post type templates; entry templates are now explicit pages users create and assign.
- Hid the empty content settings panel until an entry is selected.

### Editor and admin

- Split non-site workspace layout state from the site editor layout.
- Fixed Spotlight layer commands to operate on the active canvas tree.
- Removed circular admin dependencies and restored lazy HMR loading.
- Simplified admin color token vocabulary and added fluid typography and spacing token scales.

### Quality

- Reused page-tree traversal selectors in form analysis.
- Expanded feature validation coverage across the admin, server, and architecture gates.

## 0.0.5 - 2026-06-17

### AI & agent tooling

- Added document-targeted site agent tools for pages, templates, and Visual Components: `list_documents`, `read_document`, and `open_document` replace the page-only read surface.
- Loop authoring now routes through the HTML import path and gives agents valid loop-source field tokens before they bind dynamic content.

### Content, data, and export

- Split system-table and custom-table capabilities, and locked system table identity while still allowing safe custom field edits.
- Routed collection create, update, and delete through step-up authentication.
- Added a granular full-site export dialog with Cmd+K access and server-accurate export size estimates, including media.
- Fixed Content Outlet rendering so current-entry bodies render in any content outlet.

### Editor and canvas

- Made the Settings modal and toolbar trailer global instead of editor-panel scoped.
- Made saved layouts the single source of truth.
- Rendered `base.text` with `tag: none` as bare text on canvas to match the published DOM.
- Rewrote the GitHub README with deeper product and self-hosting detail.

## 0.0.4 - 2026-06-13

### Editor & canvas

- Inline text editing on the canvas — double-click any text node to edit it in place, byte-identical to the published element.
- User-saved layouts: save any subtree and re-insert it exactly elsewhere.
- Double-click a row in the explorer / DOM panels to rename it.
- Design mode now opens at 50% zoom; live mode is pinned to 100%.
- Live mode shows the shared frame skeleton while hydrating, and the template read-only hint/open action is scoped to template chrome rather than page content.
- Removed inconsistent panel keyboard shortcuts from the rail.
- Fixed template-preview fidelity: composed read-only content (template chrome, outlet previews, inlined Visual Components) now carries each node's inline styles, matching the published page.

### Publisher & media

- `<img sizes>` is now derived automatically from the layout — the manual Sizes field is gone, and lazy images use the standards-based `sizes=auto` with a layout-resolved fallback.
- Responsive images never serve multi-MB originals to retina screens: `srcset` is built from variants only.
- Single class-CSS emission engine shared by publish and canvas, and one-way publisher layering (repositories never import the publish layer).
- Per-module published-JS channel; the form runtime now rides it.

### Templates & content

- Added a "Not found" template target for designing 404 pages.
- Content Outlet availability fixes and toast layering; closed outlet invariant holes.
- Roster saves now survive slug handoffs (homepage swap, swaps, revivals).

### Site import

- Refactored the Super Import pipeline into one adapter contract with a phase-decomposed plan/commit flow and deduped helpers; conflict resolution split into named concerns.
- Improved import fidelity: rgba color tokens, import-from-anywhere, and engine-proof `var()` / `env()` declarations at the import boundary.

### AI & plugins

- AI tools now inherit the caller's capabilities — `ai.chat` no longer acts as a blanket read grant, and write tools require `ai.tools.write`.
- AI credential auth is derived from the provider.
- Plugin performance: handle-based VM dispatch, native base64, and indexed content-API lookups; fixed `useCanvasNodeRect` to measure real canvas nodes.

### Admin & performance

- Unknown admin URLs (typos, stale deep links, `/admin/login`) now redirect to the dashboard — showing the login form when signed out — instead of rendering a blank page. Public-site 404s keep their own handling.
- Incremental site saves with runtime builds hoisted out of the publish transaction, plus hot-path fixes across the publish pipeline, public serving, and the editor store.
- Dead-code cleanup across the codebase (knip reports zero unused surface).

### Infrastructure

- Standardized container images on GHCR and dropped the Docker Hub mirror.

## 0.0.3 - 2026-06-10

- Hardened the plugin QuickJS sandbox against hangs: interrupt deadlines on plugin-source and timer execution, a host-side worker RPC timeout, and preserved VM stack traces in server logs.
- Made plugin `fetch` and plugin HTTP routes binary-safe end to end (byte-exact request/response bodies, including multipart uploads).
- Plugin settings saved in the admin UI (or via `settings.replace`) now propagate to the running plugin VM immediately, without a reload.
- Fixed plugin scheduler correctness: schedule cancellation, pause persistence across restarts, no firing for disabled plugins, and a sweep for orphaned schedules.
- Plugin-emitted hook events are now namespaced to `plugin.<id>.*`, so a plugin can no longer forge core or other plugins' events.
- Required a dedicated `editor.code` permission for unsandboxed admin-window plugin code, and the install review dialog now always shows.
- Secret plugin settings are masked on every client-facing payload and encrypted at rest in a dedicated `plugin_secrets` table using `INSTATIC_SECRET_KEY`.
- Added a force-uninstall escape hatch for plugins with failing lifecycle hooks, and run `deactivate` before `uninstall`.
- Decoupled the CSRF origin check from proxy trust: it now uses `PUBLIC_ORIGIN` (auto-detected from `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN` on managed platforms), and `TRUSTED_PROXY_CIDRS` is now used only for client-IP attribution. Removed blanket `0.0.0.0/0` proxy trust from the deploy templates.
- Refreshed deployment docs and one-click templates (`TRUSTED_PROXY_CIDRS`, `PUBLIC_ORIGIN`, `RAILWAY_RUN_UID`, template-generated `INSTATIC_SECRET_KEY`).
- Fixed the data-table step-up authentication flow and revamped the README.

## 0.0.2 - 2026-06-09

- Added public repository community files and contribution workflow docs.
- Tightened forwarded-origin handling so `X-Forwarded-Proto` and `X-Forwarded-Host` are trusted only from configured proxy peers.
- Added Render deployment blueprints and refreshed public deployment docs.
- Improved static site import fidelity, including imported runtime behavior and CSS cascade isolation.
- Added editable HTML attributes and path-derived Site Explorer organization.
- Hardened plugin media handling, public forms, AI credential storage, and MFA secret encryption.

## 0.0.1 - 2026-06-08

- First public preview release.
- Self-hosted Bun CMS server with SQLite and Postgres support.
- React admin UI with visual site editor, content/data/media workspaces, publishing pipeline, and plugin runtime.
- Docker image, Compose files, release bundle, and Railway/Render/VPS deployment docs.
