import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { registry } from '@core/module-engine'
import { pluginRuntime } from '@core/plugins/runtime'
import type { SavedLayout } from '@core/layouts'
import type { VisualComponent } from '@core/visualComponents'
import type { InsertLocation } from '@site/store/insertLocation'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import {
  getViewportLocalPoint,
  measureCanvasDropCandidates,
} from '@site/canvas/canvasDomGeometry'
import {
  resolveCanvasInsertionTarget,
} from '@site/canvas/canvasDnd'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { Kbd } from '@ui/components/Kbd'
import { SearchBar } from '@ui/components/SearchBar'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { cn } from '@ui/cn'
import { AppGridPlusGlyphIcon } from 'pixel-art-icons/icons/app-grid-plus-glyph'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import { CalendarSolidIcon } from 'pixel-art-icons/icons/calendar-solid'
import { Grid2x22SolidIcon } from 'pixel-art-icons/icons/grid-2x2-2-solid'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { ListBoxSolidIcon } from 'pixel-art-icons/icons/list-box-solid'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import {
  LAYOUT_PRESETS,
} from './insertionPresets'
import {
  buildModuleInserterItems,
  composeLayoutsSection,
  filterInserterItems,
  itemDescription,
  recentRefForItem,
  resolveRecentItems,
  type ModuleInserterItem,
  type ModuleInserterSectionId,
} from './moduleInserterModel'
import {
  readModuleInserterPrefs,
  trackModuleInserterRecent,
  writeModuleInserterView,
  type ModuleInserterRecentRef,
} from './moduleInserterPrefs'
import { findCanvasViewportAtPoint } from './moduleInserterDropTarget'
import { SavedLayoutManageMenu, type SavedLayoutMenuState } from './SavedLayoutManageMenu'
import {
  dropPreviewStyle,
  fixedPreviewForTarget,
  fixedPreviewForViewport,
  ghostStyle,
  type CanvasDropPreview,
  type DragVisualState,
} from './moduleInserterDragPreview'
import {
  scrollSelectedItemIntoView,
  type ModuleInserterSelectionSource,
} from './moduleInserterSelectionScroll'
import {
  ModuleInserterItemButton,
  type InserterView,
  type SectionDefinition,
} from './ModuleInserterItemButton'
import { ModuleInserterShortcuts } from './ModuleInserterShortcuts'
import { ModuleWireframe } from './ModuleWireframe'
import { useModuleInsertionContext } from './useModuleInsertionContext'
import { useModuleInserterPreference } from './useModuleInserterPreference'
import styles from './ModuleInserterDialog.module.css'

interface ModuleInserterDialogProps {
  onClose: () => void
  onInsertItem: (
    item: ModuleInserterItem,
    target: InsertLocation | undefined,
    mode: 'click' | 'drop',
  ) => boolean
}

interface PointerDropResolution {
  location: InsertLocation
  preview: CanvasDropPreview
  breakpointId: string
}

type InserterZone = 'search' | 'grid' | 'rail'

const EMPTY_COMPONENTS: VisualComponent[] = []
const EMPTY_LAYOUTS: SavedLayout[] = []
const SECTIONS: readonly SectionDefinition[] = [
  { id: 'modules', name: 'Modules', accent: 'lilac', icon: AppGridPlusGlyphIcon },
  { id: 'layouts', name: 'Layouts', accent: 'sky', icon: LayoutSolidIcon },
  { id: 'components', name: 'Components', accent: 'mint', icon: BoxStackSolidIcon },
  { id: 'recent', name: 'Recent', accent: 'rose', icon: CalendarSolidIcon },
]

