/**
 * Site-wide CSS a theme prints into every page's head reaches the plan once
 * per page. The later copies are dropped so a page's own equal-specificity
 * override is not outranked by other pages' repeats of the rule it overrides
 * (a nav link white on every page, near-black on one page only).
 */
import { describe, expect, it } from 'bun:test'
import '@modules/base'
import { buildImportPlan } from '@core/siteImport'
import { createCssPlanState, dedupeRepeatedInlineRules, parseCssSourceIntoPlan } from '@core/siteImport/planCss'
import { makeEmptySiteDocument } from './mockSite'

const OPTIONS = { breakpoints: [], collectGoogleFonts: () => {} }

/** Parse page inline sources in page order, deduping as buildPlan does. */
function inlinePlanOf(sources: Array<[path: string, css: string]>) {
  const state = createCssPlanState()
  const seen = new Set<string>()
  for (const [path, css] of sources) {
    parseCssSourceIntoPlan(path, css, state, OPTIONS)
    const last = state.cssFileResults.length - 1
    state.cssFileResults[last] = dedupeRepeatedInlineRules(state.cssFileResults[last], seen)
  }
  return state.cssFileResults
}

const selectorsOf = (rules: Array<{ selector: string; styles: Record<string, unknown> }>) =>
  rules.map((rule) => `${rule.selector}{${Object.entries(rule.styles).map(([k, v]) => `${k}:${v}`).join(';')}}`)

describe('dedupeRepeatedInlineRules', () => {
  it('keeps the first page\'s copy of a site-wide rule and drops the repeats', () => {
    const siteWide = '.nav a{color:#fff}.footer p{display:block}'
    const files = inlinePlanOf([
      ['index.html::inline', `${siteWide}.home .nav a{color:#1e1e1e}`],
      ['about/index.html::inline', siteWide],
      ['contact/index.html::inline', siteWide],
    ])
    expect(selectorsOf(files[0]!.rules)).toEqual([
      '.nav a{color:#fff}',
      '.footer p{display:block}',
      '.home .nav a{color:#1e1e1e}',
    ])
    expect(files[1]!.rules).toHaveLength(0)
    expect(files[2]!.rules).toHaveLength(0)
  })

  it('a page that repeats its own rule keeps both, and a differing value is not a repeat', () => {
    const files = inlinePlanOf([
      ['index.html::inline', 'h1 a{color:red}h1 a{color:blue}h1 a{color:red}'],
      ['about/index.html::inline', 'h1 a{color:green}'],
    ])
    expect(selectorsOf(files[0]!.rules)).toEqual(['h1 a{color:red}', 'h1 a{color:blue}', 'h1 a{color:red}'])
    expect(selectorsOf(files[1]!.rules)).toEqual(['h1 a{color:green}'])
  })

  it('renumbers the survivors and re-points their asset refs', () => {
    const files = inlinePlanOf([
      ['index.html::inline', 'body{margin:0}'],
      ['about/index.html::inline', 'body{margin:0}.hero{background-image:url(hero.png)}'],
    ])
    const about = files[1]!
    expect(about.rules).toHaveLength(1)
    expect(about.rules[0]!.order).toBe(0)
    expect(about.assetRefs).toHaveLength(1)
    expect(about.assetRefs[0]!.ruleIndex).toBe(0)
    expect(about.assetRefs[0]!.rawUrl).toBe('hero.png')
  })

  it('a rule with a relative url() is only a repeat within the same directory', () => {
    const css = '.hero{background-image:url(../img/hero.png)}'
    const files = inlinePlanOf([
      ['a/index.html::inline', css],
      ['a/more.html::inline', css],
      ['b/index.html::inline', css],
    ])
    expect(files[0]!.rules).toHaveLength(1)
    expect(files[1]!.rules).toHaveLength(0)
    expect(files[2]!.rules).toHaveLength(1)
  })
})

describe('buildImportPlan — site-wide inline <style> blocks', () => {
  it('keeps a page\'s equal-specificity override after the site-wide rule other pages repeat', () => {
    const encoder = new TextEncoder()
    // Every page prints the site-wide block; the first page also prints its
    // own rule that paints the same link near-black. In a browser that page
    // shows near-black. Later pages' copies of the white rule must not land
    // after it in the imported sheet.
    const page = (extra: string) => '<!doctype html><html><head>'
      + `<style>.nav a{color:#fff}</style>${extra}</head>`
      + '<body><nav class="nav menu"><a href="#">Home</a></nav></body></html>'
    const html = (source: string) => ({ bytes: encoder.encode(source), mimeType: 'text/html' })
    const plan = buildImportPlan({
      fileMap: {
        files: {
          'about.html': html(page('<style>.menu a{color:#1e1e1e}</style>')),
          'contact.html': html(page('')),
          'index.html': html(page('')),
        },
      },
      currentSite: makeEmptySiteDocument(),
    })
    const linkRules = plan.styleRules
      .filter((rule) => rule.selector === '.nav a' || rule.selector === '.menu a')
      .map((rule) => `${rule.selector}{color:${rule.styles.color}}`)
    expect(linkRules).toEqual(['.nav a{color:#fff}', '.menu a{color:#1e1e1e}'])
  })
})
