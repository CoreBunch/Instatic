/**
 * ComponentParamsOverview — inspector view for declared params on the active Visual Component.
 *
 * Rendered by PropertiesPanel when:
 *   activeDocument.kind === 'visualComponent' && selectedNodeId === null && selectedSelectorClassId === null
 *
 * The parent resolves and passes the VC; this component never reads activeDocument itself.
 *
 * Architecture source: Contribution #619 Phase 3 §2
 * Constraint #269: may import from core/
 */

import { useEditorStore } from '@site/store/store'
import { findParamOrigin } from '@core/visualComponents'
import { useModuleList } from '@site/useModuleRegistry'
import type { VisualComponent, VCParam } from '@core/visualComponents'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import styles from './ComponentParamsOverview.module.css'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ComponentParamsOverviewProps {
  vc: VisualComponent
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Summarize a param's default value into a short display string.
 * Rules per Contribution #619 Phase 3 §2.
 */
function summarizeParamDefault(param: VCParam): string {
  switch (param.type) {
    case 'slot': {
      const nodes = Array.isArray(param.defaultValue) ? param.defaultValue : []
      return `${nodes.length} nodes`
    }
    case 'richText': {
      const n = String(param.defaultValue ?? '').length
      return `Rich text · ${n} chars`
    }
    case 'image': {
      const val = String(param.defaultValue ?? '')
      if (!val) return 'Empty'
      const segments = val.split(/[/\\]/)
      return segments[segments.length - 1] || 'Empty'
    }
    case 'enum': {
      const n = param.enumOptions?.length ?? 0
      return `(${n} options)`
    }
    case 'boolean': {
      return param.defaultValue ? 'On' : 'Off'
    }
    case 'color': {
      return String(param.defaultValue ?? '')
    }
    case 'string':
    case 'url':
    case 'number': {
      const s = String(param.defaultValue ?? '')
      return s.length > 32 ? `${s.slice(0, 32)}…` : s
    }
    default: {
      const s = String(param.defaultValue ?? '')
      return s.length > 32 ? `${s.slice(0, 32)}…` : s
    }
  }
}

// ---------------------------------------------------------------------------
// ComponentParamsOverview
// ---------------------------------------------------------------------------

export function ComponentParamsOverview({ vc }: ComponentParamsOverviewProps) {
  // Registry-reactive module index — origin-node names resolve per param,
  // and the lookup must flow from the hook's snapshot so the React Compiler
  // recomputes it when plugin packs register. See `useModuleRegistry.ts`.
  const modules = useModuleList()
  const moduleById = new Map(modules.map((m) => [m.id, m]))
  const selectNode = useEditorStore((s) => s.selectNode)
  const removeParamWithCleanup = useEditorStore((s) => s.removeParamWithCleanup)

  return (
    <div>
      {/* ── Header strip ─────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <span className={styles.kicker}>Component params</span>
        <span className={styles.countChip}>{vc.params.length}</span>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      {vc.params.length === 0 ? (
        <EmptyState
          plain
          compact
          title="Promote a property to create your first param."
        />
      ) : (
        <ul className={styles.paramList} aria-label="Component params">
          {vc.params.map((param) => {
            const origin = findParamOrigin(vc, param.id)
            const originNode = origin ? vc.tree.nodes[origin.nodeId] ?? null : null
            const moduleName = originNode
              ? (originNode.label || moduleById.get(originNode.moduleId)?.name || originNode.moduleId)
              : null
            const sourceLabel = origin && moduleName
              ? `from ${moduleName}.${origin.propKey}`
              : 'from —'

            return (
              <li key={param.id} className={styles.paramItem}>
                {/* Row body — navigates to origin node on click */}
                <Button
                  variant="ghost"
                  align="start"
                  fullWidth
                  className={styles.rowBtn}
                  disabled={!origin}
                  onClick={origin ? () => selectNode(origin.nodeId) : undefined}
                  aria-label={`Select origin of ${param.name}`}
                >
                  <div className={styles.rowContent}>
                    <div className={styles.rowTop}>
                      <span className={styles.paramName}>{param.name}</span>
                      <span className={styles.typeChip}>{param.type}</span>
                    </div>
                    <div className={styles.rowMeta}>
                      <span className={styles.sourceLabel}>{sourceLabel}</span>
                      <span className={styles.defaultSummary}>{summarizeParamDefault(param)}</span>
                    </div>
                  </div>
                </Button>

                {/* Remove button — sibling, not nested inside the row button */}
                <Button
                  variant="ghost"
                  size="xs"
                  iconOnly
                  aria-label="Remove param"
                  tooltip="Remove param"
                  className={styles.removeBtn}
                  onClick={(e) => {
                    e.stopPropagation()
                    removeParamWithCleanup(vc.id, param.id)
                  }}
                >
                  <CloseIcon size={10} color="currentColor" aria-hidden="true" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
