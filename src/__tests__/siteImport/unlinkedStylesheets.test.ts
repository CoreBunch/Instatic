/**
 * Stylesheets no imported page links.
 *
 * They used to be dropped ("Stylesheet isn't linked by any imported page").
 * They now plan as site-wide stylesheet files: `ImportStylesheet` entries with
 * no `pageSources`, flattened like a kept sheet, after the kept sheets in
 * cascade priority. Linked stylesheets keep their existing behaviour.
 */

import { describe, it, expect } from 'bun:test'
import '@modules/base'
import { buildImportPlan, detectPluginPackage } from '@core/siteImport'
import type { FileMap } from '@core/siteImport'
import { makeEmptySiteDocument } from './mockSite'

const encoder = new TextEncoder()

function css(source: string): FileMap['files'][string] {
  return { bytes: encoder.encode(source), mimeType: 'text/css' }
}

function html(source: string): FileMap['files'][string] {
  return { bytes: encoder.encode(source), mimeType: 'text/html' }
}

function plan(files: FileMap['files'], stylesheetModes: Record<string, 'convert' | 'file'> = {}) {
  return buildImportPlan({
    fileMap: { files },
    currentSite: makeEmptySiteDocument(),
    options: { stylesheetModes },
  })
}

describe('buildImportPlan — stylesheets no page links', () => {
  it('plans a lone stylesheet as one site-wide stylesheet file', () => {
    const result = plan({ 'members-starter.css': css('.members-card { padding: 24px; }') })

    expect(result.pages).toHaveLength(0)
    expect(result.stylesheets).toEqual([
      {
        path: 'members-starter.css',
        pageSources: [],
        priority: 100,
        content: '.members-card { padding: 24px; }',
      },
    ])
    // Verbatim file: nothing is converted into style rules.
    expect(result.styleRules).toHaveLength(0)
    expect(result.linkedStylesheets).toHaveLength(0)
  })

  it('keeps a linked stylesheet converting to rules and plans the unlinked one beside it', () => {
    const result = plan({
      'index.html': html('<html><head><link rel="stylesheet" href="css/site.css"></head><body><p class="lead">Hi</p></body></html>'),
      'css/site.css': css('.lead { color: red; }'),
      'css/extra.css': css('.extra { color: blue; }'),
    })

    expect(result.linkedStylesheets).toEqual([
      { path: 'css/site.css', mode: 'convert', pageSources: ['index.html'] },
    ])
    expect(result.styleRules.some((rule) => rule.name === 'lead')).toBe(true)
    expect(result.styleRules.some((rule) => rule.name === 'extra')).toBe(false)
    expect(result.stylesheets.map((sheet) => [sheet.path, sheet.pageSources])).toEqual([
      ['css/extra.css', []],
    ])
  })

  it('orders unlinked sheets after the kept linked sheets', () => {
    const result = plan(
      {
        'index.html': html('<html><head><link rel="stylesheet" href="css/site.css"></head><body></body></html>'),
        'css/site.css': css('.lead { color: red; }'),
        'css/extra.css': css('.extra { color: blue; }'),
      },
      { 'css/site.css': 'file' },
    )

    expect(result.stylesheets.map((sheet) => [sheet.path, sheet.pageSources, sheet.priority])).toEqual([
      ['css/site.css', ['index.html'], 100],
      ['css/extra.css', [], 101],
    ])
  })

  it('folds a file another unlinked sheet @imports into that sheet', () => {
    const result = plan({
      'theme.css': css('@import "parts/base.css";\n.theme { color: red; }'),
      'parts/base.css': css('body { margin: 0; }'),
    })

    expect(result.stylesheets.map((sheet) => sheet.path)).toEqual(['theme.css'])
    const content = result.stylesheets[0].content
    expect(content.indexOf('margin: 0')).toBeLessThan(content.indexOf('.theme'))
    expect(content).not.toContain('@import')
  })

  it('still yields one sheet when unlinked files @import each other in a cycle', () => {
    const result = plan({
      'a.css': css('@import "b.css";\n.a { color: red; }'),
      'b.css': css('@import "a.css";\n.b { color: blue; }'),
    })

    expect(result.stylesheets.map((sheet) => sheet.path)).toEqual(['a.css'])
    expect(result.stylesheets[0].content).toContain('.a { color: red; }')
    expect(result.stylesheets[0].content).toContain('.b { color: blue; }')
  })

  it('does not treat a file a converted linked sheet @imports as unlinked', () => {
    const result = plan({
      'index.html': html('<html><head><link rel="stylesheet" href="site.css"></head><body></body></html>'),
      'site.css': css('@import "base.css";\n.lead { color: red; }'),
      'base.css': css('.base { margin: 0; }'),
    })

    expect(result.stylesheets).toHaveLength(0)
    expect(result.styleRules.some((rule) => rule.name === 'base')).toBe(true)
  })
})

describe('detectPluginPackage', () => {
  it('recognises a root plugin.json and reads the plugin name', () => {
    const fileMap: FileMap = {
      files: {
        'plugin.json': { bytes: encoder.encode(JSON.stringify({ id: 'acme.members', name: 'Members Starter' })) },
        'frontend/members-starter.css': css('.members-card { padding: 24px; }'),
      },
    }
    expect(detectPluginPackage(fileMap)).toEqual({ name: 'Members Starter' })
  })

  it('still recognises the package when the manifest is unreadable', () => {
    const fileMap: FileMap = { files: { 'plugin.json': { bytes: encoder.encode('{ not json') } } }
    expect(detectPluginPackage(fileMap)).toEqual({ name: null })
  })

  it('ignores a plugin.json that is not at the root, and ordinary sites', () => {
    expect(detectPluginPackage({ files: { 'vendor/plugin.json': { bytes: encoder.encode('{}') } } })).toBeNull()
    expect(detectPluginPackage({ files: { 'index.html': html('<p>Hi</p>') } })).toBeNull()
  })
})
