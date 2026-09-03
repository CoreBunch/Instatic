/**
 * editorTourSteps — shape coverage. The step-by-step editor behavior
 * (prepare() opening the right panels) is exercised indirectly through the
 * store slices it calls; this test locks the tour's structural contract:
 * exact ids, in order, unique, and every step has real copy.
 */
import { describe, expect, it } from 'bun:test'
import { editorTourSteps } from './editorTourSteps'

const EXPECTED_IDS = ['welcome', 'explorer', 'new-page', 'modules', 'properties', 'framework', 'publish']

describe('editorTourSteps', () => {
  it('has the expected step ids, in order', () => {
    expect(editorTourSteps.map((step) => step.id)).toEqual(EXPECTED_IDS)
  })

  it('has unique step ids', () => {
    const ids = editorTourSteps.map((step) => step.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every step has a non-empty title and body', () => {
    for (const step of editorTourSteps) {
      expect(step.title.length).toBeGreaterThan(0)
      expect(step.body.length).toBeGreaterThan(0)
    }
  })
})
