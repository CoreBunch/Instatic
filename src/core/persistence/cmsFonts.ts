/**
 * Client-side wrappers for the fonts CMS endpoints.
 *
 * - `listCmsGoogleFonts` returns the bundled directory snapshot via the server
 *   (rather than importing the JSON directly) so the editor stays a thin client.
 * - `estimateCmsGoogleFont` returns the total woff2 download size for a
 *   selection without committing files — used by the picker to show a live
 *   "selected: 42 KB" hint before the user clicks Install.
 * - `installCmsGoogleFont` posts the user's chosen variants/subsets and returns
 *   a fully-shaped `FontEntry` to merge into `site.settings.fonts`.
 * - `registerCustomFont` posts uploaded media-asset ids + variants and returns
 *   a `FontEntry` (`source: 'custom'`) to merge into `site.settings.fonts`.
 * - `deleteCmsFontFamily` removes the on-disk woff2 files for a Google family
 *   slug. Custom fonts reference shared media assets, so removing one is a
 *   metadata-only edit — no server call.
 */

import type { FontEntry } from '@core/fonts'
import { apiRequest, type FetchLike } from '@core/http'
import {
  type CmsFontEstimateDto,
  CmsFontEntryEnvelopeSchema,
  CmsFontEstimateEnvelopeSchema,
  CmsGoogleFontsEnvelopeSchema,
  type GoogleFontFamilyDto,
} from './responseSchemas'

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

export async function listCmsGoogleFonts(
  fetchImpl: FetchLike = defaultFetch,
  basePath = '/admin/api/cms',
): Promise<GoogleFontFamilyDto[]> {
  const payload = await apiRequest(`${basePath}/fonts/google`, {
    schema: CmsGoogleFontsEnvelopeSchema,
    fetchImpl,
    fallbackMessage: 'Google fonts list failed',
  })
  return payload.families
}

interface InstallGoogleFontRequest {
  family: string
  variants: string[]
  subsets: string[]
}

/**
 * Ask the server for the on-disk size that a (family × variants × subsets)
 * selection would download. The server fetches the Google CSS2 stylesheet and
 * HEADs each woff2 URL, so this is one round-trip per call from the client's
 * point of view. Caller is responsible for debouncing rapid selection changes.
 */
export async function estimateCmsGoogleFont(
  request: InstallGoogleFontRequest,
  fetchImpl: FetchLike = defaultFetch,
  basePath = '/admin/api/cms',
  init?: { signal?: AbortSignal },
): Promise<CmsFontEstimateDto> {
  return apiRequest(`${basePath}/fonts/estimate`, {
    method: 'POST',
    body: request,
    schema: CmsFontEstimateEnvelopeSchema,
    signal: init?.signal,
    fetchImpl,
    fallbackMessage: 'Font estimate failed',
  })
}

export async function installCmsGoogleFont(
  request: InstallGoogleFontRequest,
  fetchImpl: FetchLike = defaultFetch,
  basePath = '/admin/api/cms',
): Promise<FontEntry> {
  // The envelope validates the inner shape against the canonical
  // `FontEntrySchema`, so `payload.font` is already a fully-typed FontEntry.
  const payload = await apiRequest(`${basePath}/fonts/install`, {
    method: 'POST',
    body: request,
    schema: CmsFontEntryEnvelopeSchema,
    fetchImpl,
    fallbackMessage: 'Font install failed',
  })
  return payload.font
}

interface RegisterCustomFontRequest {
  family: string
  files: { mediaAssetId: string; variant: string }[]
}

/**
 * Register a custom font from already-uploaded media assets. The binaries are
 * uploaded separately through the media route; this posts the asset ids +
 * chosen variants and returns a fully-shaped `FontEntry` to merge into
 * `site.settings.fonts` via the `addFont` action.
 */
export async function registerCustomFont(
  request: RegisterCustomFontRequest,
  fetchImpl: FetchLike = defaultFetch,
  basePath = '/admin/api/cms',
): Promise<FontEntry> {
  const payload = await apiRequest(`${basePath}/fonts/custom`, {
    method: 'POST',
    body: request,
    schema: CmsFontEntryEnvelopeSchema,
    fetchImpl,
    fallbackMessage: 'Custom font registration failed',
  })
  return payload.font
}

export async function deleteCmsFontFamily(
  family: string,
  fetchImpl: FetchLike = defaultFetch,
  basePath = '/admin/api/cms',
): Promise<void> {
  await apiRequest(`${basePath}/fonts/family/${encodeURIComponent(family)}`, {
    method: 'DELETE',
    fetchImpl,
    fallbackMessage: 'Font delete failed',
  })
}
