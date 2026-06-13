/**
 * fontTokens — pull font-family custom properties out of root-scope rules so
 * imported CSS can keep `font-family: var(--font-...)` references while the
 * builder exposes those variables as editable font tokens.
 */

import {
  normalizeFontTokenVariable,
  sanitizeFontFallbackStack,
} from '@core/fonts'
import type { NewStyleRule, ImportFontToken } from './types'
import { isRootScopeSelector } from './rootScope'

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
])

const LENGTH_OR_NUMBER_RE = /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|ch|ex|vw|vh|vmin|vmax|%|pt|pc|in|cm|mm)?$/i

function splitFontStack(raw: string): string[] {
  const parts: string[] = []
  let start = 0
  let quote: '"' | "'" | null = null

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if ((ch === '"' || ch === "'") && raw[i - 1] !== '\\') {
      quote = quote === ch ? null : quote ?? ch
      continue
    }
    if (ch === ',' && !quote) {
      const part = raw.slice(start, i).trim()
      if (part) parts.push(part)
      start = i + 1
    }
  }

  const tail = raw.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

function unquoteFamily(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

function tokenNameFromVariable(variable: string): string {
  const base = normalizeFontTokenVariable(variable).replace(/^font-/, '')
  const words = base.split('-').filter(Boolean)
  if (words.length === 0) return 'Font'
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(' ')
}

function isGenericFamily(raw: string): boolean {
  return GENERIC_FAMILIES.has(unquoteFamily(raw).toLowerCase())
}

function isFontFamilyLike(raw: string): boolean {
  const value = raw.trim()
  if (!value) return false
  if (/[{};]/.test(value)) return false
  if (/url\(|calc\(|var\(/i.test(value)) return false
  if (LENGTH_OR_NUMBER_RE.test(value)) return false

  const parts = splitFontStack(value)
  if (parts.length === 0) return false
  if (parts.some((part) => isGenericFamily(part))) return true
  if (parts.length > 1) return true
  return /^['"].+['"]$/.test(parts[0])
}

function importTokenFromDeclaration(prop: string, value: string): ImportFontToken | null {
  if (!prop.startsWith('--font-')) return null
  if (!isFontFamilyLike(value)) return null

  const variable = normalizeFontTokenVariable(prop)
  const parts = splitFontStack(value)
  if (parts.length === 0) return null

  const first = parts[0]
  const family = isGenericFamily(first) ? undefined : unquoteFamily(first)
  const fallbackParts = family ? parts.slice(1) : parts
  const fallback = sanitizeFontFallbackStack(fallbackParts.join(', '))

  return {
    name: tokenNameFromVariable(variable),
    variable,
    ...(family ? { family } : {}),
    fallback,
  }
}

/**
 * Pull font-family custom properties out of root-scope ambient rules.
 *
 * Only `--font-*` declarations with font-family-like values are extracted.
 * Sizing variables such as `--font-size-base: 16px` remain in the rule.
 */
export function extractRootFontTokens(
  rules: NewStyleRule[],
): { rules: NewStyleRule[]; fontTokens: ImportFontToken[] } {
  const fontTokens: ImportFontToken[] = []
  const out: NewStyleRule[] = []

  for (const rule of rules) {
    if (rule.kind !== 'ambient' || !isRootScopeSelector(rule.selector)) {
      out.push(rule)
      continue
    }

    const remaining: Record<string, unknown> = {}
    for (const [prop, value] of Object.entries(rule.styles)) {
      const token = typeof value === 'string' ? importTokenFromDeclaration(prop, value.trim()) : null
      if (token) fontTokens.push(token)
      else remaining[prop] = value
    }

    const hasContext = Object.keys(rule.contextStyles ?? {}).length > 0
    if (Object.keys(remaining).length > 0 || hasContext) {
      out.push({ ...rule, styles: remaining })
    }
  }

  return { rules: out, fontTokens }
}
