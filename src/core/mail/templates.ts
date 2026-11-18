/**
 * Email templates: the catalogue of emails the site can send, and the one
 * renderer that turns a template plus values into a subject, a plain-text
 * body and an HTML body.
 *
 * A template is a subject line and a Markdown body. Both may contain
 * `{name}` variables. The same renderer runs on the server (to send) and in
 * the admin (the live preview), so what an owner sees is what is sent.
 *
 * Variable values are data, never markup, and a template is not trusted to
 * carry a secret value (a member's single-use link) somewhere else. The body
 * is rendered from Markdown to HTML with the variables still in place,
 * sanitized to the few elements an email needs, and the rules are then
 * applied to that parsed tree, never to markup as text: see `fillTree`.
 */
import { escapeHtml, isSafeUrl } from '@core/publisher'
import { renderMarkdownToHtml } from '@core/markdown/renderMarkdown'
import { sanitizeToFragment, type SanitizerConfig } from '@core/sanitize'
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

/** Take a template out of the catalogue: its feature (a plugin) is no longer loaded. */
export function unregisterMailTemplate(key: string): void {
  definitions.delete(key)
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

/** What makes a run of characters read as an address to a mail client that links plain text. */
const ADDRESS_LIKE = /:\/\/|www\.|@/i

/**
 * Put values into text. `flat` is the text `source` is a part of, starting
 * at `offset` in it (the whole of it, for a subject).
 *
 * A variable that is written into an address (`https://elsewhere.example/?t={link}`,
 * with no space between) is left as written: mail clients turn an address
 * in plain text into a link, so that shape would hand a member's
 * single-use link to another server as surely as an `href` would.
 */
function fill(
  source: string,
  variables: MailVariables,
  map: (value: string) => string,
  flat: string = source,
  offset = 0,
): string {
  return source.replace(VARIABLE, (whole, name: string, at: number) => {
    if (!(name in variables)) return whole
    let start = offset + at
    let end = start + whole.length
    while (start > 0 && !/\s/.test(flat[start - 1])) start -= 1
    while (end < flat.length && !/\s/.test(flat[end])) end += 1
    const around = flat.slice(start, end).replace(VARIABLE, '')
    return ADDRESS_LIKE.test(around) ? whole : map(variables[name])
  })
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
 * A plugin's template key is `plugin.<pluginId>~<key>`; no other key holds a
 * `~`. Such a template, and the owner's edit of it, is rendered with the
 * strict profile: what a plugin ships must not be able to load anything or
 * send a link anywhere when the email is opened.
 */
export function isPluginMailTemplateKey(key: string | undefined): boolean {
  return key !== undefined && key.includes('~')
}

/** What an email body may contain once rendered: the Markdown subset and nothing a mail client would run or submit. */
const MAIL_BODY_TAGS = [
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'del', 's', 'a', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]

/**
 * What every email body is cut down to before values go in: whatever the
 * Markdown renderer or raw HTML in a template produced, only these elements
 * and attributes remain. No forms, scripts, frames, styles, event handlers,
 * and no attribute that takes an address other than `href` and `src`.
 */
const MAIL_BODY_CONFIG: SanitizerConfig = {
  ALLOWED_TAGS: [...MAIL_BODY_TAGS, 'img'],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'src', 'alt', 'width', 'height', 'align', 'start'],
  ALLOW_DATA_ATTR: false,
}

/** The same without images: a plugin's template loads nothing when the email is opened. */
const PLUGIN_MAIL_BODY_CONFIG: SanitizerConfig = {
  ALLOWED_TAGS: MAIL_BODY_TAGS,
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'align', 'start'],
  ALLOW_DATA_ATTR: false,
}

const ELEMENT_NODE = 1
const TEXT_NODE = 3

