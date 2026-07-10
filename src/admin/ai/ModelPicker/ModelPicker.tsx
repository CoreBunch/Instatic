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

import { Fragment, memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@ui/components/Button'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  MenuSearchHeader,
} from '@ui/components/ContextMenu'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { ChevronUpIcon } from 'pixel-art-icons/icons/chevron-up'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { cn } from '@ui/cn'
import { type AiModel, type CredentialView, listModels } from '@admin/ai/api'
import styles from './ModelPicker.module.css'

const FAVORITES_KEY = 'instatic:model-favorites'
const RECENTS_KEY = 'instatic:model-recents'
const SORT_KEY = 'instatic:model-sort'
const COLLAPSED_KEY = 'instatic:model-collapsed'
const MENU_SIZE_KEY = 'instatic:model-picker-size'

interface StoredModelRef {
  credentialId: string
  modelId: string
  label: string
  providerId: string
}

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch { return new Set() }
}

function saveFavorites(set: Set<string>) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(set)))
}

function loadRecents(): StoredModelRef[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    if (!raw) return []
    return JSON.parse(raw) as StoredModelRef[]
  } catch { return [] }
}

function saveRecents(list: StoredModelRef[]) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 3)))
}

function loadSort(): { key: 'default' | 'price' | 'provider' | 'name'; dir: 'asc' | 'desc' } {
  try {
    const raw = localStorage.getItem(SORT_KEY)
    if (!raw) return { key: 'default', dir: 'asc' }
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.key === 'string' && typeof parsed.dir === 'string') {
      return parsed as { key: 'default' | 'price' | 'provider' | 'name'; dir: 'asc' | 'desc' }
    }
  } catch { /* ignore */ }
  return { key: 'default', dir: 'asc' }
}

function saveSort(sort: { key: 'default' | 'price' | 'provider' | 'name'; dir: 'asc' | 'desc' }) {
  localStorage.setItem(SORT_KEY, JSON.stringify(sort))
}

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch { return new Set() }
}

function saveCollapsed(set: Set<string>) {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(set)))
}

interface MenuSize {
  width: number
  height: number
}

const MAX_MENU_WIDTH = 500
const MAX_MENU_HEIGHT = 500

function loadMenuSize(): MenuSize {
  try {
    const raw = localStorage.getItem(MENU_SIZE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as MenuSize
      return {
        width: Math.min(Math.max(parsed.width, 0), MAX_MENU_WIDTH),
        height: Math.min(Math.max(parsed.height, 180), MAX_MENU_HEIGHT),
      }
    }
  } catch { /* ignore */ }
  return { width: 0, height: 320 }
}

function saveMenuSize(size: MenuSize) {
  localStorage.setItem(MENU_SIZE_KEY, JSON.stringify(size))
}

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
  /** Auto-enable the in-menu search once loaded models exceed this. Default 8. */
  searchThreshold?: number
}

const SEP = ''
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

