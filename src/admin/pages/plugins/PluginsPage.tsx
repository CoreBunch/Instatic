import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useNavigate } from '@admin/lib/routing'
import { PluginCard } from './components/PluginCard/PluginCard'
import { DraftSitePluginCard } from './components/DraftSitePluginCard'
import { NewSitePluginDialog } from './components/NewSitePluginDialog'
import { PluginRemoveDialog } from './components/PluginRemoveDialog/PluginRemoveDialog'
import { PermissionReviewSection } from './components/PermissionReviewSection'
import { PluginSettingsDialog } from './components/PluginSettingsDialog/PluginSettingsDialog'
import { PluginSchedulesDialog } from './components/PluginSchedulesDialog/PluginSchedulesDialog'
import { isSandboxRelatedError, usePluginsWorkspace } from './hooks/usePluginsWorkspace'
import { useSitePlugins } from './hooks/useSitePlugins'
import { localIdFromSitePluginId } from '@core/site-plugins'
import { notifyCmsPluginsChanged } from './utils/pluginEvents'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import {
  canConfigurePlugins,
  canEditPlugins,
  canInstallPlugins,
  canManagePluginLifecycle,
} from '@admin/access'
import styles from './PluginsPage.module.css'

// Number of skeleton plugin cards rendered while the installed-plugin
// list is loading. Three matches a typical fresh-install showing
// (e.g. host plugins + Analytics). PluginCard's `loading` prop owns
// the actual skeleton markup — page-level code only decides count.
const SKELETON_CARD_COUNT = 3

