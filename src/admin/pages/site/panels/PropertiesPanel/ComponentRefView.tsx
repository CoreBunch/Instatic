import { useEditorLocale } from '@site/localization'
import { localizableComponentParameterIds } from '@core/visualComponents'
/**
 * ComponentRefView — PropertiesPanel view for a selected base.visual-component-ref instance.
 *
 * Architecture source: Contribution #619 §8.5
 *
 * When a visualComponentRef node is selected, this view replaces the normal
 * Properties tab. It shows:
 *   - Header: component icon + VC name + "Open in canvas" link
 *   - One row per VCParam, in vc.params declaration order
 *   - Each row: <ParamRow mode='override-edit'> (handles Default / Overridden pill + Reset)
 *
 * Achromatic palette (Guideline #376). CSS Modules only (Constraint #402/#403).
 * Icons from pixel-art-icons (Guideline #350).
 */

import { useEditorStore } from '@site/store/store'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { Button } from '@ui/components/Button'
import { ParamRow } from './ParamRow'
import styles from './ComponentRefView.module.css'

interface ComponentRefViewProps {
  /** ID of the selected base.visual-component-ref node */
  nodeId: string
  /** componentId prop from the node — identifies which VC this references */
  componentId: string
  /** propOverrides prop from the node — per-instance value overrides */
  propOverrides: Record<string, unknown>
}

export function ComponentRefView({ nodeId, componentId, propOverrides }: ComponentRefViewProps) {
  const { isTranslation } = useEditorLocale()
  const setActiveDocument = useEditorStore((s) => s.setActiveDocument)
  const updateNodeProps = useEditorStore((s) => s.updateNodeProps)

  const vc = useEditorStore(
    (s) => s.site?.visualComponents?.find((v) => v.id === componentId) ?? null,
  )

  function handleOpenInCanvas() {
    if (componentId) {
      setActiveDocument({ kind: 'visualComponent', vcId: componentId })
    }
  }

  function handleParamChange(paramId: string, value: unknown) {
    const next = { ...propOverrides, [paramId]: value }
    updateNodeProps(nodeId, { propOverrides: next })
  }

  function handleParamReset(paramId: string) {
    const next = { ...propOverrides }
    delete next[paramId]
    updateNodeProps(nodeId, { propOverrides: next })
  }

  if (!vc) {
    return (
      <div className={styles.unknownVC}>
        <WarningDiamondSolidIcon size={14} color="currentColor" aria-hidden="true" />
        <p>Unknown component: {componentId}</p>
      </div>
    )
  }

  const localizable = localizableComponentParameterIds(vc)
  const params = isTranslation ? vc.params.filter((param) => localizable.has(param.id)) : vc.params
  return (
    <>
      {/* ── Header: VC name + Open in canvas link ──────────────────────── */}
      <div className={styles.header}>
        <span className={styles.headerIcon} aria-hidden="true">
          <BracesIcon size={12} color="currentColor" />
        </span>
        <span className={styles.headerName}>{vc.name}</span>
        <Button
          variant="ghost"
          size="xs"
          onClick={handleOpenInCanvas}
          tooltip="Open component in canvas"
        >
          <ExternalLinkSolidIcon size={10} color="currentColor" aria-hidden="true" />
          Open in canvas
        </Button>
      </div>

      {/* ── Param rows ──────────────────────────────────────────────────── */}
      {params.length === 0 ? (
        <div className={styles.noParams}>
          This component has no editable parameters in this language.
          <br />
          Shared parameter definitions are edited in the source language.
        </div>
      ) : (
        <div className={styles.paramsList} role="list" aria-label="Component parameters">
          {params.map((param) => {
            const isOverridden = Object.prototype.hasOwnProperty.call(propOverrides, param.id)
            const effectiveValue = isOverridden ? propOverrides[param.id] : param.defaultValue

            return (
              <div key={param.id} role="listitem" data-testid={`vc-param-row-${param.name}`}>
                <ParamRow
                  mode="override-edit"
                  paramName={param.name}
                  paramType={param.type}
                  paramId={param.id}
                  value={effectiveValue}
                  isOverridden={isOverridden}
                  enumOptions={param.enumOptions}
                  onValueChange={(val) => handleParamChange(param.id, val)}
                  onReset={() => handleParamReset(param.id)}
                />
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
