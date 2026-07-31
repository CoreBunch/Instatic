import { formatVariant } from '@core/fonts'
import type { ParsedFontFace } from './types'

/**
 * Read every url(...) payload from a declaration value. The CSSOM has already
 * validated the declaration, so this scanner only needs to preserve the
 * quoted or unquoted payloads for later asset resolution.
 */
export function extractUrlPayloads(value: string): string[] {
  const result: string[] = []
  const pattern = /url\(\s*(['"]?)([^'")\n]*)\1\s*\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    const rawUrl = match[2].trim()
    if (rawUrl) result.push(rawUrl)
  }
  return result
}

function unquoteFamily(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function fontFaceVariant(declarations: CSSStyleDeclaration): string {
  const weightRaw = (declarations.getPropertyValue('font-weight') || '').trim().toLowerCase()
  const styleRaw = (declarations.getPropertyValue('font-style') || '').trim().toLowerCase()

  let weight = 400
  if (weightRaw === 'bold') weight = 700
  else if (weightRaw !== 'normal' && weightRaw !== '') {
    const firstNumber = weightRaw.match(/\d{2,3}/)
    if (firstNumber) weight = Number(firstNumber[0])
  }

  const italic = styleRaw.startsWith('italic') || styleRaw.startsWith('oblique')
  return formatVariant({ weight, italic })
}

export interface ParsedFontFaceRule {
  srcValue: string
  fontFace: ParsedFontFace | null
}

/**
 * Parse the modelled part of one @font-face block. The caller owns asset-ref
 * collection because it needs the final style-rule index for URL rewriting.
 */
export function parseFontFaceRule(rule: CSSFontFaceRule): ParsedFontFaceRule | null {
  const declarations = rule.style
  if (!declarations) return null
  const srcValue = declarations.getPropertyValue('src')
  if (!srcValue) return null

  const family = unquoteFamily(declarations.getPropertyValue('font-family') || '')
  const srcUrls = extractUrlPayloads(srcValue)
  if (!family || srcUrls.length === 0) return { srcValue, fontFace: null }

  const unicodeRange = (declarations.getPropertyValue('unicode-range') || '').trim()
  return {
    srcValue,
    fontFace: {
      family,
      variant: fontFaceVariant(declarations),
      srcUrls,
      ...(unicodeRange ? { unicodeRange } : {}),
    },
  }
}