/** A value that may be an address in an email: absolute `http(s)`, and nothing a browser would run. */
function isWebAddress(value: string, httpsOnly: boolean): boolean {
  return (httpsOnly ? /^https:\/\//i : /^https?:\/\//i).test(value) && isSafeUrl(value)
}

/**
 * The address an `href` or `src` ends up with.
 *
 * A variable is honoured only when it is the WHOLE address
 * (`[Confirm]({link})`) and its value is an `http(s)` address. An address
 * that merely contains a variable (`https://elsewhere.example/?t={link}`)
 * becomes `#`: that shape would hand a member's single-use link to another
 * server, on click for a link and on open for an image. An address written
 * out in the template must be `http(s)` (or `mailto:` on a link); in a
 * plugin's template (`strict`), `https` only.
 */
function resolveAddress(raw: string, variables: MailVariables, strict: boolean, link: boolean): string {
  const target = raw.trim()
  if (target.includes('{')) {
    const whole = WHOLE_VARIABLE.exec(target)
    const value = whole && whole[1] in variables ? variables[whole[1]].trim() : null
    return value !== null && isWebAddress(value, false) ? value : '#'
  }
  if (isWebAddress(target, strict)) return target
  if (link && !strict && /^mailto:/i.test(target) && isSafeUrl(target)) return target
  return '#'
}

/** Elements that do not end a line: text on both sides of one reads as one run. */
const INLINE_TAGS = new Set(['a', 'b', 'strong', 'em', 'i', 'del', 's', 'code'])

interface TextRun {
  node: ChildNode
  /** Where this node's text starts in the body's text read as one string. */
  start: number
}

/**
 * Put values into the parsed, sanitized body.
 *
 * Values go into text nodes, where they are text whatever they contain, and
 * into the one kind of attribute `resolveAddress` vouches for: the address
 * of a link (`a[href]`) or an image (`img[src]`). Every other attribute
 * that holds a `{` is removed, so there is no attribute a template can use
 * to carry a value anywhere. The tree is the one the sanitizer parsed, so
 * quoting, entities, case and whitespace in the template's markup have
 * already been read the only way they will ever be read.
 *
 * Text is filled against the body read as one string, so an address split
 * across inline elements (`https://elsewhere.example/?t=<b>{link}</b>`) is
 * still seen as one address (see `fill`).
 */
function fillTree(root: ParentNode, variables: MailVariables, strict: boolean): void {
  const runs: TextRun[] = []
  let flat = ''
  const visit = (parent: ParentNode): void => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === TEXT_NODE) {
        runs.push({ node, start: flat.length })
        flat += node.textContent ?? ''
        continue
      }
      if (node.nodeType !== ELEMENT_NODE) {
        node.parentNode?.removeChild(node)
        continue
      }
      const element = node as Element
      const tag = element.tagName.toLowerCase()
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase()
        if ((tag === 'a' && name === 'href') || (tag === 'img' && name === 'src')) {
          element.setAttribute(attribute.name, resolveAddress(attribute.value, variables, strict, tag === 'a'))
        } else if (attribute.value.includes('{')) {
          element.removeAttribute(attribute.name)
        }
      }
      const inline = INLINE_TAGS.has(tag)
      if (!inline) flat += ' '
      visit(element)
      if (!inline) flat += ' '
    }
  }
  visit(root)
  for (const { node, start } of runs) {
    node.textContent = fill(node.textContent ?? '', variables, (value) => value, flat, start)
  }
}

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'table', 'hr'])

/**
 * The plain-text body, read off the same filled tree as the HTML one, so
 * the two say the same thing and an address the HTML part refused is not in
 * the text part either. A link is its words followed by its address.
 */
function treeText(root: ParentNode): string {
  let text = ''
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === TEXT_NODE) {
      text += node.textContent ?? ''
      continue
    }
    if (node.nodeType !== ELEMENT_NODE) continue
    const element = node as Element
    const tag = element.tagName.toLowerCase()
    const inner = treeText(element)
    if (tag === 'br') text += '\n'
    else if (tag === 'img') text += element.getAttribute('alt') ?? ''
    else if (tag === 'a') {
      const href = element.getAttribute('href') ?? ''
      text += href && href !== '#' && href !== inner.trim() ? `${inner} (${href})` : inner
    } else if (tag === 'li') text += `- ${inner.trim()}\n`
    else if (tag === 'tr') text += `${inner.trim()}\n`
    else if (tag === 'th' || tag === 'td') text += `${inner.trim()}  `
    else if (BLOCK_TAGS.has(tag)) text += `${inner.trim()}\n\n`
    else text += inner
  }
  return text
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
  template: { key?: string; subject: string; body: string },
  variables: MailVariables,
): RenderedMail {
  const siteName = variables['site.name'] ?? ''
  const strict = isPluginMailTemplateKey(template.key)
  const body = sanitizeToFragment(
    renderMarkdownToHtml(template.body),
    strict ? PLUGIN_MAIL_BODY_CONFIG : MAIL_BODY_CONFIG,
  )
  // No parser, no email: the rules above are only as good as the tree they run on.
  if (!body) throw new Error('An email cannot be rendered without an HTML parser')
  fillTree(body, variables, strict)
  const holder = body.ownerDocument.createElement('div')
  holder.appendChild(body)
  return {
    subject: singleLine(fill(template.subject, variables, singleLine)),
    text: treeText(holder).replace(/\n{3,}/g, '\n\n').trim(),
    html: wrapInLayout(holder.innerHTML, siteName),
  }
}

/** The preview values of a template's variables. */
export function sampleMailVariables(variables: readonly MailTemplateVariable[]): Record<string, string> {
  return Object.fromEntries(variables.map((variable) => [variable.name, variable.sample]))
}
