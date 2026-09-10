/** Publishes explicit language variants and their frozen design dependencies. */
import { nanoid } from 'nanoid'
import type { ScheduledLocalizationRevision } from '@core/localization-schema'
import type { SiteDocument } from '@core/page-tree'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { isTemplatePage } from '@core/templates'
import { pageToCells } from '@core/data/pageFromRow'
import { buildLocalizedPath, createPublishedRouteInventory, readSnapshotLanguage, LocalizedRouteError, type PublishedRouteCandidate } from '@core/localization-routing'
import type { DbClient } from '../db/client'
import { nextDataRowVersionNumber } from '../repositories/data'
import { getLocale, listLocales } from '../repositories/localization'
import { listPublishedRouteCandidates } from '../repositories/localizationRoutes'
import {
  getDraftSiteDocument,
  getStoredSiteDocument,
  getPublishedPageSnapshotById,
  persistSitePublish,
  type PersistSitePublishInput,
  type PublishedPageVersionWrite,
} from '../repositories/publish'
import { buildSiteRuntimeScripts } from './runtime/bundleScripts'
import { RuntimeScriptBuildError } from './runtime/buildError'
import { ensureRuntimeDependencyCache } from './runtime/dependencyCache'
import { buildRuntimePackageImportmap, serializeImportmapForCsp } from './runtime/packageImportmap'
import { bumpPublishVersion, withPublishLock } from './publishState'
import { runPublishFlush } from './publishFlush'
import { rebakePublishedRoutes } from './rebakePublishedRoutes'

export interface PublishSiteOptions {
  /** Omitted means refresh currently online variants; offline stays offline. */
  variants?: { rowId: string; localeId: string }[]
  /** Internal scheduler input; never accepted from the site-publish HTTP body. */
  revision?: ScheduledLocalizationRevision
}

export async function publishDraftSite(
  db: DbClient,
  adminUserId: string | null,
  uploadsDir?: string,
  options: PublishSiteOptions = {},
): Promise<{ publishedPages: number }> {
  await runPublishFlush()
  return withPublishLock(async () => {
    const [live, locales] = await Promise.all([listPublishedRouteCandidates(db), listLocales(db)])
    const selection = options.variants ?? live.filter((entry) => entry.kind !== 'row').map((entry) => ({
      rowId: entry.contentId, localeId: entry.localeId,
    }))
    const localeSelections = new Map<string, Set<string>>()
    for (const variant of selection) {
      const ids = localeSelections.get(variant.localeId) ?? new Set<string>()
      ids.add(variant.rowId)
      localeSelections.set(variant.localeId, ids)
    }
    const inputs: PersistSitePublishInput[] = []
    // Build every requested locale before committing any of them. A runtime
    // compilation error in one language cannot publish the other languages.
    for (const [localeId, selectedIds] of localeSelections) {
      inputs.push(await prepareLocalePublish(db, adminUserId, localeId, selectedIds, options.revision))
    }
    const allocatedVersions = new Map<string, number>()
    for (const input of inputs) for (const page of input.pages) {
      page.versionNumber = Math.max(page.versionNumber, (allocatedVersions.get(page.pageId) ?? 0) + 1)
      allocatedVersions.set(page.pageId, page.versionNumber)
    }
    const variantKey = (localeId: string, rowId: string): string => JSON.stringify([localeId, rowId])
    const replaced = new Set(inputs.flatMap((input) => input.pages.filter((page) => page.activate).map((page) => variantKey(page.localeId, page.pageId))))
    const planned: PublishedRouteCandidate[] = inputs.flatMap((input) => input.pages.filter((page) => page.activate).map((page) => ({
      contentId: page.pageId, localeId: page.localeId, publishedVersionId: page.versionId,
      siteSnapshotId: input.siteSnapshotId, tableId: 'pages', tableSlug: 'pages', availability: 'online',
      languageCode: readSnapshotLanguage(page.localeId, input.site.locales, input.site.settings.language).code,
      kind: page.publicPath === null ? 'template' : 'page',
      ...(page.publicPath !== null ? { path: page.publicPath } : {}),
    })))
    // Collision checks include existing CMS URLs and other languages. They
    // happen before the short transaction, never after exposing a new route.
    createPublishedRouteInventory(locales, [
      ...live.filter((entry) => !replaced.has(variantKey(entry.localeId, entry.contentId))), ...planned,
    ])
    if (inputs.length > 0) await persistSitePublish(db, inputs)
    const version = bumpPublishVersion()
    if (uploadsDir) await rebakePublishedRoutes(db, uploadsDir, version)
    return { publishedPages: inputs.reduce((count, input) => count + input.pages.filter((page) => page.publicPath !== null).length, 0) }
  })
}

