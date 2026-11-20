/**
 * A shared kit stylesheet plus a page's own overrides is an ordinary cascade.
 *
 * The instatic.com import linked `shared/kit.css` on every page and restyled
 * some kit classes in `bake/style.css` (home) and `account/account.css`
 * (account). Each class the overrides touched was reported as a "Stylesheets
 * disagree" conflict, and every resolution lost rules: skip and overwrite
 * dropped fragments, rename split the class off the kit's own selectors.
 */
import { describe, expect, it } from 'bun:test'
import '@modules/base'
import { applyConflictResolutions, buildImportPlan } from '@core/siteImport'
import type { FileMap, ImportPlan } from '@core/siteImport'
import { makeSite } from '../fixtures'

const enc = new TextEncoder()
const file = (text: string) => ({ bytes: enc.encode(text), mimeType: '' })
const page = (...sheets: string[]) =>
  `<!doctype html><html><head>${sheets.map((s) => `<link rel="stylesheet" href="${s}">`).join('')}</head>`
  + '<body><a class="btn">Go</a><div class="card">Card</div></body></html>'

function kitPlusOverrides(): FileMap {
  return {
    files: {
      'home.html': file(page('kit.css', 'home.css')),
      'account.html': file(page('kit.css', 'account.css')),
      'kit.css': file('.btn { color: black; padding: 4px }\n.btn .icon { width: 1em }\n.card { border: 1px solid }\n'),
      'home.css': file('.btn { color: red }\n'),
      'account.css': file('.card { border: 0 }\n'),
    },
  }
}

function resolveDefaults(plan: ImportPlan): ImportPlan {
  return applyConflictResolutions(
    plan,
    plan.conflicts.pages,
    plan.conflicts.rules,
    plan.conflicts.tokens,
    plan.conflicts.crossSheetClasses,
  )
}

function selectorsOf(plan: ImportPlan): string[] {
  return plan.styleRules.map((rule) => rule.selector)
}

describe('cross-sheet cascade: shared kit + page overrides', () => {
  it('reports no conflict and keeps every rule in cascade order', () => {
    const plan = buildImportPlan({ fileMap: kitPlusOverrides(), currentSite: makeSite() })
    expect(plan.conflicts.crossSheetClasses).toEqual([])

    const resolved = resolveDefaults(plan)
    expect(resolved.styleRules).toHaveLength(5)
    expect(selectorsOf(resolved).filter((s) => s === '.btn')).toHaveLength(2)
    expect(selectorsOf(resolved).filter((s) => s === '.card')).toHaveLength(2)
    expect(selectorsOf(resolved)).toContain('.btn .icon')
    // One bindable class per name; the override keeps its position as an ambient rule.
    const btn = resolved.styleRules.filter((r) => r.selector === '.btn')
    expect(btn.map((r) => r.kind)).toEqual(['class', 'ambient'])
    expect(btn[1].styles).toEqual({ color: 'red' })
    // Pages keep binding the bare names.
    for (const p of resolved.pages) {
      const classIds = Object.values(p.nodeFragment.nodes).flatMap((n) => n.classIds ?? [])
      expect(classIds).toEqual(expect.arrayContaining(['btn', 'card']))
    }
  })

  it('names each overriding sheet in a warning, since its rules now reach every page', () => {
    const plan = buildImportPlan({ fileMap: kitPlusOverrides(), currentSite: makeSite() })
    const notes = plan.warnings.filter((w) => w.kind === 'cascade-override')
    expect(notes.map((w) => w.path).sort()).toEqual(['account.css', 'home.css'])
    expect(notes.find((w) => w.path === 'home.css')?.message).toContain('.btn')
  })

  it('still flags definitions with no shared base as a conflict', () => {
    const fileMap: FileMap = {
      files: {
        'home.html': file(page('home.css')),
        'account.html': file(page('account.css')),
        'home.css': file('.btn { color: red }\n'),
        'account.css': file('.btn { color: blue }\n'),
      },
    }
    const plan = buildImportPlan({ fileMap, currentSite: makeSite() })
    expect(plan.conflicts.crossSheetClasses.map((c) => c.desiredName)).toEqual(['btn'])
    expect(plan.warnings.filter((w) => w.kind === 'cascade-override')).toEqual([])
  })
})
