/**
 * Architecture gate — Binding compatibility coverage
 *
 * Enforces three structural invariants on the BINDING_COMPATIBILITY map
 * (`src/admin/shared/DataBindingPicker/bindingCompatibility.ts`)
 * and the `DATA_FIELD_TYPES` array (`src/core/data/schemas.ts`):
 *
 *   1. Every PropertyControlKind has an entry in BINDING_COMPATIBILITY.
 *      TypeScript's `Record<PropertyControlKind, ...>` already enforces this
 *      at compile time, but a runtime check provides cheap insurance against
 *      `as any` bypasses.
 *
 *   2. No spurious type appears in any BINDING_COMPATIBILITY value array.
 *      Every type listed as compatible must be a real `DataFieldType` member.
 *      Catches typos and stale entries.
 *
 *   3. Every DataFieldType appears in at least one control's compatibility list.
 *      A field type invisible to the picker cannot be bound by page authors.
 *      If a new field type is added to `DataFieldSchema`, it must also be wired
 *      into BINDING_COMPATIBILITY. The covered-types set must equal the full
 *      `DATA_FIELD_TYPES` set — neither a subset nor a superset.
 *
 * @see src/core/data/schemas.ts — DATA_FIELD_TYPES / DataFieldType
 * @see src/admin/shared/DataBindingPicker/bindingCompatibility.ts
 */

import { describe, test, expect } from 'bun:test'
import { DATA_FIELD_TYPES } from '@core/data/schemas'
import { BINDING_COMPATIBILITY } from '@admin/shared/DataBindingPicker/bindingCompatibility'

/**
 * The complete list of PropertyControlKind values, mirrored from
 * `src/core/module-engine/propertySchema.ts`. Hard-coded here so the test
 * can catch any mismatch at runtime (same approach as the unit test in
 * `src/__tests__/property-controls/bindingCompatibility.test.ts`).
 */
const ALL_CONTROL_KINDS = [
  'text', 'textarea', 'number', 'color', 'select', 'toggle',
  'image', 'media', 'url', 'dataTable', 'richtext', 'svg', 'group',
] as const

describe('BINDING_COMPATIBILITY — architecture coverage', () => {
  test('every PropertyControlKind has an entry (runtime guard against as-any bypasses)', () => {
    for (const kind of ALL_CONTROL_KINDS) {
      expect(BINDING_COMPATIBILITY).toHaveProperty(kind)
    }
  })

  test('no spurious DataFieldType in compat values — every listed type is a real DataFieldType', () => {
    const validTypes = new Set<string>(DATA_FIELD_TYPES)
    const allListed = Object.values(BINDING_COMPATIBILITY).flat()
    const invalid = allListed.filter((t) => !validTypes.has(t))

    if (invalid.length > 0) {
      const unique = [...new Set(invalid)]
      throw new Error(
        `[binding-compatibility-coverage] ${unique.length} unknown type(s) found in BINDING_COMPATIBILITY values.\n` +
          `These are not members of DATA_FIELD_TYPES — fix the typo or add the type to DATA_FIELD_TYPES.\n\n` +
          `Unknown types: ${unique.map((t) => JSON.stringify(t)).join(', ')}`,
      )
    }

    expect(invalid).toHaveLength(0)
  })

  test('every DataFieldType is bindable to at least one PropertyControl', () => {
    const coveredTypes = new Set(Object.values(BINDING_COMPATIBILITY).flat())
    const uncovered = DATA_FIELD_TYPES.filter((t) => !coveredTypes.has(t))

    if (uncovered.length > 0) {
      throw new Error(
        `[binding-compatibility-coverage] ${uncovered.length} DataFieldType(s) not bindable to any property control.\n` +
          `Update bindingCompatibility.ts to add entries for these types.\n\n` +
          uncovered
            .map(
              (t) =>
                `  Field type ${JSON.stringify(t)} is not bindable to any property control. Update bindingCompatibility.ts.`,
            )
            .join('\n'),
      )
    }

    expect(coveredTypes).toEqual(new Set(DATA_FIELD_TYPES))
  })
})