export function PluginsPage() {
  const currentUser = useAuthenticatedAdminUser()
  const navigate = useNavigate()
  const canConfigure = canConfigurePlugins(currentUser)
  const canInstall = canInstallPlugins(currentUser)
  const canManageLifecycle = canManagePluginLifecycle(currentUser)
  const canCreateSitePlugins = canEditPlugins(currentUser)
  const vm = usePluginsWorkspace()
  const {
    fileInputRef,
    payload,
    loading,
    uploading,
    busyPluginId,
    error,
    editorActivationErrors,
    pendingInstall,
    settingsPluginId,
    schedulesPluginId,
    pendingRemove,
    removeFailure,
  } = vm

  const { sitePlugins } = useSitePlugins()
  const [newPluginOpen, setNewPluginOpen] = useState(false)
  const openIde = (localId: string) => navigate(`/admin/plugins/develop/${localId}`)

  // ONE list: installed plugins (any provenance) plus site plugins that only
  // exist as draft source — an activated site plugin is already an installed
  // row, so drafts are the only entries the installed payload can't show.
  const installedIds = new Set(payload.plugins.map((plugin) => plugin.id))
  const draftOnlySitePlugins = (sitePlugins ?? []).filter(
    (plugin) => !installedIds.has(plugin.pluginId),
  )
  const listEmpty = !loading && payload.plugins.length === 0 && draftOnlySitePlugins.length === 0

  return (
    <AdminPageLayout
      workspace="plugins"
      title="Plugins"
      titleId="plugins-title"
      description="Install admin extensions and control what they add to the CMS."
      actions={canInstall || canCreateSitePlugins ? (
        <>
          {canCreateSitePlugins && (
            <Button
              variant="secondary"
              size="md"
              onClick={() => setNewPluginOpen(true)}
              data-testid="new-site-plugin"
            >
              <CodeIcon size={15} aria-hidden="true" />
              <span>New site plugin</span>
            </Button>
          )}
          {canInstall && (
            <>
              <Button
                variant="primary"
                size="md"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadIcon size={15} aria-hidden="true" />
                <span>{uploading ? 'Uploading' : 'Upload Plugin'}</span>
              </Button>
              <input
                ref={fileInputRef}
                className={styles.fileInput}
                aria-label="Plugin file"
                type="file"
                accept="application/json,.json,.plugin.json,.pbplugin,.zip,application/zip"
                onChange={(event) => void vm.handleUpload(event)}
              />
            </>
          )}
        </>
      ) : null}
    >
      <div className={styles.pluginsBody} data-testid="plugins-admin-canvas">
        {error && (
          <div role="alert">
            <p className={styles.error}>{error}</p>
            {isSandboxRelatedError(error) && (
              <p className={styles.errorHint}>
                This looks like a plugin sandbox issue. See the{' '}
                <a
                  href="https://github.com/corebunch/instatic/blob/main/docs/features/plugin-system.md"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  sandbox documentation
                </a>
                {' '}for what's allowed inside plugin code.
              </p>
            )}
          </div>
        )}

        {removeFailure && (
          <div role="alert" className={styles.removeFailure}>
            <p className={styles.error}>{removeFailure.message}</p>
            <p className={styles.errorHint}>
              Removing anyway skips the plugin&rsquo;s cleanup code — external
              resources it created (webhooks, third-party registrations) may
              remain.
            </p>
            <div className={styles.removeFailureActions}>
              <Button
                variant="destructive"
                size="sm"
                disabled={busyPluginId === removeFailure.plugin.id}
                onClick={() =>
                  vm.setPendingRemove({ plugin: removeFailure.plugin, force: true })
                }
              >
                Remove anyway
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => vm.setRemoveFailure(null)}
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {pendingInstall && canInstall && (
          <PermissionReviewSection
            pending={pendingInstall}
            uploading={uploading}
            onCancel={() => vm.setPendingInstall(null)}
            onConfirm={() => void vm.installPendingPlugin(pendingInstall)}
          />
        )}

        <div
          className={styles.pluginsList}
          aria-label="Plugins"
          aria-busy={loading || undefined}
        >
          {loading ? (
            // Render N skeleton cards while the plugins payload is in
            // flight. PluginCard renders its own universal skeleton
            // body when `loading` is set — no per-page skeleton markup,
            // no mock data.
            Array.from({ length: SKELETON_CARD_COUNT }, (_, i) => (
              <PluginCard key={i} loading />
            ))
          ) : listEmpty ? (
            <p className={styles.emptyState}>
              No plugins yet — upload one, or create a site plugin in the IDE.
            </p>
          ) : (
            <>
              {payload.plugins.map((plugin) => (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  busy={busyPluginId === plugin.id}
                  editorActivationError={editorActivationErrors[plugin.id]}
                  canConfigure={canConfigure}
                  canInstall={canInstall}
                  canManageLifecycle={canManageLifecycle}
                  onOpenSettings={(p) => vm.setSettingsPluginId(p.id)}
                  onOpenSchedules={(p) => vm.setSchedulesPluginId(p.id)}
                  onInstallPack={(p) => void vm.installPluginPack(p)}
                  onRestart={(p) => void vm.restartPlugin(p)}
                  onReinstall={() => fileInputRef.current?.click()}
                  onToggle={(p) => void vm.togglePlugin(p)}
                  onRemove={(p) => vm.setPendingRemove({ plugin: p, force: false })}
                  onOpenIde={(p) => {
                    const localId = localIdFromSitePluginId(p.id)
                    if (localId) openIde(localId)
                  }}
                />
              ))}
              {draftOnlySitePlugins.map((plugin) => (
                <DraftSitePluginCard
                  key={plugin.pluginId}
                  plugin={plugin}
                  onOpenIde={openIde}
                />
              ))}
            </>
          )}
        </div>

        {newPluginOpen && (
          <NewSitePluginDialog
            existingLocalIds={(sitePlugins ?? []).map((plugin) => plugin.localId)}
            onClose={() => setNewPluginOpen(false)}
            onCreated={(localId) => {
              setNewPluginOpen(false)
              openIde(localId)
            }}
          />
        )}

        {settingsPluginId && (
          <PluginSettingsDialog
            pluginId={settingsPluginId}
            pluginName={
              payload.plugins.find((p) => p.id === settingsPluginId)?.name ??
              settingsPluginId
            }
            onClose={() => vm.setSettingsPluginId(null)}
            onSaved={() => {
              notifyCmsPluginsChanged()
              void vm.loadPlugins()
            }}
          />
        )}

        {schedulesPluginId && (
          <PluginSchedulesDialog
            pluginId={schedulesPluginId}
            pluginName={
              payload.plugins.find((p) => p.id === schedulesPluginId)?.name ??
              schedulesPluginId
            }
            canManageLifecycle={canManageLifecycle}
            onClose={() => vm.setSchedulesPluginId(null)}
          />
        )}

        {pendingRemove && (
          <PluginRemoveDialog
            plugin={pendingRemove.plugin}
            force={pendingRemove.force}
            busy={busyPluginId === pendingRemove.plugin.id}
            onClose={() => vm.setPendingRemove(null)}
            onConfirm={async () => {
              const target = pendingRemove
              vm.setPendingRemove(null)
              await vm.executeRemovePlugin(target.plugin, target.force)
            }}
          />
        )}
      </div>
    </AdminPageLayout>
  )
}
