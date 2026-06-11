import { describe, expect, it, beforeAll } from 'bun:test'
import { parseSiteDocument } from '@core/page-tree'
import { makePage, makeSite } from '../publisher/helpers'

let buildSystemPromptForScope: typeof import('../../../server/ai/handlers/chat')['buildSystemPromptForScope']

beforeAll(async () => {
  await import('../../../src/modules/base') // register base modules in this process
  ;({ buildSystemPromptForScope } = await import('../../../server/ai/handlers/chat'))
})

function validSnapshot() {
  const page = makePage({
    root: { moduleId: 'base.body', children: ['t'] },
    t: { moduleId: 'base.text', props: { text: 'Hi', tag: 'h1' } },
  })
  page.title = 'Passthrough Page'
  // Run the loose fixture through the canonical shell parser so it gains the
  // explorer/runtime defaults a real editor snapshot always carries, then
  // re-attach the page + VC arrays the parser strips out.
  const base = makeSite({ pages: [page] })
  const site = { ...parseSiteDocument(base), pages: [page], visualComponents: [], layouts: [] }
  return { page, site, selectedNodeId: null, activeBreakpointId: 'desktop' }
}

describe('buildSystemPromptForScope — site snapshot validation', () => {
  it('passes a valid snapshot through to the prompt builder', () => {
    const prompt = buildSystemPromptForScope('site', validSnapshot())
    expect(prompt).toHaveLength(3)
    expect(prompt.join(' ')).toContain('Passthrough Page')
    // The empty-fallback title must NOT appear for a real snapshot.
    expect(prompt.join(' ')).not.toContain('"Untitled"')
  })

  it('falls back to the empty snapshot (not a throw) when the body is malformed', () => {
    // `page` is the wrong type, `site` missing required shell fields, etc.
    const malformed = { page: 'not-a-page', site: 42, selectedNodeId: {}, activeBreakpointId: 7 }
    let prompt: string[] | undefined
    expect(() => {
      prompt = buildSystemPromptForScope('site', malformed)
    }).not.toThrow()
    expect(prompt).toHaveLength(3)
    // Empty fallback uses the "Untitled" placeholder page.
    expect(prompt!.join(' ')).toContain('Untitled')
  })

  it('falls back to the empty snapshot when no snapshot is posted', () => {
    const fromUndefined = buildSystemPromptForScope('site', undefined)
    const fromNull = buildSystemPromptForScope('site', null)
    const fromMalformed = buildSystemPromptForScope('site', { page: 'nope' })
    expect(fromUndefined.join(' ')).toContain('Untitled')
    // Missing and malformed both resolve to the same empty-fallback prompt.
    expect(fromNull).toEqual(fromUndefined)
    expect(fromMalformed).toEqual(fromUndefined)
  })
})
