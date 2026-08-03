import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'

describe('CanvasContextSelector labels', () => {
  const source = readFileSync(
    new URL('../../admin/pages/site/canvas/CanvasContextSelector.tsx', import.meta.url),
    'utf-8',
  )

  it('uses author-facing context labels instead of exposing breakpoint/media as peers', () => {
    expect(source).toContain("label: 'Viewport'")
    expect(source).toContain("label: 'Environment'")
    expect(source).not.toContain("label: 'Breakpoint'")
  })

  it('uses the selector trigger as the only active-context summary', () => {
    expect(source).toContain('className={styles.triggerPill}')
    expect(source).not.toContain('className={styles.badge}')
    expect(source).not.toContain('Stop editing this condition')
  })

  it('omits redundant condition details when the label is the query', () => {
    expect(source).toContain('const showDetail = def.label.trim() !== detail.trim()')
    expect(source).toContain('{showDetail && <span className={styles.rowDetail}>{detail}</span>}')
    expect(source).not.toContain(
      '<span className={styles.rowDetail}>{conditionLabel(def.condition)}</span>',
    )
  })
})
