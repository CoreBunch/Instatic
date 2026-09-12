import { useRef } from 'react'
import { useEditorStore } from '@site/store/store'
import {
  Panel,
  useAutoFocusPanel,
  type DockablePanelProps,
} from '@admin/shared/Panel'
import { RegistryPanel } from './RegistryPanel'

export function DependenciesPanel({
  mode = 'docked',
  dragHandleProps,
  onToggleMode,
}: DockablePanelProps) {
  const isOpen = useEditorStore((s) => s.dependenciesPanelOpen)
  const setDependenciesPanelOpen = useEditorStore((s) => s.setDependenciesPanelOpen)
  const panelRef = useRef<HTMLElement>(null)

  useAutoFocusPanel(panelRef, isOpen)

  if (!isOpen) return null

  return (
    <Panel
      ref={panelRef}
      panelId="dependencies"
      title="Dependencies"
      testId="dependencies-panel"
      onClose={() => setDependenciesPanelOpen(false)}
      mode={mode}
      dragHandleProps={dragHandleProps}
      onToggleMode={onToggleMode}
      dockLocation="left sidebar"
      body="bare"
    >
      <RegistryPanel />
    </Panel>
  )
}
