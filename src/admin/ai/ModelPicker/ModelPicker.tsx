/**
 * ModelPicker — the single, shared `(credential, model)` picker used across the
 * admin: the AgentPanel chat composer and the AI settings → Defaults tab.
 *
 * It is a **controlled, store-agnostic** component: the parent owns the
 * selected `{ credentialId, modelId }` and reacts to `onChange`. The picker
 * itself only sources the data needed to render — credentials come in as a
 * prop, models are lazy-loaded per credential and cached internally.
 *
 * Sourcing:
 *   - Models per credential: `GET /admin/api/ai/providers/:id/models?credentialId=…`
 *     Cached per-credential. Two-phase: while CLOSED only the selected
 *     credential's models are fetched (enough to label the trigger); on OPEN
 *     it fans out to every credential so the full grouped list populates.
 *
 * Long lists (e.g. OpenRouter's 300+ models) get an in-menu search box and a
 * scrollable, viewport-clamped menu via the shared ContextMenu primitive.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  MenuSearchHeader,
} from '@ui/components/ContextMenu'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { cn } from '@ui/cn'
import { type AiModel, type CredentialView, listModels } from '@admin/ai/api'
import styles from './ModelPicker.module.css'

export interface ModelChoice {
  credentialId: string
  modelId: string
}

interface ModelPickerProps {
  /** Credentials are loaded by the parent so header/thread state stays in sync. */
  credentials: CredentialView[]
  /** True once the credential list fetch has completed at least once. */
  credentialsLoaded: boolean
  /** Current selection. `null` renders the `placeholder` label. */
  value: ModelChoice | null
  /** Fired when the user picks a `(credential, model)` pair. */
  onChange: (choice: ModelChoice) => void
  /** Fired when the menu opens — e.g. to refresh the credential list. */
  onOpen?: () => void
  /**
   * Trigger styling:
   *   - `'field'` (default): full-width form control matching a Select.
   *   - `'inline'`: compact ghost button for dense toolbars.
   */
  variant?: 'field' | 'inline'
  /** Label shown when `value` is `null`. Default: `'Default'`. */
  placeholder?: string
  className?: string
  ariaLabel?: string
  /** Prevent changing the selection while its current value is in use. */
  disabled?: boolean
  /** Auto-enable the in-menu search once loaded models exceed this. Default 8. */
  searchThreshold?: number
}

const SEP = '\0'
const choiceKey = (credentialId: string, modelId: string) => `${credentialId}${SEP}${modelId}`

/** A per-million-token USD price → compact label. `$3`, `$0.50`, `$1.25`. */
function formatPerMTok(value: number): string {
  if (value === 0) return '$0'
  // Sub-dollar prices keep two decimals; whole-dollar prices drop the `.00`.
  const text = value < 1 ? value.toFixed(2) : String(Math.round(value * 100) / 100)
  return `$${text}`
}

/** Input/output price pair shown inline per model row, e.g. `$3 / $15`. */
function formatModelPrice(model: AiModel): string | null {
  if (!model.pricing) return null
  return `${formatPerMTok(model.pricing.inputPerMTok)} / ${formatPerMTok(model.pricing.outputPerMTok)}`
}

