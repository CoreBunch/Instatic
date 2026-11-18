/** Repeated class fragments must participate in cross-page conflict detection. */
import { describe, it, expect } from 'bun:test'
import '@modules/base'
import { makeSite } from '../fixtures'
import { buildImportPlan } from '@core/siteImport'

function conflictsFor(a: string, b: string) {
  const encode = (value: string) => ({ bytes: new TextEncoder().encode(value) })
  const fileMap = { files: {
    'a.html': encode('<link rel="stylesheet" href="a.css"><body><div class="btn other">A</div></body>'),
    'b.html': encode('<link rel="stylesheet" href="b.css"><body><div class="btn other">B</div></body>'),
    'a.css': encode(a),
    'b.css': encode(b),
  } }
  return buildImportPlan({ fileMap, currentSite: makeSite() }).conflicts.crossSheetClasses
}

describe('classCascades — in-file duplicate class rules', () => {
  it('a late restatement still makes the file diverge from another cascade', () => {
    const conflicts = conflictsFor(
      '.btn { border-radius: 0 } .other { color: red } .btn { border-radius: 999px }',
      '.btn { border-radius: 0 }',
    )
    expect(conflicts.map((conflict) => conflict.desiredName)).toEqual(['btn'])
  })

  it('identical restatements in both cascades do not conflict', () => {
    const css = '.btn { border-radius: 0 } .other { color: red } .btn { border-radius: 999px }'
    expect(conflictsFor(css, css)).toEqual([])
  })
})
