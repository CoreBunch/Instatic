/**
 * TagPill — compact tinted label primitive for badges, selector chips, and
 * removable tag pills.
 *
 * The tint is deterministic from the first meaningful character of `colorKey`
 * (or `label`) via `pillAccent`. Interactive forms use the shared `Button`
 * primitive for both the main action and the optional remove action.
 */
import type {
  CSSProperties,
  KeyboardEventHandler,
  MouseEvent,
  MouseEventHandler,
  ReactNode,
} from 'react'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import { pillAccent, type PillAccent } from '@ui/pillAccent'
import styles from './TagPill.module.css'

type TagPillSize = 'xs' | 'sm'

interface TagPillProps {
  label: string
  colorKey?: string
  accent?: PillAccent
  active?: boolean
  muted?: boolean
  monospace?: boolean
  size?: TagPillSize
  leading?: ReactNode
  className?: string
  onClick?: MouseEventHandler<HTMLButtonElement>
  onContextMenu?: MouseEventHandler<HTMLSpanElement>
  onMainKeyDown?: KeyboardEventHandler<HTMLButtonElement>
  onRemove?: MouseEventHandler<HTMLButtonElement>
  removeAriaLabel?: string
  removeTooltip?: ReactNode
  mainAriaLabel?: string
  testId?: string
  mainTestId?: string
  removeTestId?: string
  'aria-hidden'?: boolean | 'true' | 'false'
}

export function TagPill({
  label,
  colorKey,
  accent,
  active = false,
  muted = false,
  monospace = false,
  size = 'sm',
  leading,
  className,
  onClick,
  onContextMenu,
  onMainKeyDown,
  onRemove,
  removeAriaLabel,
  removeTooltip,
  mainAriaLabel,
  testId,
  mainTestId,
  removeTestId,
  'aria-hidden': ariaHidden,
}: TagPillProps) {
  const resolvedAccent = accent ?? pillAccent(colorKey ?? label)
  const removable = Boolean(onRemove)
  const style = {
    '--tag-pill-tint': `var(--tag-pill-tint-${resolvedAccent})`,
  } as CSSProperties

  const labelContent = (
    <>
      {leading && <span className={styles.leading}>{leading}</span>}
      <span
        className={styles.label}
        data-accent={resolvedAccent}
        data-active={active ? 'true' : undefined}
      >
        {label}
      </span>
    </>
  )

  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    onRemove?.(event)
  }

  return (
    <span
      className={cn(styles.pill, className)}
      data-accent={resolvedAccent}
      data-active={active ? 'true' : undefined}
      data-clickable={onClick ? 'true' : undefined}
      data-muted={muted ? 'true' : undefined}
      data-monospace={monospace ? 'true' : undefined}
      data-removable={removable ? 'true' : undefined}
      data-size={size}
      data-testid={testId}
      aria-hidden={ariaHidden}
      style={style}
      onContextMenu={onContextMenu}
    >
      {onClick ? (
        <Button
          variant="ghost"
          size="micro"
          pressed={active}
          className={styles.mainButton}
          onClick={onClick}
          onKeyDown={onMainKeyDown}
          aria-label={mainAriaLabel}
          data-testid={mainTestId}
        >
          {labelContent}
        </Button>
      ) : (
        <span className={styles.staticContent}>
          {labelContent}
        </span>
      )}
      {removable && (
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          aria-label={removeAriaLabel ?? `Remove ${label}`}
          tooltip={removeTooltip}
          dangerHover
          className={styles.removeButton}
          onClick={handleRemove}
          data-testid={removeTestId}
        >
          <CloseIcon size={10} color="currentColor" aria-hidden="true" />
        </Button>
      )}
    </span>
  )
}
