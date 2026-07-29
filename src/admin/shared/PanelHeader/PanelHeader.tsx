/**
 * PanelHeader — shared header for all floating editor panels.
 *
 * Features:
 * - Consistent 36px height, title, close button (Guideline #357).
 * - Draggable: spread `dragHandleProps` onto this element so the user can
 *   reposition the panel by dragging the header (cursor: grab).
 * - Children slot: extra action buttons (e.g. AgentPanel's "clear" button)
 *   are rendered between the title and the close button.
 * - Accessibility: close button has aria-label; drag area has cursor: grab.
 *   When used, the panel root should have aria-label describing the panel.
 *
 * Constraints:
 * - CSS Modules only — no Tailwind, no !important (Constraints #402, #403).
 * - Icons from pixel-art-icons (Guideline #350).
 * - No inline styles (only CSS-var injection is permitted).
 *
 * @see Guideline #357 — Editor UI Density (Compact Mode) — 36px header
 * @see Constraint #402 — No Tailwind / no inline styles
 * @see Constraint #403 — No !important
 */
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { Button } from '@ui/components/Button'
import styles from './PanelHeader.module.css'

export interface PanelDragHandleProps {
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void
}

interface PanelHeaderProps {
  /** Panel title displayed in the header. */
  title: string
  /** Optional custom title content. The string title remains the semantic panel name. */
  titleContent?: React.ReactNode
  /**
   * Stable identifier for this panel instance — used to generate stable
   * `data-testid` attributes for the close button and for Playwright targeting.
   *
   * Examples: "dom", "properties", "agent", "site"
   * → produces: data-testid="panel-close-dom", etc.
   */
  panelId: string
  /** Called when the close (✕) button is clicked. Should hide/toggle the panel. */
  onClose: () => void
  /**
   * Spread onto the header div to enable drag-to-reposition.
   * Provided by the `useDraggablePanel` hook via its `headerDragProps` field.
   */
  dragHandleProps?: PanelDragHandleProps
  /**
   * Optional extra action buttons rendered between the title and the close button.
   * Example: AgentPanel's "clear conversation" button.
   */
  children?: React.ReactNode
}

export function PanelHeader({ title, titleContent, panelId, onClose, dragHandleProps, children }: PanelHeaderProps) {
  return (
    <div
      {...dragHandleProps}
      className={styles.header}
      data-draggable={dragHandleProps ? 'true' : 'false'}
      role="toolbar"
      aria-label={`${title} panel header`}
    >
      <div className={styles.title}>{titleContent ?? title}</div>

      {/* Optional extra actions slot */}
      {children && (
        <div className={styles.actions}>
          {children}
        </div>
      )}

      {/* Close button — closes the panel completely (toolbar button reopens) */}
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        onClick={onClose}
        aria-label={`Close ${title} panel`}
        tooltip={`Close ${title} panel`}
        data-testid={`panel-close-${panelId}`}
      >
        <CloseIcon size={12} color="currentColor" aria-hidden="true" />
      </Button>
    </div>
  )
}
