import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import { selectSelectedNode, useEditorStore } from '@site/store/store'
import { classifySelectorCreateInput, styleRuleSelector } from '@core/page-tree'
import { generatedClassKindLabel, isGeneratedClass, isGeneratedClassLocked } from '@core/page-tree'
import type { StyleRule } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { EmptyState } from '@ui/components/EmptyState'
import { FilterBar, type FilterBarItem } from '@ui/components/FilterBar'
import { Skeleton } from '@ui/components/Skeleton'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { Panel, type DockablePanelProps } from '@admin/shared/Panel'
import { cn } from '@ui/cn'
import { DeleteSelectorDialog, SelectorNameDialog } from '../SelectorDialogs'
import { SelectorContextMenu } from './SelectorContextMenu'
import {
  buildClassTokenUsageMap,
  buildSelectorUsageMap,
  getReusableClasses,
  getSelectorStyleSummary,
  normalizeSelectorQuery,
  resolveSelectorUsage,
  selectorMatchesQuery,
} from '../selectorUsage'
import styles from './SelectorsPanel.module.css'

type SelectorsPanelProps = DockablePanelProps

type SelectorFilter = 'all' | 'user' | 'utility' | 'unused'

/**
 * How many selector rows to mount per batch. A generated framework (e.g. the
 * `text/bg/border-<token>-<step>` utility set) can produce many hundreds of
 * rules; mounting them all in one synchronous frame is what made the panel lag
 * on open. We render the first batch, then reveal the next as the user scrolls
 * a sentinel into view.
 */
const SELECTOR_PAGE_SIZE = 100

/** Placeholder rows shown on the first paint after the panel opens. */
const SKELETON_ROW_COUNT = 10

const SELECTOR_FILTER_ITEMS: FilterBarItem<SelectorFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'user', label: 'User' },
  { value: 'utility', label: 'Utility' },
  { value: 'unused', label: 'Unused' },
]

interface ContextMenuState {
  x: number
  y: number
  classId: string
}

function keyboardMenuPosition(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left + Math.min(rect.width - 8, 24),
    y: rect.top + Math.min(rect.height - 8, 24),
  }
}

function getEmptyFilterMessage(filter: SelectorFilter, query: string): string {
  const normalized = query.trim()
  if (normalized) return `No selectors match “${normalized}”.`
  if (filter === 'user') return 'No user selectors yet.'
  if (filter === 'utility') return 'No utility selectors yet.'
  if (filter === 'unused') return 'No unused selectors — every selector is in use.'
  return 'No selectors match the current filters.'
}

