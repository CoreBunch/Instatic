# Email

The Email workspace (`/admin/email`): the connectors the server sends mail through, who its mail is from, the wording of each email, and the delivery log.

This is the path for mail the core sends itself (account emails, tests). It is built to be the base for broadcasts and autoresponders later; neither exists yet.

---

## TL;DR

- **Connectors** are accounts mail is sent through. Six kinds: four **one-key** providers set up with a single API key (**Resend**, **Postmark**, **Mailgun**, **Brevo**), **Amazon SES**, and **SMTP** for any other mail server. No provider SDKs: SMTP goes through `nodemailer`, every other kind is one HTTPS request. The HTTPS kinds also work on hosts that block the SMTP ports.
- **Defaults** choose the one connector the site sends through, plus the sender name, sender address and reply-to.
- **Templates** are a subject and a Markdown body with `{variables}`, edited in place in the post editor (`TiptapBodyEditor`) with the same Write / Live switch as a post. Only edited templates are stored; the built-in wording lives in code.
- **Activity** is the delivery log: per-period totals and a volume chart, search and filters, and a detail panel for each email.
- **Two entry points:** `queueTemplateMail(db, { key, to, variables })` in `server/mail/delivery.ts` for every email nobody is waiting on (it is queued, sent by a worker, retried), and `sendSiteMail(db, mail)` in `server/mail/send.ts` for the admin's own tests, which send now and report the answer.
- **Three delivery modes**, decided when an email is accepted:

  | Mode | When | What happens |
  |---|---|---|
  | `send` | a default connector and a sender address are set | queued (`queued`), then sent through it; logged `sent` or `failed` |
  | `capture` | they are not, and `NODE_ENV` is not `production` | written to Activity with its body; nothing leaves the machine |
  | `off` | they are not, in production | throws `MailNotConfiguredError` |

- **Secrets are write-only.** An SMTP password or AWS secret key is encrypted with the master key (`server/secrets/`) and never returned by any endpoint.
- **Message bodies are never logged.** `mail_outbox.body_text` is filled only for `captured` rows, which only a development server writes. Bodies carry live sign-in and reset links.
- **Capability:** `mail.manage` (Owner, Admin). Adding or removing a connector, replacing its secret, changing the defaults and editing a template also need step-up.

---

## Where the code lives

```text
src/core/mail/
├── schemas.ts                 — TypeBox wire shapes (@core/mail)
└── templates.ts               — template catalogue + renderMailTemplate (server and admin preview)
server/mail/
├── connectors.ts              — mail_connectors: CRUD, secret encryption, resolve for one send
├── defaults.ts                — the mail_settings row
├── templates.ts               — mail_templates: owner edits over the catalogue
├── smtpDriver.ts              — SMTP delivery, address guard, From header
├── sesDriver.ts               — Amazon SES v2 SendEmail, Signature Version 4
├── apiDrivers.ts              — Resend, Postmark, Mailgun, Brevo: one POST each
├── activity.ts                — mail_outbox (2000 newest rows kept per sender)
├── send.ts                    — one delivery attempt (carryThroughConnector), sendSiteMail, delivery mode
├── queue.ts                   — mail_queue: enqueue, claim, reschedule, remove; payload encryption
├── delivery.ts                — queueTemplateMail, the worker (drain, retry schedule, start / wake / stop)
└── outcomes.ts                — what became of a queued email, told to the plugin host (reason codes)
server/handlers/cms/mail.ts    — /admin/api/cms/mail/* routes
src/core/persistence/cmsMail.ts
src/admin/pages/email/         — the workspace: EmailPage + tabs/{Connectors,Defaults,Templates,Activity}Tab
src/admin/shared/SettingsWorkspace/ — shared settings forms and connector controls
```

## Connectors

A connector row holds a `kind`, a public `config_json` and one encrypted secret.

| Kind | Config | Secret |
|---|---|---|
| `smtp` | `host`, `port`, `username` | password (may be empty for an open local relay) |
| `ses` | `region`, `accessKeyId` | secret access key |

`resolveConnector` is the only function that decrypts a secret. `toView` is the only projection that leaves the server. The first connector added becomes the default automatically.

**SMTP connection rules** (`smtpDriver.ts`), the same guard as plugin outbound requests:

