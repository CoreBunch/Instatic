/**
 * Display-domain helpers shared by the platform previews. The previews are
 * 1:1 mocks, so they show the breadcrumb/domain lines exactly the way the
 * platforms render them.
 */

/** `https://acme.com/x` → `acme.com`; falls back to a neutral placeholder. */
export function previewDomain(origin: string | null, canonicalUrl?: string): string {
  const source = canonicalUrl ?? origin ?? ''
  try {
    return new URL(source).hostname
  } catch {
    return 'example.com'
  }
}

/** Google-style breadcrumb: `acme.com › posts › hello-world`. */
export function serpBreadcrumb(origin: string | null, routePath: string, canonicalUrl?: string): string {
  const domain = previewDomain(origin, canonicalUrl)
  const segments = routePath.split('/').filter(Boolean)
  return [domain, ...segments].join(' › ')
}

/** Capitalised site-name line Google shows above the breadcrumb. */
export function serpSiteLabel(siteName: string, origin: string | null): string {
  if (siteName.trim() !== '') return siteName
  return previewDomain(origin)
}
