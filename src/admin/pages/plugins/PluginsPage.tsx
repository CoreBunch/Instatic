import { Button } from '@ui/components/Button'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { PluginCard } from './components/PluginCard/PluginCard'
import { PluginRemoveDialog } from './components/PluginRemoveDialog/PluginRemoveDialog'
import { PermissionReviewSection } from './components/PermissionReviewSection'
import { PluginSettingsDialog } from './components/PluginSettingsDialog/PluginSettingsDialog'
import { PluginSchedulesDialog } from './components/PluginSchedulesDialog/PluginSchedulesDialog'
import { isSandboxRelatedError, usePluginsWorkspace } from './hooks/usePluginsWorkspace'
import { notifyCmsPluginsChanged } from './utils/pluginEvents'
import styles from './PluginsPage.module.css'

// Number of skeleton plugin cards rendered while the installed-plugin
// list is loading. Three matches a typical fresh-install showing
// (e.g. host plugins + Analytics). PluginCard's `loading` prop owns
// the actual skeleton markup — page-level code only decides count.
const SKELETON_CARD_COUNT = 3

export function PluginsPage() {
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

  return (
    <AdminPageLayout
      workspace="plugins"
      title="Plugins"
      titleId="plugins-title"
      description="Install admin extensions and control what they add to the CMS."
      actions={(
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

        {pendingInstall && (
          <PermissionReviewSection
            pending={pendingInstall}
            uploading={uploading}
            onCancel={() => vm.setPendingInstall(null)}
            onConfirm={() => void vm.installPendingPlugin(pendingInstall)}
          />
        )}

        <div
          className={styles.pluginsList}
          aria-label="Installed plugins"
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
          ) : payload.plugins.length === 0 ? (
            <p className={styles.emptyState}>No plugins installed yet.</p>
          ) : (
            payload.plugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                busy={busyPluginId === plugin.id}
                editorActivationError={editorActivationErrors[plugin.id]}
                onOpenSettings={(p) => vm.setSettingsPluginId(p.id)}
                onOpenSchedules={(p) => vm.setSchedulesPluginId(p.id)}
                onInstallPack={(p) => void vm.installPluginPack(p)}
                onRestart={(p) => void vm.restartPlugin(p)}
                onReinstall={() => fileInputRef.current?.click()}
                onToggle={(p) => void vm.togglePlugin(p)}
                onRemove={(p) => vm.setPendingRemove({ plugin: p, force: false })}
              />
            ))
          )}
        </div>

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
