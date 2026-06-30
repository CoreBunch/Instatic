import { useRef } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Switch } from '@ui/components/Switch'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import type { GeneratorShape, GroupShape, ScaleAdapter } from './adapter'
import styles from './ClassGenerator.module.css'

/**
 * One row of the class generator: pattern input + property select + on/off
 * switch + delete. Owns its own grid-row ref so the property Select's
 * dropdown can span the full row instead of being clipped to the column
 * width — matches the wider-menu treatment used on the ratio Selects.
 */
export function ClassGeneratorRow<C extends GeneratorShape>({
  generator,
  adapter,
  onPatch,
  onDelete,
}: {
  generator: C
  adapter: ScaleAdapter<GroupShape, C>
  onPatch: (id: string, patch: Partial<C>) => void
  onDelete: (id: string) => void
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={rowRef} className={styles.classGeneratorRow}>
      <Input
        fieldSize="sm"
        aria-label="Class pattern"
        value={generator.name}
        prefix="."
        onChange={(event) => onPatch(generator.id, { name: event.target.value } as Partial<C>)}
        monospace
      />
      <Select
        fieldSize="sm"
        aria-label="CSS property"
        value={generator.property[0] ?? ''}
        menuAnchorRef={rowRef}
        options={adapter.classGeneratorProperties.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
        onChange={(event) =>
          onPatch(generator.id, {
            property: [event.currentTarget.value],
          } as Partial<C>)
        }
      />
      <Switch
        checked={generator.isDisabled !== true}
        onCheckedChange={(checked) =>
          onPatch(generator.id, { isDisabled: !checked } as Partial<C>)
        }
        switchSize="sm"
        aria-label="Enabled"
      />
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        aria-label="Delete class"
        onClick={() => onDelete(generator.id)}
      >
        <TrashSolidIcon size={12} />
      </Button>
    </div>
  )
}
