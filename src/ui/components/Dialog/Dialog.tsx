/**
 * `Dialog` — shared modal primitive for the entire admin app.
 *
 * One source of truth for the chrome (backdrop, header, footer, focus +
 * Escape key handling, portal mount). Specific dialogs (`ConfirmDelete`,
 * `PluginSettings`, `PluginRemove`, `SiteCreate`, …) compose their content
 * inside <Dialog/> instead of re-rolling backdrop CSS in every module.
 *
 *   <Dialog
 *     open={isOpen}
 *     onClose={() => setOpen(false)}
 *     title="Remove plugin"
 *     eyebrow="Plugin settings"
 *     footer={
 *       <>
 *         <Button variant="secondary" onClick={...}>Cancel</Button>
 *         <Button variant="destructive" onClick={...}>Remove</Button>
 *       </>
 *     }
 *   >
 *     <p>Body text…</p>
 *   </Dialog>
 *
 * Variants:
 *   `size`  — sm (360px) | md (440px, default) | lg (520px) | xl (640px) | 2xl (820px)
 *   `tone`  — neutral (default) | danger — colours the eyebrow / header
 *
 * Accessibility:
 *   • role=dialog + aria-modal=true (or alertdialog when `tone === 'danger'`)
 *   • aria-labelledby points at the title; aria-describedby at the body
 *   • Escape closes (unless `closeOnEscape={false}`)
 *   • Backdrop click closes (unless `closeOnBackdrop={false}`)
 *   • Focus is captured on mount; first focusable element inside is focused
 *   • Focus is restored to the previously-focused element on close
 */
import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { cn } from '@ui/cn'
import styles from './Dialog.module.css'

type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl'
type DialogTone = 'neutral' | 'danger'

interface DialogProps {
  /** Whether the dialog is currently visible. */
  open: boolean
  /** Called when the dialog requests to close (Esc, backdrop, X button). */
  onClose: () => void

  /** Title shown in the header. */
  title: ReactNode
  /** Optional pre-title eyebrow label (small, uppercased). */
  eyebrow?: ReactNode
  /** Body content. */
  children?: ReactNode
  /**
   * Footer content — typically Cancel / primary / destructive buttons. When
   * omitted, the footer + border are not rendered.
   */
  footer?: ReactNode

  /** Visual size variant. Defaults to 'md' (440px). */
  size?: DialogSize
  /**
   * Tone — `'danger'` colours the eyebrow red and swaps role to
   * `alertdialog`. Defaults to `'neutral'`.
   */
  tone?: DialogTone

  /** Hide the close (X) button in the header. Defaults to false. */
  hideCloseButton?: boolean
  /** Disable Escape-key closing. Defaults to false. */
  closeOnEscape?: boolean
  /** Disable backdrop-click closing. Defaults to false. */
  closeOnBackdrop?: boolean

  /** Optional className on the dialog container. */
  className?: string
  /** Optional className on the scrollable body region. */
  bodyClassName?: string
  /** Optional className on the footer row. */
  footerClassName?: string
  /**
   * True while the dialog body's contents are being fetched. Renders a
   * universal three-bar skeleton in place of `children` and sets
   * `aria-busy="true"` on the dialog. The footer stays visible (so the
   * user can still Cancel) but its buttons should be disabled by the
   * caller while loading. One prop, no per-dialog skeleton markup.
   */
  loading?: boolean
  /** Optional aria-label override (when no `title` is suitable for ATs). */
  ariaLabel?: string
  /**
   * Element to focus when the dialog opens. When omitted, the first
   * focusable element inside the dialog is focused (typical Cancel button).
   * Pass a ref to a different element (e.g. the destructive confirm button
   * so Enter activates it) to override.
   */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<HTMLDivElement>
}

export function Dialog({
  open,
  onClose,
  title,
  eyebrow,
  children,
  footer,
  size = 'md',
  tone = 'neutral',
  hideCloseButton = false,
  closeOnEscape = true,
  closeOnBackdrop = true,
  className,
  bodyClassName,
  footerClassName,
  loading = false,
  ariaLabel,
  initialFocusRef,
  ref,
}: DialogProps) {
  const titleId = useId()
  const descId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  // Escape closes the dialog. Document-level listener so the press wins
  // over any global editor keybindings while the dialog is open.
  useEffect(() => {
    if (!open || !closeOnEscape) return undefined
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        const openDialogs = document.querySelectorAll<HTMLElement>('[data-ui-dialog="true"]')
        if (openDialogs[openDialogs.length - 1] !== dialogRef.current) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, closeOnEscape, onClose])

  // Focus management: capture focus on mount, restore on unmount.
  useEffect(() => {
    if (!open) return undefined
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null
    requestAnimationFrame(() => {
      // Caller-provided focus target wins over the first-focusable lookup.
      // Useful for destructive confirmations where Enter should activate the
      // action button without forcing a Tab from Cancel.
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus()
        return
      }
      const node = dialogRef.current
      if (!node) return
      const focusable = node.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      focusable?.focus()
    })
    return () => {
      previouslyFocusedRef.current?.focus()
    }
  }, [open, initialFocusRef])

  if (!open) return null

  const role = tone === 'danger' ? 'alertdialog' : 'dialog'

  return createPortal(
    <div
      className={styles.backdrop}
      onClick={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={(node) => {
          dialogRef.current = node
          if (typeof ref === 'function') ref(node)
          else if (ref) ref.current = node
        }}
        role={role}
        aria-modal="true"
        aria-labelledby={ariaLabel ? undefined : titleId}
        aria-label={ariaLabel}
        aria-describedby={children ? descId : undefined}
        aria-busy={loading || undefined}
        data-ui-dialog="true"
        data-size={size}
        data-tone={tone}
        className={cn(styles.dialog, className)}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div className={styles.headerText}>
            {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
          </div>
          {!hideCloseButton && (
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
            >
              <CloseIcon size={14} aria-hidden="true" />
            </Button>
          )}
        </header>

        {loading ? (
          <div id={descId} className={cn(styles.body, bodyClassName)}>
            <SkeletonBlock minHeight={120} />
          </div>
        ) : children !== undefined && children !== null && (
          <div id={descId} className={cn(styles.body, bodyClassName)}>
            {children}
          </div>
        )}

        {footer && <footer className={cn(styles.footer, footerClassName)}>{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
