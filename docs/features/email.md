# Email

The one SMTP account the server sends its own email through, the test send, and the delivery log. Set up in the admin under **Settings → Email**.

Plugins do not send through this path. It exists for mail the core sends itself.

---

## TL;DR

- **One account, installation-wide.** A single `mail_settings` row. It is not part of the site document, so it is not branched, exported or published.
- **`sendSiteMail(db, mail)`** in `server/mail/send.ts` is the only entry point. Callers hand over a finished message (`kind`, `to`, `subject`, `text`, optional `html`).
- **Three delivery modes**, decided per send:

  | Mode | When | What happens |
  |---|---|---|
  | `smtp` | an account is saved | sent through it; logged `sent` or `failed` |
  | `capture` | no account, `NODE_ENV` is not `production` | written to the delivery log with its body; nothing leaves the machine |
  | `off` | no account, production | throws `MailNotConfiguredError` |

- **The password is write-only.** Encrypted with the master key (`server/secrets/`), never returned by any endpoint. A save that omits `password` keeps the stored one; an empty string clears it.
- **Message bodies are never logged.** `mail_outbox.body_text` is filled only for `captured` rows, which only a development server writes. Bodies carry live sign-in and reset links.
- **Capability:** `mail.manage` (Owner, Admin). Saving and removing the account also need step-up.

---

## Where the code lives

```text
src/core/mail/                 — TypeBox wire shapes shared by server and admin (@core/mail)
server/mail/
├── settings.ts                — the account row: view, save, delete, decrypt for one send
├── transport.ts               — SMTP delivery, address guard, From header formatting
├── outbox.ts                  — the delivery log (500 newest rows kept)
└── send.ts                    — sendSiteMail, delivery mode
server/handlers/cms/mail.ts    — /admin/api/cms/mail/* routes
src/core/persistence/cmsMail.ts
src/admin/modals/Settings/sections/EmailSection.tsx
```

## Connection rules

`server/mail/transport.ts` applies the same guard as plugin outbound requests:

- The SMTP hostname is resolved once. **Every** DNS answer must be a public address (`isBlockedAddress`), and the socket is pinned to the validated IP while TLS still verifies the original hostname.
- Port 465 uses implicit TLS. Every other port must upgrade with STARTTLS before authenticating (`requireTLS`).
- An IP literal is rejected as a host.

`MAIL_ALLOW_PRIVATE_HOSTS=1` lifts the public-address rule and makes STARTTLS opportunistic, for a relay on the same machine or private network (Mailpit, a Postfix sidecar). It is an environment variable, not an admin setting: only someone who can already configure the server can point mail at the internal network.

Delivery errors reach the admin as a fixed set of sentences (`describeSmtpFailure`). The SMTP server's own response text, the credentials and the message never do.

## Links in emails

Anything that puts a link in an email must build it from `configuredPublicOrigin()` (`PUBLIC_ORIGIN`), never from the request's `Host` header. The settings view reports `publicOrigin` so the admin can warn when it is unset.

## Routes

All under `/admin/api/cms/mail`, all gated by `mail.manage`:

| Method | Path | Notes |
|---|---|---|
| GET | `/settings` | delivery mode, the account without its password, `publicOrigin` |
| PUT | `/settings` | save the account; step-up; audited as `mail.settings.update` |
| DELETE | `/settings` | remove the account; step-up; audited as `mail.settings.delete` |
| POST | `/test` | send a test message through the current mode; `422` with a safe message on failure |
| GET | `/outbox` | the 50 newest delivery log rows |

## Tests

- `src/__tests__/server/mail.test.ts` — delivery modes, header injection, encrypted storage, address guard, capability and step-up gates.
- `src/__tests__/server/mailSmtp.test.ts` — a real SMTP round trip against a local sink.
- `tests/e2e/email-settings.e2e.ts` — ADMIN-013.
