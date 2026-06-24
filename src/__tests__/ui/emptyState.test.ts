import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'

describe('EmptyState styles', () => {
  it('uses text hierarchy tokens for description copy', () => {
    const css = readFileSync(
      new URL('../../ui/components/EmptyState/EmptyState.module.css', import.meta.url),
      'utf-8',
    )

    expect(css).toMatch(/\.description\s*\{[^}]*color:\s*var\(--text-subtle\)/s)
    expect(css).not.toMatch(/\.description\s*\{[^}]*color:\s*var\(--border/s)
  })
})
