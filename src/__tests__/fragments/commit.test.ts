/**
 * extract → plan → commit, end to end, with an in-memory adapter that keeps a
 * media library and data tables and applies the store transaction to a plain
 * site document (plus the editor's framework reconcile).
 */

import { describe, expect, it } from 'bun:test'
import {
  FragmentCommitError,
  applyResolvedFragment,
  commitFragmentPlan,
  extractFragment,
  fragmentSourceFromSite,
  planFragmentInsert,
  type FragmentInsertAdapter,
  type FragmentMedia,
  type SiteFragment,
} from '@core/fragments'
import type { DataField, DataTable } from '@core/data/schemas'
import type { FontEntry } from '@core/fonts'
import type { PageNode, SiteDocument } from '@core/page-tree'
import { reconcileFrameworkClasses } from '@site/store/slices/site/framework/reconcile'
import { makePage, makeSite } from '../fixtures'
import {
  SOURCE_ROWS,
  SOURCE_TABLES,
  TARGET_TABLES,
  makeSourceSite,
  makeTargetSite,
  mediaBytesFor,
  sourceMediaWithBytes,
} from './fixtures'

async function extracted(selection: Parameters<typeof extractFragment>[1]) {
  return extractFragment(
    fragmentSourceFromSite(makeSourceSite(), { tables: SOURCE_TABLES, rows: SOURCE_ROWS, media: sourceMediaWithBytes() }),
    selection,
  )
}

interface MemoryServer {
  library: { id: string; url: string; filename: string; mimeType: string; sizeBytes: number }[]
  tables: DataTable[]
  rows: { tableId: string; status: string; cells: Record<string, unknown> }[]
  fonts: FontEntry[]
}

function memoryAdapter(site: SiteDocument, tables: DataTable[], placement: { pageId: string; parentId: string }, fail?: 'upload') {
  const server: MemoryServer = { library: [], tables: structuredClone(tables), rows: [], fonts: [] }
  let seq = 0
  const adapter: FragmentInsertAdapter = {
    async findMedia(media) {
      const hit = server.library.find((a) => a.filename === media.filename && a.mimeType === media.mimeType && a.sizeBytes === media.sizeBytes)
      return hit ? { id: hit.id, url: hit.url } : null
    },
    async uploadMedia(file) {
      if (fail === 'upload') throw new Error('disk full')
      seq += 1
      const asset = { id: `m${seq}`, url: `/uploads/new-${seq}-${file.filename}`, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.bytes.byteLength }
      server.library.push(asset)
      return { id: asset.id, url: asset.url }
    },
    async installGoogleFont(request) {
      return { id: `g-${request.family}`, source: 'google', family: request.family, variants: request.variants, subsets: request.subsets, files: [], createdAt: 1, updatedAt: 1 }
    },
    async registerCustomFont(request) {
      const entry: FontEntry = {
        id: `font-${++seq}`,
        source: 'custom',
        family: request.family,
        variants: request.files.map((f) => f.variant),
        subsets: ['latin'],
        files: request.files.map((f) => ({
          variant: f.variant,
          subset: 'latin',
          path: server.library.find((a) => a.id === f.mediaAssetId)!.url,
          format: 'woff2' as const,
          mediaAssetId: f.mediaAssetId,
        })),
        createdAt: 1,
        updatedAt: 1,
      }
      server.fonts.push(entry)
      return entry
    },
    async createTable(input) {
      const table: DataTable = { ...input, id: `tbl-new-${++seq}`, system: false, createdByUserId: null, updatedByUserId: null, createdAt: '', updatedAt: '' }
      server.tables.push(table)
      return { id: table.id }
    },
    async updateTableFields(tableId: string, fields: DataField[]) {
      server.tables.find((t) => t.id === tableId)!.fields = fields
    },
    async createRow(tableId, row) {
      server.rows.push({ tableId, status: row.status, cells: row.cells })
      return { id: `row-new-${++seq}` }
    },
    async commit(plan) {
      const page = site.pages.find((p) => p.id === placement.pageId)!
      const applied = applyResolvedFragment(site, plan, plan.page ? null : { tree: page, parentId: placement.parentId })
      if (applied.frameworkChanged) reconcileFrameworkClasses(site)
      return { rootIds: applied.rootIds, ...(applied.pageId ? { pageId: applied.pageId } : {}) }
    },
  }
  return { adapter, server }
}

const readBytes = (fragment: SiteFragment) => (media: FragmentMedia) => {
  const source = fragment.media.find((m) => m.id === media.id)
  return source ? mediaBytesFor(source.id) : null
}

