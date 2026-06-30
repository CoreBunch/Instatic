/**
 * FrameworkScalePanel — shared docked-panel UI for fluid Typography & Spacing.
 *
 * The visual / interaction layer is identical between the two modules: a tab
 * row of groups, a mode toggle (Automatic / Manual), the per-step preview list,
 * and the Class Generator section underneath. The two modules differ only in
 *   - what numeric "base size" field they edit (`fontSize` vs `size`),
 *   - their default scale ratio options,
 *   - the rendered preview row (text vs spacing bar),
 *   - the supported CSS properties in the Class Generator.
 *
 * Those differences are passed in via the `ScaleAdapter` (`./adapter.ts`) so
 * this same component backs both `TypographyPanel` and `SpacingPanel` without
 * duplicating the tab/mode/manual/class-generator logic.
 *
 * This file is the panel SHELL only — context menu, tab state, panel header.
 * The body lives in `./PanelBody`, which orchestrates the section stack
 * (extras → Scales → Utilities → extras).
 */

import { type MouseEvent, useState } from 'react'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@ui/components/ContextMenu'
import { Copy2SharpIcon } from 'pixel-art-icons/icons/copy-2-sharp'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import { useEditorStore } from '@site/store/store'
import { resolveFrameworkPreferences } from '@core/framework'
import { PanelBody } from './PanelBody'
import type { GeneratorShape, GroupShape, ScaleAdapter } from './adapter'

/**
 * Chrome-free scale editor body (typography / spacing), rendered inside the
 * consolidated Framework panel's tab. The `<Panel>` shell + open-state are
 * owned by FrameworkPanel; this component renders only the scale body + its
 * group context menu.
 */
export function FrameworkScalePanel<G extends GroupShape, C extends GeneratorShape>({
  adapter,
}: {
  adapter: ScaleAdapter<G, C>
}) {
  const groups = useEditorStore(adapter.selectGroups)
  const classGenerators = useEditorStore(adapter.selectClasses)
  const isDisabled = useEditorStore(adapter.selectIsDisabled)
  const preferencesRaw = useEditorStore((s) => s.site?.settings.framework?.preferences ?? null)
  const preferences = resolveFrameworkPreferences(preferencesRaw)

  const sortedGroups = [...groups].sort((a, b) => a.order - b.order)
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const activeGroup = sortedGroups.length
    ? sortedGroups.find((g) => g.id === activeTabId) ?? sortedGroups[0]
    : null

  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    groupId: string
  } | null>(null)

  function handleTabContextMenu(groupId: string, event: MouseEvent<HTMLElement>) {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ x: event.clientX, y: event.clientY, groupId })
  }

  function handleAddGroup() {
    const created = adapter.onCreateGroup()
    setActiveTabId(created.id)
  }

  function handleDuplicate(groupId: string) {
    const created = adapter.onDuplicateGroup(groupId)
    if (created) setActiveTabId(created.id)
    setContextMenu(null)
  }

  function handleReset(groupId: string) {
    adapter.onResetGroup(groupId)
    setContextMenu(null)
  }

  function handleDelete(groupId: string) {
    setContextMenu(null)
    // The adapter's onDeleteGroup already routes through the framework-change
    // confirm dialog (same as colors) — it lists the generated classes still
    // assigned to elements and strips them on confirm. Don't double-confirm.
    // Active tab auto-recovers: once the group is gone, `activeGroup` falls
    // back to the first remaining scale (or null → the empty state).
    adapter.onDeleteGroup(groupId)
  }

  return (
    <>
      <PanelBody<G, C>
        key={activeGroup?.id ?? 'empty'}
        group={(activeGroup ?? null) as G | null}
        groups={sortedGroups as G[]}
        isDisabled={isDisabled}
        adapter={adapter}
        preferences={preferences}
        onContextMenu={(e) => activeGroup && handleTabContextMenu(activeGroup.id, e)}
        onActivateGroup={(value) => setActiveTabId(value)}
        onAddGroup={handleAddGroup}
        onDeleteGroup={() => activeGroup && handleDelete(activeGroup.id)}
        classGenerators={classGenerators}
      />

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel={`${adapter.title} scale actions`}
          onClose={() => setContextMenu(null)}
        >
          <ContextMenuItem onClick={() => handleDuplicate(contextMenu.groupId)}>
            <span aria-hidden="true">
              <Copy2SharpIcon size={13} />
            </span>
            Duplicate
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleReset(contextMenu.groupId)}>
            <span aria-hidden="true">
              <ReloadIcon size={13} />
            </span>
            Reset to defaults
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            danger
            onClick={() => handleDelete(contextMenu.groupId)}
          >
            <span aria-hidden="true">
              <TrashSolidIcon size={13} />
            </span>
            Remove
          </ContextMenuItem>
        </ContextMenu>
      )}
    </>
  )
}