- The hostname is resolved once. **Every** DNS answer must be a public address (`isBlockedAddress`), and the socket is pinned to the validated IP while TLS still verifies the original hostname.
- Port 465 uses implicit TLS. Every other port must upgrade with STARTTLS before authenticating.
- An IP literal is rejected as a host.
- `MAIL_ALLOW_PRIVATE_HOSTS=1` lifts the public-address rule and makes STARTTLS opportunistic, for a relay on the same machine or network. It is an environment variable, not an admin setting: only someone who can already configure the server can point mail at the internal network. The connector form names the variable only when the typed host reads as local (`looksLikeLocalMailHost`: no dot, a local-only suffix, or a private IPv4 address); the server's refusal names it in every case.

**SES** (`sesDriver.ts`) posts to `email.<region>.amazonaws.com`. The region is validated against a strict pattern when the connector is saved, so the host is always an AWS one. `signAwsRequest` is tested against AWS's published Signature Version 4 example.

**One-key providers** (`apiDrivers.ts`) each post to a host named in the code: `api.resend.com`, `api.postmarkapp.com`, `api.mailgun.net` or `api.eu.mailgun.net`, `api.brevo.com`. Resend, Postmark and Brevo store an empty config and the key as the secret. Mailgun also stores its sending `domain` and `region`; the domain is validated as a hostname when saved and percent-encoded into the request path, so it can never change the host. An API key must be a single line, since it travels in a header.

Adding a kind is one entry in `MAIL_CONNECTOR_KINDS` and `MAIL_CONNECTOR_CONFIG_SCHEMAS` (`src/core/mail/schemas.ts`), a branch in `carryMail` (`send.ts`), and a spec in `src/admin/pages/email/connectorCatalog.ts`. No migration: `mail_connectors.kind` is free text and a stored row whose kind or config is not recognised is skipped.

**In the admin** (`src/admin/pages/email/tabs/ConnectorSetup.tsx`), a one-key connector asks for a name (pre-filled) and the key. The SMTP form starts with a picker of well-known services (`SMTP_PRESETS`: Google, Microsoft 365, SendGrid, Zoho Mail) that fills in host and port and explains what the login is, or "Other server" for a blank form. Marks show the provider's logo (`ConnectorMark`, monochrome SVG masks in `assets/`, from the simple-icons set like the AI provider logos); a connected SMTP server shows the logo of the preset its host belongs to.

Delivery errors reach the admin as a sentence built here (`describeSmtpFailure`, `describeSesFailure`, `describeFailure` in `apiDrivers.ts`). The credentials and the message never do. SMTP and SES never pass on the provider's own text; a one-key provider's own reason is appended only when it is one short line, since that is what names the address or domain to fix.

## Templates

A template definition (`MailTemplateDefinition`) has a `key`, a label, a group, its variables with sample values (the two site variables, `site.name` and `site.url`, carry none), and the built-in subject and body. Features add theirs with `registerMailTemplate` at module load, and a loaded plugin's are added and removed with it (below); `mail.test` is the only one this module registers.

Each template has a **Sending** switch in Email → Templates. All templates start on, including new plugin templates. Turning one off takes effect immediately for automatic and test sends. It also removes waiting messages for that template from the queue. Activity records those cancellations, and a message already being handed to the provider can finish. Turning sending back on allows new requests. The switch is stored by template key in `disabled_mail_templates`, independently of edits to the wording. Resetting the wording or upgrading the plugin preserves the setting for each retained key.

`renderMailTemplate(template, variables)` returns `{ subject, text, html }`:

