/**
 * api.editor.fragments: a plugin with `editor.fragments` inserts a site
 * fragment into the open document through the same flow as the Insert
 * fragment dialog (plan, media through the plugin's reader, one undo step),
 * and applies site themes on the same machinery.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { bindPluginRuntimeFragmentsHost, createEditorPluginApi } from '@core/plugins/runtime'
import type { EditorPluginApi, FragmentMedia, FragmentPreviewStyles, PluginManifest } from '@core/plugin-sdk'
import {
  extractFragment,
  extractTheme,
  fragmentSourceFromSite,
  planFragmentInsert,
  type SiteFragment,
  type SiteTheme,
} from '@core/fragments'
import type { StyleRule } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { fragmentInsertDocument } from '@site/store/slices/fragmentsSlice'
import {
  applyThemeForPlugin,
  insertFragmentForPlugin,
  planFragmentForPlugin,
  planThemeForPlugin,
  watchFragmentPreviewStyles,
} from '@admin/modals/InsertFragment/pluginFragmentsHost'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { makeNode, makePage, makeSite } from '../fixtures'
import { makeSourceSite, mediaBytesFor, sourceWithBytes } from '../fragments/fixtures'
import '@modules/base/index'

const manifest: PluginManifest = {
  id: 'acme.sections',
  name: 'Sections',
  version: '1.0.0',
  apiVersion: 1,
  description: 'Inserts sections.',
  permissions: ['editor.code', 'editor.fragments'],
  grantedPermissions: ['editor.code', 'editor.fragments'],
  entrypoints: { editor: 'editor/index.js' },
  resources: [],
  adminPages: [],
}

const realFetch = globalThis.fetch
const bytesOf = (name: string) => new TextEncoder().encode(`bytes:${name}`)

function rule(id: string, name: string): StyleRule {
  return { id, name, kind: 'class', selector: `.${name}`, order: 0, styles: { padding: '2rem' }, contextStyles: {}, createdAt: 1, updatedAt: 1 }
}

/** A banner with two images; `logo.png` is already in the target's library. */
async function bannerFragment(): Promise<SiteFragment> {
  const source = makeSite({
    pages: [makePage({
      id: 'src-page',
      rootNodeId: 'src-body',
      nodes: {
        'src-body': makeNode({ id: 'src-body', moduleId: 'base.body', children: ['src-banner'] }),
        'src-banner': makeNode({ id: 'src-banner', moduleId: 'base.container', classIds: ['src-banner-class'], children: ['src-photo', 'src-logo'] }),
        'src-photo': makeNode({ id: 'src-photo', moduleId: 'base.image', props: { src: '/uploads/photo.jpg' } }),
        'src-logo': makeNode({ id: 'src-logo', moduleId: 'base.image', props: { src: '/uploads/logo.png' } }),
      },
    })],
    styleRules: { 'src-banner-class': rule('src-banner-class', 'banner') },
  })
  const media = [
    { id: 'm-photo', path: '/uploads/photo.jpg', filename: 'photo.jpg', mimeType: 'image/jpeg' },
    { id: 'm-logo', path: '/uploads/logo.png', filename: 'logo.png', mimeType: 'image/png' },
  ].map((m) => ({ ...m, sizeBytes: bytesOf(m.filename).byteLength, readBytes: () => bytesOf(m.filename) }))
  const { fragment } = await extractFragment(fragmentSourceFromSite(source, { media }), { pageId: 'src-page', rootNodeIds: ['src-banner'] })
  // A media item nothing in the fragment uses: the plan never adds it.
  return {
    ...fragment,
    media: [...fragment.media, { id: 'm-extra', path: '/uploads/extra.jpg', filename: 'extra.jpg', mimeType: 'image/jpeg', src: 'media/extra.jpg' }],
  }
}

