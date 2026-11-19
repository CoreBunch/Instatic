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
   * Names the wording puts in braces that are not variables of this
   * template (a typo, a variable an upgrade removed). Only reported for a
   * template that says which variables it has. They are left as written,
   * and the email must not be sent. Braces meant literally are written `\{`.
   */
  unknown: string[]
  /**
   * Variables the template declares and its wording uses that were given no
   * value (for a link, an empty one counts as none). They are left as
   * written, and the email must not be sent.
   */
  missing: string[]
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

/** Stands, in the text a value is checked against, for a line break written inside a paragraph. */
const SOFT_BREAK = '\uE002'
const SPACE = /[ \t\n\r\f\uE002]/
/** A run of characters a mail client may take for (part of) an address. */
const ADDRESS_LIKE_RUN = /[/@=?&%#]|\.[a-z0-9]|www/i

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
 *
 * Two more things do not separate, because clients join across them: a line
 * break inside a paragraph when what is on the other side of it reads as an
 * address, and anything at all between a `<` and its `>` (the way a long
 * address is written across lines).
 */
function standsAlone(text: string, start: number, end: number): boolean {
  let from = start
  let to = end
  while (from > 0 && !SPACE.test(text[from - 1])) from -= 1
  while (to < text.length && !SPACE.test(text[to])) to += 1
  if (!/^[("']*$/.test(text.slice(from, start)) || !/^[.,;:!?)"']*$/.test(text.slice(end, to))) return false

  // The neighbouring run on each side, when only a soft break (and blanks) lies between.
  let gap = from
  while (gap > 0 && /[ \t\uE002]/.test(text[gap - 1])) gap -= 1
  if (text.slice(gap, from).includes(SOFT_BREAK)) {
    let run = gap
    while (run > 0 && !SPACE.test(text[run - 1])) run -= 1
    if (ADDRESS_LIKE_RUN.test(text.slice(run, gap))) return false
  }
  gap = to
  while (gap < text.length && /[ \t\uE002]/.test(text[gap])) gap += 1
  if (text.slice(to, gap).includes(SOFT_BREAK)) {
    let run = gap
    while (run < text.length && !SPACE.test(text[run])) run += 1
    if (ADDRESS_LIKE_RUN.test(text.slice(gap, run))) return false
  }

  // Inside `<...>`, within the paragraph.
  const blockStart = text.lastIndexOf('\n', start - 1) + 1
  const nextBreak = text.indexOf('\n', end)
  const before = text.slice(blockStart, start)
  const after = text.slice(end, nextBreak < 0 ? text.length : nextBreak)
  const opened = before.lastIndexOf('<') > before.lastIndexOf('>')
  const closes = after.indexOf('>')
  const reopens = after.indexOf('<')
  if (opened && closes >= 0 && (reopens < 0 || closes < reopens)) return false
  return true
}

/** A text that `source` is read as a part of, and where in it `source` starts. */
interface Reading {
  flat: string
  offset: number
}

/** How values are put into one template: for whom the stand-alone rule holds, and what it turned away. */
interface Filling {
  variables: MailVariables
  /** The variables the template declares as links (`kind: 'link'`). */
  links: ReadonlySet<string>
  /** A plugin's template: no images, and only `https` in an address written out. */
  strict: boolean
  /** Every variable the template declares, when it says: only those can be missing rather than merely unknown. */
  declared: ReadonlySet<string>
  refused: Set<string>
  missing: Set<string>
  /** Null when the template did not say which variables it has. */
  unknown: Set<string> | null
}

/** Whether a declared variable was given no usable value. An empty text is a value; an empty link is not. */
function isMissing(name: string, filling: Filling): boolean {
  if (!filling.declared.has(name)) return false
  const value = filling.variables[name]
  return value === undefined || (filling.links.has(name) && value.trim() === '')
}

/** Thrown where there is no DOM to parse an email body with. The server and the admin always have one. */
export class MailRendererUnavailableError extends Error {
  constructor() {
    super('An email cannot be rendered without an HTML parser')
    this.name = 'MailRendererUnavailableError'
  }
}

/** A value that reads as an address, whatever it was declared as. */
const ADDRESS_VALUE = /^\s*[a-z][a-z0-9+.-]*:|:\/\/|^\s*www\./i

/**
 * Whether a variable's value may only be put where it stands alone: a
 * variable declared a link, and (for a template that says nothing about its
 * variables, or a value that turns out to be one anyway) any value that is
 * an address. The site's own name and address are public and exempt.
 */
function mustStandAlone(name: string, value: string, filling: Filling): boolean {
  if (name.startsWith('site.')) return false
  return filling.links.has(name) || ADDRESS_VALUE.test(value)
}

/** Zero-width characters and the marks that reorder text. They show nothing and are taken out of a value. */
const INVISIBLE_CHARACTERS = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/**
 * A value as it is sent: itself, with the invisible characters taken out.
 * Nothing a reader can see is changed (`x²`, `™` and `…` stay as written).
 */
export function cleanMailValue(value: string): string {
  return value.replace(INVISIBLE_CHARACTERS, '')
}

/**
 * A text as it is read for addresses, never as it is sent: compatibility
 * forms folded (NFKC, so full-width letters and dots read as plain ones),
 * the ideographic full stops made `.`, and an ellipsis, written `…` or as a
 * row of dots, made a space: it ends a word, it does not join two.
 */
function foldedForCheck(text: string): string {
  return text
    .replace(/\u2026/g, ' ')
    .normalize('NFKC')
    .replace(/[\u3002\uff0e\uff61]/g, '.')
    .replace(/\.{2,}/g, ' ')
}

/** Whether a value holds a control character (tab and line breaks aside) or a line or paragraph separator. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x7f || code === 0x2028 || code === 0x2029) return true
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true
    if (code >= 0x80 && code <= 0x9f) return true
  }
  return false
}

/**
 * What in a piece of text could become a clickable address, or null. One
 * simple, conservative rule rather than a guess at what each mail client
 * links: a scheme, `www.`, an `@`, a `.` or `:` or `/` or `\` that joins two
 * things (digits on both sides of a `.` or `:` aside, so `3.5` and `12:30`
 * are fine), or four dotted numbers. It refuses honest text too (`node.js`,
 * `and/or`): that is the price of the rule being simple.
 */
function addressInText(written: string): string | null {
  const text = foldedForCheck(written)
  if (text.includes('://') || /www\./i.test(text)) return 'a web address'
  if (/\S@\S/.test(text)) return 'an `@` between two words'
  if (/\d+\.\d+\.\d+\.\d+/.test(text) || text.includes('::')) return 'a numeric address'
  for (let index = 1; index < text.length - 1; index += 1) {
    if (text[index] !== '.' && text[index] !== ':') continue
    const before = text[index - 1]
    const after = text[index + 1]
    if (/\s/.test(before) || /\s/.test(after)) continue
    if (!(/\d/.test(before) && /\d/.test(after))) return 'a `.` or `:` that joins two words'
  }
  if (/\S[/\\]\S/.test(text)) return 'a `/` or `\\` that joins two words'
  return null
}

/**
 * Why a value may not be sent in a variable of this kind, or null when it
 * may. Checked on the cleaned value (`cleanMailValue`). A `link` must be an
 * `http(s)` address. A `text` value must not contain what could become a
 * clickable address (`addressInText`): the owner approved a template's
 * wording, and a value must not be a way to put a link into it that the
 * owner never saw. A best-effort barrier, not a guarantee: see the threat
 * model in `docs/features/email.md`.
 */
export function mailValueProblem(kind: 'text' | 'link' | undefined, value: string): string | null {
  const cleaned = cleanMailValue(value)
  if (hasControlCharacter(cleaned)) return 'contains a control character'
  if (kind !== 'link' && cleaned.trim() === '' && value !== '') return 'is only invisible characters'
  if (kind === 'link') return isWebAddress(cleaned.trim(), false) ? null : 'is not an http(s) address'
  const found = addressInText(cleaned)
  return found ? `contains ${found}; only a variable declared \`kind: "link"\` may carry an address` : null
}

/**
 * Whether a `text` variable in a plugin's template sits where its value
 * could become part of an address: in the same run of characters as
 * another variable with no sentence punctuation between them
 * (`{host}.{domain}`), or as text the value rule itself would refuse
 * (`www.{name}`, `{user}@corp`, `shop.example/{id}`). Checked twice: on the
 * template as written, which is what the manifest parser and the lint see,
 * and on the run as it will be sent, with the actual value in place, so a
 * value such as `.example` or `evil.` cannot finish an address the
 * template only began.
 */
function composesAddress(text: string, start: number, end: number, value: string, filling: Filling): boolean {
  let from = start
  let to = end
  while (from > 0 && !SPACE.test(text[from - 1])) from -= 1
  while (to < text.length && !SPACE.test(text[to])) to += 1
  // The stretch between sentence punctuation (a `.` or `:` is not a break here: they join).
  let left = start
  let right = end
  while (left > from && !/[,;!?()"']/.test(text[left - 1])) left -= 1
  while (right < to && !/[,;!?()"']/.test(text[right])) right += 1
  const beside = text.slice(left, start) + text.slice(end, right)
  if (beside.includes('{') || beside.includes(VALUE_OPEN)) return true
  // Sentence punctuation around the variable is not text it can join with.
  const written = { before: text.slice(from, start), after: text.slice(end, to) }
  const before = /^[("']*$/.test(written.before) ? '' : written.before
  const after = /^[.,;:!?)"']*$/.test(written.after) ? '' : written.after
  // A value that begins or ends with a joining character joins whatever it touches.
  if (before !== '' && /^[.:/\\@]/.test(value)) return true
  if (after !== '' && /[.:/\\@]$/.test(value)) return true
  // The run as the template is written (a stand-in for every value), and the
  // run as it will be sent, with this value and its neighbours' in place.
  const others = (stretch: string) =>
    stretch.replace(VARIABLE, (whole, name: string) =>
      name in filling.variables ? cleanMailValue(filling.variables[name]) : whole,
    )
  return (
    addressInText(`${before}x${after}`.replace(VARIABLE, 'x')) !== null ||
    addressInText(`${others(before)}${value}${others(after)}`) !== null
  )
}


/**
 * Put values into text. Each reading is a text `source` is a part of (the
 * whole of it, for a subject). A value that must stand alone and does not,
 * in any one of them, is left as written; one that does is wrapped in marks
 * so the finished text can be checked again.
 */
function fill(
  source: string,
  filling: Filling,
  readings: readonly Reading[] = [{ flat: source, offset: 0 }],
): string {
  return source.replace(VARIABLE, (whole, name: string, at: number) => {
    if (filling.unknown && !filling.declared.has(name) && !SITE_VARIABLE_NAMES.has(name)) {
      filling.unknown.add(name)
      return whole
    }
    if (isMissing(name, filling)) {
      filling.missing.add(name)
      return whole
    }
    if (!(name in filling.variables)) return whole
    // The site's own values are the site's: sent exactly as they are.
    const given = filling.variables[name]
    const value = (name.startsWith('site.') ? given : cleanMailValue(given)).replace(MARKS, '')
    if (!mustStandAlone(name, value, filling)) {
      // In a plugin's template a text value may sit in a sentence, but not where it would help spell an address.
      const composes =
        filling.strict &&
        !name.startsWith('site.') &&
        readings.some(({ flat, offset }) => composesAddress(flat, offset + at, offset + at + whole.length, value, filling))
      if (!composes) return value
      filling.refused.add(name)
      return whole
    }
    const alone = readings.every(({ flat, offset }) => standsAlone(flat, offset + at, offset + at + whole.length))
    if (!alone) {
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
/** The variables every template has without declaring them. */
const SITE_VARIABLE_NAMES: ReadonlySet<string> = new Set(['site.name', 'site.url'])

/** Stands for a `{` the template wrote as `\{`: a brace that opens no variable. Put back at the end. */
const ESCAPED_BRACE = '\uE003'

export function unknownMailVariables(source: string, known: readonly MailTemplateVariable[]): string[] {
  const names = new Set(known.map((variable) => variable.name))
  const unknown = new Set<string>()
  // `\{name}` is the way to write braces that are not a variable.
  for (const match of source.replace(/\\\{/g, '').matchAll(VARIABLE)) {
    if (!names.has(match[1]) && !SITE_VARIABLE_NAMES.has(match[1])) unknown.add(match[1])
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
function resolveAddress(raw: string, filling: Filling, link: boolean): string {
  const { variables, strict } = filling
  const target = raw.trim()
  if (target.includes('{')) {
    const whole = WHOLE_VARIABLE.exec(target)
    if (whole && filling.unknown && !filling.declared.has(whole[1]) && !SITE_VARIABLE_NAMES.has(whole[1])) {
      filling.unknown.add(whole[1])
    } else if (whole && isMissing(whole[1], filling)) filling.missing.add(whole[1])
    const value = whole && whole[1] in variables ? variables[whole[1]].trim() : null
    return value !== null && isWebAddress(value, false) ? value : '#'
  }
  if (isWebAddress(target, strict)) return target
  if (link && !strict && /^mailto:/i.test(target) && isSafeUrl(target)) return target
  return '#'
}

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'table', 'hr'])
/**
 * The only elements that put space between the text before and after them
 * when an email is displayed. Everything else is inline, an image included:
 * text on both sides of it reads as one run, and is checked as one.
 */
const SEPARATING_TAGS = new Set([...BLOCK_TAGS, 'br', 'li', 'thead', 'tbody', 'tr', 'th', 'td'])

/** One stretch of the plain-text body: a text node of the tree, or something the text part adds. */
interface Piece {
  text: string
  /** The text node this stretch is, when it is one. */
  node?: ChildNode
  /** In the plain-text part only: a link's address after its words. The displayed HTML has no such text. */
  textOnly?: true
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
          const resolved = resolveAddress(written, filling, tag === 'a')
          element.setAttribute(attribute.name, resolved)
          if (tag === 'a' && resolved !== '#') shown = written.includes('{') ? written : resolved
        } else if (attribute.value.includes('{')) {
          element.removeAttribute(attribute.name)
        }
      }
      const separates = SEPARATING_TAGS.has(tag)
      if (tag === 'br') pieces.push({ text: '\n' })
      // Inline, so nothing is added around it: an empty alternative text is nothing at all.
      else if (tag === 'img') pieces.push({ text: (element.getAttribute('alt') ?? '').replace(MARKS, '') })
      else if (tag === 'li') pieces.push({ text: '\n- ' })
      else if (separates) pieces.push({ text: '\n' })
      const before = pieces.length
      visit(element)
      if (tag === 'a' && shown) {
        const words = pieces.slice(before).map((piece) => piece.text).join('').trim()
        if (words !== shown) pieces.push({ text: ` (${shown})`, textOnly: true })
      } else if (tag === 'th' || tag === 'td') pieces.push({ text: '  ' })
      else if (BLOCK_TAGS.has(tag)) pieces.push({ text: '\n\n' })
      else if (separates) pieces.push({ text: '\n' })
    }
  }
  visit(root)
  return pieces
}

/**
 * Put the values into the pieces, write them back to the tree's text nodes,
 * and return the plain text.
 *
 * The body is read two ways, and a value must stand alone in both: as the
 * plain-text part (every piece), and as the HTML part is displayed (without
 * what only the text part adds, so text on both sides of a link is one run
 * there, as it is on screen).
 */
function fillPieces(pieces: Piece[], filling: Filling): string {
  // A line break written inside a paragraph is told apart from one between
  // blocks: `standsAlone` treats the two differently.
  const checked = (piece: Piece) => (piece.node ? piece.text.replace(/[\n\r]/g, SOFT_BREAK) : piece.text)
  const asText = pieces.map(checked).join('')
  const asDisplayed = pieces.filter((piece) => !piece.textOnly).map(checked).join('')
  let textOffset = 0
  let displayedOffset = 0
  let text = ''
  let checkedText = ''
  let checkedDisplayed = ''
  for (const piece of pieces) {
    const readings: Reading[] = [{ flat: asText, offset: textOffset }]
    if (!piece.textOnly) readings.push({ flat: asDisplayed, offset: displayedOffset })
    const filled = fill(piece.text, filling, readings)
    textOffset += piece.text.length
    text += filled
    checkedText += checked({ ...piece, text: filled })
    if (!piece.textOnly) {
      displayedOffset += piece.text.length
      checkedDisplayed += checked({ ...piece, text: filled })
    }
    if (piece.node) piece.node.textContent = filled.replace(MARKS, '')
  }
  // The backstop: both finished readings, as they will be sent.
  unmark(checkedDisplayed)
  unmark(checkedText)
  return text.replace(MARKS, '')
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
  template: { key?: string; subject: string; body: string; variables?: readonly MailTemplateVariable[] },
  variables: MailVariables,
): RenderedMail {
  const siteName = variables['site.name'] ?? ''
  const strict = isPluginMailTemplateKey(template.key)
  const links = new Set((template.variables ?? []).filter((variable) => variable.kind === 'link').map((variable) => variable.name))
  const declared = new Set((template.variables ?? []).map((variable) => variable.name))
  const filling: Filling = {
    variables,
    links,
    strict,
    declared,
    refused: new Set(),
    missing: new Set(),
    unknown: template.variables ? new Set() : null,
  }
  // `\{` is a brace, not the start of a variable. It is set aside before
  // anything reads the template and put back when everything has.
  const escaped = (source: string) => source.replace(/\uE003/g, '').replace(/\\\{/g, ESCAPED_BRACE)
  const restored = (output: string) => output.replace(/\uE003/g, '{')
  const body = sanitizeToFragment(
    renderMarkdownToHtml(escaped(template.body)),
    strict ? PLUGIN_MAIL_BODY_CONFIG : MAIL_BODY_CONFIG,
  )
  // No parser, no email: the rules above are only as good as the tree they run on.
  if (!body) throw new MailRendererUnavailableError()
  const text = fillPieces(readTree(body, filling), filling)
  const holder = body.ownerDocument.createElement('div')
  holder.appendChild(body)
  return {
    subject: restored(singleLine(unmark(fill(singleLine(escaped(template.subject)), filling)))),
    text: restored(text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()),
    html: restored(wrapInLayout(holder.innerHTML, siteName)),
    refused: [...filling.refused],
    missing: [...filling.missing],
    unknown: [...(filling.unknown ?? [])],
  }
}

/** The preview values of a template's variables. */
export function sampleMailVariables(variables: readonly MailTemplateVariable[]): Record<string, string> {
  return Object.fromEntries(variables.map((variable) => [variable.name, variable.sample]))
}
