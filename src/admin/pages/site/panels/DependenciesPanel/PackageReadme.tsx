/**
 * Package README block: sanitised HTML (`readmeHtml.ts`, rendered once by the
 * package page so tab switches do not re-parse), visually clamped with a
 * "Read full README" expander.
 */
import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import styles from './PackageReadme.module.css'

export function PackageReadme({ html }: { html: string }) {
  const [expanded, setExpanded] = useState(false)
  if (!html.trim()) return <p className={styles.empty}>This package has no README.</p>
  return (
    <div className={styles.wrap} data-testid="package-readme">
      <div className={cn(styles.readme, !expanded && styles.clamped)} dangerouslySetInnerHTML={{ __html: html }} />
      {!expanded && (
        <Button variant="secondary" size="xs" onClick={() => setExpanded(true)}>
          Read full README
        </Button>
      )}
    </div>
  )
}