describe('commitFragmentPlan — into a populated site', () => {
  it('lands the section with styles, tokens, media, tables and links resolved', async () => {
    const { fragment } = await extracted({ pageId: 'page-home', rootNodeIds: ['hero'] })
    const site = makeTargetSite()
    const plan = planFragmentInsert({ site, tables: TARGET_TABLES, document: { kind: 'page', pageId: 't-home' } }, fragment)
    const { adapter, server } = memoryAdapter(site, TARGET_TABLES, { pageId: 't-home', parentId: 't-body' })

    const result = await commitFragmentPlan(plan, adapter, { readMediaBytes: readBytes(fragment) })
    const page = site.pages.find((p) => p.id === 't-home')!

    // Placed after the existing section, parent pointers consistent.
    expect(page.nodes['t-body'].children).toEqual(['t-section', result.rootIds[0]])
    const hero = page.nodes[result.rootIds[0]]
    expect(hero.parentId).toBe('t-body')

    // Every class id a placed node carries exists in the site after commit,
    // framework utilities included (the xl step and the accent colour were added).
    for (const id of Object.keys(plan.nodes)) {
      for (const classId of page.nodes[id].classIds) expect(site.styleRules[classId]).toBeDefined()
    }
    const title = Object.values(page.nodes).find((n) => n.props.text === 'Hello')!
    const titleClasses = title.classIds.map((id) => site.styleRules[id].name).sort()
    expect(titleClasses).toEqual(['hero-title', 'text-primary', 'text-xl'])
    expect(site.settings.framework!.typography!.groups[0].steps).toBe('xs,s,m,l,xl')
    expect(site.settings.framework!.colors.tokens.map((t) => t.slug)).toEqual(['primary', 'accent'])
    expect(Object.values(site.styleRules).some((r) => r.name === 'bg-accent')).toBe(true)

    // Media uploaded once each and every reference rewritten.
    expect(result.report.media).toEqual({ total: 2, uploaded: 2, reused: 0 })
    const photo = Object.values(page.nodes).find((n) => n.moduleId === 'base.image')!
    expect(photo.props.src).toMatch(/^\/uploads\/new-\d+-photo\.jpg$/)
    // Fonts: Inter registered from the uploaded file and bound to the new token.
    const inter = site.settings.fonts!.items.find((f) => f.family === 'Inter')!
    expect(inter.files[0].path).toMatch(/^\/uploads\/new-\d+-inter\.woff2$/)
    expect(site.settings.fonts!.tokens!.find((t) => t.variable === 'font-heading')!.familyId).toBe(inter.id)

    // Tables: the created contact table is wired into the form; the reused
    // projects table gained the cover field.
    const form = Object.values(page.nodes).find((n) => n.moduleId === 'base.form')!
    const contact = server.tables.find((t) => t.slug === 'contact')!
    expect(form.props.targetTableId).toBe(contact.id)
    expect(server.tables.find((t) => t.slug === 'projects')!.fields.map((f) => f.id)).toEqual(['title', 'cover'])
    expect(server.rows).toEqual([]) // forms carry no rows; the reused table keeps its own

    // Link remapped to the site's About page; Card instance points at the site's Card.
    expect(Object.values(page.nodes).find((n) => n.moduleId === 'base.link')!.props.href).toBe('cms:page:t-about#team')
    expect(Object.values(page.nodes).find((n) => n.moduleId === 'base.visual-component-ref')!.props.componentId).toBe('t-vc-card')

    // The engine-owned :root rule holds the custom property the site lacked.
    const owned = Object.values(site.styleRules).find((r) => r.description === 'Custom properties added by inserted fragments')!
    expect(owned.styles).toEqual({ '--shadow': '0 0 4px var(--primary-50)' })
    // The user's own :root rule is untouched.
    expect(site.styleRules['t-root'].styles).toEqual({ '--radius': '2px' })
  })

  it('a second insert of the same fragment reuses the uploaded media and adds no rules', async () => {
    const { fragment } = await extracted({ pageId: 'page-home', rootNodeIds: ['hero'] })
    const site = makeTargetSite()
    const { adapter } = memoryAdapter(site, TARGET_TABLES, { pageId: 't-home', parentId: 't-body' })
    const first = planFragmentInsert({ site, tables: TARGET_TABLES, document: { kind: 'page', pageId: 't-home' } }, fragment)
    await commitFragmentPlan(first, adapter, { readMediaBytes: readBytes(fragment) })
    const rulesAfterFirst = Object.keys(site.styleRules).length

    const second = planFragmentInsert({ site, tables: TARGET_TABLES, document: { kind: 'page', pageId: 't-home' } }, fragment)
    expect(second.styleRules.filter((r) => !r.scope)).toEqual([])
    expect(second.customProperties).toBeNull()
    const result = await commitFragmentPlan(second, adapter, { readMediaBytes: readBytes(fragment) })
    // Inter is in the library now, so its file is not needed again; the photo
    // is found in the media library by name, size and type.
    expect(result.report.media).toEqual({ total: 1, uploaded: 0, reused: 1 })
    // Only the per-node scoped rule is new: it belongs to the new node.
    expect(Object.keys(site.styleRules).length).toBe(rulesAfterFirst + 1)
  })

  it('stops before touching the document when an upload fails', async () => {
    const { fragment } = await extracted({ pageId: 'page-home', rootNodeIds: ['hero'] })
    const site = makeTargetSite()
    const before = structuredClone(site)
    const plan = planFragmentInsert({ site, tables: TARGET_TABLES, document: { kind: 'page', pageId: 't-home' } }, fragment)
    const { adapter } = memoryAdapter(site, TARGET_TABLES, { pageId: 't-home', parentId: 't-body' }, 'upload')
    await expect(commitFragmentPlan(plan, adapter, { readMediaBytes: readBytes(fragment) })).rejects.toBeInstanceOf(FragmentCommitError)
    expect(site).toEqual(before)
  })

  it('honours cancellation before the transaction', async () => {
    const { fragment } = await extracted({ pageId: 'page-home', rootNodeIds: ['hero'] })
    const site = makeTargetSite()
    const before = structuredClone(site)
    const plan = planFragmentInsert({ site, tables: TARGET_TABLES, document: { kind: 'page', pageId: 't-home' } }, fragment)
    const { adapter } = memoryAdapter(site, TARGET_TABLES, { pageId: 't-home', parentId: 't-body' })
    const controller = new AbortController()
    controller.abort()
    await expect(commitFragmentPlan(plan, adapter, { readMediaBytes: readBytes(fragment), signal: controller.signal })).rejects.toThrow()
    expect(site).toEqual(before)
  })
})

