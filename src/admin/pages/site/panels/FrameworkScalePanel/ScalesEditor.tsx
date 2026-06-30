import { type MouseEvent } from 'react'
import { Button } from '@ui/components/Button'
import { FilterBar, type FilterBarItem } from '@ui/components/FilterBar'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import type { resolveFrameworkPreferences } from '@core/framework'
import type { FrameworkScaleMode } from '@core/framework-schema'
import { FluidEditor } from './FluidEditor'
import { ManualEditor } from './ManualEditor'
import type { GeneratorShape, GroupShape, ScaleAdapter } from './adapter'
import styles from './ScalesEditor.module.css'

interface ScalesEditorProps<G extends GroupShape, C extends GeneratorShape> {
  group: G
  groups: G[]
  adapter: ScaleAdapter<G, C>
  preferences: ReturnType<typeof resolveFrameworkPreferences>
  onContextMenu: (event: MouseEvent<HTMLElement>) => void
  onActivateGroup: (groupId: string) => void
  onAddGroup: () => void
  onDeleteGroup: () => void
}

/**
 * The "scale exists, module enabled" body of the Scales section: scale picker
 * filter bar, a single heading row (name + `--`-prefixed variable + mode), and
 * the fluid/manual editor. The empty / disabled empty-states live one level up
 * in `PanelBody` so the surrounding sections (extras, utilities) stay reachable.
 */
export function ScalesEditor<G extends GroupShape, C extends GeneratorShape>({
  group,
  groups,
  adapter,
  preferences,
  onContextMenu,
  onActivateGroup,
  onAddGroup,
  onDeleteGroup,
}: ScalesEditorProps<G, C>) {
  return (
    <>
      <FilterBar<string>
        items={groups.map<FilterBarItem<string>>((g) => ({
          value: g.id,
          label: g.name,
        }))}
        value={group.id}
        onValueChange={onActivateGroup}
        groupLabel={`${adapter.title} scales`}
        inlineActions={
          <Button
            variant="secondary"
            size="xs"
            aria-label={`Add ${adapter.title.toLowerCase()} scale`}
            onClick={onAddGroup}
          >
            Add scale
          </Button>
        }
      />

      <div className={styles.tabHeading} onContextMenu={onContextMenu}>
        <div className={styles.tabHeadingName}>
          <Input
            fieldSize="sm"
            aria-label="Scale name"
            value={group.name}
            onChange={(event) => adapter.onUpdateGroup(group.id, { name: event.target.value })}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            tone="danger"
            aria-label="Remove scale"
            tooltip="Remove scale"
            onClick={onDeleteGroup}
          >
            <TrashSolidIcon size={13} aria-hidden="true" />
          </Button>
        </div>
        <div className={styles.tabHeadingMeta}>
          <Input
            fieldSize="sm"
            aria-label="Variable prefix"
            value={group.namingConvention}
            prefix="--"
            onChange={(event) =>
              adapter.onUpdateGroup(group.id, { namingConvention: event.target.value })
            }
            monospace
          />
          <Select
            fieldSize="sm"
            aria-label="Scale mode"
            value={group.mode}
            options={[
              { value: 'fluid', label: 'Automatic' },
              { value: 'fluid_manual', label: 'Manual' },
            ]}
            onChange={(event) =>
              adapter.onUpdateGroup(group.id, {
                mode: event.currentTarget.value as FrameworkScaleMode,
              })
            }
          />
        </div>
      </div>

      {group.mode === 'fluid_manual' ? (
        <ManualEditor group={group} adapter={adapter} />
      ) : (
        <FluidEditor group={group} adapter={adapter} preferences={preferences} />
      )}
    </>
  )
}
