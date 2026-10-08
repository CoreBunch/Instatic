/** Public infinite-loop fragments use the originating published route's native context. */
import type { DbClient } from '../../db/client'
import { ModulePropsValidationError, registry } from '@core/module-engine'
import { loopSourceRegistry } from '@core/loops/registry'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { LocalizationError } from '@core/localization'
import { PageTranslationError } from '@core/page-tree'
import { PublicAssetValidationError } from '@core/files/publicAssets'
import { LoopScopeConfigurationError, renderNode, type RenderConfig, type RenderAccumulators, type ResolvedLoopRenderData } from '@core/publisher'
import { jsonResponse } from '../../http'
import { prefetchLoopData, readLoopProps } from '../../publish/loopPrefetch'
import { prefetchMediaAssets } from '../../publish/mediaPrefetch'
import { LoopFragmentContextError, readLoopPageUrl, resolveLoopFragmentContext } from '../../publish/loopFragmentContext'
import { getPublishVersion } from '../../publish/publishState'
import { LOOP_RUNTIME_JS } from '../../publish/loopRuntime'

const LOOP_RUNTIME_PATH = '/_instatic/assets/loop-runtime.js'

export function isLoopRuntimeAssetPath(pathname: string): boolean {
  return pathname === LOOP_RUNTIME_PATH
}

export function serveLoopRuntimeAsset(): Response {
  return new Response(LOOP_RUNTIME_JS, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      // Aggressive caching — content is a fixed CMS asset that only
      // changes when the CMS itself ships a new version. We can re-deploy
      // by invalidating the path or appending a hash.
      'cache-control': 'public, max-age=3600',
    },
  })
}

interface LoopHandlerContext {
  db: DbClient
}

const LoopRequestSchema = Type.Object({
  loopId: Type.String({ minLength: 1 }),
  pageNumber: Type.Integer({ minimum: 1 }),
  pagePath: Type.String({ minLength: 1 }),
  version: Type.String({ pattern: '^(0|[1-9][0-9]*)$' }),
})

export async function handleLoopRequest(req: Request, url: URL, ctx: LoopHandlerContext): Promise<Response> {
  if (req.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  try {
    let loopId: string
    try {
      loopId = decodeURIComponent(url.pathname.slice('/_instatic/loop/'.length))
    } catch {
      throw new LoopFragmentContextError('Invalid loop id', 400)
    }
    const parsed = safeParseValue(LoopRequestSchema, {
      loopId,
      pageNumber: Number(url.searchParams.get('page') ?? '1'),
      pagePath: url.searchParams.get('pagePath'),
      version: url.searchParams.get('v'),
    })
    if (!parsed.ok) throw new LoopFragmentContextError('Invalid loop request: ' + parsed.errors.map((error) => error.path + ' ' + error.message).join('; '), 400)
    const { pageNumber, pagePath } = parsed.value
    const version = Number(parsed.value.version)
    if (version !== getPublishVersion()) throw new LoopFragmentContextError('The published page has changed; reload it before loading more', 409)
    const pageUrl = readLoopPageUrl(pagePath, url)
    const target = await resolveLoopFragmentContext(ctx.db, pageUrl, loopId)
    const { node: loopNode, page, site, templateContext } = target
    const props = readLoopProps(loopNode)
    if (props.pagination !== 'infinite') throw new LoopFragmentContextError('Loop is not in infinite mode', 400)
    const source = loopSourceRegistry.get(props.sourceId)
    if (!source) throw new LoopFragmentContextError('Source not registered', 404)
    if (source.kind === 'contextual') throw new LoopFragmentContextError('Contextual loops do not support infinite pagination', 400)

    const offset = props.offset + (pageNumber - 1) * props.pageSize
    const result = await source.fetch({
      db: ctx.db, site, filters: props.filters,
      orderBy: props.orderBy || (source.orderByOptions[0]?.id ?? ''),
      direction: props.direction, limit: props.pageSize, offset,
      request: {
        path: templateContext.route!.path, slug: templateContext.route!.slug,
        query: Object.fromEntries(target.pageUrl.searchParams), cookies: {},
      },
    })
    const hasMore = offset + result.items.length < result.totalItems
    const loopData = new Map<string, ResolvedLoopRenderData>()
    for (const variantId of loopNode.children) {
      const nested = await prefetchLoopData(page, site, ctx.db, target.pageUrl, { rootNodeId: variantId })
      for (const [id, data] of nested) loopData.set(id, data)
    }
    loopData.set(loopId, { ...result, pageNumber, hasMore })
    const mediaAssets = await prefetchMediaAssets(page, site, registry, ctx.db, { templateContext, loopData })
    const config: RenderConfig = { page, site, registry, breakpointId: undefined, templateContext, loopData, mediaAssets }
    const acc: RenderAccumulators = { cssMap: new Map(), jsMap: new Map(), infiniteLoopIds: new Set(), holeNodeIds: new Set(), cspSources: new Map() }
    let html = ''
    if (loopNode.children.length > 0) {
      result.items.forEach((item, i) => {
        const iteration: RenderConfig = { ...config, templateContext: { ...templateContext, entryStack: [...templateContext.entryStack, item] } }
        html += renderNode(loopNode.children[i % loopNode.children.length], iteration, acc)
      })
    }
    if (version !== getPublishVersion()) throw new LoopFragmentContextError('The published page changed while loading more; reload it', 409)
    return jsonResponse({ html, hasMore, pageNumber })
  } catch (err) {
    if (err instanceof LoopFragmentContextError) return jsonResponse({ error: err.message }, { status: err.status })
    if (err instanceof LocalizationError || err instanceof PageTranslationError || err instanceof PublicAssetValidationError || err instanceof LoopScopeConfigurationError || err instanceof ModulePropsValidationError) {
      return jsonResponse({ error: err.message }, { status: 422 })
    }
    console.error('[loop] Failed to load published loop fragment:', err)
    return jsonResponse({ error: 'Failed to load published loop fragment' }, { status: 500 })
  }
}
