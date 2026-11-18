# Email

The Email workspace (`/admin/email`): the connectors the server sends mail through, who its mail is from, the wording of each email, and the delivery log.

This is the path for mail the core sends itself (account emails, tests). It is built to be the base for broadcasts and autoresponders later; neither exists yet.

---

## TL;DR

- **Connectors** are accounts mail is sent through. Six kinds: four **one-key** providers set up with a single API key (**Resend**, **Postmark**, **Mailgun**, **Brevo**), **Amazon SES**, and **SMTP** for any other mail server. No provider SDKs: SMTP goes through `nodemailer`, every other kind is one HTTPS request. The HTTPS kinds also work on hosts that block the SMTP ports.
- **Defaults** choose the one connector the site sends through, plus the sender name, sender address and reply-to.
- **Templates** are a subject and a Markdown body with `{variables}`, edited in place in the post editor (`TiptapBodyEditor`) with the same Write / Live switch as a post. Only edited templates are stored; the built-in wording lives in code.
- **Activity** is the delivery log: per-period totals and a volume chart, search and filters, and a detail panel for each email.
- **Two entry points:** `sendTemplateMail(db, { key, to, variables })` and `sendSiteMail(db, mail)` in `server/mail/send.ts`.
- **Three delivery modes**, decided per send:

  | Mode | When | What happens |
  |---|---|---|
  | `send` | a default connector and a sender address are set | sent through it; logged `sent` or `failed` |
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
└── send.ts                    — sendSiteMail, sendTemplateMail, delivery mode
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

A template definition (`MailTemplateDefinition`) has a `key`, a label, a group, its variables with sample values (the two site variables, `site.name` and `site.url`, carry none), and the built-in subject and body. Features add theirs with `registerMailTemplate` at module load; `mail.test` is the only one this module registers.

`renderMailTemplate(template, variables)` returns `{ subject, text, html }`:

- The body is rendered from Markdown to HTML **first**, with variables still in place, and only then are values put in, HTML-escaped. A value cannot add formatting, a link or an element.
- In a link or image address a variable is honoured only when it is the **whole** address (`[Confirm]({link})`) and its value is an `http(s)` address. An address that merely contains a variable (`https://elsewhere.example/?t={link}`) becomes `#`: that shape would hand a member's single-use link to another server.
- Subject values are forced onto one line.
- A `{name}` with no value is left as written, so a typo is visible in the preview.

In the admin (`tabs/TemplatesTab.tsx`) a template opens in **Live** mode: the subject and body are edited inside a card styled like the sent email (`.emailCard`, coloured by the `--email-preview-*` tokens), so there is no separate preview pane. **Write** is the bare editor surface. The switch is the post editor's `ContentModeToggle`; "Insert variable" puts a `{name}` into whichever of the two fields was focused last. The editor runs without media (`onPickMedia` omitted), which hides the image options of the floating and slash menus.

"Send test" in the header opens a dialog that shows the email rendered by the same `renderMailTemplate` with each variable's `sample`, so the dialog is what is sent. For `site.name` and `site.url` the server puts the site's real name and public address into `sample` when it reads a template (`toTemplate` in `server/mail/templates.ts`, from the same `siteMailVariables` a send uses), so the editor, the footer and the dialog show the real ones; only per-recipient variables preview with made-up values. Sending is disabled until unsaved edits are saved, because the server sends the stored template. On a connector the test send and the secret replacement are dialogs too. A template test (`POST …/templates/:key/test`) also uses sample values for per-recipient variables, never real ones, so a test cannot mint a working link.

## Activity

`recordMail` (`server/mail/activity.ts`) writes one `mail_outbox` row per attempt: template key (`kind`), recipient, subject, status, the connector's label at the time, the safe error sentence, how long the hand-over took (`duration_ms`) and the id the provider answered with (`provider_message_id`: the SES `MessageId`, or nodemailer's `messageId` for SMTP). The newest 2000 rows are kept.

`listMailActivity(db, filter)` reads the whole log without bodies and does the work in memory, so search, day buckets and totals are identical on both dialects:

- **Period** (`24h`, `7d`, `30d`, `all`). `24h` is the last 24 hours in hourly buckets. The others are whole calendar days in the viewer's time zone (`tz`), so "7 days" is today and the six days before.
- **`totals`, `buckets`, `lastFailure`, `kinds`, `connectors`** describe the whole period. `status`, `kind`, `connector` and `q` (recipient or subject) only narrow `entries` and `matching`.
- **Paging:** 50 entries a page; pass the last entry's id as `before`.

`sent` means the provider accepted the message. Bounces and spam filtering happen after that and are not known here; the detail panel says so. A failure is not retried.

The tab (`tabs/ActivityTab.tsx`) shows the totals and chart, then the filters, then the list beside the selected email's details. From a failure it links to Connectors; from a template's email it opens that template.

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

- `src/__tests__/server/mail.test.ts` — delivery modes, connector storage, template rendering and injection, the address guard, SES signing and request shape, the request each one-key provider receives and how its refusals read, capability and step-up gates.
- `src/__tests__/server/mailSmtp.test.ts` — a real SMTP round trip against a local sink.
- `tests/e2e/email-workspace.e2e.ts` — ADMIN-013.
