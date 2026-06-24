import { type ReactNode } from 'react'
import { DragOverlay } from '@dnd-kit/core'
import { TreeIconSlot, TreeLabel, TreeRow } from '@site/ui/Tree'
import { useSiteExplorerDnd, type SiteExplorerDragData, type SiteExplorerDropTarget } from './useSiteExplorerDnd'
import type { ExplorerPathChangePlan } from '@core/page-tree'
import styles from './SiteExplorerPanel.module.css'

const EMPTY_DND: SiteExplorerDndState = { active: null, target: null }

export interface SiteExplorerDndState {
  active: SiteExplorerDragData | null
  target: SiteExplorerDropTarget | null
}

interface SiteExplorerDndScopeProps {
  enabled: boolean
  onStructuralPathPlan: (plan: ExplorerPathChangePlan) => void
  children: (dnd: SiteExplorerDndState) => ReactNode
}

export function SiteExplorerDndScope({ enabled, onStructuralPathPlan, children }: SiteExplorerDndScopeProps) {
  if (!enabled) return <>{children(EMPTY_DND)}</>
  return (
    <SiteExplorerDndEnabled onStructuralPathPlan={onStructuralPathPlan}>
      {children}
    </SiteExplorerDndEnabled>
  )
}

function SiteExplorerDndEnabled({
  onStructuralPathPlan,
  children,
}: Pick<SiteExplorerDndScopeProps, 'children' | 'onStructuralPathPlan'>) {
  const explorerDnd = useSiteExplorerDnd({ enabled: true, onStructuralPathPlan })

  return (
    <>
      {children(explorerDnd)}
      <SiteExplorerDragOverlay active={explorerDnd.active} />
    </>
  )
}

function SiteExplorerDragOverlay({ active }: { active: SiteExplorerDragData | null }) {
  const ActiveIcon = active?.icon
  const activeCount = active?.kind === 'siteExplorerItem' ? active.itemIds.length : 1

  return (
    <DragOverlay dropAnimation={null}>
      {active ? (
        <TreeRow depth={0} className={styles.dragOverlayRow}>
          {ActiveIcon && (
            <TreeIconSlot
              icon={ActiveIcon}
              iconSize={12}
              iconColor="var(--text-disabled)"
            />
          )}
          <TreeLabel>{activeCount > 1 ? `${activeCount} items` : active.label}</TreeLabel>
        </TreeRow>
      ) : null}
    </DragOverlay>
  )
}