/** Context window token count → compact label. `200K`, `1M`. */
function formatContextWindow(tokens: number | undefined): string | null {
  if (!tokens || tokens <= 0) return null
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Math.round(millions * 10) / 10}M`
  }
  return `${Math.round(tokens / 1000)}K`
}

export function ModelPicker({
  credentials,
  credentialsLoaded,
  value,
  onChange,
  onOpen,
  variant = 'field',
  placeholder = 'Default',
  className,
  ariaLabel = 'Pick a model',
  disabled = false,
  searchThreshold = 8,
}: ModelPickerProps) {
  const baseId = useId()
  const menuId = `${baseId}-menu`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const menuElRef = useRef<HTMLDivElement>(null)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [modelsByCred, setModelsByCred] = useState<Record<string, AiModel[]>>({})

  // Lazy-load models. Two-phase: closed → only the selected credential's
  // models (to label the trigger); open → every credential (to fill the list).
  useEffect(() => {
    if (credentials.length === 0) return
    let cancelled = false
    const targets = open
      ? credentials
      : credentials.filter((c) => c.id === value?.credentialId)
    for (const cred of targets) {
      if (modelsByCred[cred.id]) continue
      void listModels(cred.providerId, cred.id)
        .then((models) => {
          if (cancelled) return
          setModelsByCred((prev) => ({ ...prev, [cred.id]: models }))
        })
        .catch(() => {
          /* swallow — group shows "Loading models…" until it resolves */
        })
    }
    return () => {
      cancelled = true
    }
  }, [open, credentials, modelsByCred, value?.credentialId])

  // Focus the search box on open so the user can type immediately. rAF defers
  // past the menu's measuring frame (rendered `visibility: hidden`).
  const totalLoadedModels = Object.values(modelsByCred).reduce((n, m) => n + m.length, 0)
  const searchEnabled = totalLoadedModels > searchThreshold
  useEffect(() => {
    if (!open || !searchEnabled) return
    const id = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open, searchEnabled])

  if (!credentialsLoaded || credentials.length === 0) {
    return (
      <output className={cn(className, styles.staticState)}>
        {!credentialsLoaded ? 'Loading credentials…' : 'No credentials yet'}
      </output>
    )
  }

  // ── Grouping + filtering ──────────────────────────────────────────────
  const q = query.trim().toLowerCase()
  const matches = (cred: CredentialView, model: AiModel) =>
    q === '' ||
    model.label.toLowerCase().includes(q) ||
    cred.displayLabel.toLowerCase().includes(q) ||
    cred.providerId.toLowerCase().includes(q)

  const groups = credentials
    .map((cred) => ({
      cred,
      models: (modelsByCred[cred.id] ?? []).filter((m) => matches(cred, m)),
      loaded: Boolean(modelsByCred[cred.id]),
    }))
    // While searching, hide groups with no matching models. With no query,
    // keep every group (including still-loading ones).
    .filter((g) => (q === '' ? true : g.models.length > 0))

  // Flatten the visible models for keyboard navigation + option ids.
  const flat: Array<{ credentialId: string; modelId: string; optionId: string }> = []
  for (const group of groups) {
    for (const model of group.models) {
      flat.push({
        credentialId: group.cred.id,
        modelId: model.id,
        optionId: `${baseId}-opt-${flat.length}`,
      })
    }
  }
  const optionByKey = new Map(flat.map((f) => [choiceKey(f.credentialId, f.modelId), f]))
  const activeEntry =
    (activeKey != null ? optionByKey.get(activeKey) : undefined) ?? flat[0] ?? null
  const activeOptionId = activeEntry?.optionId

  const hasMatches = flat.length > 0
  const showEmpty = q !== '' && !hasMatches

  // ── Trigger label ─────────────────────────────────────────────────────
  const activeLabel = (() => {
    if (!value) return placeholder
    const cred = credentials.find((c) => c.id === value.credentialId)
    const model = (modelsByCred[value.credentialId] ?? []).find((m) => m.id === value.modelId)
    const credLabel = cred?.displayLabel ?? ''
    const modelLabel = model?.label ?? value.modelId
    return credLabel ? `${credLabel} · ${modelLabel}` : modelLabel
  })()

  function openMenu() {
    if (disabled) return
    setQuery('')
    setActiveKey(value ? choiceKey(value.credentialId, value.modelId) : null)
    setOpen(true)
    onOpen?.()
  }

  function closeMenu() {
    setOpen(false)
    setQuery('')
  }

  function toggle() {
    if (disabled) return
    if (open) closeMenu()
    else openMenu()
  }

  function pick(credentialId: string, modelId: string) {
    if (disabled) return
    closeMenu()
    onChange({ credentialId, modelId })
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function moveActive(direction: 1 | -1) {
    if (flat.length === 0) return
    const current = activeEntry
      ? flat.findIndex((f) => f.optionId === activeEntry.optionId)
      : -1
    const next = (current + direction + flat.length) % flat.length
    const entry = flat[next]
    setActiveKey(choiceKey(entry.credentialId, entry.modelId))
    // Keep the highlighted row in the scroll viewport as the user arrows
    // through a long (300+) list. The option id is stable, so we can scroll
    // it without waiting for the active-style re-render.
    requestAnimationFrame(() => {
      menuElRef.current?.ownerDocument
        .getElementById(entry.optionId)
        ?.scrollIntoView({ block: 'nearest' })
    })
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveActive(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        moveActive(-1)
        break
      case 'Enter':
        event.preventDefault()
        if (activeEntry) pick(activeEntry.credentialId, activeEntry.modelId)
        break
      case 'Escape':
        event.preventDefault()
        closeMenu()
        break
      case 'Tab':
        closeMenu()
        break
    }
  }

  return (
    <div className={cn(className, styles.root)}>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size={variant === 'field' ? 'md' : 'sm'}
        align={variant === 'field' ? 'between' : 'center'}
        fullWidth={variant === 'field'}
        disabled={disabled}
        onClick={toggle}
        // Inline trigger takes its accessible name from the 'Model' tooltip;
        // the field trigger has no tooltip, so it carries the aria-label.
        tooltip={variant === 'inline' ? 'Model' : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={variant === 'field' ? ariaLabel : undefined}
        className={variant === 'field' ? styles.fieldTrigger : styles.inlineTrigger}
      >
        <span
          className={cn(styles.triggerLabel, !value && styles.triggerPlaceholder)}
        >
          {activeLabel}
        </span>
        <ChevronDownIcon size={variant === 'field' ? 12 : 10} aria-hidden="true" />
      </Button>

      {open && (
        <ContextMenu
          ref={menuElRef}
          id={menuId}
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="start"
          side="auto"
          offset={6}
          minWidth={variant === 'field' ? 300 : 340}
          matchAnchorWidth={variant === 'field'}
          maxHeight={320}
          ariaLabel={ariaLabel}
          onClose={closeMenu}
          header={searchEnabled ? (
            <MenuSearchHeader
              inputRef={searchInputRef}
              value={query}
              onValueChange={(next) => {
                setQuery(next)
                setActiveKey(null)
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search models…"
              controls={menuId}
              activeOptionId={activeOptionId}
            />
          ) : undefined}
        >
          {showEmpty ? (
            <div className={styles.emptyOption} role="presentation">
              No matches
            </div>
          ) : (
            groups.flatMap((group, groupIndex) => {
              const credentialId = group.cred.id
              const items: ReactNode[] = []
              if (groupIndex > 0) {
                items.push(<ContextMenuSeparator key={`sep-${credentialId}`} />)
              }
              // Plain presentational row, NOT a disabled ContextMenuItem — a
              // disabled Button is dimmed to 0.38 opacity, which made the group
              // header almost invisible.
              items.push(
                <div key={`${credentialId}:header`} role="presentation" className={styles.groupHeaderRow}>
                  <span className={styles.groupHeader}>
                    {group.cred.displayLabel}
                    <span className={styles.groupProvider}> · {group.cred.providerId}</span>
                  </span>
                </div>,
              )
              if (group.models.length === 0) {
                items.push(
                  <ContextMenuItem key={`${credentialId}:loading`} disabled>
                    <span>{group.loaded ? 'No models available' : 'Loading models…'}</span>
                  </ContextMenuItem>,
                )
              } else {
                for (const model of group.models) {
                  const key = choiceKey(credentialId, model.id)
                  const entry = optionByKey.get(key)
                  const isSelected =
                    value?.credentialId === credentialId && value?.modelId === model.id
                  const priceLabel = formatModelPrice(model)
                  const contextLabel = formatContextWindow(model.contextWindow)
                  items.push(
                    <ContextMenuItem
                      key={key}
                      id={entry?.optionId}
                      role="menuitemradio"
                      aria-checked={isSelected}
                      active={entry?.optionId === activeOptionId}
                      disabled={disabled}
                      onMouseEnter={() => setActiveKey(key)}
                      onClick={() => pick(credentialId, model.id)}
                    >
                      <span className={styles.modelLabel}>{model.label}</span>
                      <span className={styles.modelMeta}>
                        {priceLabel && (
                          // in/out price per million tokens
                          <span className={styles.modelPrice} title="Input / output price per 1M tokens">
                            {priceLabel}
                          </span>
                        )}
                        {contextLabel && (
                          <span className={styles.modelContext} title="Context window">
                            {contextLabel}
                          </span>
                        )}
                      </span>
                    </ContextMenuItem>,
                  )
                }
              }
              return items
            })
          )}
        </ContextMenu>
      )}
    </div>
  )
}
