import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { styleMcpTools } from '../../../server/ai/mcp/tools/styleTools'
import { getDraftSite, saveDraftSite } from '../../../server/repositories/site'
import type { ToolContext } from '../../../server/ai/runtime/types'

async function seedClass(harness: CapabilityTestHarness): Promise<void> {
  const site = await getDraftSite(harness.db)
  if (!site) throw new Error('no default site')
  const now = Date.now()
  site.styleRules['r_testcard'] = {
    id: 'r_testcard',
    name: 'test-card',
    kind: 'class',
    selector: '.test-card',
    order: 0,
    styles: { color: 'red', padding: '10px' },
    contextStyles: {},
    createdAt: now,
    updatedAt: now,
  }
  await saveDraftSite(harness.db, site)
}

function ctxFor(harness: CapabilityTestHarness): ToolContext {
  return {
    db: harness.db,
    userId: 'u1',
    capabilities: ['site.read'],
    scope: 'site',
    conversationId: 'test',
    snapshot: null, // headless — no browser snapshot, unlike the old list_tokens
    signal: new AbortController().signal,
  }
}

const readStyles = styleMcpTools.find((t) => t.name === 'site_read_styles')!
const listBreakpoints = styleMcpTools.find((t) => t.name === 'site_list_breakpoints')!

describe('read_styles (headless design-system read)', () => {
  let harness: CapabilityTestHarness
  let originalError: typeof console.error

  beforeEach(async () => {
    originalError = console.error
    console.error = () => {}
    harness = await createCapabilityTestHarness()
    await harness.setupOwner() // creates the default site shell
  })
  afterEach(() => { console.error = originalError })

  it('returns a seeded class as CSS without needing a snapshot', async () => {
    await seedClass(harness)
    const out = (await readStyles.handler!({}, ctxFor(harness))) as { css: string; classCount: number }
    expect(typeof out.css).toBe('string')
    expect(out.classCount).toBe(1)
    expect(out.css).toContain('.test-card')
    expect(out.css).toContain('color: red')
  })

  it('can scope output to a single class by name', async () => {
    await seedClass(harness)
    const out = (await readStyles.handler!({ className: 'test-card' }, ctxFor(harness))) as { css: string }
    expect(out.css).toContain('.test-card')
  })

  it('summary mode returns a compact catalog (selector + token refs, no declarations)', async () => {
    const site = await getDraftSite(harness.db)
    const now = Date.now()
    site!.styleRules['r_tok'] = {
      id: 'r_tok', name: 'tok-card', kind: 'class', selector: '.tok-card', order: 0,
      styles: { color: 'var(--ist-accent)', padding: '8px' }, contextStyles: {}, createdAt: now, updatedAt: now,
    }
    await saveDraftSite(harness.db, site!)
    const out = (await readStyles.handler!({ format: 'summary' }, ctxFor(harness))) as {
      classes: Array<{ selector: string; tokens: string[] }>
    }
    const card = out.classes.find((c) => c.selector === '.tok-card')!
    expect(card).toBeTruthy()
    expect(card.tokens).toContain('--ist-accent')
    // summary carries no declarations
    expect(JSON.stringify(out)).not.toContain('padding')
  })

  it('list_breakpoints returns the configured viewports headlessly', async () => {
    const out = (await listBreakpoints.handler!({}, ctxFor(harness))) as {
      breakpoints: Array<{ id: string; label: string; width: number; isBase: boolean }>
    }
    expect(Array.isArray(out.breakpoints)).toBe(true)
    expect(out.breakpoints.length).toBeGreaterThan(0)
    expect(out.breakpoints[0]).toHaveProperty('id')
    expect(out.breakpoints[0].isBase).toBe(true)
    expect(listBreakpoints.execution).toBe('server')
  })

  it('errors clearly for an unknown class name', async () => {
    const out = (await readStyles.handler!({ className: 'no-such-class' }, ctxFor(harness))) as {
      ok?: boolean
      error?: string
    }
    expect(out.ok).toBe(false)
    expect(out.error).toContain('no-such-class')
  })

  it('is gated on a site read capability', () => {
    expect(readStyles.requiredCapabilities).toContain('site.read')
    expect(readStyles.execution).toBe('server')
    expect(readStyles.mutates).toBeFalsy()
  })
})
