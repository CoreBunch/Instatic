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
import { ChevronUpIcon } from 'pixel-art-icons/icons/chevron-up'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { Tooltip } from '@ui/components/Tooltip'
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

function loadMenuSize(): MenuSize {
  try {
    const raw = localStorage.getItem(MENU_SIZE_KEY)
    if (raw) return JSON.parse(raw) as MenuSize
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
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [sortPanelOpen, setSortPanelOpen] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => loadCollapsed())
  const [menuSize, setMenuSize] = useState<MenuSize>(() => loadMenuSize())

  // Clean up pending hover-leave timer on unmount.
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    }
  }, [])

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

  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const menuEl = menuElRef.current
    if (!menuEl) return
    isResizingRef.current = true
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      width: menuEl.offsetWidth,
      height: menuEl.offsetHeight,
    }
    document.addEventListener('mousemove', handleResizeMove)
    document.addEventListener('mouseup', handleResizeUp)
  }

  function handleResizeMove(e: MouseEvent) {
    if (!isResizingRef.current) return
    const menuEl = menuElRef.current
    if (!menuEl) return
    const dx = e.clientX - dragStartRef.current.x
    const dy = e.clientY - dragStartRef.current.y
    const newWidth = Math.max(280, dragStartRef.current.width + dx)
    const newHeight = Math.max(180, dragStartRef.current.height + dy)
    menuEl.style.setProperty('--context-menu-width', `${newWidth}px`)
    menuEl.style.setProperty('--context-menu-max-height', `${newHeight}px`)
  }

  function handleResizeUp() {
    if (!isResizingRef.current) return
    isResizingRef.current = false
    document.removeEventListener('mousemove', handleResizeMove)
    document.removeEventListener('mouseup', handleResizeUp)
    const menuEl = menuElRef.current
    if (menuEl) {
      const next = { width: menuEl.offsetWidth, height: menuEl.offsetHeight }
      setMenuSize(next)
      saveMenuSize(next)
    }
  }

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

  // Domino reveal — items fade/slide in as they enter the scroll viewport.
  // Uses MutationObserver to auto-discover new rows as models load, plus
  // IntersectionObserver to trigger the reveal only when they scroll into view.
  const revealObserverRef = useRef<IntersectionObserver | null>(null)
  const mutationObserverRef = useRef<MutationObserver | null>(null)
  const lastIntersectTime = useRef<number>(0)

  useEffect(() => {
    if (!open) return

    let active = true
    const timer = setTimeout(() => {
      if (!active) return
      const menuEl = menuElRef.current
      if (!menuEl) return
      const scrollBox = menuEl.querySelector('[data-scrollable]') as HTMLElement | null
      if (!scrollBox) return

      // Reveal an element: instantly if already visible, otherwise via animation.
      function revealItem(el: Element, instant: boolean) {
        if (el.classList.contains(styles.dominoRevealed)) return
        if (instant) el.classList.add(styles.dominoFast)
        el.classList.add(styles.dominoRevealed)
      }

      // Set up IntersectionObserver on the scroll box.
      const io = new IntersectionObserver(
        (entries) => {
          const now = performance.now()
          const delta = now - lastIntersectTime.current
          lastIntersectTime.current = now
          const fastScroll = delta < 50
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return
            revealItem(entry.target, fastScroll)
            io.unobserve(entry.target)
          })
        },
        { root: scrollBox, threshold: 0, rootMargin: '40px 0px' },
      )
      revealObserverRef.current = io

      // Observe any existing rows and reveal ones already in viewport.
      const observeRow = (el: Element) => {
        if (el.classList.contains(styles.dominoRevealed)) return
        const sRect = scrollBox.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        const alreadyVisible = r.top >= sRect.top && r.bottom <= sRect.bottom + 40
        if (alreadyVisible) {
          revealItem(el, true)
        } else {
          io.observe(el)
        }
      }

      scrollBox.querySelectorAll(`.${styles.rowGrid}`).forEach(observeRow)

      // Watch for new rows being added (models loading async into the portal).
      const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          Array.from(m.addedNodes).forEach((node) => {
            if (!(node instanceof HTMLElement)) return
            if (node.classList.contains(styles.rowGrid)) {
              observeRow(node)
            }
            node.querySelectorAll(`.${styles.rowGrid}`).forEach(observeRow)
          })
        }
      })
      mo.observe(scrollBox, { childList: true, subtree: true })
      mutationObserverRef.current = mo
    }, 80)

    return () => {
      active = false
      clearTimeout(timer)
      revealObserverRef.current?.disconnect()
      revealObserverRef.current = null
      mutationObserverRef.current?.disconnect()
      mutationObserverRef.current = null
    }
  }, [open])

  if (!credentialsLoaded || credentials.length === 0) {
    return (
      <output className={cn(className, styles.staticState)}>
        {!credentialsLoaded ? 'Loading credentials…' : 'No credentials yet'}
      </output>
    )
  }

  // ── Grouping + filtering ──────────────────────────────────────────────
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

  let groups = credentials
    .map((cred) => ({
      cred,
      models: (modelsByCred[cred.id] ?? []).filter((m) => matches(cred, m)),
      loaded: Boolean(modelsByCred[cred.id]),
    }))
    // While searching, hide groups with no matching models. With no query,
    // keep every group (including still-loading ones).
    .filter((g) => (q === '' ? true : g.models.length > 0))

  // Apply user-chosen sort + direction.
  const dirFactor = sort.dir === 'asc' ? 1 : -1
  if (sort.key === 'provider') {
    groups = groups.sort((a, b) => dirFactor * a.cred.providerId.localeCompare(b.cred.providerId))
  }
  if (sort.key === 'name') {
    groups = groups.map((g) => ({
      ...g,
      models: g.models.slice().sort((a, b) => dirFactor * a.label.localeCompare(b.label)),
    }))
  }
  if (sort.key === 'price') {
    groups = groups.map((g) => ({
      ...g,
      models: g.models.slice().sort((a, b) => dirFactor * (sortPrice(a) - sortPrice(b))),
    }))
  }

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
    setQuery('')
    setActiveKey(value ? choiceKey(value.credentialId, value.modelId) : null)
    setOpen(true)
    onOpen?.()
  }

  function closeMenu() {
    setOpen(false)
    setQuery('')
  }

  /** Average price for sorting — models without pricing sort to the bottom. */
  function sortPrice(model: AiModel): number {
    if (!model.pricing) return Infinity
    return (model.pricing.inputPerMTok + model.pricing.outputPerMTok) / 2
  }

  function toggle() {
    if (open) closeMenu()
    else openMenu()
  }

  function pick(credentialId: string, modelId: string) {
    closeMenu()
    onChange({ credentialId, modelId })
    // Persist to recents
    const cred = credentials.find((c) => c.id === credentialId)
    const model = (modelsByCred[credentialId] ?? []).find((m) => m.id === modelId)
    if (cred && model) {
      const ref: StoredModelRef = { credentialId, modelId, label: model.label, providerId: cred.providerId }
      setRecents((prev) => {
        const next = [ref, ...prev.filter((r) => !(r.credentialId === credentialId && r.modelId === modelId))].slice(0, 3)
        saveRecents(next)
        return next
      })
    }
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function toggleFavorite(credentialId: string, modelId: string) {
    const key = choiceKey(credentialId, modelId)
    setFavorites((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveFavorites(next)
      return next
    })
  }

  function handleMouseEnter(key: string) {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
    setHoveredKey(key)
  }

  function toggleSection(key: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveCollapsed(next)
      return next
    })
  }

  function handleMouseLeave() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(() => {
      setHoveredKey(null)
      hoverTimerRef.current = null
    }, 150)
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
          side="auto"
          offset={6}
          minWidth={variant === 'field' ? 300 : 340}
          width={menuSize.width > 0 ? menuSize.width : undefined}
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
        >
          {showEmpty ? (
            <div className={styles.emptyOption} role="presentation">
              No matches
            </div>
          ) : (
            (() => {
              const out: ReactNode[] = []

              // ── Favourites ─────────────────────────────────────────────
              if (q === '' && favorites.size > 0) {
                const favModels: Array<{ cred: CredentialView; model: AiModel; key: string }> = []
                for (const cred of credentials) {
                  for (const model of (modelsByCred[cred.id] ?? [])) {
                    const key = choiceKey(cred.id, model.id)
                    if (favorites.has(key)) {
                      favModels.push({ cred, model, key })
                    }
                  }
                }
                if (favModels.length > 0) {
                  const favCollapsed = collapsedSections.has('favourites')
                  out.push(
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
                    </button>,
                  )
                  if (!favCollapsed) {
                    for (const { cred, model, key } of favModels) {
                      const isSelected = value?.credentialId === cred.id && value?.modelId === model.id
                      const showFav = hoveredKey === `fav:${key}`
                      const priceLabel = formatModelPrice(model)
                      const contextLabel = formatContextWindow(model.contextWindow)
                      out.push(
                        <ContextMenuItem
                          key={`fav:${key}`}
                          className={styles.rowGrid}
                          role="menuitemradio"
                          aria-checked={isSelected}
                          active={isSelected}
                          onMouseEnter={() => {
                            setActiveKey(key)
                            handleMouseEnter(`fav:${key}`)
                          }}
                          onMouseLeave={handleMouseLeave}
                          onClick={() => pick(cred.id, model.id)}
                        >
                          <Tooltip
                            content={<span className={styles.modelNameTooltip}>{model.label}</span>}
                            side="top"
                            openDelay={300}
                          >
                            <span className={styles.modelLabel}>{model.label}</span>
                          </Tooltip>
                          <span className={styles.favWrap}>
                            {!showFav && <span className={styles.favStar} aria-hidden="true">★</span>}
                            {showFav && (
                              <button
                                type="button"
                                className={cn(styles.favButton, styles.favButtonActive)}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  toggleFavorite(cred.id, model.id)
                                }}
                                title="Remove favorite"
                              >
                                ★
                              </button>
                            )}
                          </span>
                          <Tooltip
                            content={model.pricing ? (
                              <div>
                                <span className={styles.priceTooltipNote}>Price per 1M tokens</span>
                                <span className={styles.priceTooltipRow}>
                                  <span>Input</span>
                                  <span>{formatPerMTok(model.pricing.inputPerMTok)}</span>
                                </span>
                                <span className={styles.priceTooltipRow}>
                                  <span>Output</span>
                                  <span>{formatPerMTok(model.pricing.outputPerMTok)}</span>
                                </span>
                                <span className={cn(styles.priceTooltipRow, styles.priceTooltipTotal)}>
                                  <span>Total</span>
                                  <span>{formatPerMTok(model.pricing.inputPerMTok + model.pricing.outputPerMTok)}</span>
                                </span>
                              </div>
                            ) : priceLabel ?? '\u00A0'}
                            side="top"
                            openDelay={300}
                          >
                            <span className={styles.modelPrice}>{priceLabel ?? '\u00A0'}</span>
                          </Tooltip>
                          <Tooltip content="Context window" side="top" openDelay={300}>
                            <span className={styles.modelContext}>{contextLabel ?? '\u00A0'}</span>
                          </Tooltip>
                        </ContextMenuItem>,
                      )
                    }
                    out.push(<ContextMenuSeparator key="favs:sep" />)
                  }
                }
              }

              // ── Recents ──────────────────────────────────────────────
              if (q === '' && recents.length > 0) {
                const recentCollapsed = collapsedSections.has('recents')
                out.push(
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
                  </button>,
                )
                if (!recentCollapsed) {
                  for (const ref of recents) {
                    const model = (modelsByCred[ref.credentialId] ?? []).find((m) => m.id === ref.modelId)
                    if (!model) continue
                    const key = choiceKey(ref.credentialId, ref.modelId)
                    const isSelected = value?.credentialId === ref.credentialId && value?.modelId === ref.modelId
                    const isFavorite = favorites.has(key)
                    const showFav = hoveredKey === `recent:${key}`
                    const priceLabel = formatModelPrice(model)
                    const contextLabel = formatContextWindow(model.contextWindow)
                    out.push(
                      <ContextMenuItem
                        key={`recent:${key}`}
                        className={styles.rowGrid}
                        role="menuitemradio"
                        aria-checked={isSelected}
                        active={isSelected}
                        onMouseEnter={() => {
                          setActiveKey(key)
                          handleMouseEnter(`recent:${key}`)
                        }}
                        onMouseLeave={handleMouseLeave}
                        onClick={() => pick(ref.credentialId, ref.modelId)}
                      >
                        <Tooltip
                          content={<span className={styles.modelNameTooltip}>{model.label}</span>}
                          side="top"
                          openDelay={300}
                        >
                          <span className={styles.modelLabel}>{model.label}</span>
                        </Tooltip>
                        <span className={styles.favWrap}>
                          {isFavorite && !showFav && <span className={styles.favStar} aria-hidden="true">★</span>}
                          {showFav && (
                            <button
                              type="button"
                              className={cn(styles.favButton, isFavorite && styles.favButtonActive)}
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleFavorite(ref.credentialId, ref.modelId)
                              }}
                              title={isFavorite ? 'Remove favorite' : 'Add favorite'}
                            >
                              {isFavorite ? '★' : '☆'}
                            </button>
                          )}
                        </span>
                        <Tooltip
                          content={model.pricing ? (
                            <div>
                              <span className={styles.priceTooltipNote}>Price per 1M tokens</span>
                              <span className={styles.priceTooltipRow}>
                                <span>Input</span>
                                <span>{formatPerMTok(model.pricing.inputPerMTok)}</span>
                              </span>
                              <span className={styles.priceTooltipRow}>
                                <span>Output</span>
                                <span>{formatPerMTok(model.pricing.outputPerMTok)}</span>
                              </span>
                              <span className={cn(styles.priceTooltipRow, styles.priceTooltipTotal)}>
                                <span>Total</span>
                                <span>{formatPerMTok(model.pricing.inputPerMTok + model.pricing.outputPerMTok)}</span>
                              </span>
                            </div>
                          ) : priceLabel ?? '\u00A0'}
                          side="top"
                          openDelay={300}
                        >
                          <span className={styles.modelPrice}>{priceLabel ?? '\u00A0'}</span>
                        </Tooltip>
                        <Tooltip content="Context window" side="top" openDelay={300}>
                          <span className={styles.modelContext}>{contextLabel ?? '\u00A0'}</span>
                        </Tooltip>
                      </ContextMenuItem>,
                    )
                  }
                  out.push(<ContextMenuSeparator key="recents:sep" />)
                }
              }

              // ── Groups ───────────────────────────────────────────────
              groups.forEach((group, groupIndex) => {
                const credentialId = group.cred.id
                if (groupIndex > 0) {
                  out.push(<ContextMenuSeparator key={`sep-${credentialId}`} />)
                }
                const groupCollapsed = collapsedSections.has(`group-${credentialId}`)
                out.push(
                  <button
                    key={`${credentialId}:header`}
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
                  </button>,
                )
                if (!groupCollapsed) {
                  if (group.models.length === 0) {
                    out.push(
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
                      const isFavorite = favorites.has(key)
                      const showFav = hoveredKey === `group:${key}`
                      const priceLabel = formatModelPrice(model)
                      const contextLabel = formatContextWindow(model.contextWindow)
                      out.push(
                        <ContextMenuItem
                          key={key}
                          id={entry?.optionId}
                          className={styles.rowGrid}
                          role="menuitemradio"
                          aria-checked={isSelected}
                          active={entry?.optionId === activeOptionId}
                          onMouseEnter={() => {
                            setActiveKey(key)
                            handleMouseEnter(`group:${key}`)
                          }}
                          onMouseLeave={handleMouseLeave}
                          onClick={() => pick(credentialId, model.id)}
                        >
                          <Tooltip
                            content={<span className={styles.modelNameTooltip}>{model.label}</span>}
                            side="top"
                            openDelay={300}
                          >
                            <span className={styles.modelLabel}>{model.label}</span>
                          </Tooltip>
                          <span className={styles.favWrap}>
                            {isFavorite && !showFav && <span className={styles.favStar} aria-hidden="true">★</span>}
                            {showFav && (
                              <button
                                type="button"
                                className={cn(styles.favButton, isFavorite && styles.favButtonActive)}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  toggleFavorite(credentialId, model.id)
                                }}
                                title={isFavorite ? 'Remove favorite' : 'Add favorite'}
                              >
                                {isFavorite ? '★' : '☆'}
                              </button>
                            )}
                          </span>
                          <Tooltip
                            content={model.pricing ? (
                              <div>
                                <span className={styles.priceTooltipNote}>Price per 1M tokens</span>
                                <span className={styles.priceTooltipRow}>
                                  <span>Input</span>
                                  <span>{formatPerMTok(model.pricing.inputPerMTok)}</span>
                                </span>
                                <span className={styles.priceTooltipRow}>
                                  <span>Output</span>
                                  <span>{formatPerMTok(model.pricing.outputPerMTok)}</span>
                                </span>
                                <span className={cn(styles.priceTooltipRow, styles.priceTooltipTotal)}>
                                  <span>Total</span>
                                  <span>{formatPerMTok(model.pricing.inputPerMTok + model.pricing.outputPerMTok)}</span>
                                </span>
                              </div>
                            ) : priceLabel ?? '\u00A0'}
                            side="top"
                            openDelay={300}
                          >
                            <span className={styles.modelPrice}>{priceLabel ?? '\u00A0'}</span>
                          </Tooltip>
                          <Tooltip content="Context window" side="top" openDelay={300}>
                            <span className={styles.modelContext}>{contextLabel ?? '\u00A0'}</span>
                          </Tooltip>
                        </ContextMenuItem>,
                      )
                    }
                  }
                }
              })

              // ── Resize handle ──────────────────────────────────────
              out.push(
                <div
                  key="resize-handle"
                  className={styles.resizeHandle}
                  onMouseDown={startResize}
                  title="Resize menu"
                  aria-hidden="true"
                >
                  <div className={styles.resizeGrip} />
                </div>,
              )

              return out
            })()
          )}
        </ContextMenu>
      )}
    </div>
  )
}
