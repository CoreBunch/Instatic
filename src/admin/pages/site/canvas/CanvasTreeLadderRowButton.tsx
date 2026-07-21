import type { CSSProperties } from 'react'
import {
  getNodeClassNames,
  getNodeDisplayName,
  getNodeHtmlTag,
  type PageNode,
  type StyleRuleRegistry,
} from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import { Button } from '@ui/components/Button'
import { useModuleDefinition } from '@site/useModuleRegistry'
import type { CanvasTreeLadderRow } from './canvasTreeLadder'
import styles from './BreakpointSelectionOverlay.module.css'

interface CanvasTreeLadderRowButtonProps {
  row: CanvasTreeLadderRow
  node: PageNode
  highlighted: boolean
  styleRules: StyleRuleRegistry
  visualComponents: ReadonlyArray<VisualComponent>
  role?: 'button' | 'menuitem'
  onHighlight: (nodeId: string) => void
  onCommit: (nodeId: string) => void
}

export function CanvasTreeLadderRowButton({
  row,
  node,
  highlighted,
  styleRules,
  visualComponents,
  role,
  onHighlight,
  onCommit,
}: CanvasTreeLadderRowButtonProps) {
  // Registry-reactive lookup — see `useModuleRegistry.ts` for why this must
  // come out of the hook's snapshot rather than a raw `registry.get()`.
  const definition = useModuleDefinition(node.moduleId)
  const displayName = getNodeDisplayName(node, definition, visualComponents)
  const htmlTag = getNodeHtmlTag(node, definition)
  const classNames = getNodeClassNames(node, styleRules)
  const visibleClassNames = classNames.slice(0, 2)
  const extraClassCount = Math.max(0, classNames.length - visibleClassNames.length)

  return (
    <Button
      role={role}
      variant="ghost"
      size="sm"
      align="between"
      fullWidth
      className={styles.treeLadderRow}
      data-relation={row.relation}
      active={highlighted}
      aria-current={highlighted ? 'true' : undefined}
      aria-label={`${displayName} ${treeLadderRelationLabel(row)}`}
      style={{ '--tree-ladder-depth': row.depth } as CSSProperties}
      onMouseEnter={() => onHighlight(row.nodeId)}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onCommit(row.nodeId)
      }}
    >
      <span className={styles.treeLadderMain}>
        {htmlTag ? (
          <span className={styles.treeLadderTag}>{htmlTag}</span>
        ) : (
          <span className={styles.treeLadderFallbackName}>{displayName}</span>
        )}
        {visibleClassNames.map((className) => (
          <span key={className} className={styles.treeLadderClass}>
            .{className}
          </span>
        ))}
        {extraClassCount > 0 && (
          <span className={styles.treeLadderClassMore}>+{extraClassCount}</span>
        )}
      </span>
      <span className={styles.treeLadderRelation}>{treeLadderRelationLabel(row)}</span>
    </Button>
  )
}

function treeLadderRelationLabel(row: CanvasTreeLadderRow): string {
  if (row.relation === 'current') return 'current'
  if (row.relation === 'firstChild') return 'first child'
  return row.depth === 0 ? 'root' : 'parent'
}
