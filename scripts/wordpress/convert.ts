import { zipSync, strToU8 } from 'fflate'
import { basename } from 'node:path'
import '@modules/base'
import '@core/loops/sources'
import { useEditorStore } from '@site/store/store'
import { DEFAULT_BREAKPOINTS, parseSiteDocument, type SiteDocument } from '@core/page-tree'
import { applyConflictResolutions, buildImportPlan, commitImportPlan, ingestInput } from '@core/siteImport'
import { pageToCells } from '@core/data/pageFromRow'
import { BUNDLE_ARCHIVE_MANIFEST_PATH, mediaArchivePath, SiteBundleArchiveManifestSchema } from '@core/data/bundleArchive'
import type { MediaAssetMetadata } from '@core/data/bundleSchema'
import { safeParseJson } from '@core/utils/jsonValidate'
import { parseValue } from '@core/utils/typeboxHelpers'
import { createDbClient } from '../../server/db'
import { runMigrations } from '../../server/db/runMigrations'
import { listDataTables } from '../../server/repositories/data'
import { MAIN_SCOPE } from '../../server/branches/scope'
import { design } from './design'
import { contentModel, objectId, row, table } from './model'
import { SourceSchema, type Mapping } from './source'

async function seededTables() {
  const { db, migrations } = createDbClient('sqlite::memory:')
  try {
    await runMigrations(db, migrations)
    return await listDataTables(db, MAIN_SCOPE)
  } finally { await db.close() }
}

