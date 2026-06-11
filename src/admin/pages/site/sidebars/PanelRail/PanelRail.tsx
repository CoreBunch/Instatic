import { useSyncExternalStore, type CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import type { LeftSidebarPanelId } from '@site/store/slices/uiSlice'
import type { IconComponent } from 'pixel-art-icons/types'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { AiSettingsSolidIcon } from 'pixel-art-icons/icons/ai-settings-solid'
import { FilesStack2SolidIcon } from 'pixel-art-icons/icons/files-stack-2-solid'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { ColorsSwatchSolidIcon } from 'pixel-art-icons/icons/colors-swatch-solid'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { RulerDimensionSolidIcon } from 'pixel-art-icons/icons/ruler-dimension-solid'
import { Button } from '@ui/components/Button'
import { assignRailAccents, railTintVar, type RailAccent } from '@ui/railAccent'
import { pluginRuntime } from '@core/plugins/runtime'
import { resolvePluginPanelIcon } from './pluginPanelIcons'
import styles from './PanelRail.module.css'

interface PrimaryRailItem {
  id: LeftSidebarPanelId
  label: string
  icon: IconComponent
  iconName: string
}

interface RailItem {
  id: string
  label: string
  icon: IconComponent
  iconName: string
  accent: RailAccent
  open: boolean
  disabled?: boolean
  onToggle: () => void
  disabledTitle?: string
  /** Plugin-supplied shortcut hint shown in the button tooltip. */
  shortcutLabel?: string
}

const PRIMARY_RAIL_ITEMS: PrimaryRailItem[] = [
  {
    id: 'layers',
    label: 'Layers',
    icon: DatabaseSolidIcon,
    iconName: 'database-solid',
  },
  {
    id: 'site',
    label: 'Site',
    icon: FilesStack2SolidIcon,
    iconName: 'files-stack-2',
  },
  {
    id: 'selectors',
    label: 'Selectors',
    icon: PaintBucketSolidIcon,
    iconName: 'paint-bucket',
  },
  {
    id: 'colors',
    label: 'Colors',
    icon: ColorsSwatchSolidIcon,
    iconName: 'colors-swatch',
  },
  {
    id: 'typography',
    label: 'Typography',
    icon: TextStartTIcon,
    iconName: 'text-start-t',
  },
  {
    id: 'spacing',
    label: 'Spacing',
    icon: RulerDimensionSolidIcon,
    iconName: 'ruler-dimension',
  },
  {
    id: 'media',
    label: 'Media',
    icon: ImagesSolidIcon,
    iconName: 'images',
  },
  {
    id: 'dependencies',
    label: 'Dependencies',
    icon: BoxStackSolidIcon,
    iconName: 'box-stack',
  },
]

const GLOBAL_RAIL_ITEMS: PrimaryRailItem[] = [
  {
    id: 'agent',
    label: 'AI assistant',
    icon: AiSettingsSolidIcon,
    iconName: 'ai-settings-solid',
  },
]

interface PanelRailProps {
  workspace?: 'site' | 'content' | 'media'
  editable?: boolean
}

const subscribePluginRuntime = (cb: () => void) => pluginRuntime.subscribe(cb)
const getPluginPanelsSnapshot = () => pluginRuntime.getPanels()
// Reuse the same empty array on the server so useSyncExternalStore doesn't
// detect a snapshot mismatch.
const SERVER_PLUGIN_PANELS_SNAPSHOT: ReturnType<typeof getPluginPanelsSnapshot> = []

export function PanelRail({ workspace = 'site', editable = true }: PanelRailProps) {
  const domOpen = useEditorStore((s) => !s.domTreePanel.collapsed)
  const siteOpen = useEditorStore((s) => s.siteExplorerPanelOpen)
  const selectorsOpen = useEditorStore((s) => s.selectorsPanelOpen)
  const colorsOpen = useEditorStore((s) => s.colorsPanelOpen)
  const typographyOpen = useEditorStore((s) => s.typographyPanelOpen)
  const spacingOpen = useEditorStore((s) => s.spacingPanelOpen)
  const mediaOpen = useEditorStore((s) => s.mediaExplorerPanelOpen)
  const dependenciesOpen = useEditorStore((s) => s.dependenciesPanelOpen)
  const agentOpen = useEditorStore((s) => s.isAgentOpen)
  const activePluginPanelId = useEditorStore((s) => s.activePluginPanelId)

  const toggleLeftSidebarPanel = useEditorStore((s) => s.toggleLeftSidebarPanel)
  const toggleActivePluginPanel = useEditorStore((s) => s.toggleActivePluginPanel)

  // Subscribe to the plugin runtime so newly-registered panels appear in the
  // rail without a manual refresh. The runtime emits on every register/reset
  // — same channel toolbar buttons and commands already use.
  const pluginPanels = useSyncExternalStore(
    subscribePluginRuntime,
    getPluginPanelsSnapshot,
    () => SERVER_PLUGIN_PANELS_SNAPSHOT,
  )

  const panelOpenById = {
    layers: domOpen,
    agent: agentOpen,
    site: siteOpen,
    selectors: selectorsOpen,
    colors: colorsOpen,
    typography: typographyOpen,
    spacing: spacingOpen,
    media: mediaOpen,
    dependencies: dependenciesOpen,
  } satisfies Record<LeftSidebarPanelId, boolean>

  // Read-only callers (Viewer / Client) see only the navigation/inspection
  // panels — Layers, Site Explorer, Media. Style/runtime editing panels and
  // the AI assistant only appear when the user can edit structure.
  const READ_ONLY_RAIL_IDS = new Set<LeftSidebarPanelId>(['layers', 'site', 'media'])
  const visiblePrimaryItems = editable
    ? PRIMARY_RAIL_ITEMS
    : PRIMARY_RAIL_ITEMS.filter((item) => READ_ONLY_RAIL_IDS.has(item.id))
  const visibleGlobalItems = editable ? GLOBAL_RAIL_ITEMS : []

  function railLabel(item: PrimaryRailItem) {
    return workspace === 'content' && item.id === 'site' ? 'Content' : item.label
  }

  function railIdentity(item: PrimaryRailItem) {
    return `${workspace}:${item.id}:${railLabel(item)}`
  }

  function toRailItem(item: PrimaryRailItem, accent: RailAccent): RailItem {
    return {
      ...item,
      label: railLabel(item),
      open: panelOpenById[item.id],
      onToggle: () => toggleLeftSidebarPanel(item.id),
      accent,
    }
  }

  const primaryAccents = assignRailAccents(visiblePrimaryItems, railIdentity)
  const globalAccents = assignRailAccents(
    visibleGlobalItems,
    (item) => `global:${item.id}:${railLabel(item)}`,
  )
  const primaryItems: RailItem[] = visiblePrimaryItems.map((item, index) => (
    toRailItem(item, primaryAccents[index] ?? 'mint')
  ))
  const globalItems: RailItem[] = visibleGlobalItems.map((item, index) => (
    toRailItem(item, globalAccents[index] ?? 'mint')
  ))

  // Plugin panels show up after the primary group when editing. Panels with an
  // explicit accent keep it; the rest get deterministic identity colors with
  // repeat avoidance within the plugin rail group.
  const pluginAccents = assignRailAccents(
    pluginPanels,
    (panel) => `plugin:${panel.id}:${panel.label}`,
    (panel) => panel.accent,
  )
  const pluginItems: RailItem[] = editable
    ? pluginPanels.map((panel, index) => ({
        id: `plugin:${panel.id}`,
        label: panel.label,
        icon: resolvePluginPanelIcon(panel.iconName),
        iconName: panel.iconName,
        accent: pluginAccents[index] ?? 'mint',
        open: activePluginPanelId === panel.id,
        onToggle: () => toggleActivePluginPanel(panel.id),
        shortcutLabel: panel.shortcutLabel,
      }))
    : []

  return (
    <nav
      aria-label="Panel dock"
      className={styles.rail}
      data-testid="panel-rail"
    >
      <div className={styles.primaryStack}>
        <div className={styles.itemGroup} data-testid="panel-rail-primary">
          {primaryItems.map((item) => (
            <RailButton key={item.id} item={item} />
          ))}
        </div>
        {pluginItems.length > 0 && (
          <div className={styles.itemGroup} data-testid="panel-rail-plugins">
            {pluginItems.map((item) => (
              <RailButton key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
      {globalItems.length > 0 && (
        <div className={styles.globalGroup} data-testid="panel-rail-global">
          {globalItems.map((item) => (
            <RailButton key={item.id} item={item} />
          ))}
        </div>
      )}
    </nav>
  )
}

function RailButton({ item }: { item: RailItem }) {
  const RailIcon = item.icon
  const action = item.open ? 'Close' : 'Open'
  const style = {
    '--rail-icon-tint': railTintVar(item.accent),
  } as CSSProperties
  const title = item.disabled
    ? item.disabledTitle
    : item.shortcutLabel
      ? `${item.label} panel (${item.shortcutLabel})`
      : `${item.label} panel`

  return (
    <Button
      variant="ghost"
      size="md"
      iconOnly
      pressed={item.open}
      aria-label={`${action} ${item.label} panel`}
      disabled={item.disabled}
      tooltip={title}
      data-testid={`panel-rail-${item.id}`}
      data-icon={item.iconName}
      data-accent={item.accent}
      style={style}
      onClick={item.onToggle}
      className={styles.railButton}
    >
      <span className={styles.activeIndicator} aria-hidden="true" />
      <RailIcon size={16} className={styles.railIcon} />
    </Button>
  )
}
