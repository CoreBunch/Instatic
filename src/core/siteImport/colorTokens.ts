/**
 * colorTokens — pull color-valued custom properties out of root-scope rules so
 * the Super Import can register them as framework color tokens.
 *
 * An imported stylesheet typically declares its palette as CSS custom properties
 * on the document root:
 *
 *   :root { --bg: #0a0a0a; --ink: #f5f5f5; --rule-2: hsl(0 0% 80%); --radius: 4px }
 *
 * The colour-valued ones (`--bg`, `--ink`, `--rule-2`) belong in the CMS colours
 * system (`site.settings.framework.colors`), which re-emits each as a `--<slug>`
 * variable — so every `var(--bg)` in the imported CSS keeps resolving. The
 * non-colour ones (`--radius`) are left on the original `:root` rule untouched.
 *
 * Extraction REMOVES the colour custom properties from the rule (so the palette
 * isn't emitted twice — once by the framework and once by a leftover `:root`
 * rule) and drops the rule entirely when nothing else remains.
 */

import type { NewStyleRule, ImportColorToken } from './types'
import { isRootScopeSelector } from './rootScope'

// ---------------------------------------------------------------------------
// Colour-value detection
// ---------------------------------------------------------------------------

// #rgb / #rgba / #rrggbb / #rrggbbaa
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
// rgb()/rgba()/hsl()/hsla()/hwb()/lab()/lch()/oklab()/oklch()/color()
const FUNCTIONAL_COLOR_RE = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^;]*\)$/i

/**
 * The CSS named colours (+ `transparent` / `currentcolor`), lowercased. A token
 * value that is exactly one of these is a colour.
 */
const NAMED_COLORS = new Set<string>([
  'transparent', 'currentcolor', 'aliceblue', 'antiquewhite', 'aqua', 'aquamarine',
  'azure', 'beige', 'bisque', 'black', 'blanchedalmond', 'blue', 'blueviolet',
  'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral',
  'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
  'darkgoldenrod', 'darkgray', 'darkgrey', 'darkgreen', 'darkkhaki', 'darkmagenta',
  'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon',
  'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise',
  'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue',
  'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite',
  'gold', 'goldenrod', 'gray', 'grey', 'green', 'greenyellow', 'honeydew',
  'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush',
  'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgrey', 'lightgreen', 'lightpink',
  'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey',
  'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen', 'magenta',
  'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple',
  'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise',
  'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin',
  'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered',
  'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred',
  'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple',
  'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon',
  'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue',
  'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal',
  'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke',
  'yellow', 'yellowgreen',
])

/**
 * Whether a CSS value is a single colour literal. Values that reference other
 * custom properties (`var(...)`) or compute (`calc(...)`) are NOT treated as
 * colour tokens — they'd be meaningless as a standalone palette entry.
 */
export function isCssColorValue(raw: string): boolean {
  const v = raw.trim()
  if (!v) return false
  if (/var\(|calc\(|url\(/i.test(v)) return false
  if (HEX_COLOR_RE.test(v)) return true
  if (FUNCTIONAL_COLOR_RE.test(v)) return true
  return NAMED_COLORS.has(v.toLowerCase())
}

// ---------------------------------------------------------------------------
// Root-scope extraction
// ---------------------------------------------------------------------------

/**
 * Pull colour-valued custom properties out of every root-scope ambient rule.
 *
 * Returns the rewritten rule list (colour vars removed; emptied rules dropped)
 * and the extracted colour tokens in source order. Non-colour custom properties
 * and every non-root rule pass through unchanged.
 */
export function extractRootColorTokens(
  rules: NewStyleRule[],
): { rules: NewStyleRule[]; colorTokens: ImportColorToken[] } {
  const colorTokens: ImportColorToken[] = []
  const out: NewStyleRule[] = []

  for (const rule of rules) {
    if (rule.kind !== 'ambient' || !isRootScopeSelector(rule.selector)) {
      out.push(rule)
      continue
    }

    const remaining: Record<string, unknown> = {}
    for (const [prop, value] of Object.entries(rule.styles)) {
      if (prop.startsWith('--') && typeof value === 'string' && isCssColorValue(value)) {
        colorTokens.push({ slug: prop.slice(2), value: value.trim() })
      } else {
        remaining[prop] = value
      }
    }

    const hasContext = Object.keys(rule.contextStyles ?? {}).length > 0
    // Keep the rule only if it still carries declarations (base or contextual).
    if (Object.keys(remaining).length > 0 || hasContext) {
      out.push({ ...rule, styles: remaining })
    }
  }

  return { rules: out, colorTokens }
}
