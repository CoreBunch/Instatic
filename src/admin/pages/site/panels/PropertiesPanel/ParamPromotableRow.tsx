/**
 * ParamPromotableRow — wraps a PropertyControl row in VC edit mode.
 *
 * Behavior:
 *   - If propBindings[propKey] is set on the node → renders <ParamRow mode='default-edit'>.
 *   - If the node has a dynamicBinding on this prop → renders PropertyControlRenderer
 *     without the expose icon (dynamic binding takes precedence per spec rule 4).
 *   - Otherwise → renders PropertyControlRenderer + inline expose icon button.
 *     Clicking expose opens an inline menu (no portal) to:
 *       (a) bind to an existing compatible param, or
 *       (b) create a new param from this property.
 *
 * Architecture source: Contribution #619 Phase 2 §B
 * Constraint #269: this file may import from core/ (it lives in editor/).
 */

import { useState } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveCanvasPage } from '@site/store/store'
import { validateParamName } from '@core/visualComponents'
import type { PropertyControl } from '@core/module-engine'
import { PropertyControlRenderer } from '@site/property-controls/PropertyControlRenderer'
import { paramTypeForControl, paramTypesCompatibleWithControl } from '@site/property-controls/paramTypeCompat'
import { ParamRow } from './ParamRow'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import type { VCParam } from '@core/visualComponents'
import styles from './ParamPromotableRow.module.css'

// ---------------------------------------------------------------------------
// Stable empty-array sentinel (Guideline #239: no ?? [] in useEditorStore selectors)
// ---------------------------------------------------------------------------

const EMPTY_PARAMS: VCParam[] = []

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ParamPromotableRowProps {
  vcId: string
  nodeId: string
  propKey: string
  control: PropertyControl
  value: unknown
  isOverride?: boolean
  onChange: (key: string, val: unknown) => void
}

// ---------------------------------------------------------------------------
// ParamPromotableRow
// ---------------------------------------------------------------------------

