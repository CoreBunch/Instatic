import type { MouseEventHandler, ReactNode } from 'react'
import { TreeChevron, TreeIconSlot, TreeLabel, TreeLabelGroup } from '@site/ui/Tree'
import { ModuleIcon } from '@site/ui/ModuleIcon'
import { TagPill } from '@ui/components/TagPill'
import styles from './TreeNode.module.css'

interface LayerTreeNodeContentProps {
  moduleId: string
  displayName: string
  htmlTag: string | null
  classSelectorChip: string | null
  hasChildren: boolean
  expanded: boolean
  showIcon: boolean
  showTag: boolean
  showClasses: boolean
  isRoot?: boolean
  locked?: boolean
  hidden?: boolean
  labelSlot?: ReactNode
  onToggle?: MouseEventHandler<HTMLSpanElement>
}

export function LayerTreeNodeContent({
  moduleId,
  displayName,
  htmlTag,
  classSelectorChip,
  hasChildren,
  expanded,
  showIcon,
  showTag,
  showClasses,
  isRoot = false,
  locked = false,
  hidden = false,
  labelSlot,
  onToggle,
}: LayerTreeNodeContentProps) {
  return (
    <>
      <TreeChevron
        onClick={onToggle}
        expanded={expanded}
        visible={hasChildren && !isRoot}
      />

      {showIcon && (
        <TreeIconSlot iconSize={11} iconColor="var(--text-disabled)">
          <ModuleIcon
            moduleId={moduleId}
            size={11}
            color="var(--text-disabled)"
          />
        </TreeIconSlot>
      )}

      {labelSlot ?? (
        <TreeLabelGroup>
          {showTag && htmlTag && (
            <TagPill
              label={htmlTag}
              size="xs"
              monospace
              aria-hidden="true"
              className={styles.tagPill}
            />
          )}
          <TreeLabel>
            {displayName}
          </TreeLabel>
          {showClasses && classSelectorChip && (
            <TagPill
              label={classSelectorChip}
              size="xs"
              monospace
              aria-hidden="true"
              className={styles.classChip}
            />
          )}
        </TreeLabelGroup>
      )}

      {locked && (
        <span title="Locked" aria-hidden="true" className={styles.indicator}>
          🔒
        </span>
      )}
      {hidden && (
        <span aria-hidden="true" className={styles.hiddenBadge}>
          hidden
        </span>
      )}
    </>
  )
}
