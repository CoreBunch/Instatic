import { describe, expect, it } from 'bun:test'
import { buildScriptPath } from '@admin/shared/dialogs/SiteCreateDialog'

describe('buildScriptPath', () => {
  it('defaults scripts to TypeScript and preserves explicit TypeScript extensions', () => {
    expect(buildScriptPath('analytics')).toBe('src/scripts/analytics.ts')
    expect(buildScriptPath('src/scripts/runtime.ts')).toBe('src/scripts/runtime.ts')
    expect(buildScriptPath('widget.tsx')).toBe('src/scripts/widget.tsx')
    expect(buildScriptPath('worker.mts')).toBe('src/scripts/worker.mts')
  })
})
