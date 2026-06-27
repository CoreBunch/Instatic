/**
 * SitemapTab — sitemap.xml inclusion, in the same shape as the Robots tab:
 * an assistant rail (left) explaining the file + the master enable toggle +
 * counts, and the actual content (the list of routable targets with
 * include/exclude switches) as the main column. Noindex targets are excluded
 * automatically and shown disabled with the reason inline.
 */
import { useState } from 'react'
import { Switch } from '@ui/components/Switch'
import { getErrorMessage } from '@core/utils/errorMessage'
import { publishCmsDraft } from '@core/persistence'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import type { SeoSitemapSettings } from '@core/seo'
import type { SeoWorkspace } from '../hooks/useSeoWorkspace'
import type { SeoSaveBridge } from '../hooks/useSeoSaveBridge'
import { useSeoSaveSurface } from '../hooks/useSeoSaveBridge'
import styles from './SettingsTabs.module.css'

interface SitemapTabProps {
  workspace: SeoWorkspace
  canManage: boolean
  bridge: SeoSaveBridge
}

type SaveState = 'idle' | 'saving' | 'saved' | 'publishing' | 'published' | 'error'

export function SitemapTab({ workspace, canManage, bridge }: SitemapTabProps) {
  const stored = workspace.siteSeo?.sitemap ?? {}
  const [draft, setDraft] = useState<SeoSitemapSettings>(stored)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const currentUser = useCurrentAdminUser()
  const { runStepUp } = useStepUp()
  const canPublish = !currentUser || hasCapability(currentUser, 'pages.publish')

  const isDirty = JSON.stringify(draft) !== JSON.stringify(stored)
  const enabled = draft.enabled !== false
  const excluded = new Set(draft.excludedTargets ?? [])

  // Routable targets only — templates have no public URL.
  const routable = workspace.targets.filter((target) => target.route !== null)
  const included = routable.filter((target) => {
    if (target.seo?.noindex === true) return false
    const key = `${target.kind === 'post' ? 'row' : 'page'}:${target.id}`
    return !excluded.has(key)
  })

  function touch(): void {
    if (saveState !== 'idle') setSaveState('idle')
  }

  function setEnabled(value: boolean): void {
    setDraft((current) => {
      const next = { ...current }
      if (value) delete next.enabled
      else next.enabled = false
      return next
    })
    touch()
  }

  function toggleTarget(kind: 'page' | 'row', id: string, include: boolean): void {
    const key = `${kind}:${id}`
    setDraft((current) => {
      const set = new Set(current.excludedTargets ?? [])
      if (include) set.delete(key)
      else set.add(key)
      const next = { ...current }
      if (set.size === 0) delete next.excludedTargets
      else next.excludedTargets = [...set].sort()
      return next
    })
    touch()
  }

  async function handleSave(): Promise<boolean> {
    setSaveState('saving')
    setSaveError(null)
    try {
      await workspace.saveSite({ ...(workspace.siteSeo ?? {}), sitemap: draft })
      setSaveState('saved')
      return true
    } catch (err) {
      console.error('[seo-page] sitemap save failed:', err)
      setSaveState('error')
      setSaveError(getErrorMessage(err, 'Could not save sitemap settings'))
      return false
    }
  }

  async function handlePublish(): Promise<void> {
    if (isDirty && !(await handleSave())) return
    setSaveState('publishing')
    try {
      // Full site publish — step-up gated, same as the Site toolbar.
      await runStepUp(() => publishCmsDraft())
      setSaveState('published')
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) {
        setSaveState('saved')
        return
      }
      console.error('[seo-page] publish failed:', err)
      setSaveState('error')
      setSaveError(getErrorMessage(err, 'Could not publish'))
    }
  }

  useSeoSaveSurface(
    bridge,
    {
      dirty: isDirty,
      state: saveState,
      canSave: canManage,
      canPublish,
      publishScope: 'site',
      liveUrl: workspace.publicOrigin ? `${workspace.publicOrigin}/sitemap.xml` : null,
    },
    { save: () => void handleSave(), publish: () => void handlePublish() },
  )

  return (
    <section className={styles.tab} aria-label="Sitemap settings">
      <div className={styles.editorWorkbench}>
        <aside className={styles.assistColumn} aria-label="Sitemap help">
          <div className={styles.card}>
            <header className={styles.cardHeader}>
              <h2 className={styles.heading}>Sitemap</h2>
              <p className={styles.subheading}>
                Generated from published content, served at <code>/sitemap.xml</code>, live on
                publish. Each URL carries its last-modified date.
              </p>
            </header>

            <div className={styles.assistGroup}>
              <div className={styles.toggleRow}>
                <label htmlFor="seo-sitemap-enabled-switch" className={styles.toggleLabel}>
                  Generate sitemap.xml
                </label>
                <Switch
                  id="seo-sitemap-enabled-switch"
                  checked={enabled}
                  disabled={!canManage}
                  onCheckedChange={setEnabled}
                  aria-label="Generate sitemap.xml"
                  data-testid="seo-sitemap-enabled"
                />
              </div>
              <p className={styles.toggleHint}>
                Search and answer engines use it to discover published pages and posts.
              </p>
              <p className={styles.counts} role="status" data-testid="seo-sitemap-counts">
                {enabled
                  ? `${included.length} of ${routable.length} routable targets included.`
                  : 'Sitemap generation is off — /sitemap.xml returns 404.'}
              </p>
            </div>

            {saveError && <p className={styles.error} role="alert">{saveError}</p>}
          </div>
        </aside>

        <div className={styles.editorMain}>
          {enabled ? (
            <div className={styles.targetList} aria-label="Sitemap inclusion">
              {routable.map((target) => {
                const kindKey = target.kind === 'post' ? ('row' as const) : ('page' as const)
                const noindexed = target.seo?.noindex === true
                const isIncluded = !noindexed && !excluded.has(`${kindKey}:${target.id}`)
                return (
                  <div key={target.id} className={styles.targetRow}>
                    <span className={styles.targetText}>
                      <span className={styles.targetTitle}>{target.title}</span>
                      <span className={styles.targetRoute}>{target.route}</span>
                    </span>
                    {noindexed && <span className={styles.targetNote}>noindex</span>}
                    <Switch
                      checked={isIncluded}
                      disabled={!canManage || noindexed}
                      onCheckedChange={(value) => toggleTarget(kindKey, target.id, value)}
                      aria-label={`Include ${target.title} in the sitemap`}
                      switchSize="sm"
                    />
                  </div>
                )
              })}
            </div>
          ) : (
            <p className={styles.disabledState} role="status">
              Sitemap generation is off. Turn it on to choose which pages and posts are listed.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
