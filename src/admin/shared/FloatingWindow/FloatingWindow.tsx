import { useImperativeHandle, useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { Button } from '@ui/components/Button'
import { MinusIcon } from 'pixel-art-icons/icons/minus'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import type { FloatingPanelId, PanelPosition } from '@admin/state/workspaceLayoutStorage'
import { cn } from '@ui/cn'
import { useDraggablePanel } from './useDraggablePanel'
import { useTopmostEscape } from './useTopmostEscape'
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
  /**
   * Offer a collapse control beside Close, leaving only the title bar.
   *
   * For windows that stay useful while the user works around them — an upload
   * in flight, a bulk edit mid-review — where the choice is otherwise between
   * losing the panel and letting it cover the grid.
   *
   * Collapsed state is per-session and stays where the window sits: the
   * position is the user's own, so folding to a corner would discard it, and
   * expanding would then have nowhere honest to return to.
   */
  minimizable?: boolean
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
  minimizable = false,
  onClose,
  children,
  ref: forwardedRef,
}: FloatingWindowProps) {
  const { panelRef, setPanelRef, headerDragProps, panelPositionStyle } = useDraggablePanel(
    panelId,
    () => defaultPosition,
  )
  useImperativeHandle(forwardedRef, () => panelRef.current as HTMLDivElement)

  const [minimized, setMinimized] = useState(false)

  useTopmostEscape(open, panelRef, onClose)

  if (!open) return null

  const style = {
    '--floating-window-w': cssLength(width),
    '--floating-window-h': minimized ? 'auto' : cssLength(height),
    '--floating-window-max-h': minimized ? 'none' : cssLength(maxHeight),
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
        {minimized ? null : headerActions}
        {minimizable && (
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            tooltip={minimized ? 'Expand' : 'Minimize'}
            aria-label={minimized ? `Expand ${title}` : `Minimize ${title}`}
            aria-expanded={!minimized}
            data-testid={`panel-minimize-${panelId}`}
            onClick={() => setMinimized((value) => !value)}
          >
            {minimized ? <PlusIcon size={13} /> : <MinusIcon size={13} />}
          </Button>
        )}
      </PanelHeader>
      {!minimized && <div className={cn(styles.body, bodyClassName)}>{children}</div>}
    </aside>,
    document.body,
  )
}