export function SelectorsPanel({
  mode = 'docked',
  dragHandleProps,
  onToggleMode,
}: SelectorsPanelProps) {
  const site = useEditorStore((s) => s.site)
  const isOpen = useEditorStore((s) => s.selectorsPanelOpen)
  const selectedSelectorClassId = useEditorStore((s) => s.selectedSelectorClassId)
  const selectedSelectorClassIds = useEditorStore(useShallow((s) => s.selectedSelectorClassIds))
  const setSelectorsPanelOpen = useEditorStore((s) => s.setSelectorsPanelOpen)
  const setSelectedSelectorClassId = useEditorStore((s) => s.setSelectedSelectorClassId)
  const setHighlightedSelectorClassId = useEditorStore((s) => s.setHighlightedSelectorClassId)
  const toggleSelectorMultiSelect = useEditorStore((s) => s.toggleSelectorMultiSelect)
  const setSelectedSelectorClassIds = useEditorStore((s) => s.setSelectedSelectorClassIds)
  const clearSelectorMultiSelect = useEditorStore((s) => s.clearSelectorMultiSelect)
  const setActiveClass = useEditorStore((s) => s.setActiveClass)
  const setPropertiesPanel = useEditorStore((s) => s.setPropertiesPanel)
  const setFocusedPanel = useEditorStore((s) => s.setFocusedPanel)
  const createClass = useEditorStore((s) => s.createClass)
  const createAmbientRule = useEditorStore((s) => s.createAmbientRule)
  const renameClass = useEditorStore((s) => s.renameClass)
  const duplicateClass = useEditorStore((s) => s.duplicateClass)
  const deleteClass = useEditorStore((s) => s.deleteClass)
  const addNodeClass = useEditorStore((s) => s.addNodeClass)
  const removeNodeClass = useEditorStore((s) => s.removeNodeClass)
  const selectedNode = useEditorStore(selectSelectedNode)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const activeClassId = useEditorStore((s) => s.activeClassId)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SelectorFilter>('all')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<StyleRule | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<StyleRule | null>(null)
  const [visibleCount, setVisibleCount] = useState(SELECTOR_PAGE_SIZE)
  // Tracks the inputs that define a "fresh" result set; when they change we
  // reset the visible window back to the first batch during render (React's
  // recommended alternative to a setState-in-effect, which avoids the extra
  // commit + cascading-render the lint rule flags).
  const [listResetKey, setListResetKey] = useState('')

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const reusableClasses = getReusableClasses(site?.styleRules ?? {})
  // One pass over the whole tree, memoized against `site` by the React Compiler.
  // Replaces a per-row scan that scaled with selector count × node count.
  const usageMap = buildSelectorUsageMap(site)
  // Class-token → applied-count rollup, so ambient rows can report "Unused"
  // only when provably dead (anchored on a class nothing uses) instead of the
  // blanket "Unused" the per-id tally produced for every ambient rule.
  const classTokenUsage = buildClassTokenUsageMap(site?.styleRules ?? {}, usageMap)
  const normalizedQuery = normalizeSelectorQuery(query)
  const selectedIdSet = new Set(selectedSelectorClassIds)
  const selecting = selectedSelectorClassIds.length > 0
  const filteredClasses = reusableClasses.filter((cls) => {
    if (filter === 'user' && isGeneratedClass(cls)) return false
    if (filter === 'utility' && !isGeneratedClass(cls)) return false
    if (filter === 'unused' && !resolveSelectorUsage(cls, usageMap, classTokenUsage).unused)
      return false
    // Search matches the selector name AND its declared CSS (property names and
    // `name: value` pairs) so users can hunt by style, not just by name.
    if (!selectorMatchesQuery(cls, normalizedQuery)) return false
    return true
  })

  // New filter / search / re-open → start again at the first batch.
  const resetKey = `${isOpen}|${filter}|${normalizedQuery}`
  if (resetKey !== listResetKey) {
    setListResetKey(resetKey)
    setVisibleCount(SELECTOR_PAGE_SIZE)
  }

  const effectiveVisibleCount = resetKey === listResetKey ? visibleCount : SELECTOR_PAGE_SIZE
  const allFilteredSelected =
    filteredClasses.length > 0 && filteredClasses.every((cls) => selectedIdSet.has(cls.id))
  const visibleClasses = filteredClasses.slice(0, effectiveVisibleCount)
  const hasMore = filteredClasses.length > visibleClasses.length
  const selectedClass = reusableClasses.find((cls) => cls.id === selectedSelectorClassId) ?? null
  const contextClass = contextMenu ? site?.styleRules[contextMenu.classId] ?? null : null

  // The selector the Properties panel is currently editing. Mirrors that
  // panel's priority: an explicitly-selected selector wins, otherwise it's the
  // active class of the selected layer. Highlighting this row keeps the
  // Selectors panel in sync with whatever rule the user is actually styling.
  const activeSelectorClassId = selectedSelectorClassId ?? (selectedNodeId ? activeClassId : null)

  // The panel stays mounted and returns null while closed, so opening it is a
  // re-render rather than a remount. `deferredOpen` lags `isOpen` by one
  // commit, letting us paint the row skeleton instantly on the urgent frame
  // and stream the real rows in on the deferred follow-up.
  const deferredOpen = useDeferredValue(isOpen)
  const showSkeleton = isOpen && !deferredOpen

  useEffect(() => {
    if (selectedSelectorClassId && !selectedClass) {
      setSelectedSelectorClassId(null)
    }
  }, [selectedSelectorClassId, selectedClass, setSelectedSelectorClassId])

  // Drop the canvas affinity rings whenever the panel closes — the per-row
  // mouseleave never fires if the panel is dismissed while a row is hovered.
  useEffect(() => {
    if (!isOpen) setHighlightedSelectorClassId(null)
  }, [isOpen, setHighlightedSelectorClassId])

  // Reveal the next batch when the tail sentinel scrolls into the panel body.
  useEffect(() => {
    if (!hasMore || showSkeleton) return
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((count) => count + SELECTOR_PAGE_SIZE)
        }
      },
      { root: scrollRef.current, rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, showSkeleton, visibleCount])

  if (!isOpen) return null

  function openContextMenu(classId: string, event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ x: event.clientX, y: event.clientY, classId })
  }

  function openKeyboardContextMenu(classId: string, event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ ...keyboardMenuPosition(event.currentTarget), classId })
  }

  function openSelectorInProperties(classId: string) {
    setSelectedSelectorClassId(classId)
    setActiveClass(classId)
    setPropertiesPanel({ collapsed: false })
    setFocusedPanel('properties')
  }

  function handleToggleSelect(classId: string) {
    const willSelect = !selectedIdSet.has(classId)
    toggleSelectorMultiSelect(classId)
    // Adding to the multi-set opens the bulk inspector; the last removal lets
    // the Properties panel auto-close via its selection-driven open effect.
    if (willSelect) {
      setPropertiesPanel({ collapsed: false })
      setFocusedPanel('properties')
    }
  }

  function handleSelectAllFiltered() {
    // "Select all" respects the active filter + search — it selects exactly the
    // rows currently visible in the list.
    setSelectedSelectorClassIds(filteredClasses.map((cls) => cls.id))
    setPropertiesPanel({ collapsed: false })
    setFocusedPanel('properties')
  }

  function handleCreate(value: string) {
    const intent = classifySelectorCreateInput(value)
    if (intent.kind === 'empty') return
    // createClass/createAmbientRule throw on invalid input; the dialog catches
    // and surfaces the message inline so the user can fix and retry.
    const rule = intent.kind === 'ambient'
      ? createAmbientRule({ selector: intent.selector })
      : createClass(intent.name)
    openSelectorInProperties(rule.id)
    setCreateDialogOpen(false)
  }

  function handleRename(name: string) {
    if (!renameTarget) return
    if (isGeneratedClassLocked(renameTarget)) return
    renameClass(renameTarget.id, name)
    setRenameTarget(null)
  }

  function handleDuplicate(cls: StyleRule) {
    if (isGeneratedClassLocked(cls)) {
      setContextMenu(null)
      return
    }
    const copy = duplicateClass(cls.id)
    if (copy) {
      openSelectorInProperties(copy.id)
    }
    setContextMenu(null)
  }

  function handleApplyToSelected(cls: StyleRule) {
    if (!selectedNodeId) return
    if ((cls.kind ?? 'class') !== 'class') return
    addNodeClass(selectedNodeId, cls.id)
    setContextMenu(null)
  }

  function handleRemoveFromSelected(cls: StyleRule) {
    if (!selectedNodeId) return
    if ((cls.kind ?? 'class') !== 'class') return
    removeNodeClass(selectedNodeId, cls.id)
    setContextMenu(null)
  }

  function handleCopySelector(cls: StyleRule) {
    void navigator.clipboard?.writeText(styleRuleSelector(cls))
    setContextMenu(null)
  }

  function handleDelete(cls: StyleRule) {
    if (isGeneratedClassLocked(cls)) return
    deleteClass(cls.id)
    setDeleteTarget(null)
  }

  return (
    <>
      <Panel
        panelId="selectors"
        title="Selectors"
        testId="selectors-panel"
        bodyRef={scrollRef}
        onClose={() => setSelectorsPanelOpen(false)}
        mode={mode}
        dragHandleProps={dragHandleProps}
        onToggleMode={onToggleMode}
        dockLocation="left sidebar"
      >
        <FilterBar<SelectorFilter>
            items={SELECTOR_FILTER_ITEMS}
            value={filter}
            onValueChange={setFilter}
            search={{
              value: query,
              onValueChange: setQuery,
              onClear: () => setQuery(''),
              placeholder: 'Search selectors',
              ariaLabel: 'Search selectors',
            }}
            searchTrailing={
              <Button
                variant="secondary"
                size="sm"
                iconOnly
                aria-label="Create selector"
                tooltip="Create selector"
                onClick={() => setCreateDialogOpen(true)}
              >
                <PlusIcon size={13} aria-hidden="true" />
              </Button>
            }
            groupLabel="Selector type"
          />

          {showSkeleton ? (
            <SelectorRowsSkeleton />
          ) : reusableClasses.length === 0 ? (
            <EmptyState
              title="No reusable selectors yet."
              action={
                <Button variant="secondary" size="sm" onClick={() => setCreateDialogOpen(true)}>
                  Create selector
                </Button>
              }
            />
          ) : filteredClasses.length === 0 ? (
            <EmptyState title={getEmptyFilterMessage(filter, query)} />
          ) : (
            <div
              className={cn(styles.rows, selecting && styles.rowsSelecting)}
              aria-label="Reusable selectors"
            >
              {visibleClasses.map((cls) => (
                <SelectorRow
                  key={cls.id}
                  cls={cls}
                  active={activeSelectorClassId === cls.id}
                  selected={selectedIdSet.has(cls.id)}
                  selecting={selecting}
                  usage={resolveSelectorUsage(cls, usageMap, classTokenUsage).label}
                  summary={getSelectorStyleSummary(cls)}
                  onSelect={() => openSelectorInProperties(cls.id)}
                  onToggleSelect={() => handleToggleSelect(cls.id)}
                  onContextMenu={(event) => openContextMenu(cls.id, event)}
                  onKeyDown={(event) => openKeyboardContextMenu(cls.id, event)}
                  onHighlight={() => setHighlightedSelectorClassId(cls.id)}
                  onClearHighlight={() => setHighlightedSelectorClassId(null)}
                />
              ))}
              {hasMore && <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />}
            </div>
          )}

          {selecting && (
            <div className={styles.selectionBar} role="group" aria-label="Selection actions">
              <span className={styles.selectionCount}>
                {selectedSelectorClassIds.length} selected
              </span>
              <div className={styles.selectionActions}>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handleSelectAllFiltered}
                  disabled={allFilteredSelected}
                >
                  Select all
                </Button>
                <Button variant="ghost" size="xs" onClick={clearSelectorMultiSelect}>
                  Deselect all
                </Button>
              </div>
            </div>
          )}
      </Panel>

      {contextMenu && contextClass && (
        <SelectorContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          selectedNodeHasClass={Boolean(selectedNode?.classIds?.includes(contextClass.id))}
          selectedNodeId={selectedNodeId}
          assignable={(contextClass.kind ?? 'class') === 'class'}
          onClose={() => setContextMenu(null)}
          onEdit={() => {
            openSelectorInProperties(contextClass.id)
            setContextMenu(null)
          }}
          onRename={() => {
            if (!isGeneratedClassLocked(contextClass)) setRenameTarget(contextClass)
            setContextMenu(null)
          }}
          onDuplicate={() => handleDuplicate(contextClass)}
          onApply={() => handleApplyToSelected(contextClass)}
          onRemove={() => handleRemoveFromSelected(contextClass)}
          onCopy={() => handleCopySelector(contextClass)}
          onDelete={() => {
            if (!isGeneratedClassLocked(contextClass)) setDeleteTarget(contextClass)
            setContextMenu(null)
          }}
          locked={isGeneratedClassLocked(contextClass)}
        />
      )}

      {createDialogOpen && (
        <SelectorNameDialog
          title="Create selector"
          initialValue=""
          submitLabel="Create"
          onCancel={() => setCreateDialogOpen(false)}
          onSubmit={handleCreate}
        />
      )}

      {renameTarget && (
        <SelectorNameDialog
          title="Rename selector"
          initialValue={
            renameTarget.kind === 'ambient'
              ? styleRuleSelector(renameTarget)
              : renameTarget.name
          }
          submitLabel="Save"
          onCancel={() => setRenameTarget(null)}
          onSubmit={handleRename}
          mode={renameTarget.kind === 'ambient' ? 'ambient' : 'class'}
        />
      )}

      {deleteTarget && (
        <DeleteSelectorDialog
          cls={deleteTarget}
          usage={resolveSelectorUsage(deleteTarget, usageMap, classTokenUsage).label}
          onCancel={() => setDeleteTarget(null)}
          onDelete={() => handleDelete(deleteTarget)}
        />
      )}
    </>
  )
}