describe('commitFragmentPlan — into an empty site', () => {
  it('creates everything, rows and media cells included', async () => {
    const { fragment } = await extracted({ pageId: 'page-home', rootNodeIds: ['hero'] })
    const site = makeSite({ pages: [makePage({ id: 'e-home', rootNodeId: 'e-body' })] })
    const plan = planFragmentInsert({ site, tables: [], document: { kind: 'page', pageId: 'e-home' } }, fragment)
    const { adapter, server } = memoryAdapter(site, [], { pageId: 'e-home', parentId: 'e-body' })
    const result = await commitFragmentPlan(plan, adapter, { readMediaBytes: readBytes(fragment) })

    expect(site.visualComponents.map((vc) => vc.name).sort()).toEqual(['Badge', 'Card'])
    const projects = server.tables.find((t) => t.slug === 'projects')!
    expect(projects.fields.map((f) => f.id)).toEqual(['title', 'cover'])
    const projectRows = server.rows.filter((r) => r.tableId === projects.id)
    expect(projectRows.map((r) => r.status)).toEqual(['published', 'draft'])
    const coverId = projectRows[0].cells.cover as string
    expect(server.library.find((a) => a.id === coverId)?.filename).toBe('cover.jpg')
    // The draft row's rich text links to a page this site does not have.
    expect(projectRows[1].cells.title).toBe('Mill <a href="#">more</a>')

    const page = site.pages[0]
    const loop = Object.values(page.nodes).find((n) => n.moduleId === 'base.loop') as PageNode
    expect((loop.props.filters as Record<string, unknown>).tableId).toBe(projects.id)
    expect(result.report.media.uploaded).toBe(4)
    // Every class the inserted nodes and components use resolves.
    for (const node of [...Object.values(page.nodes), ...site.visualComponents.flatMap((vc) => Object.values(vc.tree.nodes))]) {
      for (const classId of node.classIds) expect(site.styleRules[classId]).toBeDefined()
    }
  })

  it('a page fragment becomes a new page', async () => {
    const { fragment } = await extracted({ pageId: 'page-home' })
    const site = makeTargetSite()
    const plan = planFragmentInsert({ site, tables: TARGET_TABLES }, fragment)
    const { adapter } = memoryAdapter(site, TARGET_TABLES, { pageId: 't-home', parentId: 't-body' })
    const result = await commitFragmentPlan(plan, adapter, { readMediaBytes: readBytes(fragment) })
    const page = site.pages.find((p) => p.id === result.pageId)!
    expect(page.slug).toBe('index-2')
    expect(page.nodes[page.rootNodeId].moduleId).toBe('base.body')
    expect(Object.keys(page.nodes)).toHaveLength(Object.keys(fragment.nodes).length)
  })
})