export function ParamPromotableRow({
  vcId,
  nodeId,
  propKey,
  control,
  value,
  isOverride,
  onChange,
}: ParamPromotableRowProps) {
  const [exposeOpen, setExposeOpen] = useState(false)
  const [newParamName, setNewParamName] = useState(propKey)
  const [newParamNameError, setNewParamNameError] = useState<string | null>(null)

  // ── Store: VC params + node propBindings + dynamicBinding ────────────────

  const vcParams = useEditorStore(
    (s) => s.site?.visualComponents?.find((v) => v.id === vcId)?.params ?? EMPTY_PARAMS,
  )

  const propBinding = useEditorStore(
    (s) => selectActiveCanvasPage(s)?.nodes[nodeId]?.propBindings?.[propKey] ?? null,
  )

  const hasDynamicBinding = useEditorStore((s) =>
    Boolean(selectActiveCanvasPage(s)?.nodes[nodeId]?.dynamicBindings?.[propKey]),
  )

  // ── Store actions ─────────────────────────────────────────────────────────

  const setNodePropBinding = useEditorStore((s) => s.setNodePropBinding)
  const clearNodePropBinding = useEditorStore((s) => s.clearNodePropBinding)
  const updateParamDefaultValue = useEditorStore((s) => s.updateParamDefaultValue)
  const renameParam = useEditorStore((s) => s.renameParam)
  const updateParamMeta = useEditorStore((s) => s.updateParamMeta)
  const addParam = useEditorStore((s) => s.addParam)

  // ── Derived data ──────────────────────────────────────────────────────────

  const boundParam = propBinding
    ? vcParams.find((p) => p.id === propBinding.paramId) ?? null
    : null

  const compatibleTypes = paramTypesCompatibleWithControl(control)
  const compatibleParams = vcParams.filter((p) => compatibleTypes.includes(p.type))

  // ── Handlers: bound state (ParamRow default-edit) ─────────────────────────

  function handleValueChange(next: unknown) {
    if (boundParam) {
      updateParamDefaultValue(vcId, boundParam.id, next)
    }
  }

  function handleParamRename(next: string) {
    if (boundParam) {
      renameParam(vcId, boundParam.id, next)
    }
  }

  function handleUnbind() {
    clearNodePropBinding(nodeId, propKey)
  }

  function handleAdvancedChange(patch: {
    required?: boolean
    description?: string
    enumOptions?: string[]
  }) {
    if (boundParam) {
      updateParamMeta(vcId, boundParam.id, patch)
    }
  }

  // ── Handlers: expose popover ──────────────────────────────────────────────

  function handleBindToExisting(paramId: string) {
    setNodePropBinding(nodeId, propKey, paramId)
    setExposeOpen(false)
  }

  function handleNewParamNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value
    setNewParamName(val)
    const result = validateParamName(val, vcParams)
    setNewParamNameError(result.ok ? null : result.reason)
  }

  function handleCreateParam() {
    const result = validateParamName(newParamName, vcParams)
    if (!result.ok) {
      setNewParamNameError(result.reason)
      return
    }
    const paramType = paramTypeForControl(control)
    const newParamId = addParam(vcId, newParamName, paramType, value)
    setNodePropBinding(nodeId, propKey, newParamId)
    setExposeOpen(false)
    setNewParamName(propKey)
    setNewParamNameError(null)
  }

  function handleCreateParamKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleCreateParam()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setExposeOpen(false)
    }
  }

  // ── Render: rule 4 — dynamic binding takes precedence ────────────────────

  if (hasDynamicBinding || compatibleTypes.length === 0) {
    return (
      <PropertyControlRenderer
        propKey={propKey}
        control={control}
        value={value}
        onChange={onChange}
        isOverride={isOverride}
      />
    )
  }

  // ── Render: param bound → show ParamRow in default-edit mode ─────────────

  if (propBinding && boundParam) {
    return (
      <ParamRow
        mode="default-edit"
        paramName={boundParam.name}
        paramType={boundParam.type}
        paramId={boundParam.id}
        value={boundParam.defaultValue}
        required={boundParam.required}
        description={boundParam.description}
        enumOptions={boundParam.enumOptions}
        existingParams={vcParams}
        onValueChange={handleValueChange}
        onParamRename={handleParamRename}
        onUnbind={handleUnbind}
        onAdvancedChange={handleAdvancedChange}
      />
    )
  }

  // ── Render: no binding → PropertyControlRenderer + expose icon ────────────

  return (
    <div className={styles.exposableRow}>
      <div className={styles.controlArea}>
        <PropertyControlRenderer
          propKey={propKey}
          control={control}
          value={value}
          onChange={onChange}
          isOverride={isOverride}
        />
      </div>

      <Button
        variant="ghost"
        size="micro"
        iconOnly
        aria-label={`Expose ${propKey} as param`}
        tooltip="Expose as component param"
        onClick={() => setExposeOpen((o) => !o)}
        className={styles.exposeButton}
      >
        <LinkIcon size={10} color="currentColor" aria-hidden="true" />
      </Button>

      {exposeOpen && (
        <div
          role="menu"
          aria-label={`${propKey} param binding`}
          className={styles.exposeMenu}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setExposeOpen(false)
          }}
        >
          {/* Bind to existing compatible param */}
          {compatibleParams.length > 0 && (
            <div className={styles.exposeMenuSection}>
              <span className={styles.exposeMenuLabel}>Bind to param</span>
              {compatibleParams.map((param) => (
                <Button
                  key={param.id}
                  variant="ghost"
                  size="sm"
                  align="start"
                  menuItem
                  role="menuitem"
                  onClick={() => handleBindToExisting(param.id)}
                >
                  {param.name}
                  <span className={styles.existingParamType}>
                    {param.type}
                  </span>
                </Button>
              ))}
              <div className={styles.exposeMenuDivider} />
            </div>
          )}

          {/* Create new param */}
          <div className={styles.exposeMenuSection}>
            <span className={styles.exposeMenuLabel}>Create param</span>
            <div className={styles.createParamForm}>
              <Input
                fieldSize="xs"
                value={newParamName}
                placeholder="paramName"
                onChange={handleNewParamNameChange}
                onKeyDown={handleCreateParamKeyDown}
                aria-label="New param name"
                invalid={!!newParamNameError}
                autoFocus
              />
              {newParamNameError && (
                <span className={styles.createParamError} role="alert">
                  {newParamNameError}
                </span>
              )}
              <div className={styles.createParamActions}>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={handleCreateParam}
                  disabled={!!newParamNameError || !newParamName}
                >
                  Add param
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
