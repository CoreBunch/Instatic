/**
 * ModulePicker — searchable list of base modules and Visual Components,
 * designed to live inside a `ContextMenuSubmenu` (right-click DOM-panel
 * second level). The toolbar uses `ModuleInserterDialog`; this compact picker
 * stays for anchored context-menu flows.
 *
 * The picker reuses the dropdown primitives directly:
 *   - rows are `ContextMenuItem` (same hover, padding, typography as any
 *     other dropdown row);
 *   - groups are separated by `ContextMenuSeparator`;
 *   - the only custom style is the sticky search header at the top.
 *
 * Selection callbacks are wired by the caller, which decides the parent
 * and any post-insert side effects.
 */

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { useEditorStore } from '@site/store/store'
import { registry } from '@core/module-engine'
import type { AnyModuleDefinition } from '@core/module-engine'
import type { VisualComponent } from '@core/visualComponents'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { SearchBar } from '@ui/components/SearchBar'
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@ui/components/ContextMenu'
import { ModuleIcon } from '@site/ui/ModuleIcon'
import { FORM_PRESETS, type FormPreset } from './formPresets'
import { moduleAvailability } from './moduleInserterModel'
import { useModuleInsertionContext } from './useModuleInsertionContext'
import styles from './ModulePicker.module.css'

const EMPTY_VCS: VisualComponent[] = []

interface ModulePickerProps {
  /** Called when the user picks a base module. */
  onSelectModule: (mod: AnyModuleDefinition) => void
  /** Called when the user picks a multi-node form preset. */
  onSelectFormPreset: (preset: FormPreset) => void
  /** Called when the user picks a site Visual Component. */
  onSelectVC: (vcId: string) => void
  /** Auto-focus the search input on mount. Default: true. */
  autoFocusSearch?: boolean
  /**
   * Element whose `[role="menuitem"]` descendants are the navigation targets
   * for the search bar's ArrowDown bridge. Typically the wrapping ContextMenu
   * (or submenu panel) ref. When omitted, ArrowDown does nothing.
   */
  containerRef?: RefObject<HTMLElement | null>
}

export function ModulePicker({
  onSelectModule,
  onSelectFormPreset,
  onSelectVC,
  autoFocusSearch = true,
  containerRef,
}: ModulePickerProps) {
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const insertionContext = useModuleInsertionContext()
  const visualComponents = useEditorStore(
    (s) => s.site?.visualComponents ?? EMPTY_VCS,
  )

  // ─── Auto-focus search on mount ──────────────────────────────────────────
  useEffect(() => {
    if (!autoFocusSearch) return
    const id = setTimeout(() => searchRef.current?.focus(), 30)
    return () => clearTimeout(id)
  }, [autoFocusSearch])

  // ─── Module list + search filter ─────────────────────────────────────────
  // Same hidden/disabled rules as the inserter dialog — `moduleAvailability`
  // hides auto-materialized internals (body, VC refs, slot instances; slot
  // outlets outside VC mode) and disables context-bound modules (e.g. Content
  // Outlet outside a template) with a reason rendered as a tooltip.
  const moduleGroups: AnyModuleDefinition[][] = []
  for (const mods of Object.values(registry.listByCategory())) {
    const visible = mods.filter(
      (m) => moduleAvailability(m, insertionContext).kind !== 'hidden',
    )
    if (visible.length > 0) moduleGroups.push(visible)
  }

  const trimmedQuery = query.trim().toLowerCase()
  const filteredModuleGroups: AnyModuleDefinition[][] = !trimmedQuery
    ? moduleGroups
    : moduleGroups
        .map((g) =>
          g.filter(
            (m) =>
              m.name.toLowerCase().includes(trimmedQuery) ||
              m.id.toLowerCase().includes(trimmedQuery),
          ),
        )
        .filter((g) => g.length > 0)

  const filteredFormPresets = !trimmedQuery
    ? FORM_PRESETS
    : FORM_PRESETS.filter((preset) =>
        preset.name.toLowerCase().includes(trimmedQuery) ||
        preset.description.toLowerCase().includes(trimmedQuery) ||
        preset.id.toLowerCase().includes(trimmedQuery),
      )

  const filteredVcs = !trimmedQuery
    ? visualComponents
    : visualComponents.filter((vc) =>
        vc.name.toLowerCase().includes(trimmedQuery),
      )

  const isEmpty =
    filteredFormPresets.length === 0 &&
    filteredModuleGroups.length === 0 &&
    filteredVcs.length === 0

  // ─── Keyboard navigation: ArrowDown from search jumps to first row ───────
  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowDown') return
    e.preventDefault()
    const first =
      containerRef?.current?.querySelector<HTMLElement>('[role="menuitem"]')
    first?.focus()
  }

  // Render groups separated by ContextMenuSeparator. VCs get their own group
  // at the end so they're visually distinguishable from base modules.
  const groupCount =
    (filteredFormPresets.length > 0 ? 1 : 0) +
    filteredModuleGroups.length +
    (filteredVcs.length > 0 ? 1 : 0)

  return (
    <>
      <div
        className={styles.searchHeader}
        // Clicks on the header (e.g. the search input) inside a
        // ContextMenuSubmenu must not bubble to the panel-level click handler
        // — those are handled by the closeOnItemClickOnly flag, but
        // stopPropagation here is a defensive belt to also cover any
        // pointerdown-driven dismiss elsewhere.
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <SearchBar
          ref={searchRef}
          placeholder="Search modules…"
          value={query}
          onValueChange={setQuery}
          aria-label="Search modules"
          onKeyDown={handleSearchKeyDown}
          className={styles.searchField}
        />
      </div>

      {isEmpty && (
        <ContextMenuItem disabled aria-disabled="true">
          No modules match
        </ContextMenuItem>
      )}

      {filteredFormPresets.length > 0 && (
        <>
          {filteredFormPresets.map((preset) => (
            <ContextMenuItem
              key={preset.id}
              data-form-preset-id={preset.id}
              tooltip={preset.description}
              onClick={() => onSelectFormPreset(preset)}
            >
              <span aria-hidden="true">
                <FileTextSolidIcon size={13} />
              </span>
              {preset.name}
            </ContextMenuItem>
          ))}
        </>
      )}

      {filteredModuleGroups.map((group, groupIdx) => (
        <Fragment key={`g-${groupIdx}`}>
          {(groupIdx > 0 || filteredFormPresets.length > 0) && <ContextMenuSeparator />}
          {group.map((mod) => {
            const availability = moduleAvailability(mod, insertionContext)
            const disabledReason =
              availability.kind === 'disabled' ? availability.reason : undefined
            return (
              <ContextMenuItem
                key={mod.id}
                data-module-id={mod.id}
                disabled={Boolean(disabledReason)}
                tooltip={disabledReason}
                onClick={() => onSelectModule(mod)}
              >
                <span aria-hidden="true">
                  <ModuleIcon module={mod} size={13} />
                </span>
                {mod.name}
              </ContextMenuItem>
            )
          })}
        </Fragment>
      ))}

      {filteredVcs.length > 0 && (
        <>
          {groupCount > 1 && <ContextMenuSeparator />}
          {filteredVcs.map((vc) => (
            <ContextMenuItem
              key={vc.id}
              data-vc-id={vc.id}
              onClick={() => onSelectVC(vc.id)}
            >
              <span aria-hidden="true">
                <BracesIcon size={13} />
              </span>
              {vc.name}
            </ContextMenuItem>
          ))}
        </>
      )}
    </>
  )
}
