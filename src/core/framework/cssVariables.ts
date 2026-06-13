import { sanitiseCssValue } from '@core/css-sanitize'

interface CssVariableDeclaration {
  name: string
  value: string
}

export function formatCssVariableBlock(
  selector: string,
  variables: ReadonlyArray<CssVariableDeclaration>,
): string {
  const declarations = formatCssVariableDeclarations(variables)
  if (!declarations) return ''
  return `${selector} {\n${declarations}\n}`
}

/**
 * Serialise framework variable declarations for a `selector { … }` block,
 * routing every value through the canonical `sanitiseCssValue` (the single
 * authority shared with the publisher). A value the sanitiser rejects, or one
 * carrying a `;`, is DROPPED — the declaration is skipped rather than emitted as
 * corrupt CSS.
 *
 * The extra `;` guard is specific to this custom-property emission context: a
 * custom-property value is terminated by `;` (no brace needed), so a value like
 * `red; --evil: url(x)` would inject a sibling declaration straight into the
 * emitted `:root {}` block. Framework variable values (colors, lengths, scale
 * functions) never legitimately contain `;`, so dropping any that do is safe —
 * unlike the publisher's declaration-block context, where `;` is valid inside a
 * quoted `url("data:…;base64,…")` and therefore left to `sanitiseCssValue`.
 */
function formatCssVariableDeclarations(
  variables: ReadonlyArray<CssVariableDeclaration>,
): string {
  const lines: string[] = []
  for (const variable of variables) {
    const safe = sanitiseCssValue(variable.value)
    if (safe === null || safe.includes(';')) continue
    lines.push(`  ${variable.name}: ${safe};`)
  }
  return lines.join('\n')
}
