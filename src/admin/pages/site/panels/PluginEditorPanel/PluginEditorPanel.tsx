/**
 * PluginEditorPanel — host-side mount for a plugin-registered editor
 * panel. Looks the panel up in `pluginRuntime.getPanel(panelId)`, wraps
 * the plugin's React component in a `PluginContext.Provider`, and renders
 * it inside the host-owned panel chrome (`PanelHeader` + scrollable body).
 *
 * The plugin's component is a real React component (`definePluginPanel`)
 * that imports `react`, `@instatic/host-ui`, and `@instatic/host-hooks`
 * as externals. The host's import map resolves those bare specifiers to
 * its own React instance + design system primitives at mount time, so
 * plugin bundles share host React without bundling a copy.
 *
 * Failure modes:
 *   • Panel id is set but no panel is registered (plugin disabled, lost
 *     race) → render an "unavailable" fallback instead of throwing.
 *   • Plugin component throws → caught by ErrorBoundary so the editor
 *     shell stays alive even if a plugin crashes.
 */
import { useEffect, useState } from 'react'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import { Panel, type DockablePanelProps } from '@admin/shared/Panel'
import { useEditorStore } from '@site/store/store'
import { pluginRuntime } from '@core/plugins/runtime'
import { buildPluginRoutesHelper } from '@core/plugins/adminRuntime'
import {
  PluginContext,
  type PluginContextValue,
} from '@admin/plugin-host-hooks'
import styles from './PluginEditorPanel.module.css'

interface PluginEditorPanelProps extends DockablePanelProps {
  panelId: string
}

export function PluginEditorPanel(props: PluginEditorPanelProps) {
  const { panelId } = props
  // ErrorBoundary reset key includes the panel id so navigating away then
  // back clears stuck errors automatically.
  return (
    <ErrorBoundary location="plugin-editor-panel" resetKeys={[panelId]}>
      <PluginEditorPanelContent {...props} />
    </ErrorBoundary>
  )
}

function PluginEditorPanelContent({
  panelId,
  mode,
  dragHandleProps,
  onToggleMode,
}: PluginEditorPanelProps) {
  // Subscribe to the runtime so the panel re-renders if the plugin is
  // re-activated (e.g. after a hot reload from `instatic-plugin dev`).
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const unsubscribe = pluginRuntime.subscribe(() => setTick((t) => t + 1))
    return unsubscribe
  }, [])
  void tick
  const setActivePluginPanel = useEditorStore((s) => s.setActivePluginPanel)

  const panel = pluginRuntime.getPanel(panelId)
  const manifest = pluginRuntime.getPanelManifest(panelId)

  const handleClose = () => {
    setActivePluginPanel(null)
  }

  if (!panel || !manifest) {
    return (
      <Panel
        panelId={`plugin-${panelId}`}
        title="Plugin panel"
        testId={`panel-plugin-${panelId}`}
        onClose={handleClose}
        mode={mode}
        dragHandleProps={dragHandleProps}
        onToggleMode={onToggleMode}
        dockLocation="left sidebar"
      >
        <div className={styles.unavailable}>
          Panel <code>{panelId}</code> is not currently registered.
        </div>
      </Panel>
    )
  }

  const PanelComponent = panel.component
  const settings = pluginRuntime.getPluginSettings(panel.pluginId)

  return (
    <Panel
      panelId={`plugin-${panel.id}`}
      title={panel.label}
      testId={`panel-plugin-${panel.id}`}
      onClose={handleClose}
      mode={mode}
      dragHandleProps={dragHandleProps}
      onToggleMode={onToggleMode}
      dockLocation="left sidebar"
    >
      <PluginPanelSubtree
        panelId={panel.id}
        pluginId={panel.pluginId}
        pluginVersion={manifest.version}
        grantedPermissions={manifest.grantedPermissions ?? []}
        label={panel.label}
        settings={settings}
        PanelComponent={PanelComponent}
      />
    </Panel>
  )
}

/**
 * Inner component — wraps the plugin's panel component in a
 * `PluginContext.Provider` so the plugin's hooks (`usePluginSettings`,
 * `usePluginRoutes`, `usePluginContext`, `useEditorCommand`) resolve
 * with the right plugin identity, settings snapshot, and HTTP scope.
 */
function PluginPanelSubtree({
  panelId,
  pluginId,
  pluginVersion,
  grantedPermissions,
  label,
  settings,
  PanelComponent,
}: {
  panelId: string
  pluginId: string
  pluginVersion: string
  grantedPermissions: import('@core/plugin-sdk').PluginPermission[]
  label: string
  settings: Record<string, string | number | boolean>
  PanelComponent: import('@core/plugin-sdk').PluginEditorPanelComponent
}) {
  const contextValue: PluginContextValue = {
    pluginId,
    pluginVersion,
    surfaceId: panelId,
    surfaceLabel: label,
    grantedPermissions,
    settings,
    routes: buildPluginRoutesHelper(pluginId),
    runCommand: (commandId) => pluginRuntime.runCommand(commandId),
  }

  return (
    <PluginContext.Provider value={contextValue}>
      <PanelComponent panel={{ id: panelId, pluginId, label }} />
    </PluginContext.Provider>
  )
}
