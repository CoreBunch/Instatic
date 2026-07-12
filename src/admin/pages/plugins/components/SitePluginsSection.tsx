/**
 * SitePluginsSection — the "Site plugins" group on the Plugins page.
 *
 * Lists plugins authored in this site's draft (union of draft folders and
 * site-local runtime rows — a deleted folder never hides a still-running
 * backend). Each card shows the runtime state chip and opens the full
 * Plugin IDE; `New site plugin` scaffolds from a template.
 */
import { useCallback, useEffect, useState } from 'react'
import { apiRequest } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  SitePluginsPayloadSchema,
  sitePluginStateLabel,
  type SitePluginSummary,
} from '@core/site-plugins'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { useNavigate } from '@admin/lib/routing'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { NewSitePluginDialog } from './NewSitePluginDialog'
import styles from './SitePluginsSection.module.css'

interface SitePluginsSectionProps {
  canCreate: boolean
}

export function SitePluginsSection({ canCreate }: SitePluginsSectionProps) {
  const navigate = useNavigate()
  const [sitePlugins, setSitePlugins] = useState<SitePluginSummary[] | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // useCallback kept: stable identity for the load-on-mount effect's dep array.
  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiRequest('/admin/api/cms/site-plugins', {
        schema: SitePluginsPayloadSchema,
      })
      setSitePlugins(payload.sitePlugins)
    } catch (err) {
      console.error('[SitePluginsSection] load failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not load site plugins',
        body: getErrorMessage(err, 'Unknown error'),
      })
      setSitePlugins([])
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      void load()
    }, 0)
    return () => clearTimeout(timer)
  }, [load])

  return (
    <section className={styles.section} aria-labelledby="site-plugins-title">
      <header className={styles.header}>
        <div>
          <h2 id="site-plugins-title" className={styles.title}>
            Site plugins
          </h2>
          <p className={styles.subtitle}>
            Built from this site’s draft in the Plugin IDE — same sandbox,
            permissions, and lifecycle as installed plugins.
          </p>
        </div>
        <Button
          variant="secondary"
          size="md"
          disabled={!canCreate}
          tooltip={canCreate ? undefined : 'Requires the “Author site plugins” permission'}
          onClick={() => setDialogOpen(true)}
          data-testid="new-site-plugin"
        >
          <CodeIcon size={15} aria-hidden="true" />
          <span>New site plugin</span>
        </Button>
      </header>

      {sitePlugins === null ? (
        <p className={styles.empty}>Loading site plugins…</p>
      ) : sitePlugins.length === 0 ? (
        <p className={styles.empty}>
          No site plugins yet. Create one to add backend routes, canvas
          modules, or editor commands from this site’s own code.
        </p>
      ) : (
        <ul className={styles.list} aria-label="Site plugins">
          {sitePlugins.map((plugin) => (
            <li
              key={plugin.localId}
              className={styles.card}
              data-testid={`site-plugin-card-${plugin.localId}`}
            >
              <div className={styles.cardBody}>
                <span className={styles.cardName}>{plugin.name}</span>
                <span className={styles.cardId}>{plugin.pluginId}</span>
                <span className={styles.cardMeta}>
                  <span className={styles.stateChip} data-state={plugin.state}>
                    {sitePluginStateLabel(plugin.state)}
                  </span>
                  <span className={styles.cardVersion}>
                    {plugin.activeVersion ?? 'not built yet'}
                  </span>
                </span>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate(`/admin/plugins/develop/${plugin.localId}`)}
                data-testid={`open-ide-${plugin.localId}`}
              >
                Open IDE
              </Button>
            </li>
          ))}
        </ul>
      )}

      {dialogOpen && (
        <NewSitePluginDialog
          existingLocalIds={(sitePlugins ?? []).map((plugin) => plugin.localId)}
          onClose={() => setDialogOpen(false)}
          onCreated={(localId) => {
            setDialogOpen(false)
            navigate(`/admin/plugins/develop/${localId}`)
          }}
        />
      )}
    </section>
  )
}
