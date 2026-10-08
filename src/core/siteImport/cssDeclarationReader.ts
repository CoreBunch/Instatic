import {
  readCssDeclarationBlock,
  encodeSubstitutionDeclarations,
  cssPropertyNameToStorageKey,
} from '@core/css-substitution'
import { isEmittableProperty } from '@core/publisher'
import type { ImportWarning } from './types'
import type { DeclarationLayer } from './declarationCascade'

interface AuthoredDeclaration {
  property: string
  value: string
  important: boolean
}

/**
 * Parse declarations independently, then combine non-overlapping property
 * bags. Repeated properties keep separate fragments, preserving fallbacks,
 * shorthand resets and important priority. A browser remains the authority on
 * value validity; a headless CSSOM's unsupported value is not data loss.
 */
export function parseAuthoredDeclarationLayers(
  declarations: AuthoredDeclaration[],
  selector: string,
  Sheet: typeof CSSStyleSheet,
  warnings: ImportWarning[],
): DeclarationLayer[] {
  const layers: DeclarationLayer[] = []
  let current: DeclarationLayer = { styles: {}, priorities: {} }
  for (const declaration of declarations) {
    const sheet = new Sheet()
    sheet.replaceSync(
      encodeSubstitutionDeclarations(
        `x { ${declaration.property}: ${declaration.value}${declaration.important ? ' !important' : ''}; }`,
      ),
    )
    const rule = sheet.cssRules[0] as CSSStyleRule | undefined
    const parsed: DeclarationLayer = rule
      ? parseStyleDeclarations(rule.style, selector, warnings)
      : { styles: {}, priorities: {} }
    const property = cssPropertyNameToStorageKey(
      declaration.property.startsWith('--')
        ? declaration.property
        : declaration.property.toLowerCase(),
    )
    if (!Object.keys(parsed.styles).length && isEmittableProperty(property)) {
      parsed.styles[property] = declaration.value
      if (declaration.important) parsed.priorities[property] = 'important'
    }
    if (Object.keys(parsed.styles).some((key) => key in current.styles)) {
      layers.push(current)
      current = { styles: {}, priorities: {} }
    }
    Object.assign(current.styles, parsed.styles)
    Object.assign(current.priorities, parsed.priorities)
  }
  if (Object.keys(current.styles).length || !layers.length) layers.push(current)
  return layers
}

export function parseStyleDeclarations(
  style: CSSStyleDeclaration,
  selectorForWarning: string,
  warnings: ImportWarning[],
): DeclarationLayer {
  const parsed = readCssDeclarationBlock(style, (camel, kebab) => {
    warnings.push({
      kind: 'blocked-property',
      message: `Property "${camel}" (${kebab}) is blocked for security and was dropped`,
      selector: selectorForWarning,
      property: camel,
    })
  })
  return { styles: parsed.styles, priorities: parsed.priorities }
}
