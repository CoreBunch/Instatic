/**
 * VisualComponentModeControl — floating Visual Component edit-mode control.
 *
 * Renders below the canvas notch while the canvas is editing a Visual
 * Component: a "Back to page" exit plus a `DocumentSwitcher` to jump to any
 * page / template / component. Renaming lives in the Site panel (the switcher
 * replaces the old inline rename), so this control matches the template control
 * visually.
 */

import { type VisualComponent } from '@core/visualComponents'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { ArrowLeftIcon } from 'pixel-art-icons/icons/arrow-left'
import { DocumentSwitcher } from './DocumentSwitcher'
import { ComponentPreviewSource } from './ComponentPreviewSource'
import styles from './VisualComponentModeControl.module.css'

export default function VisualComponentModeControl() {
  const activeDocument = useEditorStore((s) => s.activeDocument)
  const exitVisualComponentMode = useEditorStore((s) => s.exitVisualComponentMode)

  const vcId = activeDocument?.kind === 'visualComponent' ? activeDocument.vcId : null
  const vc = useEditorStore(
    (s): VisualComponent | null =>
      s.site?.visualComponents?.find((component) => component.id === vcId) ?? null,
  )

  if (activeDocument?.kind !== 'visualComponent' || !vc) return null

  return (
    <div className={styles.control} data-testid="vc-mode-control">
      <Button
        variant="ghost"
        size="sm"
        shape="pill"
        className={styles.backButton}
        onClick={exitVisualComponentMode}
        data-testid="vc-mode-control-back"
        aria-label="Back to page"
      >
        <ArrowLeftIcon size={12} aria-hidden="true" />
        Back to page
      </Button>

      <span className={styles.divider} aria-hidden="true" />

      <span className={styles.modeLabel}>Editing component</span>

      <DocumentSwitcher current={{ kind: 'component', id: vc.id, label: vc.name }} />
      <ComponentPreviewSource componentId={vc.id} />
    </div>
  )
}
