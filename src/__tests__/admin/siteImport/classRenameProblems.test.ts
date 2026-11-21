/** Conflicts-step validation of class rename targets across both row kinds. */
import { describe, expect, it } from 'bun:test'
import '@modules/base'
import { buildImportPlan } from '@core/siteImport'
import type { ConflictResolution, FileMap } from '@core/siteImport'
import {
  classRenameProblems,
  classRowKey,
  crossSheetConflictKey,
} from '@admin/modals/SiteImport/shared/importPlanning'
import { makeSite } from '../../fixtures'

const enc = new TextEncoder()
const f = (text: string) => ({ bytes: enc.encode(text), mimeType: '' })
const page = (sheets: string[]) =>
  `<html><head>${sheets.map((s) => `<link rel="stylesheet" href="${s}">`).join('')}</head><body><a class="btn">Go</a></body></html>`

function setup() {
  const site = makeSite({
    styleRules: {
      existing: { id: 'existing', name: 'btn', kind: 'class', selector: '.btn', order: 0, styles: {}, contextStyles: {}, createdAt: 0, updatedAt: 0 },
      other: { id: 'other', name: 'taken', kind: 'class', selector: '.taken', order: 1, styles: {}, contextStyles: {}, createdAt: 0, updatedAt: 0 },
    },
  })
  const fileMap: FileMap = {
    files: {
      'a.html': f(page(['kit.css', 'a.css'])),
      'b.html': f(page(['kit.css'])),
      'kit.css': f('.btn { color: black }\n.card { color: gray }\n'),
      'a.css': f('.btn { color: red }\n'),
    },
  }
  const plan = buildImportPlan({ fileMap, currentSite: site })
  return { plan, siteNames: new Set(['btn', 'taken']) }
}

describe('classRenameProblems', () => {
  it('finds nothing wrong with the default names', () => {
    const { plan, siteNames } = setup()
    expect(classRenameProblems(plan, siteNames, new Map(), new Map())).toEqual(new Map())
  })

  it('flags two rows renaming to the same name, an existing class, an imported class and an invalid name', () => {
    const { plan, siteNames } = setup()
    const cross = plan.conflicts.crossSheetClasses[0]
    const crossKey = classRowKey('cross-sheet', crossSheetConflictKey(cross))
    const ruleKey = classRowKey('rule', 'btn')
    const rename = (resolvedName: string): ConflictResolution => ({ action: 'custom-rename', resolvedName })
    const check = (ruleName: string, crossName: string) =>
      classRenameProblems(plan, siteNames, new Map([['btn', rename(ruleName)]]), new Map([[crossSheetConflictKey(cross), rename(crossName)]]))

    expect(check('md:flex-2', 'fine-2').size).toBe(0)
    expect(check('same', 'same').get(crossKey)).toContain('Another conflict')
    expect(check('fine', 'taken').get(crossKey)).toContain('already a class in this site')
    expect(check('card', 'fine-2').get(ruleKey)).toContain('already brings')
    expect(check('bad name', 'fine-2').get(ruleKey)).toContain('not a valid class name')
  })
})