async function prepareLocalePublish(
  db: DbClient,
  publisherId: string | null,
  localeId: string,
  selectedIds: ReadonlySet<string>,
  revision?: ScheduledLocalizationRevision,
): Promise<PersistSitePublishInput> {
  const [draft, locale] = await Promise.all([
    revision?.siteSnapshotId ? getStoredSiteDocument(db, revision.siteSnapshotId) : getDraftSiteDocument(db, { localeId }), getLocale(db, localeId),
  ])
  if (!draft || !locale) throw new LocalizedRouteError(localeId, 'The site or language does not exist.')
  if (!locale.enabled) throw new LocalizedRouteError(locale.id, 'Enable this language before publishing content.')
  const frozenLocale = draft.locales?.find((entry) => entry.id === localeId) ?? locale
  for (const selectedId of selectedIds) {
    if (!draft.pages.some((page) => page.id === selectedId)) {
      throw new LocalizedRouteError(selectedId, 'A selected page no longer exists.')
    }
  }
  const pages: SiteDocument['pages'] = []
  for (const page of draft.pages) {
    if (isTemplatePage(page) || selectedIds.has(page.id)) {
      pages.push(page)
    } else {
      const published = await getPublishedPageSnapshotById(db, page.id, localeId)
      const frozen = published?.site.pages.find((candidate) => candidate.id === page.id)
      if (frozen) pages.push(frozen)
    }
  }
  const { localization: _draftVariants, ...withoutDraftVariants } = draft
  const site: SiteDocument = { ...withoutDraftVariants, pages, layouts: [] }
  const runtime = normalizeSiteRuntimeConfig(site.runtime)
  const dependencyCache = Object.keys(runtime.dependencyLock.packages).length > 0
    ? await ensureRuntimeDependencyCache(runtime.dependencyLock) : undefined
  const packageImportmap = dependencyCache
    ? await buildRuntimePackageImportmap(runtime.dependencyLock, dependencyCache) : null
  const serializedImportmap = packageImportmap ? await serializeImportmapForCsp(packageImportmap.importmap) : null
  const pageWrites: PublishedPageVersionWrite[] = []
  for (const page of site.pages) {
    if (!selectedIds.has(page.id) && !isTemplatePage(page)) continue
    const versionId = nanoid()
    const built = await buildSiteRuntimeScripts({
      site, page, target: 'publish', assetBasePath: `/_instatic/assets/${versionId}/`, dependencyCache,
    })
    const errors = built.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    if (errors.length > 0) throw new RuntimeScriptBuildError(page, errors)
    pageWrites.push({
      pageId: page.id, title: page.title, slug: page.slug, cells: pageToCells(page), localeId,
      activate: selectedIds.has(page.id),
      publicPath: isTemplatePage(page) ? null : revision?.publicPath ?? buildLocalizedPath(frozenLocale, page.slug),
      versionId, versionNumber: await nextDataRowVersionNumber(db, page.id),
      runtimeAssets: built.runtimeAssets, runtimeFiles: built.files,
    })
  }
  return { siteSnapshotId: nanoid(), site, serializedImportmap, pages: pageWrites, publishedByUserId: publisherId }
}
