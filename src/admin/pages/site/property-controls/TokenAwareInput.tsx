/**
 * TokenAwareInput — a single text input + autocomplete dropdown that
 * suggests framework variables (spacing scale, typography scale, …).
 *
 * Visual / behavioural model is identical to the SpacingBoxControl side
 * input, just decoupled from the box-model UI:
 *
 *   - User types `m` → menu shows tokens whose step starts with `m`.
 *   - Picking `m` (Enter / click) commits `var(--space-m)` (or whichever
 *     `valueExpr` the matching token carries).
 *   - Typing a direct CSS value (`12px`, `auto`, `calc(...)`) hides the
 *     menu so the value can be committed without the dropdown stealing
 *     outside-clicks.
 *   - As-you-type live preview through `onPreview` / `onClearPreview`.
 *   - Stored `var(--space-m)` round-trips back to the short `m` display.
 *
 * The component is presentation-only — token sourcing (spacing vs
 * typography vs sizing scale) is the caller's choice via the `tokens`
 * prop, populated by hooks from `tokenUtils.ts`.
 */

import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { Input } from '@ui/components/Input'
import { Tooltip } from '@ui/components/Tooltip'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { cn } from '@ui/cn'
import {
  type Token,
  resolveTokenValue,
  displayTokenValue,
  looksLikeDirectValue,
  isLivePreviewable,
} from './tokenUtils'
import styles from './TokenAwareInput.module.css'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface TokenAwareInputHandle {
  /** Focus the underlying input. */
  focus(): void
}

