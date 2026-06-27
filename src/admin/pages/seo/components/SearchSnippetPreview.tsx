/**
 * SearchSnippetPreview — 1:1 mock of a Google dark-theme desktop result.
 *
 * Layout mirrors the real SERP: favicon circle + site-name/breadcrumb
 * header row, the blue 20px title, then the grey snippet. Values come from
 * the RESOLVED metadata, so what's shown is exactly what the publisher
 * emits. Colours live in the `--seo-serp-*` palette (globals.css) — the
 * preview must look like Google, not like the editor.
 */
import type { ResolvedSeoMetadata } from '@core/seo'
import styles from './SearchSnippetPreview.module.css'
import { serpBreadcrumb, serpSiteLabel } from './previewDomain'

interface SearchSnippetPreviewProps {
  resolved: ResolvedSeoMetadata
  siteName: string
  origin: string | null
  routePath: string
  /** Site favicon — shown in the icon circle like the real SERP. */
  faviconUrl: string | null
}

export function SearchSnippetPreview({ resolved, siteName, origin, routePath, faviconUrl }: SearchSnippetPreviewProps) {
  const siteLabel = serpSiteLabel(siteName, origin)
  return (
    <figure className={styles.serp} aria-label="Google search result preview">
      <div className={styles.head}>
        <span className={styles.favicon} aria-hidden="true">
          {faviconUrl ? (
            <img className={styles.faviconImage} src={faviconUrl} alt="" />
          ) : (
            siteLabel.slice(0, 1).toUpperCase()
          )}
        </span>
        <span className={styles.headText}>
          <span className={styles.site}>{siteLabel}</span>
          <span className={styles.url}>{serpBreadcrumb(origin, routePath, resolved.canonicalUrl)}</span>
        </span>
      </div>
      <span className={styles.title}>{resolved.title}</span>
      <span className={styles.description}>
        {resolved.description ?? 'Google will generate a snippet from page content — add a description to control it.'}
      </span>
      {resolved.noindex && (
        <span className={styles.noindexBadge} role="status">noindex — hidden from search</span>
      )}
    </figure>
  )
}