export function ModuleInserterDialog({
  onClose,
  onInsertItem,
}: ModuleInserterDialogProps) {
  const prefs = readModuleInserterPrefs()
  const [query, setQuery] = useState('')
  const [section, setSection] = useState<ModuleInserterSectionId>('modules')
  const [selectedKeyOverride, setSelectedKeyOverride] = useState<string | null>(null)
  const [zone, setZone] = useState<InserterZone>('search')
  const [view, setView] = useState<InserterView>(prefs.view)
  const [recentRefs, setRecentRefs] = useState<ModuleInserterRecentRef[]>(prefs.recent)
  const [drag, setDrag] = useState<DragVisualState | null>(null)
  const [savedLayoutMenu, setSavedLayoutMenu] = useState<SavedLayoutMenuState | null>(null)
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const suppressClickRef = useRef(false)
  const selectionSourceRef = useRef<ModuleInserterSelectionSource>('pointer')

  const visualComponents = useEditorStore((s) => s.site?.visualComponents ?? EMPTY_COMPONENTS)
  const savedLayouts = useEditorStore((s) => s.site?.layouts ?? EMPTY_LAYOUTS)
  const setActiveBreakpoint = useEditorStore((s) => s.setActiveBreakpoint)
  const canvasPage = useEditorStore(selectActiveCanvasPage)
  const insertionContext = useModuleInsertionContext()
  const {
    isFavorite,
    toggleFavorite,
  } = useModuleInserterPreference()

  const {
    moduleItems,
    layoutItems,
    savedLayoutItems,
    componentItems,
    allItems,
  } = buildModuleInserterItems({
    modules: registry.list(),
    context: insertionContext,
    layoutPresets: LAYOUT_PRESETS,
    savedLayouts,
    visualComponents,
  })
  const recentItems = resolveRecentItems(recentRefs, allItems)

  const filteredModules = filterInserterItems(moduleItems, query)
  const filteredSavedLayouts = filterInserterItems(savedLayoutItems, query)
  const filteredLayouts = filterInserterItems(layoutItems, query)
  const filteredComponents = filterInserterItems(componentItems, query)
  const filteredRecent = filterInserterItems(recentItems, query)
  // Layouts section order: the user's saved layouts, one group per plugin
  // (labelled with the plugin's display name), then the built-in presets.
  const layoutsSection = composeLayoutsSection(
    filteredSavedLayouts,
    filteredLayouts,
    (pluginId) => pluginRuntime.getPluginName(pluginId),
  )
  const items = itemsForSection(section, {
    modules: filteredModules,
    layouts: layoutsSection.items,
    components: filteredComponents,
    recent: filteredRecent,
  })

  // Group labels for the Layouts section, keyed by each group's first item.
  const groupLabelByKey = section === 'layouts' ? layoutsSection.labelByKey : new Map<string, string>()
  const selectedKey =
    selectedKeyOverride && items.some((item) => item.key === selectedKeyOverride)
      ? selectedKeyOverride
      : items[0]?.key ?? null
  const selectedItem = items.find((item) => item.key === selectedKey) ?? null
  const selectedSection = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0]
  const sectionCounts = {
    modules: filteredModules.length,
    layouts: layoutsSection.items.length,
    components: filteredComponents.length,
    recent: filteredRecent.length,
  }

  useEffect(() => {
    const id = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    if (zone !== 'search') {
      if (document.activeElement === searchRef.current) searchRef.current?.blur()
      return
    }
    const id = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [zone])

  useEffect(() => {
    const container = scrollRef.current
    const source = selectionSourceRef.current
    selectionSourceRef.current = 'pointer'
    if (!container || !selectedKey) return
    const selected = container.querySelector<HTMLElement>('[data-selected="true"]')
    if (!selected) return
    scrollSelectedItemIntoView(container, selected, source)
  }, [selectedKey, section, query, view])

  // Required because the document keydown effect depends on this function;
  // eslint cannot see the React Compiler's runtime identity stability.
  const pickItem = useCallback((
    item: ModuleInserterItem,
    target: InsertLocation | undefined,
    mode: 'click' | 'drop',
  ): boolean => {
    if (item.disabledReason) return false
    const inserted = onInsertItem(item, target, mode)
    if (!inserted) return false
    trackModuleInserterRecent(recentRefForItem(item))
    setRecentRefs(readModuleInserterPrefs().recent)
    onClose()
    return true
  }, [onClose, onInsertItem])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const key = event.key
      if (key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }

      const columns = view === 'list' ? 1 : 3
      const index = items.findIndex((item) => item.key === selectedKey)
      const current = items[index]
      const sectionIds = SECTIONS.map((item) => item.id)

      function selectIndex(nextIndex: number) {
        const clamped = Math.max(0, Math.min(items.length - 1, nextIndex))
        const next = items[clamped]
        if (next) {
          selectionSourceRef.current = next.key === selectedKey ? 'pointer' : 'keyboard'
          setSelectedKeyOverride(next.key)
        }
      }

      function moveSection(delta: number) {
        const currentIndex = sectionIds.indexOf(section)
        const nextIndex = Math.max(0, Math.min(sectionIds.length - 1, currentIndex + delta))
        const nextSection = sectionIds[nextIndex]
        selectionSourceRef.current = nextSection === section ? 'pointer' : 'keyboard'
        setSection(nextSection)
        setSelectedKeyOverride(null)
      }

      function typeIntoSearch(char: string) {
        setZone('search')
        setQuery((currentQuery) => `${currentQuery}${char}`)
      }

      const isTypeKey =
        key.length === 1 &&
        /[\w]/.test(key) &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey

      if (zone === 'search') {
        if (key === 'ArrowDown') {
          event.preventDefault()
          setZone('grid')
        } else if (key === 'Enter' && current) {
          event.preventDefault()
          pickItem(current, undefined, 'click')
        } else if (key === 'Tab') {
          event.preventDefault()
          moveSection(event.shiftKey ? -1 : 1)
        }
        return
      }

      if (zone === 'rail') {
        if (key === 'ArrowUp') {
          event.preventDefault()
          moveSection(-1)
        } else if (key === 'ArrowDown') {
          event.preventDefault()
          moveSection(1)
        } else if (key === 'ArrowRight' || key === 'Enter') {
          event.preventDefault()
          setZone('grid')
        } else if (key === 'Tab') {
          event.preventDefault()
          moveSection(event.shiftKey ? -1 : 1)
        } else if (key === '/') {
          event.preventDefault()
          setZone('search')
        } else if (isTypeKey) {
          event.preventDefault()
          typeIntoSearch(key)
        }
        return
      }

      if (key === 'ArrowRight') {
        event.preventDefault()
        selectIndex(index + 1)
      } else if (key === 'ArrowLeft') {
        event.preventDefault()
        if (index < 0 || index % columns === 0) setZone('rail')
        else selectIndex(index - 1)
      } else if (key === 'ArrowDown') {
        event.preventDefault()
        selectIndex(index + columns)
      } else if (key === 'ArrowUp') {
        event.preventDefault()
        if (index < columns) setZone('search')
        else selectIndex(index - columns)
      } else if (key === 'Enter' && current) {
        event.preventDefault()
        pickItem(current, undefined, 'click')
      } else if (key === 'Tab') {
        event.preventDefault()
        moveSection(event.shiftKey ? -1 : 1)
      } else if (key === '/') {
        event.preventDefault()
        setZone('search')
      } else if (key === 'Backspace') {
        event.preventDefault()
        setZone('search')
        setQuery((currentQuery) => currentQuery.slice(0, -1))
      } else if (isTypeKey) {
        event.preventDefault()
        typeIntoSearch(key)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [items, onClose, pickItem, section, selectedKey, view, zone])

  function updateView(next: InserterView) {
    setView(next)
    writeModuleInserterView(next)
  }

  function handlePointerDown(
    item: ModuleInserterItem,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (event.button !== 0) return
    // Disabled items can't be dragged to the canvas either.
    if (item.disabledReason) return
    const startX = event.clientX
    const startY = event.clientY
    let started = false

    const move = (moveEvent: PointerEvent) => {
      if (!started) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 6) return
        started = true
        backdropRef.current?.setAttribute('data-dragging', 'true')
      }

      const resolved = resolvePointerDrop(moveEvent.clientX, moveEvent.clientY)
      setDrag({
        item,
        x: moveEvent.clientX,
        y: moveEvent.clientY,
        preview: resolved?.preview ?? null,
      })
    }

    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      backdropRef.current?.removeAttribute('data-dragging')

      const resolved = started
        ? resolvePointerDrop(upEvent.clientX, upEvent.clientY)
        : null
      setDrag(null)
      if (!started) return

      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)

      if (resolved && pickItem(item, resolved.location, 'drop')) {
        setActiveBreakpoint(resolved.breakpointId)
      }
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function resolvePointerDrop(
    clientX: number,
    clientY: number,
  ): PointerDropResolution | null {
    if (!canvasPage) return null
    const viewport = findCanvasViewportAtPoint(clientX, clientY)
    if (!viewport) return null
    const breakpointId = viewport.dataset.breakpointId
    if (!breakpointId) return null

    const viewportRect = viewport.getBoundingClientRect()
    if (
      clientX < viewportRect.left ||
      clientX > viewportRect.right ||
      clientY < viewportRect.top ||
      clientY > viewportRect.bottom
    ) {
      return null
    }

    const iframe = viewport.querySelector<HTMLIFrameElement>('iframe')
    const point = getViewportLocalPoint(viewport, clientX, clientY)
    const candidates = measureCanvasDropCandidates(viewport, canvasPage, iframe)
    const target = resolveCanvasInsertionTarget({
      tree: canvasPage,
      candidates,
      point,
      canHaveChildren: (moduleId) => registry.get(moduleId)?.canHaveChildren === true,
    })

    if (!target) {
      return {
        location: { parentId: canvasPage.rootNodeId, index: undefined },
        preview: fixedPreviewForViewport(viewport, 'inside', 'Drop at page root'),
        breakpointId,
      }
    }

    return {
      location: { parentId: target.parentId, index: target.index },
      preview: fixedPreviewForTarget(viewport, target, `Drop ${target.position}`),
      breakpointId,
    }
  }

  function handleBackdropClick(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onClose()
  }

  // Saved-layout manage menu (rename / delete) — see SavedLayoutManageMenu.
  function handleItemContextMenu(
    item: ModuleInserterItem,
    event: ReactMouseEvent<HTMLDivElement>,
  ) {
    if (item.kind !== 'savedLayout') return
    event.preventDefault()
    event.stopPropagation()
    setSavedLayoutMenu({
      x: event.clientX,
      y: event.clientY,
      layoutId: item.id,
      name: item.name,
    })
  }

  const dialog = (
    <div
      ref={backdropRef}
      className={styles.backdrop}
      role="presentation"
      onMouseDown={handleBackdropClick}
      data-dragging={drag ? 'true' : undefined}
    >
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Add to canvas"
      >
        <aside className={styles.rail}>
          <div className={styles.brand}>
            <AppGridPlusGlyphIcon size={18} aria-hidden="true" />
            <span>Add to canvas</span>
          </div>

          <nav className={styles.sectionList} aria-label="Module categories">
            {SECTIONS.map((item) => {
              const Icon = item.icon
              const isActive = section === item.id
              return (
                <Button
                  key={item.id}
                  variant="ghost"
                  size="md"
                  align="between"
                  className={cn(
                    styles.sectionButton,
                    isActive && styles.sectionButtonActive,
                    zone === 'rail' && isActive && styles.sectionButtonFocus,
                  )}
                  onClick={() => {
                    selectionSourceRef.current = 'pointer'
                    setSection(item.id)
                    setSelectedKeyOverride(null)
                    setZone('grid')
                  }}
                  data-accent={item.accent}
                  tabIndex={-1}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className={styles.sectionLabel}>
                    <span className={styles.sectionIcon} aria-hidden="true">
                      <Icon size={16} />
                    </span>
                    <span className={styles.sectionName}>{item.name}</span>
                  </span>
                  <span className={styles.sectionCount}>
                    {sectionCounts[item.id]}
                  </span>
                </Button>
              )
            })}
          </nav>

          {selectedItem ? (
            <div className={styles.detail} data-accent={selectedItem.accent}>
              <span className={styles.detailKind}>{selectedItem.kind}</span>
              <span className={styles.detailName}>
                <span className={styles.tintDot} aria-hidden="true" />
                {selectedItem.name}
              </span>
              <span className={styles.detailDescription}>
                {itemDescription(selectedItem)}
              </span>
            </div>
          ) : null}

          <div className={styles.railSpring} />
          <ModuleInserterShortcuts />
        </aside>

        <main className={styles.main}>
          <div className={styles.searchRow}>
            <SearchBar
              ref={searchRef}
              value={query}
              onValueChange={setQuery}
              onFocus={() => setZone('search')}
              placeholder="Search every module, layout & component..."
              aria-label="Search modules"
              className={styles.searchField}
            />
            <Kbd className={styles.escHint}>Esc</Kbd>
          </div>

          <div className={styles.sectionHeader} data-accent={selectedSection.accent}>
            <span className={styles.sectionBar} aria-hidden="true" />
            <span className={styles.sectionTitle}>{selectedSection.name}</span>
            <span className={styles.headerCount}>{items.length} items</span>
            <SegmentedControl<InserterView>
              value={view}
              onChange={updateView}
              aria-label="Module inserter view"
              className={styles.viewToggle}
              options={[
                {
                  value: 'grid',
                  icon: <Grid2x22SolidIcon size={13} aria-hidden="true" />,
                  ariaLabel: 'Grid view',
                  tooltip: 'Grid view',
                },
                {
                  value: 'list',
                  icon: <ListBoxSolidIcon size={13} aria-hidden="true" />,
                  ariaLabel: 'List view',
                  tooltip: 'List view',
                },
              ]}
            />
          </div>

          <div ref={scrollRef} className={styles.scroller}>
            {items.length === 0 ? (
              <EmptyState
                variant="centered"
                plain
                icon={<PackageSolidIcon size={22} />}
                title={query ? 'No matches' : emptyTitleForSection(section)}
                description={query ? 'Try a different search.' : emptyDescriptionForSection(section)}
                className={styles.empty}
              />
            ) : (
              <div className={view === 'list' ? styles.list : styles.grid}>
                {items.map((item) => (
                  <Fragment key={item.key}>
                    {groupLabelByKey.has(item.key) && (
                      <div className={styles.groupLabel} role="presentation">
                        {groupLabelByKey.get(item.key)}
                      </div>
                    )}
                    <ModuleInserterItemButton
                      item={item}
                      view={view}
                      selected={selectedKey === item.key}
                      favorite={isFavorite(recentRefForItem(item))}
                      onSelect={() => {
                        selectionSourceRef.current = 'pointer'
                        setSelectedKeyOverride(item.key)
                      }}
                      onPick={() => {
                        if (suppressClickRef.current) return
                        pickItem(item, undefined, 'click')
                      }}
                      onToggleFavorite={() => {
                        toggleFavorite(recentRefForItem(item))
                      }}
                      onPointerDown={handlePointerDown}
                      onContextMenu={handleItemContextMenu}
                    />
                  </Fragment>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>

      {drag?.preview ? (
        <div
          className={styles.dropPreview}
          data-position={drag.preview.position}
          style={dropPreviewStyle(drag.preview)}
          aria-hidden="true"
        >
          <span className={styles.dropTag}>
            <AppGridPlusGlyphIcon size={11} aria-hidden="true" />
            {drag.preview.label}
          </span>
        </div>
      ) : null}

      {savedLayoutMenu && (
        <SavedLayoutManageMenu
          menu={savedLayoutMenu}
          onClose={() => setSavedLayoutMenu(null)}
          onCloseInserter={onClose}
        />
      )}

      {drag ? (
        <div className={styles.ghost} style={ghostStyle(drag)} aria-hidden="true">
          <div className={styles.ghostWire}>
            <ModuleWireframe node={drag.item.wire} />
          </div>
          <span className={styles.ghostLabel} data-accent={drag.item.accent}>
            <span className={styles.tintDot} aria-hidden="true" />
            {drag.item.name}
          </span>
        </div>
      ) : null}
    </div>
  )

  if (typeof document === 'undefined') return null
  return createPortal(dialog, document.body)
}

function itemsForSection(
  section: ModuleInserterSectionId,
  groups: {
    modules: ModuleInserterItem[]
    layouts: ModuleInserterItem[]
    components: ModuleInserterItem[]
    recent: ModuleInserterItem[]
  },
): ModuleInserterItem[] {
  if (section === 'layouts') return groups.layouts
  if (section === 'components') return groups.components
  if (section === 'recent') return groups.recent
  return groups.modules
}

function emptyTitleForSection(section: ModuleInserterSectionId): string {
  if (section === 'components') return 'No components yet'
  if (section === 'recent') return 'No recent inserts'
  return 'Nothing to insert'
}

function emptyDescriptionForSection(section: ModuleInserterSectionId): string {
  if (section === 'components') return 'Create a Visual Component to insert it from here.'
  if (section === 'recent') return 'Inserted modules and layouts will appear here.'
  return 'This section has no available items.'
}