function asset(id: string, filename: string, mimeType: string, sizeBytes: number) {
  return { id, filename, mimeType, sizeBytes, publicPath: `/uploads/library/${filename}`, uploadedByUserId: null, createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let uploads: string[] = []

function stubCmsApi(): void {
  uploads = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/data/tables')) return json({ tables: [] })
    if (url.endsWith('/media') && init?.method === 'POST') {
      const file = (init.body as FormData).get('file') as File
      uploads.push(file.name)
      return json({ asset: asset(`new-${file.name}`, file.name, file.type, file.size) })
    }
    if (url.endsWith('/media/lookup')) {
      const { contentHashes } = JSON.parse(String(init?.body))
      const contentHash = new Bun.CryptoHasher('sha256').update(bytesOf('logo.png')).digest('hex')
      const match = { contentHash, id: 'lib-logo', filename: 'logo.png', publicPath: '/uploads/library/logo.png' }
      return json({ matches: contentHashes.includes(contentHash) ? [match] : [] })
    }
    throw new Error(`unexpected request ${url}`)
  }) as unknown as typeof fetch
}

function seedEditor(): void {
  useEditorStore.setState({
    site: makeSite({
      pages: [makePage({
        id: 'page-1',
        rootNodeId: 'body',
        nodes: {
          body: makeNode({ id: 'body', moduleId: 'base.body', children: ['first', 'second'] }),
          first: makeNode({ id: 'first', moduleId: 'base.container', children: ['first-text'] }),
          'first-text': makeNode({ id: 'first-text', moduleId: 'base.text', props: { text: 'Hello' } }),
          second: makeNode({ id: 'second', moduleId: 'base.container', children: [] }),
        },
      })],
    }),
    activePageId: 'page-1',
    activeDocument: { kind: 'page', pageId: 'page-1' },
    selectedNodeId: 'first',
    selectedNodeIds: ['first'],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

let unbind: () => void = () => {}
let toasts: ReadonlyArray<Toast> = []

beforeEach(() => {
  stubCmsApi()
  seedEditor()
  __resetToastBusForTests()
  subscribeToasts((next) => { toasts = next })
  unbind = bindPluginRuntimeFragmentsHost({
    canvasDropAt: () => ({
      preview: { left: 0, top: 0, width: 100, height: 20, position: 'before' },
      insert: input => insertFragmentForPlugin(input, action => action(), undefined, { parentId: 'body', index: 0 }),
    }),
    insert: (input) => insertFragmentForPlugin(input, (action) => action()),
    plan: planFragmentForPlugin,
    watchPreviewStyles: watchFragmentPreviewStyles,
    applyTheme: (input) => applyThemeForPlugin(input, (action) => action()),
    planTheme: planThemeForPlugin,
  })
})

afterEach(() => {
  unbind()
  globalThis.fetch = realFetch
})

function api(granted: PluginManifest['grantedPermissions'] = manifest.grantedPermissions): EditorPluginApi {
  return createEditorPluginApi({ ...manifest, grantedPermissions: granted }, globalThis.fetch)
}

function bodyChildren(): string[] {
  return useEditorStore.getState().site!.pages[0].nodes.body.children
}

describe('api.editor.fragments', () => {
  it('is denied without the editor.fragments permission', async () => {
    const denied = api(['editor.code'])
    expect(() => denied.editor.fragments.canvasDropAt(4, 8)).toThrow('requires permission "editor.fragments"')
    await expect(denied.editor.fragments.insert({ fragment: await bannerFragment(), readMediaBytes: () => null }))
      .rejects.toThrow('requires permission "editor.fragments"')
    await expect(denied.editor.fragments.plan({ fragment: await bannerFragment() }))
      .rejects.toThrow('requires permission "editor.fragments"')
    expect(bodyChildren()).toEqual(['first', 'second'])
  })

  it('watches unused shared styles and skips node-owned rules', () => {
    const styles: (FragmentPreviewStyles | null)[] = []
    const denied = api(['editor.code'])
    expect(() => denied.editor.fragments.watchPreviewStyles(() => {}))
      .toThrow('requires permission "editor.fragments"')
    const unsubscribe = api().editor.fragments.watchPreviewStyles(value => styles.push(value))
    try {
      expect(styles).toHaveLength(1)
      expect(styles[0]?.css).not.toContain('.btn')
      useEditorStore.setState(state => {
        state.site!.styleRules.button = rule('button', 'btn')
        state.site!.styleRules.owned = {
          ...rule('owned', 'owned'),
          scope: { type: 'node', nodeId: 'first', role: 'module-style' },
        }
      })
      expect(styles[1]?.rules).toEqual([{ kind: 'class', name: 'btn', selector: '.btn' }])
      expect(styles[1]?.css).toContain('.btn {')
      expect(styles[1]?.css).not.toContain('.owned')
      useEditorStore.setState({ selectedNodeId: 'second' })
      expect(styles).toHaveLength(2)
      useEditorStore.setState({ site: null })
      expect(styles.at(-1)).toBeNull()
    } finally {
      unsubscribe()
    }
    seedEditor()
    expect(styles).toHaveLength(3)
  })

  it('inserts after the selection, reads only the media it uploads, and undoes in one step', async () => {
    const fragment = await bannerFragment()
    const before = useEditorStore.getState().site!.pages[0].nodes
    const state = useEditorStore.getState()
    const expected = planFragmentInsert({ site: state.site!, tables: [], document: fragmentInsertDocument(state)! }, fragment).report
    const read: string[] = []

    const outcome = await api().editor.fragments.insert({
      fragment,
      silent: true,
      readMediaBytes: (media: FragmentMedia) => {
        read.push(media.filename)
        return bytesOf(media.filename)
      },
    })

    if (!outcome.ok) throw new Error(outcome.message)
    expect(bodyChildren()).toEqual(['first', outcome.insertedRootIds[0], 'second'])
    expect(useEditorStore.getState().selectedNodeId).toBe(outcome.insertedRootIds[0])
    // logo.png is already in the library and extra.jpg is unused: only photo.jpg is read.
    expect(read).toEqual(['photo.jpg'])
    expect(uploads).toEqual(['photo.jpg'])
    expect(outcome.report.media).toEqual({ total: 2, uploaded: 1, reused: 1 })
    expect({ ...outcome.report, media: expected.media }).toEqual(expected)
    expect(toasts).toEqual([])

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.pages[0].nodes).toEqual(before)
  })

  it('does not apply a second plan after another insert changed the destination', async () => {
    const fragment = await bannerFragment()
    let indicateRead!: () => void
    let resumeRead!: () => void
    const waiting = new Promise<void>(resolve => { indicateRead = resolve })
    const resume = new Promise<void>(resolve => { resumeRead = resolve })
    const first = api().editor.fragments.insert({
      fragment,
      silent: true,
      readMediaBytes: async media => {
        indicateRead()
        await resume
        return bytesOf(media.filename)
      },
    })
    try {
      await waiting
      const second = await api().editor.fragments.insert({ fragment, silent: true, readMediaBytes: media => bytesOf(media.filename) })
      expect(second.ok).toBe(true)
    } finally {
      resumeRead()
    }
    const outdated = await first
    expect(outdated.ok).toBe(false)
    if (outdated.ok) throw new Error('The stale plan changed the site')
    expect(outdated.message).toContain('The destination changed')
    const rules = Object.values(useEditorStore.getState().site!.styleRules)
    expect(rules.filter(rule => rule.name === 'banner')).toHaveLength(1)
    expect(bodyChildren()).toHaveLength(3)
  })

  it("places inside the selected container for 'inside-selection' and at the end for 'end'", async () => {
    const inside = await api().editor.fragments.insert({ fragment: await bannerFragment(), placement: 'inside-selection', readMediaBytes: (m) => bytesOf(m.filename), silent: true })
    if (!inside.ok) throw new Error(inside.message)
    expect(useEditorStore.getState().site!.pages[0].nodes.first.children).toEqual(['first-text', inside.insertedRootIds[0]])

    useEditorStore.setState({ selectedNodeId: 'first-text', selectedNodeIds: ['first-text'] })
    const end = await api().editor.fragments.insert({ fragment: await bannerFragment(), placement: 'end', readMediaBytes: (m) => bytesOf(m.filename), silent: true })
    if (!end.ok) throw new Error(end.message)
    expect(bodyChildren()).toEqual(['first', 'second', end.insertedRootIds[0]])
  })

  it('reports progress and cancels a background import while the media reader is pending', async () => {
    const controller = new AbortController()
    const phases: string[] = []
    const started = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const outcome = await api().editor.fragments.insert({
      fragment: await bannerFragment(),
      assets: 'background',
      signal: controller.signal,
      onProgress: event => phases.push(event.phase),
      readMediaBytes: async media => {
        started.resolve()
        await resume.promise
        return bytesOf(media.filename)
      },
    })
    expect(outcome.ok).toBe(true)
    await started.promise
    controller.abort()
    resume.resolve()
    await Bun.sleep(0)
    expect(phases[0]).toBe('commit')
    expect(phases).toContain('media')
    expect(uploads).toEqual([])
    expect(bodyChildren()).toHaveLength(3)
  })

  it('inserts at a canvas drop ahead of the first sibling independently of selection', async () => {
    const fragments = api().editor.fragments
    expect(fragments.canvasDropAt(NaN, 20)).toBeNull()
    const drop = fragments.canvasDropAt(10, 20)!
    const fragment = await bannerFragment()
    useEditorStore.getState().selectNode('second')
    const input = { fragment, readMediaBytes: (m: FragmentMedia) => bytesOf(m.filename), silent: true }
    const outcome = await drop.insert(input)
    if (!outcome.ok) throw new Error(outcome.message)
    expect(bodyChildren()).toEqual([outcome.insertedRootIds[0], 'first', 'second'])
    unbind()
    expect(await drop.insert(input)).toMatchObject({ ok: false, stage: 'unavailable' })
  })

  it('shows the result toast unless silent', async () => {
    const outcome = await api().editor.fragments.insert({ fragment: await bannerFragment(), readMediaBytes: (m) => bytesOf(m.filename) })
    expect(outcome.ok).toBe(true)
    expect(toasts.map((t) => t.title)).toEqual(['Fragment inserted'])
  })

  it('plan reports what an insert would add without changing the store', async () => {
    const fragment = await bannerFragment()
    const site = useEditorStore.getState().site
    const outcome = await api().editor.fragments.plan({ fragment })
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome.report.rules.added).toEqual(['banner'])
    expect(outcome.report.media.total).toBe(2)
    expect(useEditorStore.getState().site).toBe(site)
    expect(uploads).toEqual([])
  })

  it('a malformed fragment: plan resolves not ok, insert rejects', async () => {
    const plan = await api().editor.fragments.plan({ fragment: { format: 'something-else' } })
    expect(plan.ok).toBe(false)
    await expect(api().editor.fragments.insert({ fragment: { format: 'something-else' }, readMediaBytes: () => null }))
      .rejects.toThrow()
    expect(bodyChildren()).toEqual(['first', 'second'])
  })

  it('rejects a malformed input shape', async () => {
    const fragment = await bannerFragment()
    await expect(api().editor.fragments.insert({ fragment } as never)).rejects.toThrow('readMediaBytes must be a function')
    await expect(api().editor.fragments.insert({ fragment, readMediaBytes: () => null, placement: 'top' as never }))
      .rejects.toThrow('placement must be one of')
    await expect(api().editor.fragments.plan({ fragment, colorSources: { 'bg-alt': 3 } as never }))
      .rejects.toThrow('colorSources must map colour slugs to colour slugs')
  })

  it('a media failure resolves with its stage and leaves the document untouched', async () => {
    const outcome = await api().editor.fragments.insert({ fragment: await bannerFragment(), readMediaBytes: () => null, silent: true })
    expect(outcome).toMatchObject({ ok: false, stage: 'media' })
    expect(bodyChildren()).toEqual(['first', 'second'])
  })

  it('without an open site editor it resolves unavailable', async () => {
    unbind()
    const outcome = await api().editor.fragments.insert({ fragment: await bannerFragment(), readMediaBytes: () => null })
    expect(outcome).toMatchObject({ ok: false, stage: 'unavailable' })
    expect(await api().editor.fragments.plan({ fragment: await bannerFragment() })).toMatchObject({ ok: false })
  })
})

/**
 * The fragment fixtures' source theme without its custom font (no font
 * endpoints to stub), plus a root `--texture` pointing at an image the
 * target's library lacks.
 */
async function textureTheme(): Promise<SiteTheme> {
  const site = makeSourceSite()
  site.settings.fonts = { items: [], tokens: [] }
  site.styleRules['cls-root'].styles['--texture'] = "url('/uploads/bg.jpg')"
  return (await extractTheme(sourceWithBytes(site))).theme
}

const readThemeBytes = (media: FragmentMedia) => mediaBytesFor(media.id)

describe('api.editor.fragments themes', () => {
  it('is denied without the editor.fragments permission', async () => {
    const denied = api(['editor.code'])
    await expect(denied.editor.fragments.applyTheme({ theme: await textureTheme(), readMediaBytes: readThemeBytes }))
      .rejects.toThrow('requires permission "editor.fragments"')
    await expect(denied.editor.fragments.planTheme({ theme: await textureTheme() }))
      .rejects.toThrow('requires permission "editor.fragments"')
  })

  it('planTheme reports what would change without changing the store', async () => {
    const site = useEditorStore.getState().site
    const outcome = await api().editor.fragments.planTheme({ theme: await textureTheme() })
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome.report.customProperties.added.map((p) => p.name)).toContain('--texture')
    expect(outcome.report.media.total).toBe(1)
    expect(useEditorStore.getState().site).toBe(site)
    expect(uploads).toEqual([])
  })

  it('applyTheme replaces the design variables, uploads what it needs and undoes in one step', async () => {
    const before = useEditorStore.getState().site!
    const outcome = await api().editor.fragments.applyTheme({ theme: await textureTheme(), readMediaBytes: readThemeBytes })
    if (!outcome.ok) throw new Error(outcome.message)
    expect(uploads).toEqual(['bg.jpg'])
    expect(outcome.report.media).toEqual({ total: 1, uploaded: 1, reused: 0 })
    const after = useEditorStore.getState().site!
    expect(after.settings.framework!.colors.tokens.find((t) => t.slug === 'primary')?.lightValue).toBe('#3366ff')
    expect(Object.values(after.styleRules).some((r) => r.styles['--texture'] === "url('/uploads/library/bg.jpg')")).toBe(true)
    expect(after.pages).toEqual(before.pages)
    expect(toasts.map((t) => t.title)).toEqual(['Theme applied'])

    useEditorStore.getState().undo()
    const undone = useEditorStore.getState().site!
    expect(undone.settings).toEqual(before.settings)
    expect(undone.styleRules).toEqual(before.styleRules)
  })

  it('a malformed theme: planTheme resolves not ok, applyTheme rejects', async () => {
    const plan = await api().editor.fragments.planTheme({ theme: { format: 'instatic-fragment' } })
    expect(plan.ok).toBe(false)
    await expect(api().editor.fragments.applyTheme({ theme: { format: 'instatic-fragment' }, readMediaBytes: () => null }))
      .rejects.toThrow()
  })

  it('rejects a malformed input shape', async () => {
    const theme = await textureTheme()
    await expect(api().editor.fragments.applyTheme({ theme } as never)).rejects.toThrow('applyTheme: input.readMediaBytes must be a function')
    await expect(api().editor.fragments.planTheme({} as never)).rejects.toThrow('planTheme: input.theme is required')
    await expect(api().editor.fragments.applyTheme({ theme, readMediaBytes: readThemeBytes, silent: 'yes' as never }))
      .rejects.toThrow('input.silent must be a boolean')
  })

  it('a media failure resolves with its stage and leaves the site untouched', async () => {
    const before = useEditorStore.getState().site
    const outcome = await api().editor.fragments.applyTheme({ theme: await textureTheme(), readMediaBytes: () => null, silent: true })
    expect(outcome).toMatchObject({ ok: false, stage: 'media' })
    expect(useEditorStore.getState().site).toBe(before)
    expect(toasts).toEqual([])
  })

  it('leaves the new destination untouched if the site changes during a theme download', async () => {
    const theme = await textureTheme()
    const nextSite = makeSite({ pages: [makePage({ id: 'other-site' })] })
    const outcome = await api().editor.fragments.applyTheme({
      theme,
      readMediaBytes: (media) => {
        useEditorStore.setState({ site: nextSite })
        return readThemeBytes(media)
      },
    })
    expect(outcome).toMatchObject({ ok: false, stage: 'media', message: expect.stringContaining('destination changed') })
    expect(uploads).toEqual([])
    expect(useEditorStore.getState().site).toBe(nextSite)
  })

  it('without an open site editor it resolves unavailable', async () => {
    unbind()
    const outcome = await api().editor.fragments.applyTheme({ theme: await textureTheme(), readMediaBytes: readThemeBytes })
    expect(outcome).toMatchObject({ ok: false, stage: 'unavailable' })
    expect(await api().editor.fragments.planTheme({ theme: await textureTheme() })).toMatchObject({ ok: false })
  })
})