- The body is rendered from Markdown to HTML with the variables still in place, then sanitized (`sanitizeToFragment` with `MAIL_BODY_CONFIG`) to the elements Markdown produces. Raw HTML in a template cannot add a form, a script, a frame, a style or an event handler, and no attribute that takes an address survives except a link's `href` and an image's `src`.
- The rules are applied to that **parsed tree** (`readTree`), never to markup as text, so quoting, entities, case and whitespace in a template cannot be read one way by the rule and another by the mail client. Any attribute holding a `{`, other than a link's `href` or an image's `src`, is removed.
- The address rule (`resolveAddress`): a variable is honoured only when it is the **whole** address (`[Confirm]({link})`) and its value is an `http(s)` address. An address that merely contains a variable (`https://elsewhere.example/?t={link}`) becomes `#`: that shape would hand a member's single-use link to another server. An address written out must be `http(s)` (or `mailto:` on a link).
- The HTML part and the plain-text part are one reading of the tree: `readTree` returns the body as the pieces of its plain text (text nodes, line breaks, an image's alternative text, a link's address in brackets after its words), `fillPieces` puts the values into that one string, and the HTML's text nodes are those same pieces.
- **Variables have a kind** (`MailTemplateVariable.kind`, `text` by default). A `link` is an address; `text` is anything else. A `link` variable, and any value that turns out to be an address, follows the stand-alone rule; `text` may sit anywhere in a sentence (`Ticket #{id}`, `{name}'s`). `site.*` is exempt.
- **The stand-alone rule** (`standsAlone`). Mail clients link addresses in plain text themselves, with or without a scheme. So a link is put into text only where it stands alone: within its run of non-space characters there is only opening punctuation `("'` before it and closing punctuation `.,;:!?)"'` after it. Only ASCII whitespace separates, and only block elements and `<br>` add any: an image, a link and every other inline element put nothing between the text on either side of them. Two more things do not separate: a line break inside a paragraph when the text on the other side of it reads as an address, and anything between a `<` and its `>`. The body is read two ways, as the plain-text part and as the HTML part is displayed (without the link addresses only the text part adds), and a link must stand alone in both. `elsewhere.example/{link}`, `user@{link}`, `Link:{link}`, `<{link}>` or a zero-width space before the variable all leave it as written. The subject follows the same rule. `unmark` checks the finished text once more. `renderMailTemplate` returns the names it left unfilled as `refused`.
- **Every variable the wording uses must be given.** `renderMailTemplate` returns, as `missing`, the declared variables its wording uses that have no value (an empty `link` counts as none; an empty `text` is a value). `buildTemplateMail` throws `MailVariableMissingError` when an email is asked for that way, for the core as for a plugin (`variable_missing:` from `api.cms.mail.send`), so nothing is queued. At delivery, where the wording may have changed since the email was accepted, the built-in wording is used if it renders completely, with a note in Activity; otherwise the email fails as `template_invalid`. A variable passed that the template does not declare is refused for a plugin and ignored for the core.
- **In a plugin's template a text value is also checked where it lands** (`composesAddress`): the run of characters around it is checked with the actual value in place, so a value such as `.example` or `evil.` cannot finish an address the template's text began; such a send is refused as `template_invalid`.
- **An email is never sent with a variable left in it.** `buildTemplateMail` (`server/mail/send.ts`) renders the owner's wording; if that leaves a variable unfilled it renders the built-in wording instead and sets a note ("Your wording was not used: {link} must stand alone. The built-in wording was sent."), which Activity shows on the sent email. If the built-in wording fails too it throws `MailTemplateInvalidError`: nothing is queued, and an email already queued fails with reason `template_invalid`. Saving a wording that fails is refused (`mailWordingProblem`, also the reason the editor's Save is disabled). An edit stored before this rule is flagged in the template picker ("Not used", `MailTemplate.wordingProblem`) and named in the server log at start (`listUnusableTemplateEdits`).
- **Values are held to their kind when a plugin sends** (`mailValueProblem`). The value is sent as written with only zero-width and direction marks removed (`cleanMailValue`); nothing visible is rewritten, and `site.*` values are not touched at all. For the address check alone it is read folded (`foldedForCheck`: NFKC, ideographic full stops made `.`, an ellipsis `…` or a row of dots made a space, since it ends a word). A `link` value must be an `http(s)` address. A `text` value is refused when it contains a control character, `://`, `www.`, an `@` between two non-space characters, a `.` or `:` with a non-space character on both sides unless both are digits, four dotted numbers or `::`, or a `/` or `\` with a non-space character on both sides. So `O'Brien`, `Dr. Smith`, `#1042`, `€12.50`, `v1.2` and `12:30` pass, and `evil.example`, `a.b`, `10.0.0.1`, `host:8080` and `and/or` do not. The rule is deliberately one simple test, so it has false positives: `node.js` or `e.g.` as a value is refused, and a plugin author writes such text into the template's wording instead. In a plugin's template a `text` variable may also not touch another variable, or template text the same rule would refuse (`{a}.{b}`, `www.{name}`, `shop.example/{id}`); the manifest parser and the lint refuse such a template.

