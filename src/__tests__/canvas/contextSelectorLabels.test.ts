import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'

describe('CanvasContextSelector labels', () => {
  const source = readFileSync(
    new URL('../../admin/pages/site/canvas/CanvasContextSelector.tsx', import.meta.url),
    'utf-8',
  )

  it('uses author-facing context labels instead of exposing breakpoint/media as peers', () => {
    const dialog = readFileSync(
      new URL('../../admin/pages/site/canvas/CanvasContextDialog.tsx', import.meta.url),
      'utf-8',
    )
    expect(dialog).toContain("label: 'Viewport'")
    expect(dialog).toContain("label: 'Environment'")
    expect(dialog).not.toContain("label: 'Breakpoint'")
  })

  it('uses the selector trigger as the only active-context summary', () => {
    expect(source).toContain('className={styles.triggerPill}')
    expect(source).not.toContain('className={styles.badge}')
    expect(source).not.toContain('Stop editing this condition')
  })

  it('omits redundant condition details when the label is the query', () => {
    expect(source).toContain('detail: def.label.trim() === query.trim() ? null : query')
    expect(source).toContain('{context.detail && <span className={styles.rowDetail}>{context.detail}</span>}')
    expect(source).not.toContain(
      '<span className={styles.rowDetail}>{conditionLabel(def.condition)}</span>',
    )
  })
})
