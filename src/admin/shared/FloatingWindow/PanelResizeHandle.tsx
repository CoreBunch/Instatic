import type { PanelResizeHandleProps } from './useResizablePanel'
import styles from './PanelResizeHandle.module.css'

interface ResizeHandleProps {
  panelLabel: string
  resizeHandleProps: PanelResizeHandleProps
}

/** Bottom-right pointer and keyboard affordance for a floating panel. */
export function PanelResizeHandle({
  panelLabel,
  resizeHandleProps,
}: ResizeHandleProps) {
  return (
    <div
      {...resizeHandleProps}
      role="separator"
      aria-label={`Resize ${panelLabel} panel`}
      tabIndex={0}
      className={styles.handle}
      title={`Resize ${panelLabel} panel`}
    />
  )
}
