/**
 * CSS class tokens embedded in selector text.
 *
 * A style rule can be node-assignable even when its selector is more than a
 * bare class:
 *
 *   .hover\:bg-blue-700:hover
 *   .group:hover .group-hover\:block
 *   .space-x-4 > :not([hidden]) ~ :not([hidden])
 *
 * The importer, class rename path, usage index, and publisher tree-shaker all
 * need to agree on the decoded class names carried by those selectors. This
 * module is the one dependency-free lexer they share.
 */

export interface CssSelectorClassToken {
  /** Class-attribute value after decoding CSS identifier escapes. */
  name: string
  /** Offset of the leading `.` in the selector string. */
  start: number
  /** Exclusive end offset of the escaped identifier. */
  end: number
  /** Functional-pseudo nesting depth at the leading `.`. */
  functionalDepth: number
}

function isHexDigit(char: string): boolean {
  return /^[0-9a-fA-F]$/.test(char)
}

function isIdentifierChar(char: string): boolean {
  if (!char) return false
  const codePoint = char.codePointAt(0) ?? 0
  return /[\w-]/.test(char) || codePoint >= 0x80
}

function consumeCssEscape(
  source: string,
  slashIndex: number,
): { decoded: string; end: number } | null {
  if (source[slashIndex] !== '\\' || slashIndex + 1 >= source.length) return null

  let index = slashIndex + 1
  if (isHexDigit(source[index])) {
    const hexStart = index
    while (index < source.length && index - hexStart < 6 && isHexDigit(source[index])) {
      index += 1
    }
    const codePoint = Number.parseInt(source.slice(hexStart, index), 16)
    if (/\s/.test(source[index] ?? '')) index += 1
    const decoded =
      codePoint === 0 || codePoint > 0x10ffff
        ? '\uFFFD'
        : String.fromCodePoint(codePoint)
    return { decoded, end: index }
  }

  const decoded = source[index]
  return { decoded, end: index + 1 }
}

function readClassToken(
  selector: string,
  dotIndex: number,
): Omit<CssSelectorClassToken, 'functionalDepth'> | null {
  let index = dotIndex + 1
  let name = ''

  while (index < selector.length) {
    const char = selector[index]
    if (char === '\\') {
      const escape = consumeCssEscape(selector, index)
      if (!escape) break
      name += escape.decoded
      index = escape.end
      continue
    }
    if (!isIdentifierChar(char)) break
    name += char
    index += char.length
  }

  if (!name) return null
  return {
    name,
    start: dotIndex,
    end: index,
  }
}

/**
 * Extract class selectors while ignoring dots inside quoted strings and
 * attribute selectors. Functional pseudos remain searchable, so
 * `:not(.disabled)` correctly contributes `disabled`.
 */
export function extractCssSelectorClasses(selector: string): CssSelectorClassToken[] {
  const tokens: CssSelectorClassToken[] = []
  let quote: '"' | "'" | null = null
  let attributeDepth = 0
  let functionalDepth = 0

  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[') {
      attributeDepth += 1
      continue
    }
    if (char === ']') {
      attributeDepth = Math.max(0, attributeDepth - 1)
      continue
    }
    if (attributeDepth > 0) continue
    if (char === '\\') {
      const escape = consumeCssEscape(selector, index)
      if (escape) index = escape.end - 1
      continue
    }
    if (char === '(') {
      functionalDepth += 1
      continue
    }
    if (char === ')') {
      functionalDepth = Math.max(0, functionalDepth - 1)
      continue
    }
    if (char !== '.') continue

    const token = readClassToken(selector, index)
    if (!token) continue
    tokens.push({ ...token, functionalDepth })
    index = token.end - 1
  }

  return tokens
}

/** Split a selector list without treating commas inside functions/attrs as separators. */
export function splitCssSelectorList(selector: string): string[] {
  const parts: string[] = []
  let start = 0
  let quote: '"' | "'" | null = null
  let bracketDepth = 0
  let parenDepth = 0

  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '[') bracketDepth += 1
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    else if (char === '(') parenDepth += 1
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1)
    else if (char === ',' && bracketDepth === 0 && parenDepth === 0) {
      const part = selector.slice(start, index).trim()
      if (part) parts.push(part)
      start = index + 1
    }
  }

  const tail = selector.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

const COMBINATOR_CHARS = new Set([' ', '\t', '\n', '\f', '\r', '>', '+', '~'])

/**
 * The subject compound of a single selector part — everything after the last
 * top-level combinator. Combinators inside attribute selectors, functional
 * pseudos, and quoted strings do not split the selector.
 */
function subjectCompound(part: string): string {
  let quote: '"' | "'" | null = null
  let bracketDepth = 0
  let parenDepth = 0
  let subjectStart = 0

  for (let index = 0; index < part.length; index += 1) {
    const char = part[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '[') bracketDepth += 1
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    else if (char === '(') parenDepth += 1
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1)
    else if (bracketDepth === 0 && parenDepth === 0 && COMBINATOR_CHARS.has(char)) {
      subjectStart = index + 1
    }
  }

  return part.slice(subjectStart)
}

/** Count the class tokens a compound binds directly (ignoring `:not()` / `:is()` interiors). */
function subjectClassCount(part: string): number {
  return extractCssSelectorClasses(subjectCompound(part)).filter(
    (token) => token.functionalDepth === 0,
  ).length
}

/**
 * The class token a selector rule should expose in the class picker.
 *
 * The rightmost class selector is the styled subject for descendant variants
 * (`.group:hover .group-hover\:block`). If every comma-list alternative has
 * the same subject class, the whole list is bindable to that one class.
 * Callers normally split lists first, but the all-equal behavior keeps this
 * helper safe for hand-authored selector lists too.
 *
 * A subject compound stacking two or more classes (`.drawer.is-open`) has no
 * unambiguous binding: either token could be the one authored onto the node,
 * and the other commonly arrives at runtime (a state class toggled by a
 * script). Returning null classifies the rule as ambient, so it emits whenever
 * its class dependencies can match instead of requiring a node assignment that
 * a runtime-only class can never provide.
 */
export function selectorBindingClassName(selector: string): string | null {
  let binding: string | null = null
  for (const part of splitCssSelectorList(selector)) {
    if (subjectClassCount(part) > 1) return null
    const tokens = extractCssSelectorClasses(part).filter(
      (token) => token.functionalDepth === 0,
    )
    const candidate = tokens.at(-1)?.name ?? null
    if (!candidate) return null
    if (binding !== null && binding !== candidate) return null
    binding = candidate
  }
  return binding
}

/**
 * Rename one decoded class token everywhere it appears in a selector.
 * Replacement runs from right to left so offsets remain valid.
 */
export function replaceCssSelectorClassName(
  selector: string,
  fromName: string,
  toEscapedName: string,
): string {
  const matches = extractCssSelectorClasses(selector).filter((token) => token.name === fromName)
  let result = selector
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const token = matches[index]
    result = `${result.slice(0, token.start + 1)}${toEscapedName}${result.slice(token.end)}`
  }
  return result
}
