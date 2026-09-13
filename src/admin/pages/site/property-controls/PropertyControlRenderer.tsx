/**
 * PropertyControlRenderer — dispatches a PropertyControl schema entry to the
 * correct React control component.
 *
 * Adds a structural shell for data-testid/state attributes while the concrete
 * control component owns its own row layout via controls.module.css.
 *
 * Row layout:
 *   - The schema-level `layout` field on a PropertyControl ('inline' | 'stacked')
 *     wins when present.
 *   - Otherwise, the renderer falls back to a sensible per-type default
 *     (`image`, `media`, `textarea`, and `svg` are stacked; everything else
 *     is inline). See `defaultLayoutFor`.
 *   - The resolved layout is forwarded to each concrete control component
 *     so individual controls don't need to repeat the resolution logic.
 */
import { useState } from 'react'
import type {
  PropertyControl,
  PropertyControlLayout,
  PropertySchema,
} from '@core/module-engine'
import { resolvePropertyControlCategory } from '@core/module-engine'
import type { DynamicPropBinding } from '@core/page-tree'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { TextControl } from './TextControl'
import { TextareaControl } from './TextareaControl'
import { NumberControl } from './NumberControl'
import { ColorControl } from './ColorControl'
import { SelectControl } from './SelectControl'
import { ToggleControl } from './ToggleControl'
import { ImageControl } from './ImageControl'
import { MediaLibraryControl } from './MediaLibraryControl'
import { UrlControl } from './UrlControl'
import { SvgControl } from './SvgControl'
import { DataTableControl } from './DataTableControl'
import { DynamicBindingControl } from './DynamicBindingControl'
import { getDynamicBindingMode } from '@admin/shared/DataBindingPicker/bindingCompatibility'
import { cn } from '@ui/cn'
import styles from './controls.module.css'

interface DynamicBindingRenderContext {
  binding?: DynamicPropBinding
  onSet: (binding: DynamicPropBinding) => void
  onClear: () => void
  /**
   * Fields available on the closest enclosing scope's source (a loop's
   * registered LoopEntitySource, or the page's content collection). When
   * present, the binding picker generates options from these instead of
   * the hard-coded content-entry option set. Field labels and id come from
   * the source's `fields` declaration.
   */
  availableFields?: import('@core/loops/types').LoopSourceField[]
  /** Optional human label for the binding source — shown in the picker. */
  sourceLabel?: string
  /**
   * When the enclosing loop is bound to a specific data table, this is its
   * table id. The picker uses it to auto-scope to that single table instead
   * of listing every table in the workspace.
   */
  loopTableId?: string | null
}

interface RenderControlOptions {
  propKey: string
  control: PropertyControl
  value: unknown
  onChange: (key: string, val: unknown) => void
  isOverride?: boolean
  disabled?: boolean
  dynamicBinding?: DynamicBindingRenderContext
}

/**
 * Per-control-type default row layout. A control that is fundamentally
 * unsuited to a 100px label column (media pickers with their own internal
 * layout, multi-line text areas) defaults to `stacked`; everything else
 * defaults to `inline`. The schema-level `layout` field overrides this.
 */
function defaultLayoutFor(controlType: PropertyControl['type']): PropertyControlLayout {
  switch (controlType) {
    case 'image':
    case 'media':
    case 'svg':
    case 'textarea':
      return 'stacked'
    default:
      return 'inline'
  }
}

/** Resolve the effective layout: explicit schema field beats per-type default. */
function resolveControlLayout(control: PropertyControl): PropertyControlLayout {
  return control.layout ?? defaultLayoutFor(control.type)
}

/**
 * Render a single property control wrapped in the test/accessibility shell.
 * Returns null for unknown or unimplemented control types.
 */