/** Price tooltip text for native title attribute. */
function formatPriceTitle(model: AiModel): string | undefined {
  if (!model.pricing) return undefined
  return `Price per 1M tokens — Input: ${formatPerMTok(model.pricing.inputPerMTok)}, Output: ${formatPerMTok(model.pricing.outputPerMTok)}, Total: ${formatPerMTok(model.pricing.inputPerMTok + model.pricing.outputPerMTok)}`
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

interface ModelRowProps {
  credentialId: string
  model: AiModel
  optionId?: string
  isSelected: boolean
  isActive: boolean
  isFavorite: boolean
  onPick: (credentialId: string, modelId: string) => void
  onToggleFavorite: (credentialId: string, modelId: string) => void
  onHover: (key: string) => void
}

/** Memoized single row so React can skip unchanged models during hover / keyboard nav. */
const ModelRow = memo(function ModelRow({
  credentialId,
  model,
  optionId,
  isSelected,
  isActive,
  isFavorite,
  onPick,
  onToggleFavorite,
  onHover,
}: ModelRowProps) {
  const key = choiceKey(credentialId, model.id)
  const priceLabel = formatModelPrice(model)
  const contextLabel = formatContextWindow(model.contextWindow)
  return (
    <ContextMenuItem
      id={optionId}
      className={styles.rowGrid}
      role="menuitemradio"
      aria-checked={isSelected}
      active={isActive}
      onMouseEnter={() => onHover(key)}
      onClick={() => onPick(credentialId, model.id)}
    >
      <span className={styles.modelLabel} title={model.label}>{model.label}</span>
      <span className={styles.favWrap}>
        {isFavorite && (
          <span className={cn(styles.favStar, styles.favStarStatic)} aria-hidden="true">★</span>
        )}
        <span
          role="button"
          tabIndex={0}
          className={cn(styles.favButton, isFavorite && styles.favButtonActive, styles.favButtonHover)}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite(credentialId, model.id)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              onToggleFavorite(credentialId, model.id)
            }
          }}
          title={isFavorite ? 'Remove favorite' : 'Add favorite'}
        >
          {isFavorite ? '★' : '☆'}
        </span>
      </span>
      <span className={styles.modelPrice} title={formatPriceTitle(model) ?? priceLabel ?? undefined}>{priceLabel ?? '\u00A0'}</span>
      <span className={styles.modelContext} title={contextLabel ? 'Context window' : undefined}>{contextLabel ?? '\u00A0'}</span>
    </ContextMenuItem>
  )
})

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
  const [sort, setSort] = useState<{ key: 'default' | 'price' | 'provider' | 'name'; dir: 'asc' | 'desc' }>(() => loadSort())
  const [favorites, setFavorites] = useState<Set<string>>(() => loadFavorites())
  const [recents, setRecents] = useState<StoredModelRef[]>(() => loadRecents())
  const [sortPanelOpen, setSortPanelOpen] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => loadCollapsed())
  const [menuSize, setMenuSize] = useState<MenuSize>(() => loadMenuSize())
  const openTimeRef = useRef<number>(0)

  // Persist sort and collapsed section state to localStorage.
  useEffect(() => {
    saveSort(sort)
  }, [sort])
  useEffect(() => {
    saveCollapsed(collapsedSections)
  }, [collapsedSections])

  // ── Menu resize ───────────────────────────────────────────────────────
  const isResizingRef = useRef(false)
  const dragStartRef = useRef({ x: 0, y: 0, width: 0, height: 0 })
  const resizeEdgeRef = useRef<'n' | 'e' | 'ne' | null>(null)
  const resizeAnchorRef = useRef({ triggerTop: 0, offset: 6 })
  const resizeOverlayElRef = useRef<HTMLDivElement | null>(null)

  function createResizeOverlay(cursor: string) {
    const el = document.createElement('div')
    el.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:' + cursor + ';'
    document.body.appendChild(el)
    resizeOverlayElRef.current = el
  }

  function removeResizeOverlay() {
    if (resizeOverlayElRef.current) {
      resizeOverlayElRef.current.remove()
      resizeOverlayElRef.current = null
    }
  }

  const startResize = useCallback((edge: 'n' | 'e' | 'ne') => {
    return (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const menuEl = menuElRef.current
      const triggerEl = triggerRef.current
      if (!menuEl) return
      const rect = menuEl.getBoundingClientRect()
      isResizingRef.current = true
      resizeEdgeRef.current = edge
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        width: rect.width,
        height: rect.height,
      }
      if (triggerEl) {
        resizeAnchorRef.current = {
          triggerTop: triggerEl.getBoundingClientRect().top,
          offset: 6,
        }
      }
      const cursors: Record<string, string> = {
        n: 'ns-resize', e: 'ew-resize', ne: 'nesw-resize',
      }
      createResizeOverlay(cursors[edge])
      document.addEventListener('mousemove', handleResizeMove)
      document.addEventListener('mouseup', handleResizeUp)
    }
  }, [])

  function handleResizeMove(e: MouseEvent) {
    if (!isResizingRef.current) return
    e.preventDefault()
    const menuEl = menuElRef.current
    if (!menuEl) return
    const edge = resizeEdgeRef.current
    if (!edge) return

    const dx = e.clientX - dragStartRef.current.x
    const dy = e.clientY - dragStartRef.current.y

    let newWidth = dragStartRef.current.width
    let newHeight = dragStartRef.current.height

    if (edge.includes('e')) newWidth = Math.max(280, Math.min(MAX_MENU_WIDTH, dragStartRef.current.width + dx))
    if (edge.includes('n')) newHeight = Math.max(180, Math.min(MAX_MENU_HEIGHT, dragStartRef.current.height - dy))

    menuEl.style.setProperty('--context-menu-width', `${newWidth}px`)
    menuEl.style.setProperty('--context-menu-max-height', `${newHeight}px`)

    // With side="top", the bottom edge must stay pinned to the trigger.
    // The ContextMenu ResizeObserver will confirm this on the next frame,
    // but we set it directly to avoid a one-frame flicker.
    if (edge.includes('n')) {
      const { triggerTop, offset } = resizeAnchorRef.current
      const newTop = triggerTop - offset - newHeight
      menuEl.style.setProperty('--context-menu-y', `${newTop}px`)
    }
  }

  function handleResizeUp() {
    if (!isResizingRef.current) return
    isResizingRef.current = false
    removeResizeOverlay()
    const menuEl = menuElRef.current
    if (menuEl) {
      const next = {
        width: Math.min(Math.max(menuEl.offsetWidth, 280), MAX_MENU_WIDTH),
        height: Math.min(Math.max(menuEl.offsetHeight, 180), MAX_MENU_HEIGHT),
      }
      setMenuSize(next)
      saveMenuSize(next)
    }
    resizeEdgeRef.current = null
    document.removeEventListener('mousemove', handleResizeMove)
    document.removeEventListener('mouseup', handleResizeUp)
  }

  // Lazy-load models. Two-phase: closed → only the selected credential's
  // models (to label the trigger); open → every credential (to fill the list).
  const modelsByCredRef = useRef(modelsByCred)
  modelsByCredRef.current = modelsByCred
  useEffect(() => {
    if (credentials.length === 0) return
    let cancelled = false
    const targets = open
      ? credentials
      : credentials.filter((c) => c.id === value?.credentialId)
    const toFetch = targets.filter((c) => !modelsByCredRef.current[c.id])
    if (open) {
      console.log(`[ModelPicker] model load effect: ${toFetch.length} creds to fetch, ${targets.length - toFetch.length} cached`)
    }
    for (const cred of toFetch) {
      void listModels(cred.providerId, cred.id)
        .then((models) => {
          if (cancelled) return
          console.log(`[ModelPicker] models arrived for ${cred.providerId}/${cred.id}: ${models.length} models`)
          setModelsByCred((prev) => ({ ...prev, [cred.id]: models }))
        })
        .catch(() => {
          /* swallow — group shows "Loading models…" until it resolves */
        })
    }
    return () => {
      cancelled = true
    }
  }, [open, credentials, value?.credentialId])

  // Log total time from open click to render commit
  useEffect(() => {
    if (!open || !openTimeRef.current) return
    const t = performance.now()
    console.log(`[ModelPicker] render committed: ${t.toFixed(1)}ms (+${(t - openTimeRef.current).toFixed(1)}ms from open click)`)
  }, [open])

  // Focus the search box on open so the user can type immediately. rAF defers
  // past the menu's measuring frame (rendered `visibility: hidden`).
  const totalLoadedModels = Object.values(modelsByCred).reduce((n, m) => n + m.length, 0)
  const searchEnabled = totalLoadedModels > searchThreshold
  useEffect(() => {
    if (!open || !searchEnabled) return
    const id = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open, searchEnabled])

  // ── Grouping + filtering (memoized) ────────────────────────────────────
  const groups = useMemo(() => {
    const t0 = performance.now()
    const q = query.trim().toLowerCase()
    const matches = (cred: CredentialView, model: AiModel) => {
      if (q === '') return true
      if (model.label.toLowerCase().includes(q)) return true
      if (cred.displayLabel.toLowerCase().includes(q)) return true
      if (cred.providerId.toLowerCase().includes(q)) return true
      const ctxLabel = formatContextWindow(model.contextWindow)
      if (ctxLabel && ctxLabel.toLowerCase().includes(q)) return true
      if (model.contextWindow && String(model.contextWindow).includes(q)) return true
      const priceLabel = formatModelPrice(model)
      if (priceLabel && priceLabel.toLowerCase().includes(q)) return true
      if (model.pricing) {
        if (String(model.pricing.inputPerMTok).includes(q)) return true
        if (String(model.pricing.outputPerMTok).includes(q)) return true
      }
      return false
    }

    let result = credentials
      .map((cred) => ({
        cred,
        models: (modelsByCred[cred.id] ?? []).filter((m) => matches(cred, m)),
        loaded: Boolean(modelsByCred[cred.id]),
      }))
      .filter((g) => (q === '' ? true : g.models.length > 0))

    const dirFactor = sort.dir === 'asc' ? 1 : -1
    if (sort.key === 'provider') {
      result = result.sort((a, b) => dirFactor * a.cred.providerId.localeCompare(b.cred.providerId))
    }
    if (sort.key === 'name') {
      result = result.map((g) => ({
        ...g,
        models: g.models.slice().sort((a, b) => dirFactor * a.label.localeCompare(b.label)),
      }))
    }
    if (sort.key === 'price') {
      result = result.map((g) => ({
        ...g,
        models: g.models.slice().sort((a, b) => dirFactor * (sortPrice(a) - sortPrice(b))),
      }))
    }
    const t1 = performance.now()
    console.log(`[ModelPicker] groups useMemo: ${(t1 - t0).toFixed(1)}ms, ${result.reduce((n, g) => n + g.models.length, 0)} models`)
    return result
  }, [credentials, modelsByCred, query, sort])

  // Flatten the visible models for keyboard navigation + option ids.
  const { flat, optionByKey } = useMemo(() => {
    const t0 = performance.now()
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
    const t1 = performance.now()
    console.log(`[ModelPicker] flat useMemo: ${(t1 - t0).toFixed(1)}ms, ${flat.length} items`)
    return { flat, optionByKey }
  }, [groups, baseId])

  const activeEntry =
    (activeKey != null ? optionByKey.get(activeKey) : undefined) ?? flat[0] ?? null
  const activeOptionId = activeEntry?.optionId

  const q = query.trim().toLowerCase()
  const hasMatches = flat.length > 0
  const showEmpty = q !== '' && !hasMatches

  const isEmptyState = !credentialsLoaded || credentials.length === 0

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
    openTimeRef.current = performance.now()
    console.log('[ModelPicker] openMenu clicked at', openTimeRef.current.toFixed(1))
    setQuery('')
    setActiveKey(value ? choiceKey(value.credentialId, value.modelId) : null)
    setOpen(true)
    onOpen?.()
  }

  const closeMenu = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  /** Average price for sorting — models without pricing sort to the bottom. */
  function sortPrice(model: AiModel): number {
    if (!model.pricing) return Infinity
    return (model.pricing.inputPerMTok + model.pricing.outputPerMTok) / 2
  }

  function toggle() {
    if (open) closeMenu()
    else openMenu()
  }

  const credentialsRef = useRef(credentials)
  credentialsRef.current = credentials

  const pick = useCallback((credentialId: string, modelId: string) => {
    closeMenu()
    onChange({ credentialId, modelId })
    // Persist to recents
    const cred = credentialsRef.current.find((c) => c.id === credentialId)
    const model = (modelsByCredRef.current[credentialId] ?? []).find((m) => m.id === modelId)
    if (cred && model) {
      const ref: StoredModelRef = { credentialId, modelId, label: model.label, providerId: cred.providerId }
      setRecents((prev) => {
        const next = [ref, ...prev.filter((r) => !(r.credentialId === credentialId && r.modelId === modelId))].slice(0, 3)
        saveRecents(next)
        return next
      })
    }
    requestAnimationFrame(() => triggerRef.current?.focus())
  }, [onChange, closeMenu])

  const toggleFavorite = useCallback((credentialId: string, modelId: string) => {
    const key = choiceKey(credentialId, modelId)
    setFavorites((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveFavorites(next)
      return next
    })
  }, [])

  function toggleSection(key: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveCollapsed(next)
      return next
    })
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
    <>
      {isEmptyState ? (
        <output className={cn(className, styles.staticState)}>
          {!credentialsLoaded ? 'Loading credentials…' : 'No credentials yet'}
        </output>
      ) : (
        <div className={cn(className, styles.root)}>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size={variant === 'field' ? 'md' : 'xs'}
            align={variant === 'field' ? 'between' : 'center'}
            fullWidth={variant === 'field'}
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
              side="top"
              offset={6}
              minWidth={variant === 'field' ? 300 : 340}
              width={menuSize.width > 0 ? menuSize.width : undefined}
              maxWidth={MAX_MENU_WIDTH}
              matchAnchorWidth={menuSize.width === 0 && variant === 'field'}
              maxHeight={menuSize.height}
              ariaLabel={ariaLabel}
              onClose={closeMenu}
              header={(
                <div className={styles.menuHeaderWrap}>
                  {searchEnabled && (
                    <>
                      <div className={styles.searchRow}>
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
                        <Button
                          type="button"
                          variant="ghost"
                          size="micro"
                          iconOnly
                          pressed={sortPanelOpen}
                          onClick={() => setSortPanelOpen((v) => !v)}
                          className={styles.sortTrigger}
                          title="Sort models"
                          aria-label="Sort models"
                          aria-expanded={sortPanelOpen}
                        >
                          <SlidersHorizontalIcon size={14} />
                        </Button>
                      </div>
                      <div
                        className={cn(styles.sortPanel, sortPanelOpen && styles.sortPanelOpen)}
                        aria-hidden={!sortPanelOpen}
                      >
                        <div className={styles.sortPanelInner}>
                          {[
                            { key: 'default' as const, label: 'Default' },
                            { key: 'price' as const, label: 'Price' },
                            { key: 'provider' as const, label: 'Provider' },
                            { key: 'name' as const, label: 'Name' },
                          ].map((opt) => {
                            const active = sort.key === opt.key
                            const isAsc = active && sort.dir === 'asc'
                            return (
                              <Button
                                key={opt.key}
                                type="button"
                                variant="ghost"
                                size="micro"
                                pressed={active}
                                onClick={() => {
                                  setSort((prev) => ({
                                    key: opt.key,
                                    dir: prev.key === opt.key && prev.dir === 'asc' ? 'desc' : 'asc',
                                  }))
                                  setActiveKey(null)
                                }}
                                className={styles.sortButton}
                              >
                                {opt.label}
                                {active && (
                                  <span className={styles.sortChevron}>
                                    {isAsc ? <ChevronUpIcon size={10} /> : <ChevronDownIcon size={10} />}
                                  </span>
                                )}
                              </Button>
                            )
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
              footer={(
                <div className={styles.resizeOverlay} aria-hidden="true">
                  <div className={cn(styles.resizeEdge, styles.resizeEdgeN)} onMouseDown={startResize('n')} />
                  <div className={cn(styles.resizeEdge, styles.resizeEdgeE)} onMouseDown={startResize('e')} />
                  <div className={cn(styles.resizeCorner, styles.resizeCornerNE)} onMouseDown={startResize('ne')} />
                </div>
              )}
            >
              {showEmpty ? (
                <div className={styles.emptyOption} role="presentation">
                  No matches
                </div>
              ) : (
                <>
                  {q === '' && favorites.size > 0 && (() => {
                    const favModels: Array<{ cred: CredentialView; model: AiModel; key: string }> = []
                    for (const cred of credentials) {
                      for (const model of (modelsByCred[cred.id] ?? [])) {
                        const key = choiceKey(cred.id, model.id)
                        if (favorites.has(key)) {
                          favModels.push({ cred, model, key })
                        }
                      }
                    }
                    if (favModels.length === 0) return null
                    const favCollapsed = collapsedSections.has('favourites')
                    return (
                      <>
                        <button
                          key="favs:header"
                          type="button"
                          className={styles.sectionToggle}
                          onClick={() => toggleSection('favourites')}
                          aria-expanded={!favCollapsed}
                        >
                          <span className={cn(styles.sectionIcon, favCollapsed && styles.sectionIconCollapsed)}>
                            <ChevronDownIcon size={10} />
                          </span>
                          <span className={styles.groupHeader}>Favourites</span>
                        </button>
                        {!favCollapsed && favModels.map(({ cred, model, key }) => (
                          <ModelRow
                            key={`fav:${key}`}
                            credentialId={cred.id}
                            model={model}
                            isSelected={value?.credentialId === cred.id && value?.modelId === model.id}
                            isActive={value?.credentialId === cred.id && value?.modelId === model.id}
                            isFavorite={true}
                            onPick={pick}
                            onToggleFavorite={toggleFavorite}
                            onHover={setActiveKey}
                          />
                        ))}
                        {!favCollapsed && <ContextMenuSeparator key="favs:sep" />}
                      </>
                    )
                  })()}

                  {q === '' && recents.length > 0 && (() => {
                    const recentCollapsed = collapsedSections.has('recents')
                    return (
                      <>
                        <button
                          key="recents:header"
                          type="button"
                          className={styles.sectionToggle}
                          onClick={() => toggleSection('recents')}
                          aria-expanded={!recentCollapsed}
                        >
                          <span className={cn(styles.sectionIcon, recentCollapsed && styles.sectionIconCollapsed)}>
                            <ChevronDownIcon size={10} />
                          </span>
                          <span className={styles.groupHeader}>Recents</span>
                        </button>
                        {!recentCollapsed && recents.map((ref) => {
                          const model = (modelsByCred[ref.credentialId] ?? []).find((m) => m.id === ref.modelId)
                          if (!model) return null
                          const key = choiceKey(ref.credentialId, ref.modelId)
                          return (
                            <ModelRow
                              key={`recent:${key}`}
                              credentialId={ref.credentialId}
                              model={model}
                              isSelected={value?.credentialId === ref.credentialId && value?.modelId === ref.modelId}
                              isActive={value?.credentialId === ref.credentialId && value?.modelId === ref.modelId}
                              isFavorite={favorites.has(key)}
                              onPick={pick}
                              onToggleFavorite={toggleFavorite}
                              onHover={setActiveKey}
                            />
                          )
                        })}
                        {!recentCollapsed && <ContextMenuSeparator key="recents:sep" />}
                      </>
                    )
                  })()}

                  {groups.map((group, groupIndex) => {
                    const credentialId = group.cred.id
                    const groupCollapsed = collapsedSections.has(`group-${credentialId}`)
                    return (
                      <Fragment key={credentialId}>
                        {groupIndex > 0 && <ContextMenuSeparator key={`sep-${credentialId}`} />}
                        <button
                          type="button"
                          className={styles.sectionToggle}
                          onClick={() => toggleSection(`group-${credentialId}`)}
                          aria-expanded={!groupCollapsed}
                        >
                          <span className={cn(styles.sectionIcon, groupCollapsed && styles.sectionIconCollapsed)}>
                            <ChevronDownIcon size={10} />
                          </span>
                          <span className={styles.groupHeader}>
                            {group.cred.displayLabel}
                            <span className={styles.groupProvider}> · {group.cred.providerId}</span>
                          </span>
                        </button>
                        {!groupCollapsed && (
                          group.models.length === 0 ? (
                            <ContextMenuItem key={`${credentialId}:loading`} disabled>
                              <span>{group.loaded ? 'No models available' : 'Loading models…'}</span>
                            </ContextMenuItem>
                          ) : (
                            group.models.map((model) => {
                              const key = choiceKey(credentialId, model.id)
                              const entry = optionByKey.get(key)
                              return (
                                <ModelRow
                                  key={key}
                                  credentialId={credentialId}
                                  model={model}
                                  optionId={entry?.optionId}
                                  isSelected={value?.credentialId === credentialId && value?.modelId === model.id}
                                  isActive={entry?.optionId === activeOptionId}
                                  isFavorite={favorites.has(key)}
                                  onPick={pick}
                                  onToggleFavorite={toggleFavorite}
                                  onHover={setActiveKey}
                                />
                              )
                            })
                          )
                        )}
                      </Fragment>
                    )
                  })}

                </>
              )}
            </ContextMenu>
          )}
        </div>
      )}
    </>
  )
}
