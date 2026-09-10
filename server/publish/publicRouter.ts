/** One public inventory gates HTML, cache hits, redirects and localized SEO. */
import {
  buildLocalizedPath,
  localeForPublishedPath,
  LocalizedRouteError,
  normalizePublishedPath,
  resolvePublishedRoute,
} from '@core/localization-routing'
import type { DbClient } from '../db/client'
import { getPublishedRedirectByPath } from '../repositories/data'
import { getLatestPublishedSiteSnapshot } from '../repositories/publish'
import { getOrRender, peek } from './renderCache'
import { arePublishedArtefactsCurrent, getPublishVersion } from './publishState'
import { canonicalRenderQuery } from './loopPrefetch'
import { getPublishedRouteInventoryForVersion } from './publishedRoutes'
import { projectPublishedSite, readPublishedRouteContext } from './publishedRouteContext'
import { notFoundArtefactPath, readArtefact } from './staticArtefact'
import { renderPublishedNotFound, renderResolvedPublishedRoute } from './publicRenderer'
import { applyPublishedHtmlPipeline } from './publishedHtmlPipeline'
import { buildLocalizedSitemap } from './localizedSeo'
import { snapshotForNotFoundRoute } from './entryTemplateSnapshot'

const htmlHeaders = { 'content-type': 'text/html; charset=utf-8' }

export async function renderPublicResolution(db: DbClient, url: URL, uploadsDir?: string): Promise<Response | null> {
  const version = getPublishVersion()
  const inventory = await getPublishedRouteInventoryForVersion(db, version)
  if (url.pathname === '/sitemap.xml') {
    const carrier = inventory.routes[0] ?? inventory.dependencies[0]
    if (!carrier) return null
    const snapshot = await getLatestPublishedSiteSnapshot(db, carrier.localeId, carrier.siteSnapshotId)
    const origin = snapshot?.site.settings.publicOrigin
    return origin ? new Response(buildLocalizedSitemap(inventory, origin), { headers: { 'content-type': 'application/xml; charset=utf-8' } }) : null
  }
  const route = resolvePublishedRoute(inventory, url.pathname)
  if (!route) {
    let path: string
    try {
      path = normalizePublishedPath(url.pathname)
    } catch (error) {
      if (error instanceof LocalizedRouteError) return null
      throw error
    }
    const redirect = await getPublishedRedirectByPath(db, path)
    if (!redirect || !resolvePublishedRoute(inventory, redirect.targetPath)) return null
    return new Response(null, { status: 301, headers: { location: `${redirect.targetPath}${url.search}` } })
  }
  // The authoritative visibility check is before disk and memory fast paths.
  // A version bump disables old artefacts, including baked lists of retracted
  // items, until the replacement slot is complete.
  const queryString = canonicalRenderQuery(url.searchParams)
  if (uploadsDir && queryString === '' && arePublishedArtefactsCurrent()) {
    const html = await readArtefact(uploadsDir, route.path)
    if (html !== null) return new Response(html, { headers: htmlHeaders })
  }
  const key = { urlPath: route.path, queryString }
  const warm = peek(key)
  if (warm) return new Response(warm.body, { status: warm.status, headers: warm.headers })
  const rendered = await getOrRender(key, async () => {
    const context = await readPublishedRouteContext(db, route, inventory)
    if (!context) return null
    const output = await renderResolvedPublishedRoute(context, db, url, inventory, version)
    if (!output) return null
    return { body: await applyPublishedHtmlPipeline(output, db), status: 200, headers: htmlHeaders }
  })
  return rendered ? new Response(rendered.body, { status: rendered.status, headers: rendered.headers }) : null
}

export async function renderNotFoundResponse(db: DbClient, url: URL, uploadsDir?: string): Promise<Response | null> {
  const version = getPublishVersion()
  const inventory = await getPublishedRouteInventoryForVersion(db, version)
  const locale = localeForPublishedPath(inventory.locales, url.pathname)
  if (!locale) return null
  const path = buildLocalizedPath(locale, '404')
  if (uploadsDir && arePublishedArtefactsCurrent()) {
    const html = await readArtefact(uploadsDir, notFoundArtefactPath(locale.id))
    if (html !== null) return new Response(html, { status: 404, headers: htmlHeaders })
  }
  const key = { urlPath: `${path}:not-found`, queryString: '' }
  const rendered = await getOrRender(key, async () => {
    const published = await getLatestPublishedSiteSnapshot(db, locale.id)
    if (!published) return null
    const site = projectPublishedSite(published.site, inventory, locale.id)
    const snapshot = await snapshotForNotFoundRoute(db, { ...published, site })
    const output = await renderPublishedNotFound(snapshot, { db, url: new URL(path, url.origin), publishVersion: version })
    if (!output) return null
    return { body: await applyPublishedHtmlPipeline(output, db), status: 200, headers: htmlHeaders }
  })
  return rendered ? new Response(rendered.body, { status: 404, headers: rendered.headers }) : null
}
