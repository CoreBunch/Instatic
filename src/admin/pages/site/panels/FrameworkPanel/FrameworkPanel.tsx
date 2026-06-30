/**
 * FrameworkPanel — the consolidated design-token panel.
 *
 * One `<Panel>` shell hosting a top SegmentedControl that switches between a
 * Home overview and the Colors / Typography / Space editing tabs (the
 * extracted ColorsPanelBody and the chrome-free scale bodies). The header
 * action opens the Manage Core Framework dialog (import / remove / prune),
 * which is mounted once via FrameworkManagerHost.
 */
import { useEditorStore } from '@site/store/store'
import { Panel } from '@admin/shared/Panel'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Button } from '@ui/components/Button'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { ColorsPanelBody } from '@site/panels/ColorsPanel'
import { TypographyTab } from '@site/panels/TypographyPanel'
import { SpacingTab } from '@site/panels/SpacingPanel'
import type { FrameworkPanelTab } from '@site/store/slices/uiSlice'
import { FrameworkHome } from './FrameworkHome'
import { FrameworkManagerHost } from './FrameworkManagerHost'
import styles from './FrameworkPanel.module.css'

const TABS: ReadonlyArray<{ value: FrameworkPanelTab; label: string }> = [
  { value: 'home', label: 'Overview' },
  { value: 'colors', label: 'Colors' },
  { value: 'typography', label: 'Type' },
  { value: 'spacing', label: 'Space' },
]

export function FrameworkPanel() {
  const tab = useEditorStore((s) => s.frameworkPanelTab)
  const setTab = useEditorStore((s) => s.setFrameworkPanelTab)
  const setOpen = useEditorStore((s) => s.setFrameworkPanelOpen)
  const setManagerOpen = useEditorStore((s) => s.setFrameworkManagerOpen)

  return (
    <Panel
      panelId="framework"
      title="Framework"
      testId="framework-panel"
      onClose={() => setOpen(false)}
      headerActions={
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Manage Core Framework"
          tooltip="Manage framework"
          onClick={() => setManagerOpen(true)}
        >
          <SlidersHorizontalIcon size={13} aria-hidden="true" />
        </Button>
      }
      body="bare"
    >
      <div className={styles.tabsRow}>
        <SegmentedControl<FrameworkPanelTab>
          value={tab}
          options={TABS}
          onChange={setTab}
          size="sm"
          fullWidth
        />
      </div>
      <div className={styles.tabBody}>
        {tab === 'home' && <FrameworkHome />}
        {tab === 'colors' && <ColorsPanelBody />}
        {tab === 'typography' && <TypographyTab />}
        {tab === 'spacing' && <SpacingTab />}
      </div>

      <FrameworkManagerHost />
    </Panel>
  )
}