interface SelectorRowProps {
  cls: StyleRule
  active: boolean
  selected: boolean
  selecting: boolean
  /** Usage badge text, or `null` to render no badge (unassessable ambient rule). */
  usage: string | null
  summary: string
  onSelect: () => void
  onToggleSelect: () => void
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  /** Light up the canvas affinity rings for this selector. */
  onHighlight: () => void
  /** Drop the canvas affinity rings. */
  onClearHighlight: () => void
}

function SelectorRow({
  cls,
  active,
  selected,
  selecting,
  usage,
  summary,
  onSelect,
  onToggleSelect,
  onContextMenu,
  onKeyDown,
  onHighlight,
  onClearHighlight,
}: SelectorRowProps) {
  // Display the rule's full selector. For class-kind rules this resolves to
  // `.<escaped-name>`; for ambient rules it is whatever selector the user or
  // CSS importer wrote (e.g. `h1 > span`, `.hero .title`, `a:hover`).
  const selectorLabel = styleRuleSelector(cls)
  const kindLabel = cls.kind === 'ambient'
    ? 'Ambient'
    : generatedClassKindLabel(cls)

  // The leading slot is a paint-bucket icon at rest; on row hover (or whenever a
  // multi-selection is in progress) it becomes a checkbox so the user can build
  // a bulk set without leaving the panel.
  return (
    <div
      className={styles.row}
      data-selecting={selecting || undefined}
      data-selected={selected || undefined}
      onMouseEnter={onHighlight}
      onMouseLeave={onClearHighlight}
    >
      <span className={styles.rowCheck}>
        <PaintBucketSolidIcon size={13} aria-hidden="true" className={styles.rowCheckIcon} />
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          boxSize="sm"
          className={styles.rowCheckControl}
          aria-label={`Select selector ${selectorLabel}`}
        />
      </span>
      <Button
        variant="ghost"
        size="sm"
        active={active}
        className={styles.rowMain}
        aria-label={`Edit selector ${selectorLabel}`}
        onClick={onSelect}
        onContextMenu={onContextMenu}
        onFocus={onHighlight}
        onBlur={onClearHighlight}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect()
            return
          }
          onKeyDown(event)
        }}
      >
        <span className={styles.rowText}>
          <span className={styles.rowLabel}>{selectorLabel}</span>
          <span className={styles.rowMeta}>{summary}</span>
        </span>
        <span className={styles.rowAside}>
          {kindLabel && <span className={styles.utilityBadge}>{kindLabel}</span>}
          {usage !== null && <span className={styles.rowUsage}>{usage}</span>}
        </span>
      </Button>
    </div>
  )
}

/**
 * Loading placeholder for the selector list. Mirrors `SelectorRow`'s grid
 * (icon · two-line text · trailing badge) so the swap to real rows doesn't
 * shift layout. Painted on the first frame after the panel opens; the real
 * rows stream in on the deferred follow-up render.
 */
function SelectorRowsSkeleton() {
  return (
    <div className={styles.rows} aria-busy="true" aria-label="Loading selectors">
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
        <div key={i} className={styles.skeletonRow} aria-hidden="true">
          <Skeleton width={13} height={13} radius={3} />
          <span className={styles.skeletonRowText}>
            <Skeleton width="55%" height={11} />
            <Skeleton width="32%" height={9} />
          </span>
          <Skeleton width={46} height={16} radius={999} />
        </div>
      ))}
    </div>
  )
}
