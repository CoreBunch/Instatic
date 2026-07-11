import { useImperativeHandle, type CSSProperties, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { PanelHeader } from '@admin/shared/PanelHeader'
import type { FloatingPanelId, PanelPosition } from '@admin/state/workspaceLayoutStorage'
import { cn } from '@ui/cn'
import { useDraggablePanel } from './useDraggablePanel'
import styles from './FloatingWindow.module.css'

interface FloatingWindowProps {
  panelId: FloatingPanelId
  open: boolean
  title: string
  defaultPosition: PanelPosition
  headerActions?: ReactNode
  width?: number | string
  height?: number | string
  maxHeight?: number | string
  className?: string
  bodyClassName?: string
  ariaLabel?: string
  testId?: string
  onClose(): void
  children?: ReactNode
  ref?: Ref<HTMLDivElement>
}

function cssLength(value: number | string): string {
  return typeof value === 'number' ? `${value}px` : value
}

/** Portal-backed draggable window shell shared across admin workspaces. */
export function FloatingWindow({
  panelId,
  open,
  title,
  defaultPosition,
  headerActions,
  width = 320,
  height = 'auto',
  maxHeight = 480,
  className,
  bodyClassName,
  ariaLabel,
  testId,
  onClose,
  children,
  ref: forwardedRef,
}: FloatingWindowProps) {
  const { panelRef, setPanelRef, headerDragProps, panelPositionStyle } = useDraggablePanel(
    panelId,
    () => defaultPosition,
  )
  useImperativeHandle(forwardedRef, () => panelRef.current as HTMLDivElement)

  if (!open) return null

  const style = {
    '--floating-window-w': cssLength(width),
    '--floating-window-h': cssLength(height),
    '--floating-window-max-h': cssLength(maxHeight),
    ...panelPositionStyle,
  } as CSSProperties

  return createPortal(
    <aside
      ref={setPanelRef}
      className={cn(styles.window, className)}
      role="dialog"
      aria-label={ariaLabel ?? title}
      data-testid={testId ?? `floating-window-${panelId}`}
      tabIndex={-1}
      style={style}
      onClick={(event) => event.stopPropagation()}
    >
      <PanelHeader
        panelId={panelId}
        title={title}
        onClose={onClose}
        dragHandleProps={headerDragProps}
      >
        {headerActions}
      </PanelHeader>
      <div className={cn(styles.body, bodyClassName)}>{children}</div>
    </aside>,
    document.body,
  )
}
