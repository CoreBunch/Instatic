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
 * applied to that parsed tree, never to markup as text: see `readTree`.
 * The plain-text part and the HTML part are read off that one tree.
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
  /**
   * Variables that have a value but were left as written, because the
   * template puts them where they do not stand alone (see `standsAlone`).
   * The admin preview names them.
   */
  refused: string[]
}

/** A value on one line, so it can never break out of a header or a subject. */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/** Marks, in text being assembled, where a value that must stand alone was put. Never in a template or a value. */
const VALUE_OPEN = '\uE000'
const VALUE_CLOSE = '\uE001'
const MARKS = /[\uE000\uE001]/g

const ASCII_SPACE = /[ \t\n\r\f]/

/**
 * Whether `text[start, end)` stands alone: within its run of non-space
 * characters there is nothing but opening punctuation before it and closing
 * punctuation after it.
 *
 * Mail clients turn an address in plain text into a link by themselves, and
 * they decide where it starts and ends. A value written into one
 * (`https://elsewhere.example/?t={link}`, `elsewhere.example/{link}`,
 * `user@{link}`) would hand a member's single-use link to another server as
 * surely as an `href` would. Rather than guess what a client takes for an
 * address, a value is only ever put where nothing touches it. Only ASCII
 * whitespace separates: a zero-width or other exotic space does not.
 */
function standsAlone(text: string, start: number, end: number): boolean {
  let from = start
  let to = end
  while (from > 0 && !ASCII_SPACE.test(text[from - 1])) from -= 1
  while (to < text.length && !ASCII_SPACE.test(text[to])) to += 1
  return /^[("']*$/.test(text.slice(from, start)) && /^[.,;:!?)"']*$/.test(text.slice(end, to))
}

/** How values are put into one template: for whom the stand-alone rule holds, and what it turned away. */
interface Filling {
  variables: MailVariables
  /** A plugin's template: every value must stand alone, not only an address. */
  strict: boolean
  refused: Set<string>
}

/**
 * Whether a variable's value may only be put where it stands alone: a value
 * that is an address (a link), and in a plugin's template every value. The
 * site's own name and address are public and exempt.
 */
function mustStandAlone(name: string, value: string, strict: boolean): boolean {
  if (name.startsWith('site.')) return false
  return strict || /^\s*[a-z][a-z0-9+.-]*:|:\/\/|^\s*www\./i.test(value)
}

/**
 * Put values into text. `flat` is the text `source` is a part of, starting
 * at `offset` in it (the whole of it, for a subject). A value that must
 * stand alone and does not is left as written; one that does is wrapped in
 * marks so the finished text can be checked again.
 */
function fill(source: string, filling: Filling, flat: string = source, offset = 0): string {
  return source.replace(VARIABLE, (whole, name: string, at: number) => {
    if (!(name in filling.variables)) return whole
    const value = filling.variables[name].replace(MARKS, '')
    if (!mustStandAlone(name, value, filling.strict)) return value
    const start = offset + at
    if (!standsAlone(flat, start, start + whole.length)) {
      filling.refused.add(name)
      return whole
    }
    return `${VALUE_OPEN}${value}${VALUE_CLOSE}`
  })
}

/**
 * The last word on a finished text: every marked value stands alone in it.
 * `fill` decided the same on the template; this reads what will be sent.
 */
function unmark(text: string): string {
  let at = text.indexOf(VALUE_OPEN)
  while (at >= 0) {
    const close = text.indexOf(VALUE_CLOSE, at)
    if (close < 0 || !standsAlone(text, at, close + 1)) {
      throw new Error('An email template puts a link where it would become part of another address')
    }
    at = text.indexOf(VALUE_OPEN, close)
  }
  return text.replace(MARKS, '')
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
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'table', 'hr'])

/** One stretch of the plain-text body: a text node of the tree, or something the text part adds. */
interface Piece {
  text: string
  /** The text node this stretch is, when it is one. */
  node?: ChildNode
}

/**
 * Apply the address rule to every attribute of the parsed, sanitized body
 * and read the body off as the pieces of its plain text, values not yet in.
 *
 * An `href` or `src` gets the address `resolveAddress` vouches for; every
 * other attribute that holds a `{` is removed, so there is no attribute a
 * template can use to carry a value anywhere. The tree is the one the
 * sanitizer parsed, so quoting, entities, case and whitespace in the
 * template's markup have already been read the only way they will be.
 *
 * The pieces are the plain-text part in full: the text nodes, the line
 * breaks between blocks, an image's alternative text, and a link's address
 * after its words. Values are put into this one string (`fillPieces`), and
 * the HTML's text nodes are the same pieces, so the two parts of an email
 * cannot disagree about what a value stands next to.
 */
function readTree(root: ParentNode, filling: Filling): Piece[] {
  const pieces: Piece[] = []
  const visit = (parent: ParentNode): void => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === TEXT_NODE) {
        pieces.push({ text: (node.textContent ?? '').replace(MARKS, ''), node })
        continue
      }
      if (node.nodeType !== ELEMENT_NODE) {
        node.parentNode?.removeChild(node)
        continue
      }
      const element = node as Element
      const tag = element.tagName.toLowerCase()
      /** The link's address as the text part shows it: the variable it is, or the address written out. */
      let shown = ''
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase()
        if ((tag === 'a' && name === 'href') || (tag === 'img' && name === 'src')) {
          const written = attribute.value.trim()
          const resolved = resolveAddress(written, filling.variables, filling.strict, tag === 'a')
          element.setAttribute(attribute.name, resolved)
          if (tag === 'a' && resolved !== '#') shown = written.includes('{') ? written : resolved
        } else if (attribute.value.includes('{')) {
          element.removeAttribute(attribute.name)
        }
      }
      const inline = INLINE_TAGS.has(tag)
      if (tag === 'br') pieces.push({ text: '\n' })
      else if (tag === 'img') pieces.push({ text: ` ${(element.getAttribute('alt') ?? '').replace(MARKS, '')} ` })
      else if (tag === 'li') pieces.push({ text: '\n- ' })
      else if (!inline) pieces.push({ text: '\n' })
      const before = pieces.length
      visit(element)
      if (tag === 'a' && shown) {
        const words = pieces.slice(before).map((piece) => piece.text).join('').trim()
        if (words !== shown) pieces.push({ text: ` (${shown})` })
      } else if (tag === 'th' || tag === 'td') pieces.push({ text: '  ' })
      else if (BLOCK_TAGS.has(tag)) pieces.push({ text: '\n\n' })
      else if (!inline) pieces.push({ text: '\n' })
    }
  }
  visit(root)
  return pieces
}

