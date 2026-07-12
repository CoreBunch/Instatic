/**
 * DraftSitePluginCard — a site plugin that exists ONLY as draft source (no
 * runtime row yet: never activated, or its first build failed). Rendered in
 * the SAME list as installed plugins, reusing PluginCard's chrome so the
 * page reads as one consistent surface; the only action a draft can offer
 * is opening the IDE. Once activated, the plugin becomes an ordinary
 * installed row and this card disappears.
 */
import { Button } from '@ui/components/Button'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import {
  sitePluginStateLabel,
  type SitePluginSummary,
} from '@core/site-plugins'
import styles from './PluginCard/PluginCard.module.css'

/** Map site-plugin states onto PluginCard's status-pill palette. */
function pillStatus(state: SitePluginSummary['state']): string {
  switch (state) {
    case 'active':
      return 'active'
    case 'build-failed':
    case 'runtime-error':
    case 'source-missing':
      return 'error'
    default:
      return 'installed'
  }
}

interface DraftSitePluginCardProps {
  plugin: SitePluginSummary
  onOpenIde: (localId: string) => void
}

export function DraftSitePluginCard({ plugin, onOpenIde }: DraftSitePluginCardProps) {
  return (
    <article className={styles.pluginCard} data-testid={`site-plugin-card-${plugin.localId}`}>
      <header className={styles.pluginHeader}>
        <div className={styles.pluginHeaderInfo}>
          <div className={styles.pluginHeaderTitle}>
            <h2>{plugin.name}</h2>
            <span className={styles.pluginVersionPill} aria-label="Draft plugin">
              draft
            </span>
            <span className={styles.pluginStatusPill} data-status={pillStatus(plugin.state)}>
              {sitePluginStateLabel(plugin.state)}
            </span>
          </div>
        </div>
        <div className={styles.pluginActions}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onOpenIde(plugin.localId)}
            aria-label={`Open ${plugin.name} in the Plugin IDE`}
            data-testid={`open-ide-${plugin.localId}`}
          >
            <CodeIcon size={14} aria-hidden="true" />
            <span>Open IDE</span>
          </Button>
        </div>
      </header>
      <div className={styles.pluginBody}>
        <p className={styles.pluginDescription}>
          {plugin.manifestError ?? `${plugin.pluginId} — authored in this site's draft, not activated yet.`}
        </p>
      </div>
    </article>
  )
}
