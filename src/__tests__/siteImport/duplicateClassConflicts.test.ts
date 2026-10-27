/**
 * A stylesheet that restates a bare class later in the file keeps both
 * occurrences as class-kind rules through Phase 1. Cross-sheet conflict
 * detection merges every class-kind fragment of a page cascade in source
 * order, so the late restatement must still count toward that page's
 * effective definition.
 */

import { describe, it, expect } from 'bun:test'
import { cssToStyleRules } from '@core/siteImport/cssToStyleRules'
import { detectCrossSheetClassConflicts } from '@core/siteImport/classCascades'
import type { PagePlan } from '@core/siteImport/types'

function cssFile(cssPath: string, css: string) {
  const { rules } = cssToStyleRules(css)
  return { cssPath, rules, assetRefs: [] }
}

function page(source: string, ...linkedCssPaths: string[]): PagePlan {
  return { source, linkedCssPaths } as unknown as PagePlan
}

describe('classCascades — in-file duplicate class rules', () => {
  it('a late restatement still makes the file diverge from another cascade', () => {
    const files = [
      cssFile('a.css', '.btn { border-radius: 0 } .other { color: red } .btn { border-radius: 999px }'),
      cssFile('b.css', '.btn { border-radius: 0 }'),
    ]
    const conflicts = detectCrossSheetClassConflicts(
      [page('a.html', 'a.css'), page('b.html', 'b.css')],
      files,
      [],
    )
    expect(conflicts.map((conflict) => conflict.desiredName)).toEqual(['btn'])
  })

  it('identical restatements in both cascades do not conflict', () => {
    const css = '.btn { border-radius: 0 } .other { color: red } .btn { border-radius: 999px }'
    const files = [cssFile('a.css', css), cssFile('b.css', css)]
    const conflicts = detectCrossSheetClassConflicts(
      [page('a.html', 'a.css'), page('b.html', 'b.css')],
      files,
      [],
    )
    expect(conflicts).toEqual([])
  })
})
