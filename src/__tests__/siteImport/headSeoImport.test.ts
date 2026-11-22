/**
 * An imported page keeps its `<head>`: description, canonical, robots,
 * theme colours, favicon, social cards, alternates, preloads and JSON-LD land
 * in the page's SEO settings, files they point at are uploaded and rewritten,
 * and whatever cannot be kept is reported instead of vanishing.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import '@modules/base'
import { useEditorStore } from '@site/store/store'
import { applyConflictResolutions, buildImportPlan, commitImportPlan } from '@core/siteImport'
import type { FileMap, SiteImportAdapter } from '@core/siteImport'
import { createSiteImportAdapter } from '@admin/modals/SiteImport/shared/createSiteImportAdapter'
import { makeSite } from '../fixtures'

const enc = new TextEncoder()

const HEAD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta http-equiv="refresh" content="5">
<title>Launch</title>
<meta name="description" content="Design live, ship static.">
<link rel="canonical" href="https://example.com/">
<link rel="alternate" hreflang="de" href="../de/index.html">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#f3f3f1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0a0a0b" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="../shared/logo.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="../shared/touch.png" sizes="180x180">
<link rel="alternate" type="text/plain" href="llms.txt" title="For language models">
<link rel="preload" href="../shared/fonts/sans.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="app.js" as="script">
<link rel="modulepreload" href="app.js">
<link rel="stylesheet" href="style.css">
<meta property="og:type" content="website">
<meta property="og:title" content="Launch &amp; ship">
<meta property="og:image" content="https://example.com/og.png">
<meta property="og:image:width" content="1200">
<meta name="twitter:card" content="summary_large_image">
<meta name="google-site-verification" content="abc123">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Example"}</script>
<script type="application/ld+json">{ not json</script>
</head>
<body><h1>Hi</h1></body>
</html>`

function fileMap(): FileMap {
  const file = (text: string, mimeType: string) => ({ bytes: enc.encode(text), mimeType })
  return {
    files: {
      'bake/index.html': file(HEAD, 'text/html'),
      'de/index.html': file('<!doctype html><html><head><title>DE</title><link rel="canonical" href="index.html?edition=de#intro"><meta property="og:url" content="./index.html"></head><body></body></html>', 'text/html'),
      'bake/style.css': file('h1 { margin: 0 }', 'text/css'),
      'bake/llms.txt': file('# Example', 'text/plain'),
      'bake/app.js': file('console.info(1)', 'text/javascript'),
      'shared/logo.svg': file('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'),
      'shared/touch.png': { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' },
      'shared/fonts/sans.woff2': { bytes: new Uint8Array([119, 79, 70, 50]), mimeType: 'font/woff2' },
    },
  }
}

describe('HTML import keeps the page head', () => {
  beforeEach(() => {
    useEditorStore.getState().loadSite(makeSite())
  })

  it('maps head tags into the page SEO settings and plans their files', () => {
    const plan = buildImportPlan({ fileMap: fileMap(), currentSite: useEditorStore.getState().site! })
    const page = plan.pages.find((candidate) => candidate.source === 'bake/index.html')!
    expect(page.title).toBe('Launch')
    // Head URLs naming another imported page stay as authored until commit,
    // where they become page references (see the commit test).
    const german = plan.pages.find((candidate) => candidate.source === 'de/index.html')!
    expect(german.seo).toEqual({ canonical: 'index.html?edition=de#intro', openGraph: { url: './index.html' } })
    expect(page.seo).toEqual({
      description: 'Design live, ship static.',
      canonical: 'https://example.com/',
      robots: 'index, follow',
      colorScheme: 'light dark',
      themeColors: [
        { color: '#f3f3f1', media: '(prefers-color-scheme: light)' },
        { color: '#0a0a0b', media: '(prefers-color-scheme: dark)' },
      ],
      favicon: { href: 'shared/logo.svg', type: 'image/svg+xml' },
      openGraph: { type: 'website', title: 'Launch & ship', image: 'https://example.com/og.png' },
      twitter: { card: 'summary_large_image' },
      meta: [
        { attribute: 'property', name: 'og:image:width', content: '1200' },
        { attribute: 'name', name: 'google-site-verification', content: 'abc123' },
      ],
      links: [
        { rel: 'alternate', href: '../de/index.html', hreflang: 'de' },
        { rel: 'apple-touch-icon', href: 'shared/touch.png', sizes: '180x180' },
        { rel: 'alternate', href: '/bake/llms.txt', type: 'text/plain', title: 'For language models' },
        { rel: 'preload', href: 'shared/fonts/sans.woff2', as: 'font', type: 'font/woff2', crossorigin: 'anonymous' },
      ],
      jsonLd: ['{"@context":"https://schema.org","@type":"Organization","name":"Example"}'],
    })

    const assetPaths = plan.assets.map((asset) => asset.sourcePath)
    expect(assetPaths).toContain('shared/logo.svg')
    expect(assetPaths).toContain('shared/touch.png')
    expect(assetPaths).toContain('shared/fonts/sans.woff2')

    const kinds = plan.warnings.map((warning) => [warning.kind, warning.message] as const)
    expect(kinds.filter(([kind]) => kind === 'head-file-not-hosted').map(([, message]) => message))
      .toEqual([expect.stringContaining('"/bake/llms.txt"')])
    const dropped = kinds.filter(([kind]) => kind === 'head-tag-dropped').map(([, message]) => message)
    expect(dropped).toHaveLength(4)
    expect(dropped.some((message) => message.includes('http-equiv="refresh"'))).toBe(true)
    expect(dropped.some((message) => message.includes('rel="preload" as="script"'))).toBe(true)
    expect(dropped.some((message) => message.includes('rel="modulepreload"'))).toBe(true)
    expect(dropped.some((message) => message.includes('not valid JSON'))).toBe(true)
  })

  it('commits the settings onto the page with uploaded media URLs', async () => {
    const plan = buildImportPlan({ fileMap: fileMap(), currentSite: useEditorStore.getState().site! })
    const resolved = applyConflictResolutions(
      plan,
      plan.conflicts.pages,
      plan.conflicts.rules,
      plan.conflicts.tokens,
      plan.conflicts.crossSheetClasses,
    )
    const adapter: SiteImportAdapter = {
      ...createSiteImportAdapter({ sessionId: 'head-seo-test' }),
      uploadAsset: async (asset) => ({ url: `/uploads/${asset.path.split('/').pop()}`, warnings: [] }),
    }
    const result = await commitImportPlan(resolved, adapter)
    const committed = result.pages.find((candidate) => candidate.source === 'bake/index.html')!
    const page = useEditorStore.getState().site!.pages.find((candidate) => candidate.id === committed.id)!

    expect(page.seo?.favicon).toEqual({ href: '/uploads/logo.svg', type: 'image/svg+xml' })
    const germanId = result.pages.find((candidate) => candidate.source === 'de/index.html')!.id
    const german = useEditorStore.getState().site!.pages.find((candidate) => candidate.id === germanId)!
    expect(german.seo).toEqual({ canonical: `cms:page:${germanId}?edition=de#intro`, openGraph: { url: `cms:page:${germanId}` } })
    expect(page.seo?.links?.map((link) => link.href)).toEqual([
      `cms:page:${germanId}`,
      '/uploads/touch.png',
      '/bake/llms.txt',
      '/uploads/sans.woff2',
    ])
    expect(page.seo?.description).toBe('Design live, ship static.')
  })
})
