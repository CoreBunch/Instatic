import { readCssDeclarationBlock } from '@core/css-substitution'
import type { ImportWarning } from './types'
import type { DeclarationLayer } from './declarationCascade'

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
