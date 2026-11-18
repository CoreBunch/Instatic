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
├── activity.ts                — mail_outbox (2000 newest rows kept)
├── send.ts                    — one delivery attempt (carryThroughConnector), sendSiteMail, delivery mode
├── queue.ts                   — mail_queue: enqueue, claim, reschedule, remove; payload encryption
└── delivery.ts                — queueTemplateMail, the worker (drain, retry schedule, start / wake / stop)
server/handlers/cms/mail.ts    — /admin/api/cms/mail/* routes
src/core/persistence/cmsMail.ts
src/admin/pages/email/         — the workspace: EmailPage + tabs/{Connectors,Defaults,Templates,Activity}Tab
src/admin/shared/SettingsWorkspace/ — the section-rail + master-detail layout shared with the AI workspace
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

`renderMailTemplate(template, variables)` returns `{ subject, text, html }`:

- The body is rendered from Markdown to HTML **first**, with variables still in place, and only then are values put in, HTML-escaped. A value cannot add formatting, a link or an element.
- In a link or image address a variable is honoured only when it is the **whole** address (`[Confirm]({link})`) and its value is an `http(s)` address. An address that merely contains a variable (`https://elsewhere.example/?t={link}`) becomes `#`: that shape would hand a member's single-use link to another server.
- Subject values are forced onto one line.
- A `{name}` with no value is left as written, so a typo is visible in the preview.

In the admin (`tabs/TemplatesTab.tsx`) a template opens in **Live** mode: the subject and body are edited inside a card styled like the sent email (`.emailCard`, coloured by the `--email-preview-*` tokens), so there is no separate preview pane. **Write** is the bare editor surface. The switch is the post editor's `ContentModeToggle`; "Insert variable" puts a `{name}` into whichever of the two fields was focused last. The editor runs without media (`onPickMedia` omitted), which hides the image options of the floating and slash menus.

"Send test" in the header opens a dialog that shows the email rendered by the same `renderMailTemplate` with each variable's `sample`, so the dialog is what is sent. For `site.name` and `site.url` the server puts the site's real name and public address into `sample` when it reads a template (`toTemplate` in `server/mail/templates.ts`, from the same `siteMailVariables` a send uses), so the editor, the footer and the dialog show the real ones; only per-recipient variables preview with made-up values. Sending is disabled until unsaved edits are saved, because the server sends the stored template. On a connector the test send and the secret replacement are dialogs too. A template test (`POST …/templates/:key/test`) also uses sample values for per-recipient variables, never real ones, so a test cannot mint a working link.

## Activity

`recordMail` (`server/mail/activity.ts`) writes one `mail_outbox` row per email (`updateMailProgress` brings a queued email's row up to date after each attempt): template key (`kind`), recipient, subject, status, the connector's label at the time, the safe error sentence, how long the hand-over took (`duration_ms`) and the id the provider answered with (`provider_message_id`: the SES `MessageId`, or nodemailer's `messageId` for SMTP). The newest 2000 rows are kept.

`listMailActivity(db, filter)` reads the whole log without bodies and does the work in memory, so search, day buckets and totals are identical on both dialects:

- **Period** (`24h`, `7d`, `30d`, `all`). `24h` is the last 24 hours in hourly buckets. The others are whole calendar days in the viewer's time zone (`tz`), so "7 days" is today and the six days before.
- **`totals`, `buckets`, `lastFailure`, `kinds`, `connectors`** describe the whole period. `status`, `kind`, `connector` and `q` (recipient or subject) only narrow `entries` and `matching`.
- **Paging:** 50 entries a page; pass the last entry's id as `before`.

`queued` is an email that has not left: `attempts` is 0 while it waits for its first try, and above 0 while it waits for the next one after a temporary failure, with the last error and `nextAttemptAt`. `sent` means the provider accepted the message. Bounces and spam filtering happen after that and are not known here; the detail panel says so. `failed` is final: the provider judged the message, or a day of retries ran out.

The tab (`tabs/ActivityTab.tsx`) shows the totals and chart, then the filters, then the list beside the selected email's details. From a failure it links to Connectors; from a template's email it opens that template.

## Plugin templates

A plugin declares its emails in its manifest (`mail.templates[]`) and can send nothing else; see [plugin system](plugin-system.md) → Email. `registerPluginMailTemplates` (`server/mail/pluginTemplates.ts`) puts them in the catalogue as `plugin.<pluginId>~<key>` when the plugin's server code loads and `unregisterPluginMailTemplates` takes them out when it unloads, so the Templates tab lists them, under the plugin's name, exactly while the plugin can send. They are edited, previewed and tested like any other template; the edit is stored under the same key, survives an upgrade and is deleted by `removePluginMail` on uninstall.

A plugin's email is queued with `source` set to the plugin's id and `lane` 1. `assertWithinMailLimits` (`server/mail/limits.ts`) refuses a twenty-first email from one plugin to one recipient within an hour, and an email from a plugin that already has 10,000 waiting. `setQueuedMailOutcomeHandler` tells the plugin host what became of each such email, which it passes to that plugin alone as `mail.delivered` or `mail.failed`.

## The queue

`queueTemplateMail` renders the template once (to prove it exists and to give the log its subject), writes the `queued` activity row and the `mail_queue` row in one transaction, wakes the worker and returns. The request that asked for the email never waits for a provider.

A `mail_queue` row holds the template key, the recipient, `source` (`core`, or a plugin id), `lane` and the variables. The variables are encrypted with the master key (`payload_ciphertext`, `payload_iv`), because they carry live links, and the row is deleted as soon as the email is sent or given up on. The email is rendered again at each attempt, so it leaves with the wording of that moment.

**The worker** (`startMailQueue` at boot, `stopMailQueue` on shutdown) drains the queue on a wake and on a 15-second tick:

- One email at a time, 100 ms apart, ordered by `lane` (0 = core, always first), then due time, then acceptance order.
- A wake starts a drain at once, so a sign-in link's first attempt is not delayed. On several instances, a wake that lands while another instance holds the lock is a no-op; that instance's drain or the next tick picks the email up.
- A drain runs under the scheduler leader lock (`withSchedulerLeaderLock`, the same mechanism as the plugin and publish schedulers), so several instances on one Postgres database send as one. A row is also claimed with a conditional update (`claimed_at`), so no two drains ever take the same email.
- Each driver marks its `MailDeliveryError` with `retry`: `never` (the provider judged the message: SMTP 5xx, an HTTP 4xx), `later` (unreachable, a 5xx, a timeout, rejected credentials, an unreadable secret, email no longer set up), or `slow-down` (HTTP 429, SMTP 421/45x), which also holds every other email back for a minute.
- `later` and `slow-down` put the email back with the next wait from `RETRY_DELAYS_MS` (30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, 6 h, 8 h; each moved by up to 20% either way). An email still undelivered 24 hours after it was accepted is failed.
- An email whose template no longer exists, or whose payload can no longer be decrypted (the master key changed), is failed at once.

**Delivery is at least once.** The row is deleted after the provider accepts the email. A process that dies between those two steps leaves a claimed row; claims older than ten minutes are released and the email is sent a second time.

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
| DELETE | `/templates/:key` | back to the built-in wording. Step-up. Audited `mail.template.reset` |
| POST | `/templates/:key/test` | send with sample values |
| GET | `/activity?period=&tz=&status=&kind=&connector=&q=&before=` | one page of matching emails plus the period's totals, chart buckets and filter menus |

## Tests

- `src/__tests__/server/mailQueue.test.ts` — accepting (capture, refusal, encryption at rest), delivery, the retry schedule and which refusals are retried, giving up, the rate-limit pause, lane order, claims and two drains at once, a member email end to end.
- `src/__tests__/server/pluginMail.test.ts` — a real plugin in its sandbox: declared templates in the workspace, sending to a member and to an address, the permission each needs, hostile values, the limits, outcome events, edits across an upgrade, disable and uninstall.
- `src/__tests__/server/mail.test.ts` — delivery modes, connector storage, template rendering and injection, the address guard, SES signing and request shape, the request each one-key provider receives and how its refusals read, capability and step-up gates.
- `src/__tests__/server/mailSmtp.test.ts` — a real SMTP round trip against a local sink.
- `tests/e2e/email-workspace.e2e.ts` — ADMIN-013.
