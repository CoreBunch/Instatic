# Email

The Email workspace (`/admin/email`): the connectors the server sends mail through, who its mail is from, the wording of each email, and the delivery log.

This is the path for mail the core sends itself (account emails, tests). It is built to be the base for broadcasts and autoresponders later; neither exists yet.

---

## TL;DR

- **Connectors** are accounts mail is sent through. Two kinds: **SMTP** and **Amazon SES**. No provider SDKs: SMTP goes through `nodemailer`, SES is one signed HTTPS request.
- **Defaults** choose the one connector the site sends through, plus the sender name, sender address and reply-to.
- **Templates** are a subject and a Markdown body with `{variables}`, edited in the post editor (`TiptapBodyEditor`). Only edited templates are stored; the built-in wording lives in code.
- **Activity** is the delivery log.
- **Two entry points:** `sendTemplateMail(db, { key, to, variables })` and `sendSiteMail(db, mail)` in `server/mail/send.ts`.
- **Three delivery modes**, decided per send:

  | Mode | When | What happens |
  |---|---|---|
  | `send` | a default connector and a sender address are set | sent through it; logged `sent` or `failed` |
  | `capture` | they are not, and `NODE_ENV` is not `production` | written to Activity with its body; nothing leaves the machine |
  | `off` | they are not, in production | throws `MailNotConfiguredError` |

- **Secrets are write-only.** An SMTP password or AWS secret key is encrypted with the master key (`server/secrets/`) and never returned by any endpoint.
- **Message bodies are never logged.** `mail_outbox.body_text` is filled only for `captured` rows, which only a development server writes. Bodies carry live sign-in and reset links.
- **Capability:** `mail.manage` (Owner, Admin). Adding or removing a connector, replacing its secret, and changing the defaults also need step-up.

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
- `MAIL_ALLOW_PRIVATE_HOSTS=1` lifts the public-address rule and makes STARTTLS opportunistic, for a relay on the same machine or network. It is an environment variable, not an admin setting: only someone who can already configure the server can point mail at the internal network.

**SES** (`sesDriver.ts`) posts to `email.<region>.amazonaws.com`. The region is validated against a strict pattern when the connector is saved, so the host is always an AWS one. `signAwsRequest` is tested against AWS's published Signature Version 4 example.

Delivery errors reach the admin as a fixed set of sentences (`describeSmtpFailure`, `describeSesFailure`). The provider's own response text, the credentials and the message never do.

## Templates

A template definition (`MailTemplateDefinition`) has a `key`, a label, a group, its variables with sample values, and the built-in subject and body. Features add theirs with `registerMailTemplate` at module load; `mail.test` is the only one this module registers.

`renderMailTemplate(template, variables)` returns `{ subject, text, html }`:

- The body is rendered from Markdown to HTML **first**, with variables still in place, and only then are values put in, HTML-escaped. A value cannot add formatting, a link or an element.
- Inside a link target the filled-in value must be an `http(s)` address, or the link becomes `#`.
- Subject values are forced onto one line.
- A `{name}` with no value is left as written, so a typo is visible in the preview.

The admin preview calls the same function with each variable's `sample`, so the preview is what is sent. A template test (`POST …/templates/:key/test`) also uses sample values, never real ones, so a test cannot mint a working link.

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
| PUT | `/templates/:key` | Audited `mail.template.update` |
| DELETE | `/templates/:key` | back to the built-in wording. Audited `mail.template.reset` |
| POST | `/templates/:key/test` | send with sample values |
| GET | `/activity?status=` | the 100 newest rows, plus 30-day totals |

## Tests

- `src/__tests__/server/mail.test.ts` — delivery modes, connector storage, template rendering and injection, the address guard, SES signing and request shape, capability and step-up gates.
- `src/__tests__/server/mailSmtp.test.ts` — a real SMTP round trip against a local sink.
- `tests/e2e/email-workspace.e2e.ts` — ADMIN-013.