interface TokenAwareInputProps {
  id?: string
  /** Current resolved CSS value (e.g. `var(--space-md)`, `12px`, `auto`). */
  value: string | undefined
  /** Placeholder shown when no value is set. Token-display is applied. */
  placeholder?: string
  /** Token catalog to suggest. Empty array → plain text input behaviour. */
  tokens: ReadonlyArray<Token>
  /** Commit handler — receives the resolved CSS expression or undefined. */
  onCommit: (resolved: string | undefined) => void
  /**
   * Optional live-preview handler. When provided, the component fires
   * `onPreview` on every keystroke and on token-row hover with the
   * resolved value, then `onClearPreview` on blur / menu-close.
   */
  onPreview?: (resolved: string | undefined) => void
  onClearPreview?: () => void
  /** Optional raw draft channel for controls that need sibling fields to mirror active typing. */
  onDraftChange?: (draft: string) => void
  onDraftClear?: () => void
  /** Side-effect fired when the input gains focus (e.g. tracking last-focused field). */
  onFocus?: () => void
  /**
   * Renders the field's hover-revealed ▲▼ stepper and delegates each click
   * here. Used by dimension fields (Width / Height), whose value is free-form
   * text but carries a numeric part worth stepping.
   */
  onStep?: (delta: number) => void
  fieldSize?: 'xs' | 'sm' | 'md'
  /** Aria label for the input — required when there's no visible label. */
  'aria-label': string
  className?: string
  inputClassName?: string
  style?: CSSProperties
  /**
   * Optional dropdown menu label override. When omitted, falls back to
   * the input's aria-label.
   */
  menuAriaLabel?: string
  spellCheck?: boolean
  autoComplete?: string
  disabled?: boolean
  /**
   * Shows the value but refuses edits — the field stays legible and
   * selectable, unlike `disabled`. Used by a pinned inset edge, where the
   * point is "this value is held", not "this control is unavailable".
   */
  readOnly?: boolean
  'data-testid'?: string
  /**
   * Suppress the token autocomplete dropdown while keeping every other token
   * behaviour (short display, typed-step resolution, preview). The spacing /
   * inset side fields use this: their value editor popout already carries the
   * scale as a chip grid, so a second floating token list beside the same
   * field is duplicate chrome that covers the canvas.
   */
  hideTokenMenu?: boolean
  /**
   * Render the input as a caller-positioned overlay: the wrapper uses
   * `display: contents` so it establishes no box, letting the caller
   * absolutely position the input against its own container (used by the
   * spacing box's per-side segments). Defaults to a block wrapper.
   */
  overlay?: boolean
  /**
   * When true, wrap the input in a Tooltip that surfaces the full stored
   * value — including the implicit `px` unit the display hides — on hover
   * whenever the rendered text overflows the field and the field isn't
   * being edited (used by the narrow per-side spacing inputs).
   */
  tooltipOnOverflow?: boolean
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<TokenAwareInputHandle>
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * px is the field's implicit default unit: a stored `200px` renders as a
 * bare `200` (`resolveTokenValue` mirrors this on the way back in — a bare
 * typed number commits as `200px`). Any other unit, keyword, token step, or
 * CSS expression displays as-is.
 */
const PX_VALUE = /^(-?\d+(?:\.\d+)?)px$/i

function displayValue(
  value: string | undefined,
  tokens: ReadonlyArray<Token>,
): string {
  const display = displayTokenValue(value, tokens)
  const match = display.match(PX_VALUE)
  return match ? match[1] : display
}

/** Does the rendered text overrun the field's visible box? */
function hasOverflow(el: HTMLInputElement): boolean {
  return el.scrollWidth > el.clientWidth + 1
}

// ---------------------------------------------------------------------------
// TokenAwareInput
// ---------------------------------------------------------------------------

export function TokenAwareInput({
  id,
  value,
  placeholder,
  tokens,
  onCommit,
  onPreview,
  onClearPreview,
  onDraftChange,
  onDraftClear,
  onFocus,
  onStep,
  fieldSize = 'sm',
  'aria-label': ariaLabel,
  className,
  inputClassName,
  style,
  menuAriaLabel,
  spellCheck = false,
  autoComplete = 'off',
  disabled,
  readOnly,
  'data-testid': dataTestId,
  hideTokenMenu = false,
  overlay = false,
  tooltipOnOverflow = false,
  ref,
}: TokenAwareInputProps) {
    const display = displayValue(value, tokens)
    const placeholderDisplay = displayValue(placeholder, tokens)

    // The shared "preview suggestions on hover" preference. When off,
    // hovering a token row in the dropdown doesn't fire onPreview — but
    // typing still does (live as-you-type preview is its own UX feature).
    const hoverPreviewEnabled = useEditorPreference('hoverPreview')

    // Local draft so we don't fire onCommit on every keystroke (which would
    // round-trip through Mutative + re-validate every press).
    const [draft, setDraft] = useState(display)
    const [isEditing, setIsEditing] = useState(false)
    // Focus alone is not "the user is mid-word". The value editor popout
    // opens BESIDE a focused field and writes through the same commit
    // channel, so a focused-but-untouched field must still follow the store —
    // otherwise its draft goes stale and the next blur commits the pre-popout
    // value back over the popout's.
    const [isTyping, setIsTyping] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
    }))

    // Narrow overlay fields (e.g. the spacing box's 38px sides) visually
    // truncate long values like a full `clamp(...)`. Track overflow so the
    // optional tooltip can surface the full value on hover — only measured
    // when the caller opts in via `tooltipOnOverflow`.
    //
    // The draft-keyed measure below is only a warm-up for the common case
    // (visible mount, value known). The authoritative measure runs on hover
    // (the Input's onMouseEnter): geometry changes without the text changing
    // — a mount inside a hidden panel surface reads 0×0, `field-sizing:
    // content` resizes the field with its value, the panel resizes — and a
    // stale "not overflowing" would otherwise disarm the tooltip forever.
    const [isOverflowing, setIsOverflowing] = useState(false)
    useLayoutEffect(() => {
      if (!tooltipOnOverflow) return
      const el = inputRef.current
      if (!el) return
      setIsOverflowing(hasOverflow(el))
    }, [draft, tooltipOnOverflow])

    // Sync external value → draft unless the user is mid-keystroke. React 19
    // idiom: adjust state during render by tracking the previous external value.
    const [lastExternalDisplay, setLastExternalDisplay] = useState(display)
    if (!isTyping && display !== lastExternalDisplay) {
      setLastExternalDisplay(display)
      setDraft(display)
    }

    // Toggling the Tooltip's `disabled` swaps the Input in and out of the
    // tooltip wrapper, which REMOUNTS the DOM input (Tooltip's disabled path
    // renders its child bare). When that flip is caused by focus — editing
    // disables the tooltip — the just-focused input would be destroyed and
    // the click would appear to do nothing. Restore focus to the remounted
    // node; a no-op whenever focus survived (no remount happened).
    useLayoutEffect(() => {
      if (!tooltipOnOverflow || !isEditing) return
      const el = inputRef.current
      if (el && document.activeElement !== el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    }, [isEditing, tooltipOnOverflow])

    // Filter tokens by typed prefix for the autocomplete dropdown.
    // When there's no query, the "Suggested" section is hidden entirely —
    // returning [] here lets the "Tokens" section render the full scale.
    const q = draft.trim().toLowerCase()
    const suggestions = !q
      ? []
      : tokens
          .filter(
            (t) =>
              t.step.toLowerCase().startsWith(q) ||
              t.step.toLowerCase().includes(q),
          )
          .slice(0, 8)

    const commit = (raw: string) => {
      const resolved = resolveTokenValue(raw, tokens)
      onClearPreview?.()
      onCommit(resolved)
      onDraftClear?.()
      setIsEditing(false)
      setIsTyping(false)
    }

    // Preview a hovered token's value on the canvas. Gated by the
    // hoverPreview editor preference so users who don't want flicker can
    // opt out. Note: the as-you-type preview below is intentionally always
    // on, since it reflects an explicit edit the user is making.
    const previewToken = (rawValue: string) => {
      if (!hoverPreviewEnabled || !onPreview) return
      const resolved = resolveTokenValue(rawValue, tokens)
      onPreview(resolved)
    }

    // Defensive: if the preference is toggled off while a hover preview is
    // active (e.g. user flips it in another tab), clear the canvas preview
    // so nothing sticks around.
    useEffect(() => {
      if (!hoverPreviewEnabled) onClearPreview?.()
    }, [hoverPreviewEnabled, onClearPreview])

    // Live-preview a typed draft. Updates the canvas on every keystroke so
    // users see their values applied without having to press Enter / Tab /
    // blur — matches the behaviour of every modern visual builder. When the
    // current draft is provably incomplete (e.g. `var(--spa`), we skip the
    // update and keep the last valid preview on screen instead of writing
    // garbage to the engine.
    const previewDraft = (rawValue: string) => {
      if (!onPreview) return
      if (!isLivePreviewable(rawValue)) return
      const resolved = resolveTokenValue(rawValue, tokens)
      onPreview(resolved)
    }

    // Hide the dropdown when the user is typing a direct CSS value
    // (numbers, units, `auto`, `calc(...)`, etc.) — non-token typing should
    // commit on Enter/Tab/Blur without the menu intercepting outside-clicks.
    const isDirectValue = looksLikeDirectValue(draft)
    const showMenu = isEditing && !isDirectValue && tokens.length > 0 && !hideTokenMenu

    // Split tokens into "Suggested" (matching the typed query) and "All"
    // (everything else) so users always see the full scale even when they
    // haven't started typing.
    const queryTrim = draft.trim().toLowerCase()
    const suggestedSet = new Set(suggestions.map((t) => t.varName))
    const allOthers = tokens.filter((t) => !suggestedSet.has(t.varName))
    const showSuggestedHeader = queryTrim.length > 0 && suggestions.length > 0
    const showAllHeader = allOthers.length > 0

    const inputEl = (
      <Input
        ref={inputRef}
        id={id}
        type="text"
        fieldSize={fieldSize}
        value={draft}
        placeholder={placeholderDisplay}
        spellCheck={spellCheck}
        autoComplete={autoComplete}
        aria-label={ariaLabel}
        disabled={disabled}
        readOnly={readOnly}
        data-testid={dataTestId}
        onStep={onStep}
        className={cn(styles.input, inputClassName)}
        onMouseEnter={
          tooltipOnOverflow
            ? () => {
                // The authoritative overflow measure — at the moment the
                // answer is needed (see the comment on the warm-up effect).
                const el = inputRef.current
                if (el) setIsOverflowing(hasOverflow(el))
              }
            : undefined
        }
        onFocus={() => {
          setIsEditing(true)
          setIsTyping(false)
          onFocus?.()
        }}
        onChange={(e) => {
          const next = e.target.value
          // Typing is editing, whatever got us here (an arrow-key step drops
          // isEditing so the stepped value can flow back into the draft).
          setIsEditing(true)
          setIsTyping(true)
          setDraft(next)
          onDraftChange?.(next)
          previewDraft(next)
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && onStep) {
            // Steps go through the caller's math (units survive), and the
            // field leaves editing mode so the stepped external value flows
            // back into the visible draft — the focused draft would otherwise
            // keep showing the pre-step text.
            e.preventDefault()
            setIsEditing(false)
            setIsTyping(false)
            onDraftClear?.()
            onStep((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(display)
            setIsEditing(false)
            setIsTyping(false)
            onDraftClear?.()
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Tab') {
            // Allow default tab behaviour but commit the current value.
            commit((e.target as HTMLInputElement).value)
          }
        }}
      />
    )

    return (
      <div
        className={cn(overlay ? styles.wrapperOverlay : styles.wrapper, className)}
        style={style}
      >
        {tooltipOnOverflow ? (
          <Tooltip
            // The full stored value — including the implicit px unit the
            // bare-number display hides (a field showing "220" tips "220px").
            content={value || draft}
            side="top"
            disabled={!isOverflowing || isEditing || !draft}
          >
            {inputEl}
          </Tooltip>
        ) : (
          inputEl
        )}

        {showMenu &&
          createPortal(
            <ContextMenu
              anchorRef={inputRef}
              side="auto"
              align="start"
              offset={4}
              matchAnchorWidth
              minWidth={132}
              ariaLabel={menuAriaLabel ?? `${ariaLabel} variables`}
              triggerRef={inputRef}
              onClose={() => onClearPreview?.()}
              onMouseLeave={() => onClearPreview?.()}
            >
              {showSuggestedHeader && (
                <div className={styles.menuHeader} aria-hidden="true">
                  Suggested
                </div>
              )}
              {showSuggestedHeader &&
                suggestions.map((t) => (
                  <ContextMenuItem
                    key={`suggested-${t.varName}`}
                    onMouseDown={(e) => {
                      // mousedown beats blur — commits the token before
                      // the input loses focus.
                      e.preventDefault()
                      commit(t.step)
                    }}
                    onMouseEnter={() => previewToken(t.step)}
                    className={styles.menuItem}
                  >
                    <span className={styles.menuToken}>{t.step}</span>
                    <span className={styles.menuVar} title={t.valueExpr}>
                      {t.varName}
                    </span>
                  </ContextMenuItem>
                ))}
              {showAllHeader && (
                <div className={styles.menuHeader} aria-hidden="true">
                  {showSuggestedHeader ? 'All tokens' : 'Tokens'}
                </div>
              )}
              {(showAllHeader ? allOthers : tokens).map((t) => (
                <ContextMenuItem
                  key={`all-${t.varName}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    commit(t.step)
                  }}
                  onMouseEnter={() => previewToken(t.step)}
                  className={styles.menuItem}
                >
                  <span className={styles.menuToken}>{t.step}</span>
                  <span className={styles.menuVar} title={t.valueExpr}>
                    {t.varName}
                  </span>
                </ContextMenuItem>
              ))}
            </ContextMenu>,
            document.body,
          )}
      </div>
    )
}
