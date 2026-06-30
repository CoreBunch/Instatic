/**
 * ExplorerPanel — the consolidated navigation panel.
 *
 * One `<Panel>` shell hosting a top SegmentedControl that switches between the
 * Layers (DOM tree), Site (pages/templates/components), Code (stylesheets +
 * scripts), and Media tabs. Each tab renders the corresponding panel in its
 * headerless `tab` variant — this shell owns the chrome (header + tabs +
 * close). Mirrors FrameworkPanel.
 *
 * The Site and Code tabs are both served by a SINGLE `SiteExplorerPanel`
 * mount (its `sectionGroup` prop selects which sections show). Two separate
 * instances would each register their own `useDndMonitor`, double-handling
 * every explorer drag — so they deliberately share one instance + DnD scope.
 */
import { useEditorStore } from '@site/store/store'
import { Panel } from '@admin/shared/Panel'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { DomPanel } from '@site/panels/DomPanel'
import { SiteExplorerPanel } from '@site/panels/SiteExplorerPanel'
import { MediaExplorerPanel } from '@site/panels/MediaExplorerPanel'
import type { ExplorerPanelTab } from '@site/store/slices/uiSlice'
import styles from './ExplorerPanel.module.css'

const TABS: ReadonlyArray<{ value: ExplorerPanelTab; label: string }> = [
  { value: 'layers', label: 'Layers' },
  { value: 'site', label: 'Site' },
  { value: 'code', label: 'Code' },
  { value: 'media', label: 'Media' },
]

interface ExplorerPanelProps {
  /** Whether the caller can perform structural edits (drives DnD/insert). */
  editable?: boolean
}

export function ExplorerPanel({ editable = true }: ExplorerPanelProps) {
  const tab = useEditorStore((s) => s.explorerPanelTab)
  const setTab = useEditorStore((s) => s.setExplorerPanelTab)
  const setOpen = useEditorStore((s) => s.setExplorerPanelOpen)

  return (
    <Panel
      panelId="explorer"
      title="Explorer"
      testId="explorer-panel"
      onClose={() => setOpen(false)}
      body="bare"
    >
      <div className={styles.tabsRow}>
        <SegmentedControl<ExplorerPanelTab>
          value={tab}
          options={TABS}
          onChange={setTab}
          size="sm"
          fullWidth
        />
      </div>
      <div className={styles.tabBody}>
        <div className={styles.tabMount} hidden={tab !== 'layers'}>
          <DomPanel editable={editable} />
        </div>
        {/* Single SiteExplorerPanel serves both the Site and Code tabs; the
            `sectionGroup` prop picks which sections render. */}
        <div className={styles.tabMount} hidden={tab !== 'site' && tab !== 'code'}>
          <SiteExplorerPanel
            sectionGroup={tab === 'code' ? 'code' : 'site'}
            organizationDndEnabled={editable}
          />
        </div>
        <div className={styles.tabMount} hidden={tab !== 'media'}>
          <MediaExplorerPanel variant="tab" />
        </div>
      </div>
    </Panel>
  )
}
