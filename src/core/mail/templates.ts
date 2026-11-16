/**
 * Email templates: the catalogue of emails the site can send, and the one
 * renderer that turns a template plus values into a subject, a plain-text
 * body and an HTML body.
 *
 * A template is a subject line and a Markdown body. Both may contain
 * `{name}` variables. The same renderer runs on the server (to send) and in
 * the admin (the live preview), so what an owner sees is what is sent.
 *
 * Variable values are data, never markup. The body is rendered to HTML
 * first, with the variables still in place, and only then are the values
 * put in, HTML-escaped. A value therefore cannot add formatting, a link or
 * an element, whatever a member typed into their profile.
 *
 * A template is also not trusted to carry a secret value somewhere else: see
 * `fillHtml` for how variables in link and image addresses are confined.
 */
import { escapeHtml, isSafeUrl } from '@core/publisher'
import { renderMarkdownToHtml } from '@core/markdown/renderMarkdown'
import type { MailTemplateVariable } from './schemas'

// ─── Catalogue ─────────────────────────────────────────────────────────────

export interface MailTemplateDefinition {
  /** Stable id, also the `kind` recorded in the activity log. */
  key: string
  label: string
  /** When this email is sent, in a sentence. */
  description: string
  /** Heading the template is listed under in the admin. */
  group: string
  variables: readonly MailTemplateVariable[]
  defaultSubject: string
  defaultBody: string
}

/**
 * Variables every template can use. They carry no made-up sample: the server
 * fills `sample` with the site's real name and address when it hands a
 * template to the admin.
 */
export const COMMON_MAIL_VARIABLES: readonly MailTemplateVariable[] = [
  { name: 'site.name', label: 'Site name', sample: '' },
  { name: 'site.url', label: 'Site address', sample: '' },
]

const definitions = new Map<string, MailTemplateDefinition>()

/** Add a template to the catalogue. Features register theirs at module load. */
export function registerMailTemplate(definition: MailTemplateDefinition): void {
  definitions.set(definition.key, {
    ...definition,
    variables: [...definition.variables, ...COMMON_MAIL_VARIABLES],
  })
}

export function getMailTemplateDefinition(key: string): MailTemplateDefinition | undefined {
  return definitions.get(key)
}

export function listMailTemplateDefinitions(): MailTemplateDefinition[] {
  return [...definitions.values()]
}

export const TEST_MAIL_TEMPLATE_KEY = 'mail.test'

registerMailTemplate({
  key: TEST_MAIL_TEMPLATE_KEY,
  label: 'Test email',
  description: 'Sent when you press "Send test email" on a connector or a template.',
  group: 'General',
  variables: [],
  defaultSubject: 'Test email from {site.name}',
  defaultBody:
    'This is a test email from **{site.name}**.\n\nIf you are reading it, outgoing email works.',
})

// ─── Rendering ─────────────────────────────────────────────────────────────

const VARIABLE = /\{([a-zA-Z][a-zA-Z0-9_.]{0,60})\}/g

export type MailVariables = Readonly<Record<string, string>>

export interface RenderedMail {
  subject: string
  text: string
  html: string
}

/** A value on one line, so it can never break out of a header or a subject. */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function fill(source: string, variables: MailVariables, map: (value: string) => string): string {
  return source.replace(VARIABLE, (whole, name: string) =>
    name in variables ? map(variables[name]) : whole,
  )
}

/** Every `{name}` in a subject or body that is not one of `known`. */
export function unknownMailVariables(source: string, known: readonly MailTemplateVariable[]): string[] {
  const names = new Set(known.map((variable) => variable.name))
  const unknown = new Set<string>()
  for (const match of source.matchAll(VARIABLE)) {
    if (!names.has(match[1])) unknown.add(match[1])
  }
  return [...unknown]
}

const WHOLE_VARIABLE = /^\{([a-zA-Z][a-zA-Z0-9_.]{0,60})\}$/

/**
 * Put values into rendered HTML.
 *
 * In a link or image address a variable is honoured only when it is the
 * WHOLE address (`[Confirm]({link})`), and only if its value is an http(s)
 * address. An address that merely contains a variable
 * (`https://elsewhere.example/?t={link}`) is neutralised: that shape would
 * hand a member's single-use link to another server, on click for a link
 * and on open for an image. Everywhere else a value is text.
 */
function fillHtml(html: string, variables: MailVariables): string {
  const withAddresses = html.replace(/\b(href|src)="([^"]*)"/g, (whole, attribute: string, target: string) => {
    if (!target.includes('{')) return whole
    const single = WHOLE_VARIABLE.exec(target)
    const value = single && single[1] in variables ? variables[single[1]].trim() : null
    const safe = value !== null && /^https?:\/\//i.test(value) && isSafeUrl(value) ? escapeHtml(value) : '#'
    return `${attribute}="${safe}"`
  })
  return fill(withAddresses, variables, (value) => escapeHtml(value))
}

const LAYOUT_STYLE = {
  body: 'margin:0;padding:0;background:#f4f4f5;',
  card:
    'max-width:560px;margin:0 auto;padding:32px;background:#ffffff;' +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;" +
    'font-size:16px;line-height:1.55;color:#18181b;',
  footer:
    'max-width:560px;margin:0 auto;padding:16px 32px 32px;' +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;" +
    'font-size:13px;color:#71717a;',
} as const

/** Wrap a rendered body in the plain, client-safe layout every email shares. */
function wrapInLayout(bodyHtml: string, siteName: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    `<body style="${LAYOUT_STYLE.body}">` +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">' +
    `<tr><td style="padding:32px 16px 0;"><div style="${LAYOUT_STYLE.card}">${bodyHtml}</div></td></tr>` +
    `<tr><td><div style="${LAYOUT_STYLE.footer}">${escapeHtml(siteName)}</div></td></tr>` +
    '</table></body></html>'
  )
}

/**
 * Render a template with values. Variables with no value are left as
 * written (`{like.this}`), so a typo is visible in the preview instead of
 * silently vanishing.
 */
export function renderMailTemplate(
  template: { subject: string; body: string },
  variables: MailVariables,
): RenderedMail {
  const siteName = variables['site.name'] ?? ''
  return {
    subject: singleLine(fill(template.subject, variables, singleLine)),
    text: fill(template.body, variables, (value) => value),
    html: wrapInLayout(fillHtml(renderMarkdownToHtml(template.body), variables), siteName),
  }
}

/** The preview values of a template's variables. */
export function sampleMailVariables(variables: readonly MailTemplateVariable[]): Record<string, string> {
  return Object.fromEntries(variables.map((variable) => [variable.name, variable.sample]))
}
