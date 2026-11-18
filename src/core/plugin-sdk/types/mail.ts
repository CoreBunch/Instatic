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
   * (20 emails an hour to one recipient, 10,000 waiting).
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
