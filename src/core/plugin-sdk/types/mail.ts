/**
 * Email for plugins: the templates a plugin declares and the call that sends
 * one. See `docs/features/plugin-system.md` → "Email".
 */

/** One `{name}` a template's subject and body may use. */
export interface PluginMailTemplateVariable {
  name: string
  /** What the value is, for the person editing the template. */
  label: string
  /** A realistic made-up value for the preview and the test send. */
  sample: string
  /**
   * `link` for an address (`https://...`): it must stand alone in the
   * template, or be the whole address of a link (`[Open]({link})`), and its
   * value must be an `http(s)` address. `text` (the default) may sit
   * anywhere in a sentence, and its value must not contain an address.
   */
  kind?: 'text' | 'link'
}

/** An email a plugin can send, declared in the manifest's `mail.templates[]`. */
export interface PluginMailTemplateDeclaration {
  /** Lower-case name, unique within the plugin. Listed as `plugin.<pluginId>~<key>`. */
  key: string
  /** The template's name in Email → Templates. */
  label: string
  /** When this email is sent, in a sentence. */
  description: string
  variables: PluginMailTemplateVariable[]
  /** The built-in subject: one line, may use `{variables}`. */
  subject: string
  /** The built-in body in Markdown, may use `{variables}`. */
  body: string
}

export interface PluginMailDeclarations {
  templates: PluginMailTemplateDeclaration[]
}

/** Who an email goes to: a site member (the host looks the address up), or an address. */
export type PluginMailRecipient = { member: string } | { address: string }

/**
 * Why an email was given up on (`mail.failed`). The site owner sees the full
 * explanation under Email → Activity; a plugin gets one of these codes:
 *
 *  - `recipient_rejected`: the mail provider refused the message or the recipient.
 *  - `expired`: it could not be delivered before its deadline (a day), so it was not sent.
 *  - `template_removed`: the template no longer exists.
 *  - `unreadable`: the queued email could not be read any more.
 *  - `recipient_unavailable`: the member it was for was suspended or deleted before it went out.
 *  - `template_invalid`: the template would have gone out with a variable still in it.
 */
export type PluginMailFailureReason =
  | 'recipient_rejected'
  | 'expired'
  | 'template_removed'
  | 'unreadable'
  | 'recipient_unavailable'
  | 'template_invalid'

export interface PluginMailSendInput {
  /** A `key` from this plugin's `mail.templates[]`. */
  template: string
  to: PluginMailRecipient
  /** Values for the template's variables. Unknown names are refused. */
  variables?: Record<string, string>
  /** The plugin's own name for this email, handed back with `mail.delivered` / `mail.failed`. */
  reference?: string
}

export interface ServerPluginMailApi {
  /**
   * Queue one of this plugin's templates for one recipient. Resolves
   * `queued` once the site has accepted the email (it is sent by the mail
   * queue, with retries), or `captured` on a development server with no
   * connector. `{ member }` needs `mail.send`; `{ address }` needs
   * `mail.send.external`.
   *
   * Rejects when email is not set up, the member cannot be emailed, the
   * address is not valid, a value is not a string, or a limit is reached
   * (20 emails to one recipient within a clock hour, 200 an hour to
   * addresses, 10,000 waiting). Three rejections start with a code:
   * `variable_missing:` when the template's wording, as the owner has it
   * now, uses a variable that was not given (an empty `link` counts as not
   * given; an empty `text` is a value),
   * `variable_not_allowed:` when a value may not be sent in its variable (a
   * `text` value that contains an address, a `link` value that is not an
   * `http(s)` address, a control character), and `template_invalid:` when
   * the email would go out with a variable still in it. Nothing is queued.
   *
   * Nothing here returns a member's address: the outcome events name the
   * recipient the way this call did.
   */
  send: (input: PluginMailSendInput) => Promise<'queued' | 'captured'>
}

export interface ServerPluginSiteApi {
  /**
   * The site's configured public address (`https://example.com`), or null
   * when none is configured. Build every link that goes into an email from
   * this, never from a request's `Host` header.
   */
  publicUrl: () => Promise<string | null>
}
