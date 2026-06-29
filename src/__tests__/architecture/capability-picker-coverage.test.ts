/**
 * Architecture gate — every entry in `CORE_CAPABILITIES` must appear in
 * `CAPABILITY_META` AND in one `CAPABILITY_GROUPS` section. Otherwise a
 * new capability added to the canonical list would silently fall out of the
 * role-edit UI — admins couldn't grant it to a custom role.
 *
 * There is no longer a server-vs-client mirror check: `CORE_CAPABILITIES`
 * is defined once in `@core/capabilities` and imported by the server, so the
 * two sides cannot drift. This gate only guards the picker metadata, which is
 * genuinely separate from the list.
 */

import { describe, expect, it } from 'bun:test'
import { CORE_CAPABILITIES } from '@core/capabilities'
import { ALL_PICKER_CAPABILITIES } from '@admin/pages/users/utils/capabilities'
import { CAPABILITY_META } from '@admin/shared/CapabilityPicker'

describe('capability picker coverage', () => {
  it('every CoreCapability has a CAPABILITY_META entry', () => {
    const missing = CORE_CAPABILITIES.filter((cap) => !(cap in CAPABILITY_META))
    if (missing.length > 0) {
      throw new Error(
        `[capability-picker-coverage] capabilities missing from CAPABILITY_META:\n` +
        missing.map((c) => `  - ${c}`).join('\n') +
        `\n\nAdd a { label, description } entry in ` +
        `src/admin/shared/CapabilityPicker/capabilityMeta.ts so the picker ` +
        `can render a human-readable row for each grant.`,
      )
    }
    expect(missing).toHaveLength(0)
  })

  it('every CoreCapability appears in one CAPABILITY_GROUPS section', () => {
    const pickerSet = new Set(ALL_PICKER_CAPABILITIES)
    const missing = CORE_CAPABILITIES.filter((cap) => !pickerSet.has(cap))
    if (missing.length > 0) {
      throw new Error(
        `[capability-picker-coverage] capabilities not assigned to a picker group:\n` +
        missing.map((c) => `  - ${c}`).join('\n') +
        `\n\nAdd each capability to the appropriate { title, capabilities } ` +
        `entry in CAPABILITY_GROUPS so the role-edit dialog renders a ` +
        `checkbox for it.`,
      )
    }
    expect(missing).toHaveLength(0)
  })

  it('CAPABILITY_GROUPS does not reference unknown capabilities', () => {
    const coreSet = new Set<string>(CORE_CAPABILITIES)
    const orphans = ALL_PICKER_CAPABILITIES.filter((cap) => !coreSet.has(cap))
    if (orphans.length > 0) {
      throw new Error(
        `[capability-picker-coverage] picker references capabilities that ` +
        `are not in CORE_CAPABILITIES:\n` +
        orphans.map((c) => `  - ${c}`).join('\n') +
        `\n\nEither remove them from CAPABILITY_GROUPS or add them to ` +
        `CORE_CAPABILITIES in both src/core/capabilities.ts and ` +
        `server/auth/capabilities.ts.`,
      )
    }
    expect(orphans).toHaveLength(0)
  })
})
