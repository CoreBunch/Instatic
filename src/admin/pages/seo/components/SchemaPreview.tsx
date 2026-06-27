/**
 * SchemaPreview — read-only, syntax-highlighted JSON-LD exactly as the
 * publisher will emit it for the selected target (same `buildJsonLdEntities`
 * call). Rendered through the shared CodeMirror viewer so the AEO output is
 * inspectable with real JSON highlighting.
 */
import { buildJsonLdEntities, type ResolvedSeoMetadata } from '@core/seo'
import type { SeoTarget } from '../lib/seoApi'
import type { SeoWorkspace } from '../hooks/useSeoWorkspace'
import { SeoCodeViewer } from './SeoCodeViewer'
import styles from './SchemaPreview.module.css'

export function SchemaPreview({
  target,
  resolved,
  workspace,
}: {
  target: SeoTarget
  resolved: ResolvedSeoMetadata
  workspace: SeoWorkspace
}) {
  const entities = buildJsonLdEntities(resolved, {
    kind: target.kind === 'post' ? 'row' : 'page',
    routePath: target.route ?? '/',
    origin: workspace.publicOrigin ?? undefined,
    siteName: workspace.siteName,
    organization: workspace.siteSeo?.organization,
  })

  if (entities.length === 0) {
    return (
      <p className={styles.empty} role="status">
        {resolved.noindex
          ? 'Noindex targets emit no structured data.'
          : workspace.publicOrigin
            ? 'No structured data applies to this target.'
            : 'Structured data with absolute URLs is emitted once PUBLIC_ORIGINS is configured.'}
      </p>
    )
  }

  return (
    <div className={styles.schema} aria-label="JSON-LD structured data preview">
      <SeoCodeViewer
        docKey={`schema:${target.id}`}
        value={entities.map((entity) => JSON.stringify(entity, null, 2)).join('\n\n')}
        language="json"
      />
    </div>
  )
}
