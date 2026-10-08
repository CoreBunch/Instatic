/** CSS source → native ordered registry fragments, preserving grouping blocks. */
import parse from 'postcss/lib/parse'
import { nanoid } from 'nanoid'
import type { ChildNode, Container, AtRule } from 'postcss'
import type { CSSRuleGroup, Condition, ConditionDef } from '@core/page-tree'
import {
  classKindSelector,
  conditionId,
  makeConditionDef,
  selectorBindingClassName,
  splitCssSelectorList,
  isValidCssLayerName,
} from '@core/page-tree'
import { encodeSubstitutionDeclarations } from '@core/css-substitution'
import { processKeyframesRule } from './keyframesToStyleRule'
import { matchMediaQueryToViewport } from './mediaQueryMatch'
import { sparsePriorities } from './declarationCascade'
import { parseStyleDeclarations, parseAuthoredDeclarationLayers } from './cssDeclarationReader'
import { extractUrlPayloads, parseFontFaceRule } from './fontFaceParser'
import type { ImportWarning, BreakpointHint, AssetRef, NewStyleRule, ParsedFontFace } from './types'

interface CssToStyleRulesOptions {
  breakpoints?: BreakpointHint[]
  mediaTolerance?: number
}
interface CssToStyleRulesResult {
  rules: NewStyleRule[]
  warnings: ImportWarning[]
  assetRefs: AssetRef[]
  conditions: ConditionDef[]
  fontFaces: ParsedFontFace[]
}
function truncate(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}
function getSheetConstructor(): typeof CSSStyleSheet | null {
  if (typeof CSSStyleSheet !== 'undefined') return CSSStyleSheet
  return typeof window !== 'undefined' && window.CSSStyleSheet ? window.CSSStyleSheet : null
}
function collectAssetRefsFromDecls(
  decls: Record<string, unknown>,
  ruleIndex: number,
  contextId: string | undefined,
  assetRefs: AssetRef[],
  rawCss = false,
): void {
  for (const [property, value] of Object.entries(decls)) {
    if (typeof value !== 'string') continue
    for (const rawUrl of extractUrlPayloads(value))
      assetRefs.push({
        ruleIndex,
        property,
        rawUrl,
        ...(contextId === undefined ? {} : { contextId }),
        ...(rawCss ? { rawCss: true } : {}),
      })
  }
}
/**
 * PostCSS owns source structure. CSSOM only reads individual declaration
 * blocks: headless engines otherwise silently discard @layer, @property
 * and every valid selector nested inside an unsupported block.
 */
