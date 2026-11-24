/**
 * cssUrlAfterRootTokens.test.ts — `url()` assets keep their rewrite when token
 * extraction removes a root-scope rule earlier in the same stylesheet.
 *
 * The parser records each `url()` against the rule it came from. Colour and
 * font token extraction can then drop an emptied `:root` / `body` rule, so the
 * rules after it must still be matched to their own `url()`s, not to the
 * `url()`s of whichever rule now sits at their old position.
 */

import { describe, it, expect } from 'bun:test'
import '@modules/base'
import { buildImportPlan } from '@core/siteImport'
import type { FileMap } from '@core/siteImport'
import { makeSite } from '../fixtures'

const enc = new TextEncoder()

function planFor(rootRule: string) {
  const css = `${rootRule}
.a { background-image: url("../img/a.svg"); }
.b { background-image: url("../img/b.svg"); }`
  const fileMap: FileMap = {
    files: {
      'index.html': {
        bytes: enc.encode('<html><head><link rel="stylesheet" href="css/site.css"></head><body><div class="a"></div><div class="b"></div></body></html>'),
        mimeType: 'text/html',
      },
      'css/site.css': { bytes: enc.encode(css), mimeType: 'text/css' },
      'img/a.svg': { bytes: enc.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), mimeType: 'image/svg+xml' },
      'img/b.svg': { bytes: enc.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), mimeType: 'image/svg+xml' },
    },
  }
  return buildImportPlan({ fileMap, currentSite: makeSite({ pages: [] }) })
}

function backgroundOf(plan: ReturnType<typeof planFor>, selector: string): unknown {
  return plan.styleRules.find((rule) => rule.selector === selector)?.styles.backgroundImage
}

describe('Site Import rewrites url() after a root rule removed by token extraction', () => {
  it.each([
    ['no root rule', ''],
    ['a root rule that keeps a non-colour declaration', ':root { --brand: #0575d6; --space: 1rem; }'],
    ['a :root with only a colour', ':root { --brand: #0575d6; }'],
    ['a :root with only a font stack', ':root { --font-body: "Inter", sans-serif; }'],
    ['an empty :root', ':root {}'],
    ['a body with only a colour variable', 'body { --brand: #0575d6; }'],
  ])('after %s', (_label, rootRule) => {
    const plan = planFor(rootRule)
    expect(backgroundOf(plan, '.a')).toBe(`url('img/a.svg')`)
    expect(backgroundOf(plan, '.b')).toBe(`url('img/b.svg')`)
    expect(plan.assets.map((asset) => asset.sourcePath).sort()).toEqual(['img/a.svg', 'img/b.svg'])
  })
})
