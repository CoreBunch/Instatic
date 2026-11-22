import type { MouseEventHandler, ReactNode } from 'react'
import { EyeOffSolidIcon } from 'pixel-art-icons/icons/eye-off-solid'
import { TreeChevron, TreeIconSlot, TreeLabel, TreeLabelGroup } from '@site/ui/Tree'
import { ModuleIcon } from '@site/ui/ModuleIcon'
import { TagPill } from '@ui/components/TagPill'
import styles from './TreeNode.module.css'

export function LayerLabel({ name, preview }: { name: string; preview?: string }) {
  return <TreeLabel>{name}{preview && <small className={styles.preview}>{preview}</small>}</TreeLabel>
}

interface LayerTreeNodeContentProps {
  moduleId: string
  preview?: string
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
  preview,
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
          <LayerLabel name={displayName} preview={preview} />
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
        <span title="Hidden" aria-hidden="true" className={styles.hiddenIndicator}>
          <EyeOffSolidIcon size={13} color="currentColor" />
        </span>
      )}
      {hasChildren && !isRoot && <TreeChevron expanded={expanded} onClick={onToggle} />}
    </>
  )
}