// The standalone CLI owns this editor-store instance. Use the actual Site Import
// transaction so class linking, body attributes, runtime files and scope match the UI.
export async function convert(bytes: Uint8Array, mapping: Mapping) {
  const input = await ingestInput({ zipBytes: bytes })
  if (!input.files['instatic-wordpress-source.json']) throw new Error('Expected an Instatic WordPress source package')
  const parsed = safeParseJson(new TextDecoder().decode(input.files['instatic-wordpress-source.json'].bytes), SourceSchema)
  if (!parsed.ok) throw parsed.error
  const source = parsed.value
  const warnings = new Set(source.warnings)
  const capture = design(source, input.files, mapping, warnings)
  const now = Date.parse(source.date)
  const initial: SiteDocument = { ...parseSiteDocument({
    id: objectId(source, 'site', source.blog), name: source.name, createdAt: now, updatedAt: now, breakpoints: DEFAULT_BREAKPOINTS,
  }), pages: [], visualComponents: [], layouts: [] }
  useEditorStore.setState({ site: initial, siteRuntime: initial.runtime, packageJson: initial.packageJson })
  const plan = buildImportPlan({ fileMap: { files: capture.files }, currentSite: initial, options: { stylesheetModes: capture.stylesheetModes } })
  const resolved = applyConflictResolutions(plan, plan.conflicts.pages, plan.conflicts.rules, plan.conflicts.tokens, plan.conflicts.crossSheetClasses)
  const media: MediaAssetMetadata[] = []
  const mediaByPath = new Map<string, MediaAssetMetadata>()
  const archiveMedia: Record<string, Uint8Array> = Object.create(null)
  const sourceMedia = new Map(source.media.map(m => [new URL(m.url).pathname.slice(1), m]))
  const imported = await commitImportPlan(resolved, {
    async uploadAsset(file) {
      const id = objectId(source, 'media', file.path)
      const filename = basename(file.path)
      const storagePath = id + '/' + filename
      const original = sourceMedia.get(file.path)
      const asset: MediaAssetMetadata = { id, storagePath, filename, title: original?.title ?? filename, mimeType: file.mimeType,
        sizeBytes: file.bytes.length, altText: original?.alt || file.altText || '', caption: original?.caption ?? '', tags: [],
        width: null, height: null, durationMs: null, dominantColor: null, blurHash: null, posterPath: null, folderIds: [] }
      media.push(asset)
      mediaByPath.set('/' + file.path, asset)
      archiveMedia[mediaArchivePath(storagePath)] = file.bytes
      return { url: '/uploads/' + storagePath, warnings: [] }
    },
    async installGoogleFont() { throw new Error('Online font installation requires operator review') },
    async commit(recipe) {
      const ok = useEditorStore.getState().mutateAllPagesAndSite((_site, tx) => { recipe(tx); return true })
      if (!ok) throw new Error('Could not apply Site Import plan')
    },
  })
  for (const warning of imported.warnings) warnings.add(warning.kind + ': ' + warning.message)
  const site = structuredClone(useEditorStore.getState().site!)
  const pagesById = new Map(site.pages.map(p => [p.id, p]))
  const pageIds = new Map<number, string>()
  for (const entry of imported.pages) {
    const spec = capture.pages.get(entry.source)!
    const page = pagesById.get(entry.id)!
    if (spec.post) pageIds.set(spec.post, page.id)
    if (spec.entry || spec.shared) {
      page.title = spec.shared ? 'Shared layout' : spec.entry + ' entry'
      page.template = { enabled: true, priority: 0, target: spec.shared ? { kind: 'everywhere' } :
        { kind: 'postTypes', tableSlugs: [spec.entry === 'post' ? 'posts' : spec.entry!.replaceAll('_', '-')] } }
      delete page.seo // A sample's canonical URL and share card belong to that entry alone.
    }
  }
  // Body cells take a separate path from page-tree assets. Localize the links in
  // them as well, including responsive image candidates in Gutenberg content.
  function mediaUrl(value: string) {
    const url = new URL(value, source.site)
    const match = url.origin === new URL(source.site).origin && mediaByPath.get(url.pathname)
    return match ? '/uploads/' + match.storagePath + url.hash : value
  }
  for (const [id, body] of capture.bodies) {
    const doc = new DOMParser().parseFromString(body, 'text/html')
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of ['src', 'poster', 'href']) {
        const value = el.getAttribute(attr)
        if (value) el.setAttribute(attr, mediaUrl(value))
      }
      const srcset = el.getAttribute('srcset')
      if (srcset && !srcset.includes('data:')) el.setAttribute('srcset', srcset.split(',').map(candidate => {
        const [url, ...descriptor] = candidate.trim().split(/\s+/)
        return [mediaUrl(url), ...descriptor].join(' ')
      }).join(', '))
    }
    capture.bodies.set(id, doc.body.innerHTML)
  }
  const mediaIds = new Map(source.media.flatMap(m => {
    const asset = mediaByPath.get(new URL(m.url).pathname)
    return asset ? [[m.id, asset.id] as const] : []
  }))
  const model = contentModel(source, await seededTables(), mediaIds, warnings, capture.bodies, pageIds)
  for (const form of mapping.forms ?? []) {
    const fields = Object.entries(form.fields).map(([id, type]) => ({ id, label: id, type }))
    if (!fields.length) throw new Error('Form mapping needs at least one field')
    const target = table(objectId(source, 'form', form.name), 'wp-form-' + form.name, form.name, fields, source.date)
    target.primaryFieldId = fields[0].id
    model.tables.push(target)
  }
  const postByPage = new Map([...pageIds].map(([post, page]) => [page, post]))
  for (const p of site.pages) model.rows.push(row(p.id, 'pages', p.slug, {
    ...pageToCells(p), ...model.pageCells.get(postByPage.get(p.id) ?? -1),
  }, source.date))
  const manifest = parseValue(SiteBundleArchiveManifestSchema, { schemaVersion: 1, sourceSiteName: source.name,
    exportedAt: source.date, site: parseSiteDocument(site), tables: model.tables, rows: model.rows, media })
  const archive = zipSync({ [BUNDLE_ARCHIVE_MANIFEST_PATH]: strToU8(JSON.stringify(manifest)), ...archiveMedia }, { level: 0 })
  return { archive, report: { source: source.site, inventory: source.inventory, tables: model.tables.length,
    rows: model.rows.length, media: media.length, pages: site.pages.map(p => ({ title: p.title, slug: p.slug })),
    warnings: [...warnings].sort() } }
}
