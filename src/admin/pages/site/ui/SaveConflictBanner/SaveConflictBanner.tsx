/**
 * SaveConflictBanner — the resolution UI for 409'd saves (multi-admin
 * conflict safety, level A).
 *
 * Renders when the store holds pending `saveConflicts` (set by the save
 * pipeline when the server rejects an incremental save because another admin
 * stored newer versions of shipped rows). One row per conflicted target with
 * the two resolutions:
 *
 *   Load theirs — fetch the remote state (single-row `?id=` fetch, or the
 *                 shell GET) and adopt it via `applyRemoteSnapshot`,
 *                 discarding the local unsaved edits to that target only.
 *   Keep mine   — `resolveSaveConflictKeepMine` bumps the base seq; the next
 *                 save overwrites the remote version as a stated decision.
 *                 The button label carries the "(overwrite)" warning — that
 *                 IS the explicit confirmation.
 *
 * This is deliberately a persistent banner, not a toast: a conflict is not a
 * transient failure but a decision the user must make per target, and the
 * unsaved local edits stay parked until they do (autosave is suppressed
 * while conflicts pend). Once the last conflict is resolved, the pending
 * edits are flushed through the editor save queue (`flushEditorSave`).
 */

import { useState } from 'react'
import type { SiteDocument } from '@core/page-tree'
import type { SaveConflict } from '@core/persistence/saveConflict'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { useEditorStore } from '@site/store/store'
import { fetchRemoteSnapshot } from '@site/hooks/remoteSnapshot'
import { flushEditorSave } from '@site/hooks/editorSaveRef'
import styles from './SaveConflictBanner.module.css'

const KIND_LABEL: Record<SaveConflict['table'], string> = {
  site: 'Site settings',
  pages: 'Page',
  components: 'Component',
  layouts: 'Layout',
}

/** Human label for a conflicted target, resolved from the local document. */
function conflictLabel(site: SiteDocument | null, conflict: SaveConflict): string {
  if (conflict.table === 'site') return 'Site settings & styles'
  if (!site) return conflict.rowId
  if (conflict.table === 'pages') {
    return site.pages.find((p) => p.id === conflict.rowId)?.title ?? conflict.rowId
  }
  if (conflict.table === 'components') {
    return site.visualComponents.find((vc) => vc.id === conflict.rowId)?.name ?? conflict.rowId
  }
  return site.layouts.find((layout) => layout.id === conflict.rowId)?.name ?? conflict.rowId
}

/** Ship the surviving local edits once the last conflict is decided. */
async function flushIfResolved(): Promise<void> {
  const { saveConflicts, hasUnsavedChanges } = useEditorStore.getState()
  if (saveConflicts.length > 0 || !hasUnsavedChanges) return
  await flushEditorSave()
}

export function SaveConflictBanner() {
  const conflicts = useEditorStore((s) => s.saveConflicts)
  // Subscribed (not getState) so labels track renames/removals live.
  const site = useEditorStore((s) => s.site)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  if (conflicts.length === 0) return null

  async function loadTheirs(conflict: SaveConflict) {
    setBusyKey(`${conflict.table}:${conflict.rowId}`)
    try {
      const snapshot = await fetchRemoteSnapshot(conflict)
      useEditorStore.getState().applyRemoteSnapshot(snapshot)
      await flushIfResolved()
    } catch (err) {
      console.error('[SaveConflictBanner] failed to load the remote version:', err)
      pushToast({
        kind: 'error',
        title: 'Could not load their version',
        body: getErrorMessage(err, 'Unknown conflict-resolution error'),
      })
    } finally {
      setBusyKey(null)
    }
  }

  async function keepMine(conflict: SaveConflict) {
    useEditorStore.getState().resolveSaveConflictKeepMine(conflict)
    try {
      await flushIfResolved()
    } catch (err) {
      // The save pipeline already surfaces failures via saveStatus / a
      // fresh conflict banner; log for the console trail only.
      console.error('[SaveConflictBanner] post-resolution save failed:', err)
    }
  }

  return (
    <div className={styles.banner} role="alert">
      <div className={styles.title}>Another admin saved newer changes</div>
      <div className={styles.subtitle}>
        Your edits are safe but unsaved. Decide per item: load their version
        (discards your unsaved edits to it) or keep yours (overwrites theirs on
        the next save).
      </div>
      <ul className={styles.conflictList}>
        {conflicts.map((conflict) => {
          const key = `${conflict.table}:${conflict.rowId}`
          return (
            <li key={key} className={styles.conflictRow}>
              <span className={styles.conflictLabel}>
                <span className={styles.conflictKind}>{KIND_LABEL[conflict.table]} · </span>
                {conflictLabel(site, conflict)}
              </span>
              <Button
                variant="secondary"
                size="xs"
                disabled={busyKey !== null}
                onClick={() => void loadTheirs(conflict)}
              >
                Load theirs
              </Button>
              <Button
                variant="destructive"
                size="xs"
                disabled={busyKey !== null}
                onClick={() => void keepMine(conflict)}
              >
                Keep mine (overwrite)
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
