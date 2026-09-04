/**
 * Page script resolution — the God Mode JS panel's target: the one script
 * asset scoped to exactly the current page, created lazily at
 * `scripts/pages/<slug>.js`.
 */
import { describe, expect, it } from 'bun:test'
import type { SiteFile } from '@core/files/schemas'
import {
  DEFAULT_SCRIPT_RUNTIME_CONFIG,
  findPageScript,
  pageScriptPath,
  pageScriptRuntimeConfig,
  normalizeSiteRuntimeConfig,
} from '@core/site-runtime'

function script(id: string, path: string): SiteFile {
  return { id, path, type: 'script', content: '', createdAt: 1, updatedAt: 1 }
}

describe('pageScriptRuntimeConfig', () => {
  it('scopes a script to exactly one page with the default load settings', () => {
    expect(pageScriptRuntimeConfig('p1')).toEqual({
      ...DEFAULT_SCRIPT_RUNTIME_CONFIG,
      scope: { type: 'pages', pageIds: ['p1'] },
    })
  })
})

describe('findPageScript', () => {
  const files = [script('site', 'scripts/site.js'), script('home', 'scripts/pages/index.js'), script('shared', 'scripts/shared.js'), script('about', 'scripts/pages/about.js')]
  const runtime = normalizeSiteRuntimeConfig({
    scripts: {
      home: pageScriptRuntimeConfig('p-home'),
      shared: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, scope: { type: 'pages', pageIds: ['p-home', 'p-about'] } },
      about: pageScriptRuntimeConfig('p-about'),
    },
  })

  it('returns the script scoped to exactly that page, ignoring all-pages and multi-page scripts', () => {
    expect(findPageScript(files, runtime, 'p-home')?.id).toBe('home')
    expect(findPageScript(files, runtime, 'p-about')?.id).toBe('about')
    expect(findPageScript(files, runtime, 'p-contact')).toBeNull()
  })

  it('prefers the lowest priority, then path, when several scripts target one page', () => {
    const twice = [...files, script('home-late', 'scripts/pages/index-2.js'), script('home-early', 'scripts/pages/aaa.js')]
    const withTwo = normalizeSiteRuntimeConfig({
      scripts: {
        ...runtime.scripts,
        'home-late': { ...pageScriptRuntimeConfig('p-home'), priority: 200 },
        'home-early': { ...pageScriptRuntimeConfig('p-home'), priority: 100 },
      },
    })
    expect(findPageScript(twice, withTwo, 'p-home')?.id).toBe('home-early')
  })
})

describe('pageScriptPath', () => {
  it('names the script after the page slug under scripts/pages', () => {
    expect(pageScriptPath([], { slug: 'about' })).toBe('scripts/pages/about.js')
    expect(pageScriptPath([], { slug: '' })).toBe('scripts/pages/index.js')
    expect(pageScriptPath([], { slug: 'docs/getting-started' })).toBe('scripts/pages/docs/getting-started.js')
  })

  it('steps around an existing file at the same path', () => {
    const files = [script('a', 'scripts/pages/about.js'), script('b', 'scripts/pages/about-2.js')]
    expect(pageScriptPath(files, { slug: 'about' })).toBe('scripts/pages/about-3.js')
  })
})
