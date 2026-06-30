import { Button } from '@ui/components/Button'
import { ClassGeneratorRow } from './ClassGeneratorRow'
import type { GeneratorShape, GroupShape, ScaleAdapter } from './adapter'
import styles from './ClassGenerator.module.css'

/**
 * "Utilities" section body — one row per class-generator pattern bound to
 * the active scale group. Other groups' rows are preserved when the user
 * adds/edits/removes within this group.
 */
export function ClassGeneratorList<C extends GeneratorShape>({
  groupId,
  groupNamingConvention,
  adapter,
  classes,
}: {
  groupId: string
  groupNamingConvention: string
  adapter: ScaleAdapter<GroupShape, C>
  classes: C[]
}) {
  const localClasses = classes.filter((c) => c.tabId === groupId)

  function patchClasses(next: C[]) {
    // Replace just the rows belonging to this group; preserve other groups'.
    const others = classes.filter((c) => c.tabId !== groupId)
    adapter.onSetClassGenerators([...others, ...next])
  }

  function handleAdd() {
    const fresh = {
      id: crypto.randomUUID(),
      name: `${groupNamingConvention}-*`,
      property: [adapter.classGeneratorProperties[0]?.value ?? ''],
      tabId: groupId,
    } as unknown as C
    patchClasses([...localClasses, fresh])
  }

  function handlePatch(id: string, patch: Partial<C>) {
    patchClasses(localClasses.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }

  function handleDelete(id: string) {
    patchClasses(localClasses.filter((c) => c.id !== id))
  }

  return (
    <div className={styles.classGenerator} aria-label="Class generator">
      <p className={styles.classGeneratorHint}>
        Turn the sizes above into reusable utility classes you can apply across your site.
      </p>
      {localClasses.length > 0 && (
        <div className={styles.classGeneratorRows}>
          {localClasses.map((generator) => (
            <ClassGeneratorRow
              key={generator.id}
              generator={generator}
              adapter={adapter}
              onPatch={handlePatch}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
      <div className={styles.classGeneratorActions}>
        <Button variant="secondary" size="sm" onClick={handleAdd}>
          Generate utility
        </Button>
      </div>
    </div>
  )
}