**Threat model for values.** A member's single-use link (confirm, reset, sign in, invite) exists only in the core's templates. It is a `link` variable, and the stand-alone and whole-address rules above, applied to the one parsed tree both parts of an email are read from, are what keep it from reaching another server. A plugin's template never receives such a link. What remains in plugin email is a plugin the owner installed and gave `mail.send` using a value to put a clickable address into wording the owner approved: phishing by a malicious plugin. The `text` value rule is a best-effort barrier against that, not a guarantee, and reports of further patterns that slip past it are weighed against this model. The rule is not applied to the core's own values (a core template's `{email}` is an address by design); there, a value that is an address must stand alone, as a link must.
- A **plugin's** template (key `plugin.<id>~<key>`, and the owner's edit of it) is held to a stricter profile: no images at all, because an image is fetched from its server when the email is opened, and a link written out in the template must be `https`.
- Subject values are forced onto one line.
- **Braces around a word are reserved.** Every `{name}` in a subject or body must be one of the template's declared variables, or `site.name` / `site.url`. Anything else (a typo, a variable an upgrade removed) is reported by `renderMailTemplate` as `unknown` and treated like a link that does not stand alone: the editor and the save route refuse it, a stored edit that has one is flagged (`wordingProblem`) and replaced by the built-in wording when an email is sent, with the note in Activity. To write braces that are not a variable, put a backslash before the opening one: `\{name}` is sent as `{name}`. A value is never read for variables: a value that is itself `{link}` is sent as those characters.

In the admin (`tabs/TemplatesTab.tsx`) a template opens in **Live** mode: the subject and body are edited inside a card styled like the sent email (`.emailCard`, coloured by the `--email-preview-*` tokens), so there is no separate preview pane. **Write** is the bare editor surface. The switch is the post editor's `ContentModeToggle`; "Insert variable" puts a `{name}` into whichever of the two fields was focused last. The editor runs without media (`onPickMedia` omitted), which hides the image options of the floating and slash menus.

"Send test" in the header opens a dialog that shows the email rendered by the same `renderMailTemplate` with each variable's `sample`, so the dialog is what is sent. For `site.name` and `site.url` the server puts the site's real name and public address into `sample` when it reads a template (`toTemplate` in `server/mail/templates.ts`, from the same `siteMailVariables` a send uses), so the editor, the footer and the dialog show the real ones; only per-recipient variables preview with made-up values. Sending is disabled until unsaved edits are saved, because the server sends the stored template. On a connector the test send and the secret replacement are dialogs too. A template test (`POST …/templates/:key/test`) also uses sample values for per-recipient variables, never real ones, so a test cannot mint a working link.

## Activity

