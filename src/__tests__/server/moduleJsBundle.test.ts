import { describe, expect, it } from 'bun:test'
import { collectSiteModuleAssets } from '../../../server/publish/siteModuleAssets'
import {
  buildPublishedSiteModuleJsMap,
  buildSiteModuleJsMap,
  injectModuleScripts,
  resolveModuleScripts,
} from '../../../server/publish/moduleJsBundle'
import { assetContentVersion } from '../../../server/publish/assetVersion'
import { bumpPublishVersion, resetPublishStateForTests } from '../../../server/publish/publishState'
import { makeModule, makePage, makeRegistry, makeSite } from '../publisher/helpers'

const registry = makeRegistry({
  'base.body': makeModule('base.body', {
    canHaveChildren: true,
    render: (_p, children) => ({ html: `<main>${children.join('')}</main>` }),
  }),
  'test.jsy': makeModule('test.jsy', {
    render: () => ({ html: '<div></div>', js: 'JS_BODY' }),
  }),
  'test.plain': makeModule('test.plain'),
})

function makeTwoPageSite() {
  const pageA = makePage({
    root: { moduleId: 'base.body', children: ['a'] },
    a: { moduleId: 'test.jsy' },
  })
  const pageB = makePage({
    root: { moduleId: 'base.body', children: ['b'] },
    b: { moduleId: 'test.jsy' },
  })
  pageB.id = 'page-2'
  pageB.slug = 'two'
  return makeSite({ pages: [pageA, pageB] })
}

const HTML_DOC = `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; worker-src 'none'; style-src 'self'; img-src 'self' data:; connect-src 'self';">
</head>
<body>
<main></main>
</body>
</html>`

describe('site module-JS map', () => {
  it('walks every page and dedupes js per moduleId', () => {
    const site = makeTwoPageSite()
    const acc = collectSiteModuleAssets(site, registry)
    expect([...acc.jsMap.entries()]).toEqual([['test.jsy', 'JS_BODY']])
    const map = buildSiteModuleJsMap(site, registry)
    expect([...map.keys()]).toEqual(['test.jsy'])
  })

  it('excludes modules that emit no js', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['p'] },
      p: { moduleId: 'test.plain' },
    })
    const map = buildSiteModuleJsMap(makeSite({ pages: [page] }), registry)
    expect(map.size).toBe(0)
  })
})

describe('resolveModuleScripts', () => {
  it('keeps only modules that ship js, sorted and de-duplicated, each with its body hash', () => {
    const map = new Map([
      ['z.widget', 'Z_BODY'],
      ['a.widget', 'A_BODY'],
    ])
    expect(resolveModuleScripts(['z.widget', 'no.js', 'a.widget', 'z.widget'], map)).toEqual([
      { moduleId: 'a.widget', version: assetContentVersion('A_BODY') },
      { moduleId: 'z.widget', version: assetContentVersion('Z_BODY') },
    ])
  })
})

/** The script URL a published page carries for `test.jsy` when its body is `js`. */
function publishedScriptUrl(js: string): string {
  const reg = makeRegistry({
    'base.body': makeModule('base.body', {
      canHaveChildren: true,
      render: (_p, children) => ({ html: `<main>${children.join('')}</main>` }),
    }),
    'test.jsy': makeModule('test.jsy', { render: () => ({ html: '<div></div>', js }) }),
  })
  const map = buildPublishedSiteModuleJsMap(makeTwoPageSite(), reg)
  const html = injectModuleScripts(HTML_DOC, resolveModuleScripts(['test.jsy'], map))
  const match = /src="([^"]+)"/.exec(html)
  if (!match) throw new Error('no module script tag was injected')
  return match[1]
}

describe('module script URL is a content address', () => {
  it('gives a changed body a new URL across a restart', () => {
    const before = publishedScriptUrl('OLD_RUNTIME')
    // A restart or upgrade: the publish counter starts again at 0.
    resetPublishStateForTests()
    const after = publishedScriptUrl('NEW_RUNTIME')
    expect(after).not.toBe(before)
  })

  it('keeps the URL of an unchanged body across a restart and a publish', () => {
    const before = publishedScriptUrl('SAME_RUNTIME')
    resetPublishStateForTests()
    bumpPublishVersion()
    expect(publishedScriptUrl('SAME_RUNTIME')).toBe(before)
  })
})

describe('injectModuleScripts', () => {
  const scripts = [
    { moduleId: 'a.widget', version: 'aaa111' },
    { moduleId: 'z.widget', version: 'zzz999' },
  ]

  it('appends versioned, deferred script tags before </body> in the given order and relaxes CSP', () => {
    const html = injectModuleScripts(HTML_DOC, scripts)
    const aIdx = html.indexOf('data-instatic-module-js="a.widget"')
    const zIdx = html.indexOf('data-instatic-module-js="z.widget"')
    expect(aIdx).toBeGreaterThan(-1)
    expect(zIdx).toBeGreaterThan(aIdx)
    expect(html).toContain('<script src="/_instatic/module-js/a.widget.js?v=aaa111" defer data-instatic-module-js="a.widget"></script>')
    expect(html).toContain('<script src="/_instatic/module-js/z.widget.js?v=zzz999" defer data-instatic-module-js="z.widget"></script>')
    expect(zIdx).toBeLessThan(html.indexOf('</body>'))
    expect(html).toContain("script-src 'self';")
    expect(html).not.toContain("script-src 'none';")
  })

  it('does nothing (and keeps CSP locked) for an empty script list', () => {
    const html = injectModuleScripts(HTML_DOC, [])
    expect(html).toBe(HTML_DOC)
    expect(html).toContain("script-src 'none';")
  })

  it('is idempotent', () => {
    const once = injectModuleScripts(HTML_DOC, scripts)
    const twice = injectModuleScripts(once, scripts)
    expect(twice).toBe(once)
  })
})
