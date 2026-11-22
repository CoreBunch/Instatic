import { isEmittableProperty, sanitiseCssValue } from '@core/publisher'
import type { AssetRef, NewStyleRule } from './types'
import type { ImportWarning } from './warnings'

type ParseDeclarations = (
  style: CSSStyleDeclaration,
  selectorForWarning: string,
  warnings: ImportWarning[],
) => Record<string, unknown>

type CollectAssetRefsFromDecls = (
  decls: Record<string, unknown>,
  ruleIndex: number,
  contextId: string | undefined,
  assetRefs: AssetRef[],
  rawCss?: boolean,
) => void

interface ProcessKeyframesDeps {
  parseDeclarations: ParseDeclarations
  collectAssetRefsFromDecls: CollectAssetRefsFromDecls
}

const KEYFRAMES_NAME_RE = /^-?[_a-zA-Z][\w-]*$/
const KEYFRAME_SELECTOR_RE =
  /^(?:(?:from|to)|(?:\d+(?:\.\d+)?%))(?:\s*,\s*(?:(?:from|to)|(?:\d+(?:\.\d+)?%)))*$/i

function truncate(text: string, maxLen = 120): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…`
}

function camelToKebab(prop: string): string {
  if (prop.startsWith('--')) return prop
  return prop.replace(/([A-Z])/g, (_, c: string) => `-${c.toLowerCase()}`)
}

function keyframeRuleName(rule: CSSKeyframesRule): string {
  const directName = (rule as CSSKeyframesRule & { name?: string }).name
  if (typeof directName === 'string' && directName.trim()) return directName.trim()
  const match = rule.cssText.match(/^@(?:-webkit-)?keyframes\s+([^\s{]+)/i)
  return match ? match[1].trim() : ''
}

function isSafeKeyframeSelector(keyText: string): boolean {
  return KEYFRAME_SELECTOR_RE.test(keyText.trim())
}

function keyframeDeclarationsToCss(decls: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [prop, value] of Object.entries(decls)) {
    if (!isEmittableProperty(prop)) continue
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const safeValue = sanitiseCssValue(value)
    if (safeValue === null) continue
    lines.push(`    ${camelToKebab(prop)}: ${safeValue};`)
  }
  return lines.join('\n')
}

export function processKeyframesRule(
  rule: CSSKeyframesRule,
  rules: NewStyleRule[],
  warnings: ImportWarning[],
  assetRefs: AssetRef[],
  deps: ProcessKeyframesDeps,
): void {
  const name = keyframeRuleName(rule)
  if (!KEYFRAMES_NAME_RE.test(name)) {
    warnings.push({
      kind: 'invalid-rule',
      message: `@keyframes name "${name || '(empty)'}" is not supported by the import engine`,
      source: truncate(rule.cssText),
    })
    return
  }

  const frames: string[] = []
  const ruleIndex = rules.length
  for (let i = 0; i < rule.cssRules.length; i++) {
    const frame = rule.cssRules[i] as CSSKeyframeRule
    const keyText = (frame.keyText ?? '').trim()
    if (!isSafeKeyframeSelector(keyText)) {
      warnings.push({
        kind: 'invalid-rule',
        message: `@keyframes "${name}" frame "${keyText || '(empty)'}" is not supported by the import engine`,
        source: truncate(frame.cssText),
      })
      continue
    }

    const decls = deps.parseDeclarations(frame.style, `@keyframes ${name} ${keyText}`, warnings)
    const css = keyframeDeclarationsToCss(decls)
    if (!css) continue
    frames.push(`  ${keyText} {\n${css}\n  }`)
    deps.collectAssetRefsFromDecls(decls, ruleIndex, undefined, assetRefs, true)
  }

  if (frames.length === 0) return

  const rawCss = `@keyframes ${name} {\n${frames.join('\n')}\n}`
  rules.push({
    name: `@keyframes ${name}`,
    kind: 'ambient',
    selector: `@keyframes ${name}`,
    order: ruleIndex,
    styles: {},
    contextStyles: {},
    rawCss,
  })
}
