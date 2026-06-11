import { resolveHref } from './htmlPagePlan'
import type { FileMap, ImportWarning } from './types'

interface ExpandedCssSource {
  cssPath: string
  cssSource: string
}

interface ExpandLinkedCssImportsResult {
  cssPaths: string[]
  sources: ExpandedCssSource[]
  warnings: ImportWarning[]
}

interface CssImportRule {
  href: string
  tail: string
  source: string
  start: number
  end: number
}

const CSS_IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)([^;]*);/gi
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g

/**
 * Expand unconditional local CSS @import rules into the linked stylesheet list.
 *
 * CSS `url(...)` values are resolved relative to the stylesheet they appear in,
 * so each expanded source keeps its own FileMap path instead of being inlined
 * into the parent CSS text.
 */
export function expandLinkedCssImports(
  linkedCssPaths: string[],
  fileMap: FileMap,
): ExpandLinkedCssImportsResult {
  const sources: ExpandedCssSource[] = []
  const warnings: ImportWarning[] = []
  const visited = new Set<string>()
  const stack: string[] = []

  const visit = (cssPath: string, importRule?: CssImportRule, importedBy?: string): void => {
    if (visited.has(cssPath)) return
    if (stack.includes(cssPath)) {
      warnings.push({
        kind: 'dropped-at-rule',
        message: `CSS @import cycle involving "${cssPath}" was skipped`,
        source: importRule?.source,
        path: cssPath,
      })
      return
    }

    const entry = fileMap.files[cssPath]
    if (!entry) {
      warnings.push({
        kind: 'missing-stylesheet',
        message: importedBy
          ? `Stylesheet "${importRule?.href ?? cssPath}" imported by "${importedBy}" was not found in the import`
          : `Stylesheet "${cssPath}" was not found in the import`,
        source: importedBy,
        path: importRule?.href ?? cssPath,
      })
      return
    }

    stack.push(cssPath)
    const cssSource = decodeUtf8(entry.bytes)
    const sourceForRules = stripFollowedImportRules(cssSource, cssPath, warnings, visit)
    stack.pop()
    visited.add(cssPath)
    sources.push({ cssPath, cssSource: sourceForRules })
  }

  for (const cssPath of linkedCssPaths) visit(cssPath)

  return {
    cssPaths: sources.map((source) => source.cssPath),
    sources,
    warnings,
  }
}

function stripFollowedImportRules(
  cssSource: string,
  cssPath: string,
  warnings: ImportWarning[],
  visit: (cssPath: string, importRule?: CssImportRule, importedBy?: string) => void,
): string {
  const rangesToStrip: Array<{ start: number; end: number }> = []

  for (const rule of extractCssImportRules(cssSource)) {
    const resolved = resolveHref(rule.href, cssPath)
    if (!resolved) continue

    const tail = rule.tail.trim()
    if (tail.length > 0) {
      warnings.push({
        kind: 'dropped-at-rule',
        message: `Conditional local CSS @import "${rule.href}" in "${cssPath}" could not be modelled`,
        source: rule.source,
        path: rule.href,
      })
      rangesToStrip.push({ start: rule.start, end: rule.end })
      continue
    }

    rangesToStrip.push({ start: rule.start, end: rule.end })
    visit(resolved, rule, cssPath)
  }

  if (rangesToStrip.length === 0) return cssSource
  return stripRanges(cssSource, rangesToStrip)
}

function extractCssImportRules(cssSource: string): CssImportRule[] {
  const scanSource = cssSource.replace(CSS_COMMENT_RE, (comment) => ' '.repeat(comment.length))
  const rules: CssImportRule[] = []

  for (const match of scanSource.matchAll(CSS_IMPORT_RE)) {
    const start = match.index
    if (start === undefined) continue
    const href = (match[2] ?? match[4] ?? '').trim()
    if (!href) continue
    const source = cssSource.slice(start, start + match[0].length)
    rules.push({
      href,
      tail: match[5] ?? '',
      source,
      start,
      end: start + match[0].length,
    })
  }

  return rules
}

function stripRanges(source: string, ranges: Array<{ start: number; end: number }>): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  let result = ''
  let cursor = 0

  for (const range of sorted) {
    result += source.slice(cursor, range.start)
    cursor = Math.max(cursor, range.end)
  }

  return result + source.slice(cursor)
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}
