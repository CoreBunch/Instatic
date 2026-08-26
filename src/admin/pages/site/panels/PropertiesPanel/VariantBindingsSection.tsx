/**
 * VariantBindingsSection — editor UI for a VC node's variant (class) bindings.
 *
 * A variant is an enum param whose selected value appends a CLASS to this node
 * at instantiation (`classBindings`). It exists because `class` is not a prop,
 * so `propBindings` can never change appearance. Until now this channel was
 * reachable only through the agent tool `site_bind_component_variant`; this
 * section drives the same store action (`setNodeClassBinding`) from the panel.
 *
 * Lists EVERY enum param of the component, not just the ones already bound on
 * this node, so a freshly created variant param is immediately mappable. A
 * value mapped to "No class" adds nothing — that is how a "default" option
 * works — and a param with no mapped values carries no binding on this node.
 *
 * Rendered only in VC edit mode for style-capable editors (a variant is
 * appearance, same gate as ClassPicker).
 */
import { useState } from 'react'
import { useEditorStore } from '@site/store/store'
import { isUserVisibleClass, type PageNode, type StyleRule } from '@core/page-tree'
import type { VisualComponent, VCParam } from '@core/visualComponents'
import { validateParamName } from '@core/visualComponents'
import { Section } from '@ui/components/Section'
import { Select } from '@ui/components/Select'
import { Input } from '@ui/components/Input'
import { Button } from '@ui/components/Button'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import styles from './VariantBindingsSection.module.css'

interface VariantBindingsSectionProps {
  nodeId: string
  node: PageNode
  vc: VisualComponent
}

interface ClassOption {
  id: string
  name: string
}

function classOptionsFromRules(rules: Record<string, StyleRule> | undefined): ClassOption[] {
  if (!rules) return []
  return Object.values(rules)
    .filter((r) => r.kind === 'class' && isUserVisibleClass(r))
    .map((r) => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Per-param editor — value → class rows plus an "add option" form
// ---------------------------------------------------------------------------

interface ParamVariantEditorProps {
  vcId: string
  nodeId: string
  param: VCParam
  binding: Record<string, string>
  classOptions: ClassOption[]
}

function ParamVariantEditor({ vcId, nodeId, param, binding, classOptions }: ParamVariantEditorProps) {
  const setNodeClassBinding = useEditorStore((s) => s.setNodeClassBinding)
  const updateParamMeta = useEditorStore((s) => s.updateParamMeta)
  const [newOption, setNewOption] = useState('')
  const [optionError, setOptionError] = useState('')

  const options = param.enumOptions ?? []

  const mapValue = (value: string, classId: string) => {
    const next = { ...binding }
    if (classId) next[value] = classId
    else delete next[value]
    setNodeClassBinding(nodeId, param.id, next)
  }

  const addOption = () => {
    const value = newOption.trim()
    if (!value) return
    if (options.includes(value)) {
      setOptionError(`"${value}" already exists`)
      return
    }
    updateParamMeta(vcId, param.id, { enumOptions: [...options, value] })
    setNewOption('')
    setOptionError('')
  }

  return (
    <div className={styles.param}>
      <p className={styles.paramName}>{param.name}</p>

      {options.map((value) => (
        <div key={value} className={styles.valueRow}>
          <span className={styles.valueLabel}>{value}</span>
          <Select
            fieldSize="sm"
            value={binding[value] ?? ''}
            onChange={(e) => mapValue(value, e.target.value)}
            aria-label={`Class for ${param.name}: ${value}`}
          >
            <option value="">No class</option>
            {classOptions.map((cls) => (
              <option key={cls.id} value={cls.id}>{cls.name}</option>
            ))}
          </Select>
        </div>
      ))}

      <div className={styles.addRow}>
        <Input
          fieldSize="sm"
          value={newOption}
          onChange={(e) => { setNewOption(e.target.value); setOptionError('') }}
          onKeyDown={(e) => { if (e.key === 'Enter') addOption() }}
          placeholder="New option…"
          aria-label={`Add option to ${param.name}`}
        />
        <Button variant="ghost" size="xs" onClick={addOption} disabled={!newOption.trim()}>
          <PlusIcon size={12} color="currentColor" />
        </Button>
      </div>
      {optionError ? <p className={styles.error} role="alert">{optionError}</p> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section — all enum params + "add variant" form
// ---------------------------------------------------------------------------

export function VariantBindingsSection({ nodeId, node, vc }: VariantBindingsSectionProps) {
  const styleRules = useEditorStore((s) => s.site?.styleRules)
  const addParam = useEditorStore((s) => s.addParam)
  const updateParamMeta = useEditorStore((s) => s.updateParamMeta)
  const [newName, setNewName] = useState('')
  const [nameError, setNameError] = useState('')

  const enumParams = vc.params.filter((p) => p.type === 'enum')
  const classOptions = classOptionsFromRules(styleRules ?? undefined)
  const boundCount = Object.keys(node.classBindings ?? {}).length

  const createVariant = () => {
    const name = newName.trim()
    if (!name) return
    const validation = validateParamName(name, vc.params)
    if (!validation.ok) {
      setNameError(validation.reason)
      return
    }
    // Seeded with a "default" option mapped to nothing, so the param renders
    // a working dropdown immediately; the author adds real options below.
    const paramId = addParam(vc.id, name, 'enum', 'default')
    updateParamMeta(vc.id, paramId, { enumOptions: ['default'] })
    setNewName('')
    setNameError('')
  }

  return (
    <Section title="Variants" icon={PaintBucketSolidIcon} defaultOpen={boundCount > 0}>
      <div className={styles.body}>
        <p className={styles.hint}>
          Each option of an enum param can add a class to this element on every instance.
        </p>

        {enumParams.map((param) => (
          <ParamVariantEditor
            key={param.id}
            vcId={vc.id}
            nodeId={nodeId}
            param={param}
            binding={node.classBindings?.[param.id] ?? {}}
            classOptions={classOptions}
          />
        ))}

        <div className={styles.addRow}>
          <Input
            fieldSize="sm"
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setNameError('') }}
            onKeyDown={(e) => { if (e.key === 'Enter') createVariant() }}
            placeholder="New variant param…"
            aria-label="New variant param name"
          />
          <Button variant="ghost" size="xs" onClick={createVariant} disabled={!newName.trim()}>
            <PlusIcon size={12} color="currentColor" />
            Add
          </Button>
        </div>
        {nameError ? <p className={styles.error} role="alert">{nameError}</p> : null}
      </div>
    </Section>
  )
}
