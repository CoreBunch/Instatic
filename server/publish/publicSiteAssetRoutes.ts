import type { RouteHandler } from '../serverRuntime'
import { resolvePreviewCookie } from '../branches/previewLinks'
import { getDraftSiteDocument } from '../repositories/publish'
import { isTemplatePage } from '@core/templates'
import { pagePublicPath } from '@core/page-tree'
import { publicAssetRequestPath } from '@core/files/publicAssets'
import { compilePublicSiteAssets, publicSiteAssetResponse, readPublicSiteAsset } from './publicSiteAssets'

/** Only published bytes are public; a live branch token grants that branch's draft. */
export const tryServePublicSiteAsset: RouteHandler = async (req, runtime, _url, pathname) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  const publicPath = publicAssetRequestPath(pathname)
  if (!publicPath) return null
  const branchId = await resolvePreviewCookie(req, runtime.db)
  if (branchId) {
    const site = await getDraftSiteDocument(runtime.db, { branchId })
    if (!site) return null
    const assets = compilePublicSiteAssets(site.files, site.pages.filter((page) => !isTemplatePage(page)).map((page) => pagePublicPath(page.slug)))
    const asset = assets.find((candidate) => candidate.publicPath === publicPath)
    // A missing branch asset never exposes main's published asset at this URL.
    return asset ? publicSiteAssetResponse(req, asset, true) : null
  }
  if (!runtime.uploadsDir) return null
  const asset = await readPublicSiteAsset(runtime.uploadsDir, publicPath)
  return asset ? publicSiteAssetResponse(req, asset) : null
}
