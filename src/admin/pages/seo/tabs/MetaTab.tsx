/**
 * MetaTab — the SEO workspace's control center.
 *
 * One flat three-column grid:
 *   - Left: the site-wide SEO score (liquid-progress ring) over the target
 *     index — search, kind filters, dense rows with score pills, full
 *     keyboard navigation. Score and index rows derive from the same
 *     per-target reports.
 *   - Middle: the active editor's form — snippet fields with
 *     inherited-value placeholders, ideal-band length meters, a live
 *     per-target score, and an actionable improvements list. The pinned
 *     "Site defaults" row opens the site-level editor instead.
 *   - Right: the editor's sticky platform-preview rail (Google / Open
 *     Graph / X / JSON-LD). The editors render form + rail as fragment
 *     siblings so the grid stays flat.
 *
 * Save/publish lives in the workspace toolbar: the active editor registers
 * itself on the save bridge passed down from SeoPage.
 *
 * The homepage is selected by default so the user lands on a live preview,
 * not an empty defaults form. Switching targets with unsaved changes asks
 * through an in-app dialog (never `confirm()`).
 */
import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import type { SeoTarget } from '../lib/seoApi'
import type { SeoWorkspace } from '../hooks/useSeoWorkspace'
import type { SeoSaveBridge } from '../hooks/useSeoSaveBridge'
import { indexSeoTargets } from '../lib/indexTargets'
import { SeoScoreSummary } from '../components/SeoScoreSummary'
import { SeoTargetIndex } from '../components/SeoTargetIndex'
import { SeoPreviewEditor } from '../components/SeoPreviewEditor'
import { SiteDefaultsEditor } from '../components/SiteDefaultsEditor'
import styles from './MetaTab.module.css'

/** Selection id for the pinned site-defaults pseudo-target. */
const SITE_DEFAULTS_ID = 'site:defaults'

interface MetaTabProps {
  workspace: SeoWorkspace
  canManage: boolean
  bridge: SeoSaveBridge
}

/** Homepage first, then any page, then the site defaults row. */
function defaultSelectionId(targets: SeoTarget[]): string {
  return (
    targets.find((target) => target.kind === 'page' && target.route === '/')?.id ??
    targets.find((target) => target.kind === 'page')?.id ??
    SITE_DEFAULTS_ID
  )
}

export function MetaTab({ workspace, canManage, bridge }: MetaTabProps) {
  const [selection, setSelection] = useState<string | null>(null)
  const [pendingSelection, setPendingSelection] = useState<string | null>(null)

  // One report per target, shared by the score summary and the index so
  // both agree on scores and what counts as an issue.
  const indexed = indexSeoTargets(workspace.targets, workspace.resolveContext)

  const editorDirty = bridge.status?.dirty ?? false
  const selectedId = selection ?? defaultSelectionId(workspace.targets)

  const selectedTarget: SeoTarget | null =
    selectedId === SITE_DEFAULTS_ID
      ? null
      : workspace.targets.find((target) => target.id === selectedId) ?? null

  function handleSelect(nextId: string): void {
    if (nextId === selectedId) return
    if (editorDirty) {
      setPendingSelection(nextId)
      return
    }
    setSelection(nextId)
  }

  function discardAndSwitch(): void {
    if (pendingSelection !== null) {
      setSelection(pendingSelection)
      setPendingSelection(null)
    }
  }

  return (
    <div className={styles.columns}>
      <div className={styles.indexColumn}>
        <SeoScoreSummary indexed={indexed} />
        <SeoTargetIndex
          indexed={indexed}
          selectedId={selectedId}
          siteDefaultsId={SITE_DEFAULTS_ID}
          onSelect={handleSelect}
        />
      </div>

      {/* Fragment children: the form lands in the middle column, the
          preview rail in the right one. */}
      {selectedTarget ? (
        <SeoPreviewEditor
          key={selectedTarget.id}
          target={selectedTarget}
          workspace={workspace}
          canManage={canManage}
          bridge={bridge}
        />
      ) : (
        <SiteDefaultsEditor
          key={SITE_DEFAULTS_ID}
          workspace={workspace}
          canManage={canManage}
          bridge={bridge}
        />
      )}

      <Dialog
        open={pendingSelection !== null}
        onClose={() => setPendingSelection(null)}
        title="Discard unsaved changes?"
        tone="danger"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setPendingSelection(null)}>
              Keep editing
            </Button>
            <Button variant="destructive" size="sm" onClick={discardAndSwitch} data-testid="seo-discard-switch">
              Discard changes
            </Button>
          </>
        }
      >
        <p>The selected target has unsaved SEO changes. Switching now will discard them.</p>
      </Dialog>
    </div>
  )
}
