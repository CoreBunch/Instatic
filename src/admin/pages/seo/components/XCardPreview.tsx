/**
 * XCardPreview — 1:1 mock of an X (Twitter) dark-theme card.
 *
 * `summary_large_image`: 16px-radius hairline-bordered image with the title
 * chip overlaid bottom-left, then the grey "From domain" line below — X's
 * current rendering. `summary`: square thumb on the left, domain/title/
 * description stack on the right. Colours live in the `--seo-x-*` palette.
 */
import { cn } from '@ui/cn'
import type { ResolvedSeoMetadata } from '@core/seo'
import styles from './XCardPreview.module.css'
import { previewDomain } from './previewDomain'

interface XCardPreviewProps {
  resolved: ResolvedSeoMetadata
  origin: string | null
}

export function XCardPreview({ resolved, origin }: XCardPreviewProps) {
  const domain = previewDomain(origin, resolved.canonicalUrl)
  const large = resolved.xCard === 'summary_large_image'

  if (large) {
    return (
      <figure className={styles.wrap} aria-label="X card preview">
        <div className={styles.largeCard}>
          {resolved.xImage ? (
            <img className={styles.largeImage} src={resolved.xImage} alt={resolved.xImageAlt ?? ''} />
          ) : (
            <div className={styles.largePlaceholder} aria-hidden="true">No image</div>
          )}
          <span className={styles.overlayTitle}>{resolved.xTitle}</span>
        </div>
        <span className={styles.fromLine}>From {domain}</span>
      </figure>
    )
  }

  return (
    <figure className={styles.wrap} aria-label="X card preview">
      <div className={cn(styles.summaryCard)}>
        {resolved.xImage ? (
          <img className={styles.summaryImage} src={resolved.xImage} alt={resolved.xImageAlt ?? ''} />
        ) : (
          <div className={styles.summaryPlaceholder} aria-hidden="true" />
        )}
        <div className={styles.summaryMeta}>
          <span className={styles.summaryDomain}>{domain}</span>
          <span className={styles.summaryTitle}>{resolved.xTitle}</span>
          {resolved.xDescription && (
            <span className={styles.summaryDescription}>{resolved.xDescription}</span>
          )}
        </div>
      </div>
    </figure>
  )
}