export function PropertyControlRenderer({
  propKey,
  control,
  value,
  onChange,
  isOverride = false,
  disabled = false,
  dynamicBinding,
}: RenderControlOptions) {
  const layout = resolveControlLayout(control)

  // Caller-permission gate: content props and structural module props are
  // separate edit modes. Holding `site.structure.edit` does not imply copy
  // editing permission.
  const permissions = useEditorPermissions()
  const category = resolvePropertyControlCategory(control)
  const allowedByCategory = category === 'content'
    ? permissions.canEditContent
    : permissions.canEditStructure
  const effectiveDisabled = disabled || !allowedByCategory

  const shared = {
    propKey,
    value,
    onChange,
    label: control.label,
    isOverride,
    disabled: effectiveDisabled,
    layout,
  }

  let inner: React.ReactNode

  switch (control.type) {
    case 'text':
      inner = (
        <TextControl
          {...shared}
          value={String(value ?? '')}
          placeholder={control.placeholder}
          normalize={control.normalize}
        />
      )
      break

    case 'textarea':
      inner = (
        <TextareaControl
          {...shared}
          value={String(value ?? '')}
          rows={control.rows}
          placeholder={control.placeholder}
        />
      )
      break

    case 'number':
      inner = (
        <NumberControl
          {...shared}
          value={Number(value ?? 0)}
          min={control.min}
          max={control.max}
          step={control.step}
          unit={control.unit}
        />
      )
      break

    case 'color':
      inner = <ColorControl {...shared} value={String(value ?? '')} format={control.format} />
      break

    case 'select':
      inner = <SelectControl {...shared} options={control.options} />
      break

    case 'toggle':
      inner = <ToggleControl {...shared} value={Boolean(value)} />
      break

    case 'image':
      inner = <ImageControl {...shared} value={String(value ?? '')} />
      break

    case 'media':
      inner = (
        <MediaLibraryControl
          {...shared}
          value={String(value ?? '')}
          mediaKind={control.mediaKind}
        />
      )
      break

    case 'url':
      inner = <UrlControl {...shared} value={String(value ?? '')} />
      break

    case 'dataTable':
      inner = (
        <DataTableControl
          {...shared}
          value={String(value ?? '')}
          includeSystem={control.includeSystem}
        />
      )
      break

    case 'svg':
      inner = <SvgControl {...shared} value={String(value ?? '')} />
      break

    case 'richtext':
      return null

    case 'group':
      inner = (
        <GroupSection
          label={control.label}
          schema={control.children}
          props={{ [propKey]: value } as Record<string, unknown>}
          onChange={onChange}
          isOverride={isOverride}
          disabled={disabled}
          defaultCollapsed={control.collapsed}
        />
      )
      break

    default:
      return null
  }

  if (control.type === 'group') {
    return (
      <div data-testid={`property-control-${propKey}`}>
        {inner}
      </div>
    )
  }

  // Bake the resolved disabled flag into the inner-content for the
  // DynamicBindingControl branch below.
  const isDisabled = effectiveDisabled

  // Binding mode is explicit. Token mode is only for free text-ish props
  // that can safely contain `{source.field}` snippets. Structured mode
  // writes a whole-prop dynamicBindings overlay for non-token values such
  // as media URLs, numbers, and booleans.
  const bindingMode = getDynamicBindingMode(control)

  const content = dynamicBinding && !isDisabled && bindingMode !== null ? (
    <DynamicBindingControl
      propKey={propKey}
      label={control.label ?? propKey}
      control={control}
      layout={layout}
      binding={dynamicBinding.binding}
      onSet={dynamicBinding.onSet}
      onClear={dynamicBinding.onClear}
      insertMode={bindingMode === 'token'}
      onInsertToken={(token) => {
        // Append to the current string value with a leading space when
        // the value isn't empty. Stage A — caret-position-aware
        // insertion lands in Stage B with the chip UI.
        const current = typeof value === 'string' ? value : ''
        const next = current.length === 0 ? token : `${current} ${token}`
        onChange(propKey, next)
      }}
      availableFields={dynamicBinding.availableFields}
      sourceLabel={dynamicBinding.sourceLabel}
      loopTableId={dynamicBinding.loopTableId}
    >
      {inner}
    </DynamicBindingControl>
  ) : inner

  return (
    <div
      data-testid={`property-control-${propKey}`}
      data-disabled={isDisabled ? 'true' : undefined}
      data-category={category}
      data-override={isOverride ? 'true' : undefined}
      data-layout={layout}
    >
      {content}
    </div>
  )
}

// ---------------------------------------------------------------------------
// GroupSection — visual grouping with collapsible header
// ---------------------------------------------------------------------------

interface GroupSectionProps {
  label: string
  schema: PropertySchema
  props: Record<string, unknown>
  onChange: (key: string, val: unknown) => void
  isOverride?: boolean
  disabled?: boolean
  defaultCollapsed?: boolean
}

function GroupSection({
  label,
  schema,
  props,
  onChange,
  isOverride,
  disabled,
  defaultCollapsed = false,
}: GroupSectionProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  return (
    <div className={styles.groupWrapper}>
      {/* Group header */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className={styles.groupHeader}
      >
        <span className={cn(styles.groupChevron, !collapsed && styles.groupChevronExpanded)}>
          <ChevronRightIcon size={10} />
        </span>
        {label}
      </button>

      {/* Group children */}
      {!collapsed && (
        <div className={styles.groupChildren}>
          {Object.entries(schema).map(([key, ctrl]) => (
            <PropertyControlRenderer
              key={key}
              propKey={key}
              control={ctrl}
              value={props[key]}
              onChange={onChange}
              isOverride={isOverride}
              disabled={disabled}
            />
          ))}
        </div>
      )}
    </div>
  )
}
