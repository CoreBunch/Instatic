/**
 * `PluginRemoveDialog` — confirmation prompt for plugin uninstall.
 *
 * Built on the shared `<Dialog>` primitive. Doesn't go through the
 * `useConfirmDelete` hook because that hook is gated on the
 * `confirmBeforeDelete` editor preference (default off, for power-user
 * layer-delete flow). Plugin uninstall is a different class of destructive
 * action — drops DB rows, kills routes / hooks / canvas modules, removes
 * plugin records and on-disk assets — so it always confirms.
 *
 * `force` switches to the force-remove variant offered after a normal
 * uninstall failed on a lifecycle-hook error: the server skips the plugin's
 * own cleanup hooks, so the copy warns that external resources the plugin
 * set up may be left behind.
 */
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import type { InstalledPlugin } from '@core/plugin-sdk'
import styles from './PluginRemoveDialog.module.css'

interface PluginRemoveDialogProps {
  plugin: InstalledPlugin
  force: boolean
  busy: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
}

export function PluginRemoveDialog({
  plugin,
  force,
  busy,
  onClose,
  onConfirm,
}: PluginRemoveDialogProps) {
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      tone="danger"
      eyebrow={force ? 'Force remove plugin' : 'Remove plugin'}
      title={plugin.name}
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            type="button"
            onClick={() => void onConfirm()}
            disabled={busy}
          >
            {busy ? 'Removing…' : force ? 'Remove anyway' : 'Remove plugin'}
          </Button>
        </>
      }
    >
      {force ? (
        <>
          <p className={styles.lead}>
            The plugin&rsquo;s own cleanup code will be skipped. Force-removing will:
          </p>
          <ul className={styles.checklist}>
            <li>Skip its <code>deactivate</code> and <code>uninstall</code> lifecycle hooks.</li>
            <li>Drop its routes, hooks, settings, schedules, and canvas modules from the runtime.</li>
            <li>Delete every record stored under the plugin&rsquo;s declared resources.</li>
            <li>Remove all of the plugin&rsquo;s files under <code>uploads/plugins/{plugin.id}/</code>.</li>
          </ul>
          <p className={styles.warning}>
            External resources the plugin set up — webhooks, third-party
            registrations, scheduled callbacks — may be left behind, because
            the plugin&rsquo;s cleanup code does not run.
          </p>
        </>
      ) : (
        <>
          <p className={styles.lead}>Removing this plugin will:</p>
          <ul className={styles.checklist}>
            <li>Run its <code>deactivate</code> and <code>uninstall</code> lifecycle hooks.</li>
            <li>Drop its routes, hooks, settings, and canvas modules from the runtime.</li>
            <li>Delete every record stored under the plugin&rsquo;s declared resources.</li>
            <li>Remove the plugin&rsquo;s files from <code>{plugin.manifest.assetBasePath ?? 'uploads/plugins/…'}</code>.</li>
          </ul>
          <p className={styles.note}>
            Pack-imported Visual Components, pages, and CSS classes stay on your site.
          </p>
        </>
      )}
    </Dialog>
  )
}