/** Put the values into the pieces, write them back to the tree's text nodes, and return the plain text. */
function fillPieces(pieces: Piece[], filling: Filling): string {
  const flat = pieces.map((piece) => piece.text).join('')
  let offset = 0
  let text = ''
  for (const piece of pieces) {
    const filled = fill(piece.text, filling, flat, offset)
    offset += piece.text.length
    text += filled
    if (piece.node) piece.node.textContent = filled.replace(MARKS, '')
  }
  return unmark(text)
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
  const filling: Filling = { variables, strict, refused: new Set() }
  const body = sanitizeToFragment(
    renderMarkdownToHtml(template.body),
    strict ? PLUGIN_MAIL_BODY_CONFIG : MAIL_BODY_CONFIG,
  )
  // No parser, no email: the rules above are only as good as the tree they run on.
  if (!body) throw new Error('An email cannot be rendered without an HTML parser')
  const text = fillPieces(readTree(body, filling), filling)
  const holder = body.ownerDocument.createElement('div')
  holder.appendChild(body)
  return {
    subject: singleLine(unmark(fill(singleLine(template.subject), filling))),
    text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    html: wrapInLayout(holder.innerHTML, siteName),
    refused: [...filling.refused],
  }
}

/** The preview values of a template's variables. */
export function sampleMailVariables(variables: readonly MailTemplateVariable[]): Record<string, string> {
  return Object.fromEntries(variables.map((variable) => [variable.name, variable.sample]))
}
