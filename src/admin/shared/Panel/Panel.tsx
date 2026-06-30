/**
 * Panel — shared docked-panel shell.
 *
 * Owns the consistent shell every docked editor panel uses:
 *   - <aside role="complementary"> with `data-panel`, `tabIndex={-1}`,
 *     and the click-stopPropagation guard the editor's surface listeners
 *     rely on (Guideline #192).
 *   - Shared 36px `<PanelHeader>` (title, close button, optional header
 *     actions slot, optional drag handle for floating variants).
 *   - Scrollable, padded `.contentPadded` body — the canonical 8px
 *     padding + 10px gap that previously lived (duplicated) in every
 *     panel's CSS module.
 *
 * Pre-refactor, every panel hand-rolled this shell, which led to drift:
 * DependenciesPanel skipped the `.content` wrapper entirely, so its
 * SearchBar sat flush to the panel edge while every other panel had an
 * 8px inset. Centralizing the shell here makes that impossible.
 *
 * Floating variants (DomPanel / AgentPanel / PropertiesPanel) keep their
 * own positioning shells — they manage drag, resize, and z-index, so
 * sharing this shell would over-couple them. They still use the same
 * `<PanelHeader>` so the header bar stays consistent.
 *
 * @see PanelHeader — header inside this shell
 * @see Guideline #192 — `data-panel` event-propagation guard
 * @see Guideline #357 — Compact UI density (36px header)
 */
import type { CSSProperties, ReactNode, Ref } from 'react'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { cn } from '@ui/cn'
import styles from './Panel.module.css'

interface PanelProps {
  /** Stable identifier — feeds the `<PanelHeader>` testids and the
   *  `data-testid` on the panel root. */
  panelId: string
  /** Panel title displayed in the header. */
  title: string
  /** Optional custom title content (e.g. an editable name field). The
   *  string `title` remains the semantic panel name. */
  titleContent?: ReactNode
  /** ARIA label for the `<aside>` landmark. Defaults to `title`. */
  ariaLabel?: string
  /** Override the default `panel-${panelId}` testid on the `<aside>`. */
  testId?: string
  /** Called when the close (✕) button is clicked. */
  onClose: () => void
  /** When true, the header (title + close + actions) is omitted entirely —
   *  used when an outer shell already owns the chrome, e.g. a panel rendered
   *  as a tab body inside the consolidated ExplorerPanel. */
  headerless?: boolean
  /** Optional extra action buttons rendered in the header between the
   *  title and the close button. */
  headerActions?: ReactNode
  /** Body layout. `padded` (default) wraps children in a scrollable
   *  flex column with 8px padding + 10px gap. `bare` mounts children
   *  directly under the header so the panel can own its own scroll
   *  surface or split layout. */
  body?: 'padded' | 'bare'
  /** Additional class on the body wrapper (composes with the chosen
   *  `body` layout). */
  bodyClassName?: string
  /** Forwarded to the body wrapper. */
  bodyRef?: Ref<HTMLDivElement>
  /** Style on the body wrapper (rare — used for CSS var injection). */
  bodyStyle?: CSSProperties
  /** Additional class on the `<aside>` shell. */
  className?: string
  /** Children render inside the body wrapper. */
  children?: ReactNode
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<HTMLElement>
}

/**
 * Standard docked panel shell. Pass the panel-specific content as
 * children — the shell owns chrome (aside + header + scrollable body).
 *
 * Forwards a ref to the outer `<aside>` so callers can focus it or
 * measure it (e.g. SiteExplorerPanel's autofocus on open).
 */
export function Panel({
  panelId,
  title,
  titleContent,
  ariaLabel,
  testId,
  onClose,
  headerless = false,
  headerActions,
  body = 'padded',
  bodyClassName,
  bodyRef,
  bodyStyle,
  className,
  children,
  ref,
}: PanelProps) {
  return (
    <aside
      ref={ref}
      role="complementary"
      aria-label={ariaLabel ?? title}
      data-panel=""
      data-testid={testId ?? `panel-${panelId}`}
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      className={cn(styles.panel, className)}
    >
      {!headerless && (
        <PanelHeader
          panelId={panelId}
          title={title}
          titleContent={titleContent}
          onClose={onClose}
        >
          {headerActions}
        </PanelHeader>
      )}

      <div
        ref={bodyRef}
        style={bodyStyle}
        className={cn(
          body === 'padded' ? styles.contentPadded : styles.contentBare,
          bodyClassName,
        )}
      >
        {children}
      </div>
    </aside>
  )
}