`recordMail` (`server/mail/activity.ts`) writes one `mail_outbox` row per email (`updateMailProgress` brings a queued email's row up to date after each attempt): template key (`kind`), recipient, subject, status, the connector's label at the time, the safe error sentence, how long the hand-over took (`duration_ms`) and the id the provider answered with (`provider_message_id`: the SES `MessageId`, or nodemailer's `messageId` for SMTP). The newest 2000 rows are kept **per sender** (the core, and each plugin on its own), so a plugin that sends a great deal cannot push the site's own sign-in email out of the log. A row whose email is still queued is never pruned. A plugin's row also stores the plugin's name as it was when the email was accepted (`source_label`), shown as "Sent by" in the details and kept after the plugin is uninstalled.

`listMailActivity(db, filter)` reads the whole log without bodies and does the work in memory, so search, day buckets and totals are identical on both dialects:

- **Period** (`24h`, `7d`, `30d`, `all`). `24h` is the last 24 hours in hourly buckets. The others are whole calendar days in the viewer's time zone (`tz`), so "7 days" is today and the six days before.
- **`totals`, `buckets`, `lastFailure`, `kinds`, `connectors`** describe the whole period. `status`, `kind`, `connector` and `q` (recipient or subject) only narrow `entries` and `matching`.
- **Paging:** 50 entries a page; pass the last entry's id as `before`.

`queued` is an email that has not left. With no `error` it is waiting its turn. With an error and a `nextAttemptAt` it is being retried after a temporary failure. With an error and no `nextAttemptAt` it is held because the connector refused the account. `waitingError` in the response is the newest such error, for the Waiting tile. `sent` means the provider accepted the message. Bounces and spam filtering happen after that and are not known here; the detail panel says so. `failed` is final: the provider judged the message, its deadline passed, or it could not be queued at all.

The four Email tabs share a section header. Connectors groups connected accounts and available providers above the selected form. Defaults places the saved delivery status beside the sender form. Templates lists all available templates by source in a searchable sidebar beside the editor. At phone widths a grouped picker above the editor keeps the same selection. Activity (`tabs/ActivityTab.tsx`) opens on a searchable delivery table. Selecting an email opens its details in the directory inspector, which becomes a drawer on narrow screens. Overview shows the selected period’s totals and volume chart in individually rounded tiles with a one-pixel gap. From a failure it links to Connectors; from a template's email it opens that template.

## Plugin templates

A plugin declares its emails in its manifest (`mail.templates[]`) and can send nothing else; see [plugin system](plugin-system.md) → Email. They are in the catalogue as `plugin.<pluginId>~<key>` while the plugin is installed and enabled. `syncPluginMailTemplates(db)` (`server/mail/pluginTemplates.ts`) brings the catalogue in line with `installed_plugins` after every install, upgrade, enable, disable and uninstall, and at boot. It replaces one plugin's set at a time (add and replace first, then drop what is no longer declared) and never clears the catalogue to refill it, so reloading the plugins, which every uninstall and upgrade does, leaves no moment at which another plugin's template is missing. The templates are edited, previewed and tested like any other; the edit is stored under the same key, survives an upgrade, is deleted when an upgrade drops its template, and is deleted with the rest by `removePluginMail` on uninstall.

A plugin's email is queued with `source` set to the plugin's id and `lane` 1. Three limits apply (`server/mail/limits.ts`): 20 emails from one plugin to one recipient within a clock hour, 200 emails from one plugin to addresses (not members) within a clock hour, and 10,000 of one plugin's emails waiting. Each is a row in `mail_counters` raised by one conditional update (`set count = count + 1 where count < limit`) inside the transaction that accepts the email, so concurrent sends, on one instance or several, cannot exceed it, and a refused or failed acceptance gives its places back with the rollback. `removeQueuedMail` lowers the backlog count in the transaction that deletes the queue row. The per-recipient count is keyed by how the plugin named the recipient (`member:<id>` or `to:<address>`), never merged, so a refusal cannot reveal a member's address. An address is counted as written, lower-cased: aliases of one inbox (`a+1@…`, dots in a Gmail name) count apart, which the 200 an hour for all addresses bounds. When the plugin named a member, `mail_queue.member_id` records it, and the outcome names that member and never the address the host looked up.

What the queue does with a plugin's email that it cannot simply send (`attemptQueuedMail`, `discardQueuedMail` in `server/mail/delivery.ts`):

- **Its template is not in the catalogue.** If the plugin is still installed and its manifest declares the template (the plugin is disabled, or is being reloaded), the email waits and is retried like a temporary failure, until the plugin is back or the email's deadline passes. Only when the plugin is gone, or an upgrade dropped the template, does it fail (`template_removed`).
- **Its member is no longer active.** A member send is checked again at delivery: a suspended or deleted member is not written to (`recipient_unavailable`). Deleting a member also takes their waiting email out of the queue at once (`discardQueuedMailForMember`).
- **Its plugin is uninstalled.** `removePluginMail` takes the plugin's waiting email out of the queue in one transaction and logs each as failed. An email a worker has claimed at that moment is left to that worker and is logged as what became of it.

A failure reaches the plugin as a `MailFailureReason` code (`recipient_rejected`, `expired`, `template_removed`, `template_disabled`, `unreadable`, `recipient_unavailable`, `template_invalid`); the provider's sentence stays in `mail_outbox.error`, which only the admin reads. `setQueuedMailOutcomeHandler` tells the plugin host what became of each such email, which it passes to that plugin alone as `mail.delivered` or `mail.failed`. If the plugin is not listening at that moment (it is disabled or being reloaded), the news is held in memory, up to 500 per plugin and for at most a day, and handed over when the plugin next subscribes; a server restart in between loses it, and the Activity log still has the outcome. Delivery to a listener is at most once: news emitted to a plugin whose sandbox is torn down before the listener ran is not sent again. News belongs to the install that queued the email: every install has a random id (`installed_plugins.install_id`, given by `ensurePluginInstallId` when it first sends), each email it queues carries it (`mail_queue.install_id`), and an outcome is delivered only when the two match. No clocks are compared. Held news is cleared on uninstall and on a fresh install, so a plugin id that is installed again hears nothing of its predecessor's email. A plugin's email has the default one-day deadline.

## The queue

`queueTemplateMail` renders the template once (to prove it exists and to give the log its subject), encrypts the variables, then writes the `queued` activity row and the `mail_queue` row in one transaction, wakes the worker and returns. The request that asked for the email never waits for a provider. Encryption happens before the transaction opens: on SQLite's one shared connection nothing that can fail for its own reasons belongs inside a `BEGIN`.

A `mail_queue` row holds the template key, the recipient, `source` (`core`, or a plugin id), `lane`, `deliver_before` and the variables. The variables are encrypted with the master key (`payload_ciphertext`, `payload_iv`), because they carry live links, and the row is deleted as soon as the email is sent or given up on. The email is rendered again at each attempt, so it leaves with the wording of that moment.

**Deadlines.** Every email has a `deliver_before`, passed as `deliverBefore`: the expiry of the link it carries (`queueMemberMail` uses the token lifetimes in `server/members/tokens.ts`: 15 minutes for a sign-in link, an hour for a reset), or `MAIL_DELIVERY_WINDOW_MS` (a day) for mail without one. The worker never sends past it, nor within its last minute (`DELIVERY_MARGIN_MS`): a link with seconds left is no better than an expired one. An email whose deadline has passed or is that close, or whose next retry would fall there, is failed with "Not sent: the time in which this email was of use ran out…" and its last error. A member is still told to check their inbox (the response must not depend on delivery); the owner sees the failure in Activity.

**The worker** (`startMailQueue` at boot, `stopMailQueue` on shutdown) drains the queue on a wake and on a 15-second tick:

- One email at a time, 100 ms apart, ordered by `lane` (0 = core, always first), then emails not tried yet before retries, then due time, then acceptance order. A fresh sign-in link is never behind a stack of retries.
- **No lock between workers.** A row is claimed with one conditional update (`update … set claimed_at … where id = … and claimed_at is null`), so any number of instances on one Postgres database drain side by side and none takes an email another has. The worker deliberately does not use `withSchedulerLeaderLock`: that helper takes a session-scoped advisory lock through a pooled client, so the unlock can run on another connection, leave the lock held and stop a second instance from ever draining. (The helper's other callers are not changed here.)
- Each driver marks its `MailDeliveryError` with `retry`. An HTTP driver reads the provider's own error body first (`classify…Error` in `apiDrivers.ts`, `retryForSesError`) and falls back to the status (`retryForHttpStatus`). A bare status is not trusted to mean the account: one visitor giving an address the provider refuses must never pause everyone's mail.

  | `retry` | Means | What the worker does |
  |---|---|---|
  | `never` | the provider judged this message or this recipient: SMTP 5xx, an HTTP 4xx, Postmark `ErrorCode` 300 / 406 / 412, Mailgun's "authorized recipients" sandbox refusal, SES `MessageRejected` | fails it |
  | `later` | this message's or this moment's trouble: unreachable, a 5xx, a timeout, every other SMTP 4yz, so greylisting and a full mailbox (450 / 451 / 452) and a login answered with 454, and an SES request refused for its timestamp (`InvalidSignatureException`, `RequestExpired`: check the server's clock) | retries this email with backoff; everything else carries on |
  | `slow-down` | the provider throttles the whole account: HTTP 429, a rate or quota error by name (Resend `rate_limit_exceeded` / `daily_quota_exceeded`, Brevo `too_many_requests`, SES `ThrottlingException` / `LimitExceededException`, which arrive as HTTP 400 too), SMTP 421, a 4yz whose text speaks of rate or quota and not of a recipient (a throttled recipient, or a refusal at `RCPT TO`, is `later`) | retries it and sends nothing else from this process for a minute |
  | `connector` | the provider refuses the account, by a signal that names it: HTTP 401, the provider's own key, permission, credit or unverified-sender error (Resend `invalid_api_key`, Postmark `ErrorCode` 10 / 400 / 401 / 405, Brevo `unauthorized` / `account_under_validation`, SES `AccessDeniedException` / `SignatureDoesNotMatch` / `SendingPausedException` and the like), SMTP 530 / 535 or `EAUTH`, no TLS offered, an unreadable secret, no connector or sender set | pauses delivery (below) |
  | `suspect` | a refusal that could be the account's or one recipient's: a 403 whose body does not say (providers also answer 403 for a blocked or suppressed recipient, or one a sandbox account may not write to) | retries this email like `later`; pauses only once three different recipients in a row got it with no success in between (`settleSuspect` in `send.ts`) |

- Retries wait 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, 6 h, 8 h (`RETRY_DELAYS_MS`; each moved by up to 20% either way), until the deadline. A wait that would run past the last useful moment (the deadline less the one-minute margin and two worker ticks, `LAST_TRY_LEAD_MS`, so the worker finds it whatever the phase of its 15-second tick) is cut short to it, so an email always gets its last try.
- An email whose template no longer exists, or whose payload can no longer be decrypted (`QueuedMailUnreadableError`: the master key changed), is failed at once.
- A provider's "slow down" is per process (`pausedUntil`): each instance backs off on its own refused request. Not knowing about another instance's costs one refused request and nothing else, so it is not stored.

**A connector that refuses the account trips a breaker.** Retrying every queued email against a wrong key or password can get an account locked. On a `connector` failure the email goes back untouched, with no attempt counted (`holdQueuedMail`), its activity row shows the reason at once, `pauseConnectorDelivery` sets `mail_connectors.delivery_paused_at` to the time of the refusal, and the drain stops. While it is set:

- nothing is handed to the connector except a **probe**: every two minutes (`CONNECTOR_PROBE_INTERVAL_MS`) one worker takes the probe with a conditional update (`takeConnectorProbe`) and tries one email, chosen by `claimProbeMail`: one that has no ambiguous refusal behind it (`mail_queue.suspect_at`), the core's before a plugin's, newest first; only when every due email was refused that way is the newest of those used. If it gets through, `noteConnectorUse` lifts the pause and the drain carries on with the rest. If the provider refuses it for its recipient's own reasons, the turn passes to the next candidate, three at most (`PROBE_CANDIDATES`). Any other answer leaves the pause in place with the time and reason refreshed. A turn is not taken while nothing is due (`hasDueMail`), so the first email to arrive is tried at once. So a provider's bad minute costs minutes, and nobody has to switch delivery back on;
- deadlines still run, and an email accepted meanwhile is logged as "Waiting: the connector is paused. <reason>" (`pausedMailMessage`);
- the Connectors tab shows "Delivery paused" with the error, Activity's Waiting tile shows it (`waitingError`), and each held email reads "Held".

A new secret (`setMailConnectorSecret`) or a successful send through the connector (the connector test) lifts the pause at once; those handlers and a change of defaults wake the worker. A connector's host, port or region cannot be edited in place today (a connector is replaced), so there is no config edit to lift it.

**Which refusals can pause.** A clear account signal pauses on the first occurrence. An ambiguous 403 (`suspect`) pauses only when three different recipients got one within ten minutes with no success in between; a 403 whose text names the recipient, a suppression or a testing restriction is `never` and does not count. That leaves one way a visitor-chosen address can contribute to a pause: a provider that answers a recipient-specific refusal with a 403 whose body says nothing about the recipient. Of the built-in drivers that is possible with Mailgun (free-text messages only), Brevo (`permission_denied`) and a typeless SES 403; Resend and Postmark name their errors. Three distinct such addresses in ten minutes would pause delivery for at most the two minutes until the next probe, which is a different email, succeeds. An email that got such a refusal is marked (`suspect_at`) and no longer counts towards a pause when it is retried, so the same junk addresses cannot pause delivery again and again.

**Delivery is at least once, and a failed record does not multiply it.** When the provider accepts an email the worker first sets `mail_queue.accepted_at` in one small statement (`markQueuedMailAccepted`), then updates the log and deletes the row. A row so marked is never claimed for sending again; if the later writes failed, `finishAcceptedMail` completes them at the start of the next drain. If even the mark cannot be written, the process remembers the id and will not send it again, and the row is put back with a growing wait (`backOffQueuedMail`) instead of being retried every pass. A duplicate is therefore possible only when a worker dies, or the database is unreachable and the process restarts, between the provider's acceptance and the mark: at most one.

**Claims and clocks.** A claim older than two minutes (`STALE_CLAIM_MS`; a hand-over is cut off by its driver after ten seconds) is released. The claim time is written by one instance's clock and judged by another's, so the rule tolerates clocks that differ by up to about 110 seconds; beyond that a live claim could be taken over, which costs a duplicate, not a lost email.

**Member email** (`queueMemberMail`) is handed over after the request has decided its answer and is not awaited by it. That keeps template rendering and the queue's writes out of the response time; it does not make a request for a known address indistinguishable from one for an unknown address, since the request itself already issues the token for a known one. It is also why queueing is not in the token's transaction: the token is committed first, and the email is queued a moment later in its own transaction. If that fails, the member has a token nobody sent them; the token expires, the failure is a `failed` activity entry ("Not queued, so never sent: …"), and the member can ask again. Handing over is awaited on shutdown (`flushMemberMail`).

`sendSiteMail` and `sendConnectorTest` do not use the queue: "Send test" and the connector test report the provider's answer to the person who clicked.

## Links in emails

Anything that puts a link in an email must build it from `configuredPublicOrigin()` (`PUBLIC_ORIGIN`), never from the request's `Host` header. The overview reports `publicOrigin` so the admin can warn when it is unset.

## Routes

All under `/admin/api/cms/mail`, all gated by `mail.manage`. "Step-up" marks the ones that also need a fresh password.

| Method | Path | Notes |
|---|---|---|
| GET | `/` | delivery mode, connectors (no secrets), defaults, `publicOrigin` |
| POST | `/connectors` | add a connector. Step-up. Audited `mail.connector.create` |
| DELETE | `/connectors/:id` | Step-up. Audited `mail.connector.delete` |
| PUT | `/connectors/:id/secret` | replace the secret. Step-up. Audited `mail.connector.secret` |
| POST | `/connectors/:id/test` | send the test template through this connector; `422` with a safe message on failure |
| PUT | `/defaults` | Step-up. Audited `mail.defaults.update` |
| GET | `/templates` | every template with the owner's edits applied |
| PUT | `/templates/:key` | Step-up. Audited `mail.template.update` |
| PUT | `/templates/:key/sending` | set `sendingEnabled`. Step-up. Audited `mail.template.update` |
| DELETE | `/templates/:key` | back to the built-in wording. Step-up. Audited `mail.template.reset` |
| POST | `/templates/:key/test` | send with sample values |
| GET | `/activity?period=&tz=&status=&kind=&connector=&q=&before=` | one page of matching emails plus the period's totals, chart buckets and filter menus |

## Tests

- `src/__tests__/server/mailQueue.test.ts` — accepting (capture, refusal, encryption at rest), delivery, the retry schedule and which refusals are retried, deadlines (a link is never sent after it expired), a connector fault pausing and resuming delivery, a greylisted recipient not delaying anyone else, order within a lane, claims and two drains at once, an outcome that cannot be recorded, an email that could not be queued.
- `src/__tests__/server/mailQueuePostgres.test.ts` — two workers on two connection pools against a real Postgres: every email sent exactly once, no advisory lock left behind. Runs when `INSTATIC_TEST_POSTGRES_URL` is set, which CI's test job does; the file says how to start a throwaway server locally.
- `src/__tests__/server/pluginMail.test.ts` — a real plugin in its sandbox: declared templates in the workspace, sending to a member and to an address, the permission each needs, hostile values, the limits, outcome events, edits across an upgrade, disable and uninstall.
- `src/__tests__/server/mail.test.ts` — delivery modes, connector storage, template rendering and injection, the address guard, SES signing and request shape, the request each one-key provider receives and how its refusals read, capability and step-up gates.
- `src/__tests__/server/mailSmtp.test.ts` — a real SMTP round trip against a local sink.
- `tests/e2e/email-workspace.e2e.ts` — ADMIN-013.
