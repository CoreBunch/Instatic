/**
 * api.editor.fragments: a plugin with `editor.fragments` inserts a site
 * fragment into the open document through the same flow as the Insert
 * fragment dialog (plan, media through the plugin's reader, one undo step).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { bindPluginRuntimeFragmentsHost, createEditorPluginApi } from '@core/plugins/runtime'
import type { EditorPluginApi, FragmentMedia, PluginManifest } from '@core/plugin-sdk'
import { extractFragment, fragmentSourceFromSite, planFragmentInsert, type SiteFragment } from '@core/fragments'
import type { StyleRule } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { fragmentInsertDocument } from '@site/store/slices/fragmentsSlice'
import { insertFragmentForPlugin, planFragmentForPlugin } from '@admin/modals/InsertFragment/pluginFragmentsHost'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { makeNode, makePage, makeSite } from '../fixtures'
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
    if (url.endsWith('/media')) return json({ assets: [asset('lib-logo', 'logo.png', 'image/png', bytesOf('logo.png').byteLength)] })
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
    insert: (input) => insertFragmentForPlugin(input, (action) => action()),
    plan: planFragmentForPlugin,
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
    await expect(denied.editor.fragments.insert({ fragment: await bannerFragment(), readMediaBytes: () => null }))
      .rejects.toThrow('requires permission "editor.fragments"')
    await expect(denied.editor.fragments.plan({ fragment: await bannerFragment() }))
      .rejects.toThrow('requires permission "editor.fragments"')
    expect(bodyChildren()).toEqual(['first', 'second'])
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

  it("places inside the selected container for 'inside-selection' and at the end for 'end'", async () => {
    const inside = await api().editor.fragments.insert({ fragment: await bannerFragment(), placement: 'inside-selection', readMediaBytes: (m) => bytesOf(m.filename), silent: true })
    if (!inside.ok) throw new Error(inside.message)
    expect(useEditorStore.getState().site!.pages[0].nodes.first.children).toEqual(['first-text', inside.insertedRootIds[0]])

    useEditorStore.setState({ selectedNodeId: 'first-text', selectedNodeIds: ['first-text'] })
    const end = await api().editor.fragments.insert({ fragment: await bannerFragment(), placement: 'end', readMediaBytes: (m) => bytesOf(m.filename), silent: true })
    if (!end.ok) throw new Error(end.message)
    expect(bodyChildren()).toEqual(['first', 'second', end.insertedRootIds[0]])
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