export function cssToStyleRules(
  cssText: string,
  options?: CssToStyleRulesOptions,
): CssToStyleRulesResult {
  const rules: NewStyleRule[] = [],
    warnings: ImportWarning[] = [],
    assetRefs: AssetRef[] = [],
    fontFaces: ParsedFontFace[] = []
  const conditions = new Map<string, ConditionDef>(),
    seenClasses = new Set<string>()
  const Sheet = getSheetConstructor()
  if (!Sheet) {
    warnings.push({
      kind: 'invalid-rule',
      message: 'CSSStyleSheet is not available in this environment',
      source: truncate(cssText),
    })
    return { rules, warnings, assetRefs, conditions: [], fontFaces }
  }
  let root
  try {
    root = parse(cssText)
  } catch (err) {
    warnings.push({
      kind: 'invalid-rule',
      message: `CSS parse error: ${err instanceof Error ? err.message : String(err)}`,
      source: truncate(cssText),
    })
    return { rules, warnings, assetRefs, conditions: [], fontFaces }
  }
  let nextGroupId = 0
  const groupNamespace = nanoid()
  const newGroupId = () => `${groupNamespace}:${nextGroupId++}`
  const sheetRule = (node: ChildNode): CSSRule | undefined => {
    const sheet = new Sheet()
    sheet.replaceSync(encodeSubstitutionDeclarations(node.toString()))
    return sheet.cssRules[0]
  }
  const addStructuralRule = (
    selector: string,
    grouping: CSSRuleGroup[],
    atRule: NonNullable<NewStyleRule['atRule']>,
  ) => {
    rules.push({
      name: selector,
      kind: 'ambient',
      selector,
      order: rules.length,
      styles: {},
      contextStyles: {},
      grouping: grouping.slice(),
      atRule,
    })
  }
  const contextGroup = (condition: Condition): CSSRuleGroup => {
    const matched =
      condition.kind === 'media'
        ? matchMediaQueryToViewport(
            condition.query,
            options?.breakpoints ?? [],
            options?.mediaTolerance ?? 10,
          )
        : null
    let contextId: string
    if (matched) contextId = matched.id
    else {
      contextId = conditionId(condition)
      if (!conditions.has(contextId)) conditions.set(contextId, makeConditionDef(condition))
    }
    return { id: newGroupId(), kind: 'context', contextId }
  }
  const warnUnsupported = (node: AtRule, reason = 'is not supported by the import engine') => {
    warnings.push({
      kind: 'dropped-at-rule',
      message: `@${node.name} ${reason}`,
      source: truncate(node.toString()),
    })
  }
  const walk = (container: Container, grouping: CSSRuleGroup[] = []) => {
    for (const node of container.nodes ?? []) {
      if (node.type === 'comment') continue
      try {
        if (node.type === 'rule') {
          const rule = sheetRule(node)
          if (!rule || rule.type !== 1) {
            warnings.push({
              kind: 'invalid-rule',
              message: 'The CSS engine rejected a selector rule',
              source: truncate(node.toString()),
            })
            continue
          }
          const styleRule = rule as CSSStyleRule
          const declarationLayers = parseAuthoredDeclarationLayers(
            node.nodes
              .filter((child) => child.type === 'decl')
              .map((child) => ({
                property: child.prop,
                value: child.value,
                important: child.important ?? false,
              })),
            styleRule.selectorText,
            Sheet,
            warnings,
          )
          const context = grouping.findLast((group) => group.kind === 'context')
          const contextId = context?.kind === 'context' ? context.contextId : undefined
          for (const selector of selectorsForStorage(styleRule.selectorText.trim())) {
            const binding = selectorBindingClassName(selector)
            if (binding && contextId === undefined) {
              if (seenClasses.has(selector))
                warnings.push({
                  kind: 'duplicate-class',
                  message: `Class "${binding}" (${selector}) appears more than once; each occurrence keeps its cascade position`,
                  selector,
                })
              seenClasses.add(selector)
            }
            for (const declarations of declarationLayers) {
              const idx = rules.length,
                priorities = sparsePriorities(declarations.priorities)
              rules.push({
                name: binding ?? selector,
                kind: binding ? 'class' : 'ambient',
                selector,
                order: idx,
                styles: contextId === undefined ? { ...declarations.styles } : {},
                ...(contextId === undefined && priorities
                  ? { stylePriorities: { ...priorities } }
                  : {}),
                contextStyles:
                  contextId === undefined ? {} : { [contextId]: { ...declarations.styles } },
                ...(contextId !== undefined && priorities
                  ? { contextStylePriorities: { [contextId]: { ...priorities } } }
                  : {}),
                ...(grouping.length ? { grouping: grouping.slice() } : {}),
              })
              collectAssetRefsFromDecls(declarations.styles, idx, contextId, assetRefs)
            }
          }
          for (const child of node.nodes ?? [])
            if (child.type !== 'decl' && child.type !== 'comment') {
              warnings.push({
                kind: 'dropped-at-rule',
                message: 'Nested selector rules are not supported by the import engine',
                source: truncate(child.toString()),
              })
            }
          continue
        }
        if (node.type !== 'atrule') continue
        const name = node.name.toLowerCase()
        if (name === 'layer') {
          if (node.nodes) {
            if (node.params.trim() && !isValidCssLayerName(node.params.trim())) {
              warnUnsupported(node, 'block has an invalid layer name')
              continue
            }
            const group: CSSRuleGroup = {
              id: newGroupId(),
              kind: 'layer',
              ...(node.params.trim() ? { name: node.params.trim() } : {}),
            }
            addStructuralRule(`@layer ${node.params}`.trim(), grouping, { kind: 'group', group })
            walk(node, [...grouping, group])
          } else {
            const names = splitCssSelectorList(node.params)
            if (names.length && names.every(isValidCssLayerName))
              addStructuralRule(`@layer ${node.params}`, grouping, { kind: 'layer-order', names })
            else warnUnsupported(node, 'statement has invalid layer names')
          }
          continue
        }
        if (name === 'media' || name === 'supports' || name === 'container') {
          if (!node.nodes) {
            warnUnsupported(node, 'has no block')
            continue
          }
          let condition: Condition
          if (name === 'container') {
            const params = node.params.trim(),
              match = /^([\w-]+)\s+(.+)$/.exec(params)
            condition = {
              kind: 'container',
              query: match?.[2] ?? params,
              ...(match ? { name: match[1] } : {}),
            }
          } else condition = { kind: name, query: node.params.trim() }
          walk(node, [...grouping, contextGroup(condition)])
          continue
        }
        if (name === 'property') {
          const descriptors = new Map(
            (node.nodes ?? [])
              .filter((child) => child.type === 'decl')
              .map((child) => [child.prop.toLowerCase(), child.value]),
          )
          const syntax = descriptors.get('syntax'),
            inherits = descriptors.get('inherits'),
            initialValue = descriptors.get('initial-value')
          if (
            !syntax ||
            !/^(['"])[\s\S]*\1$/.test(syntax) ||
            !['true', 'false'].includes(inherits ?? '') ||
            !node.params.trim().startsWith('--')
          ) {
            warnUnsupported(node, 'registration has invalid required descriptors')
            continue
          }
          addStructuralRule(`@property ${node.params}`, grouping, {
            kind: 'property',
            name: node.params.trim(),
            syntax: decodeCssString(syntax),
            inherits: inherits === 'true',
            ...(initialValue === undefined ? {} : { initialValue }),
          })
          if (initialValue !== undefined)
            collectAssetRefsFromDecls({ initialValue }, rules.length - 1, undefined, assetRefs)
          continue
        }
        if (name === 'font-face') {
          if (grouping.length) {
            warnUnsupported(
              node,
              'inside a grouping block cannot be represented by the native font library',
            )
            continue
          }
          const rule = sheetRule(node)
          if (rule?.type !== 5) {
            warnUnsupported(node, 'was rejected by the CSS engine')
            continue
          }
          const parsed = parseFontFaceRule(rule as CSSFontFaceRule)
          if (parsed) {
            collectAssetRefsFromDecls({ src: parsed.srcValue }, rules.length, undefined, assetRefs)
            if (parsed.fontFace) fontFaces.push(parsed.fontFace)
          }
          continue
        }
        if (name === 'keyframes' || name === '-webkit-keyframes') {
          const rule = sheetRule(node)
          if (rule?.type !== 7) {
            warnUnsupported(node, 'was rejected by the CSS engine')
            continue
          }
          const start = rules.length
          processKeyframesRule(rule as CSSKeyframesRule, rules, warnings, assetRefs, {
            parseDeclarations: (style, selector, frameWarnings) =>
              parseStyleDeclarations(style, selector, frameWarnings).styles,
            collectAssetRefsFromDecls,
          })
          for (let index = start; index < rules.length; index += 1)
            if (grouping.length) rules[index].grouping = grouping.slice()
          continue
        }
        warnUnsupported(node)
      } catch (err) {
        warnings.push({
          kind: 'invalid-rule',
          message: `Unexpected error processing rule: ${err instanceof Error ? err.message : String(err)}`,
          source: truncate(node.toString()),
        })
      }
    }
  }
  if (root.type === 'document') {
    for (const stylesheet of root.nodes) walk(stylesheet)
  } else {
    walk(root)
  }
  normalizeParsedBindableClassRules(rules)
  return { rules, warnings, assetRefs, conditions: [...conditions.values()], fontFaces }
}
function decodeCssString(value: string): string {
  return value
    .slice(1, -1)
    .replace(
      /\\(?:([\da-f]{1,6})\s?|([^\r\n]))/gi,
      (_, hex: string | undefined, char: string | undefined) => {
        if (!hex) return char ?? ''
        const code = parseInt(hex, 16)
        return String.fromCodePoint(
          code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code,
        )
      },
    )
}

function normalizeParsedBindableClassRules(rules: NewStyleRule[]): void {
  const primaryIndexByName = new Map<string, number>()
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]
    if (rule.kind !== 'class') continue
    const primaryIndex = primaryIndexByName.get(rule.name)
    if (primaryIndex === undefined) {
      primaryIndexByName.set(rule.name, index)
      continue
    }

    const primary = rules[primaryIndex]
    const canonicalSelector = classKindSelector(rule.name)
    if (rule.selector === canonicalSelector && primary.selector !== canonicalSelector) {
      rules[primaryIndex] = {
        ...primary,
        kind: 'ambient',
        name: primary.selector,
      }
      primaryIndexByName.set(rule.name, index)
      continue
    }

    rules[index] = {
      ...rule,
      kind: 'ambient',
      name: rule.selector,
    }
  }
}

/**
 * Preserve class-free lists and lists sharing one binding as one CSS rule.
 * Split only when alternatives have different binding ownership; that gives
 * each picker class an independent registry entry without fragmenting resets.
 */
function selectorsForStorage(selectorList: string): string[] {
  const parts = splitCssSelectorList(selectorList)
  if (parts.length <= 1) return parts
  const bindings = parts.map(selectorBindingClassName)
  if (bindings.every((binding) => binding === null)) return [selectorList]
  const first = bindings[0]
  if (first !== null && bindings.every((binding) => binding === first)) {
    return [selectorList]
  }
  return parts
}
