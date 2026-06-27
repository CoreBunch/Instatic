/**
 * SeoPreviewRail — the Meta tab's sticky left rail: every platform preview
 * stacked and live. Google snippet, Open Graph card, and X card update on
 * each keystroke from the SAME resolved metadata the publisher emits; the
 * JSON-LD schema block sits at the bottom behind a toggle (it's inspection,
 * not glanceable).
 */
import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import type { ResolvedSeoMetadata } from '@core/seo'
import type { SeoTarget } from '../lib/seoApi'
import type { SeoWorkspace } from '../hooks/useSeoWorkspace'
import { SearchSnippetPreview } from './SearchSnippetPreview'
import { OpenGraphPreview } from './OpenGraphPreview'
import { XCardPreview } from './XCardPreview'
import { SchemaPreview } from './SchemaPreview'
import styles from './SeoPreviewRail.module.css'

interface SeoPreviewRailProps {
  resolved: ResolvedSeoMetadata
  workspace: SeoWorkspace
  routePath: string
  /**
   * Target backing the schema block. The site-defaults editor passes the
   * homepage here so the rail previews "a typical page with these defaults".
   */
  schemaTarget: SeoTarget | null
}

export function SeoPreviewRail({ resolved, workspace, routePath, schemaTarget }: SeoPreviewRailProps) {
  const [schemaOpen, setSchemaOpen] = useState(false)

  return (
    <aside className={styles.rail} aria-label="Live previews">
      <section className={styles.block}>
        <h3 className={styles.blockLabel}>Google</h3>
        <SearchSnippetPreview
          resolved={resolved}
          siteName={workspace.siteName}
          origin={workspace.publicOrigin}
          routePath={routePath}
          faviconUrl={workspace.faviconUrl}
        />
      </section>

      <section className={styles.block}>
        <h3 className={styles.blockLabel}>Open Graph</h3>
        <OpenGraphPreview resolved={resolved} origin={workspace.publicOrigin} />
      </section>

      <section className={styles.block}>
        <h3 className={styles.blockLabel}>X</h3>
        <XCardPreview resolved={resolved} origin={workspace.publicOrigin} />
      </section>

      {schemaTarget && (
        <section className={styles.block}>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={styles.schemaToggle}
            aria-expanded={schemaOpen}
            onClick={() => setSchemaOpen((open) => !open)}
            data-testid="seo-schema-toggle"
          >
            {schemaOpen
              ? <ChevronDownIcon size={11} aria-hidden="true" />
              : <ChevronRightIcon size={11} aria-hidden="true" />}
            <span>Structured data (JSON-LD)</span>
          </Button>
          {schemaOpen && (
            <SchemaPreview target={schemaTarget} resolved={resolved} workspace={workspace} />
          )}
        </section>
      )}
    </aside>
  )
}
