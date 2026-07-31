import {
  assertValidCssClassName,
  classKindSelector,
  isGeneratedClassLocked,
  replaceCssSelectorClassName,
  type StyleRule,
} from '@core/page-tree'

/**
 * Defensive selector validity check using the browser CSS parser. `CSS.supports`
 * validates pseudo-elements and unknown pseudo-classes; stylesheet parsing
 * keeps selector lists valid in older engines that lack selector() support.
 */
export function isValidCssSelector(selector: string): boolean {
  const cssSupportsResult = validateSelectorListWithCssSupports(selector)
  if (cssSupportsResult !== null) return cssSupportsResult

  const stylesheetResult = validateSelectorRuleWithStylesheet(selector)
  if (stylesheetResult !== null) return stylesheetResult

  if (typeof document === 'undefined') return true
  try {
    document.createDocumentFragment().querySelector(selector)
    return true
  } catch {
    return false
  }
}

function validateSelectorListWithCssSupports(selector: string): boolean | null {
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    try {
      if (!CSS.supports('selector(*)')) return null
      const selectors = splitTopLevelSelectorList(selector)
      if (selectors.length === 0 || selectors.some((part) => part.length === 0)) return false
      return selectors.every((part) => CSS.supports(`selector(${part})`))
    } catch {
      return false
    }
  }

  return null
}

type CssStyleSheetConstructor = new () => CSSStyleSheet

function validateSelectorRuleWithStylesheet(selector: string): boolean | null {
  const Sheet = typeof CSSStyleSheet !== 'undefined'
    ? CSSStyleSheet
    : typeof window !== 'undefined' && typeof window.CSSStyleSheet === 'function'
      ? window.CSSStyleSheet
      : null
  if (!Sheet) return null

  try {
    const sheet = new (Sheet as CssStyleSheetConstructor)()
    const rule = `${selector} {}`
    if (typeof sheet.replaceSync === 'function') {
      sheet.replaceSync(rule)
    } else {
      sheet.insertRule(rule, 0)
    }
    return sheet.cssRules.length > 0
  } catch {
    return false
  }
}

function splitTopLevelSelectorList(selector: string): string[] {
  const parts: string[] = []
  let current = ''
  let bracketDepth = 0
  let parenDepth = 0
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const char of selector) {
    current += char

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (quote) {
      if (char === quote) quote = null
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === '[') {
      bracketDepth += 1
      continue
    }

    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
      continue
    }

    if (char === '(') {
      parenDepth += 1
      continue
    }

    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
      continue
    }

    if (char === ',' && bracketDepth === 0 && parenDepth === 0) {
      parts.push(current.slice(0, -1).trim())
      current = ''
    }
  }

  parts.push(current.trim())
  return parts
}

export function renameStyleRule(
  styleRules: Record<string, StyleRule>,
  classId: string,
  name: string,
): boolean {
  const rule = styleRules[classId]
  if (!rule || isGeneratedClassLocked(rule)) return false

  const trimmed = name.trim()
  if ((rule.kind ?? 'class') === 'ambient') {
    if (trimmed.length === 0) throw new Error('[classSlice] Ambient selector cannot be empty')
    if (!isValidCssSelector(trimmed)) throw new Error(`[classSlice] Invalid CSS selector: ${trimmed}`)
    if (Object.is(rule.selector, trimmed) && Object.is(rule.name, trimmed)) return false

    rule.name = trimmed
    rule.selector = trimmed
    rule.updatedAt = Date.now()
    return true
  }

  assertValidCssClassName(trimmed)
  const escapedName = classKindSelector(trimmed).slice(1)
  const renamedSelector = replaceCssSelectorClassName(rule.selector, rule.name, escapedName)
  const selector = renamedSelector === rule.selector && rule.name !== trimmed
    ? classKindSelector(trimmed)
    : renamedSelector
  if (Object.is(rule.name, trimmed) && Object.is(rule.selector, selector)) return false

  const existing = Object.values(styleRules).find(
    (candidate) =>
      (candidate.kind ?? 'class') === 'class' &&
      candidate.name === trimmed &&
      candidate.id !== classId,
  )
  if (existing) throw new Error(`[classSlice] A class named "${trimmed}" already exists`)

  rule.name = trimmed
  rule.selector = selector
  rule.updatedAt = Date.now()
  return true
}
