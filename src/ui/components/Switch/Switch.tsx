import { type ButtonHTMLAttributes, type Ref } from 'react'
import { cn } from '@ui/cn'
import styles from './Switch.module.css'

interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'role' | 'onChange'> {
  checked: boolean
  onCheckedChange?: (checked: boolean) => void
  switchSize?: 'sm' | 'md'
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<HTMLButtonElement>
}

export function Switch({
  checked,
  onCheckedChange,
  switchSize = 'md',
  className,
  disabled,
  onClick,
  type = 'button',
  children,
  ref,
  ...props
}: SwitchProps) {
  return (
    <button
      ref={ref}
      type={type}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-size={switchSize}
      className={cn(styles.switch, className)}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented && !disabled) {
          onCheckedChange?.(!checked)
        }
      }}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(styles.track, checked ? styles.trackOn : styles.trackOff)}
      >
        <span
          aria-hidden="true"
          className={cn(styles.thumb, checked ? styles.thumbOn : styles.thumbOff)}
        />
      </span>
      {children}
    </button>
  )
}
