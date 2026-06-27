/**
 * OpenGraphPreview — 1:1 mock of a Facebook dark-theme link card: the
 * 1.91:1 image, then the grey meta strip with the uppercase domain, bold
 * title, and one-line description. Colours live in the `--seo-og-*`
 * palette (globals.css).
 */
import type { ResolvedSeoMetadata } from '@core/seo'
import styles from './OpenGraphPreview.module.css'
import { previewDomain } from './previewDomain'

interface OpenGraphPreviewProps {
  resolved: ResolvedSeoMetadata
  origin: string | null
}

export function OpenGraphPreview({ resolved, origin }: OpenGraphPreviewProps) {
  return (
    <figure className={styles.card} aria-label="Open Graph link preview">
      {resolved.ogImage ? (
        <img className={styles.image} src={resolved.ogImage} alt={resolved.ogImageAlt ?? ''} />
      ) : (
        <div className={styles.imagePlaceholder} aria-hidden="true">
          <span>No social image</span>
        </div>
      )}
      <div className={styles.strip}>
        <span className={styles.domain}>{previewDomain(origin, resolved.canonicalUrl)}</span>
        <span className={styles.title}>{resolved.ogTitle}</span>
        {resolved.ogDescription && <span className={styles.description}>{resolved.ogDescription}</span>}
      </div>
    </figure>
  )
}
