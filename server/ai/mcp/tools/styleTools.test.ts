import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { makeSite } from '../../../../src/__tests__/fixtures'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../../../../src/__tests__/helpers/capabilityHarness'
import { saveDraftSite } from '../../../repositories/site'
import type { ToolContext } from '../../runtime/types'
import { styleMcpTools } from './styleTools'
import { MAIN_SCOPE } from '../../../branches/scope'

describe('MCP site_read_styles', () => {
  let harness: CapabilityTestHarness

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  it('includes Core Framework font-token variables in token-inclusive reads', async () => {
    const base = makeSite()
    await saveDraftSite(harness.db, MAIN_SCOPE, {
      ...base,
      settings: {
        ...base.settings,
        fonts: {
          items: [{
            id: 'font-1',
            source: 'custom',
            family: 'Example Sans',
            variants: ['400'],
            subsets: ['latin'],
            files: [],
            createdAt: 0,
            updatedAt: 0,
          }],
          tokens: [{
            id: 'font-token-1',
            name: 'Primary',
            variable: 'font-primary',
            familyId: 'font-1',
            fallback: 'sans-serif',
            order: 0,
            createdAt: 0,
            updatedAt: 0,
          }],
        },
      },
    })

    const tool = styleMcpTools.find((candidate) => candidate.name === 'site_read_styles')
    if (!tool?.handler) throw new Error('site_read_styles handler is missing')

    const context: ToolContext = {
      db: harness.db,
      userId: 'owner',
      capabilities: ['site.read'],
      scope: 'site',
      branch: MAIN_SCOPE,
      conversationId: 'test',
      snapshot: null,
      signal: new AbortController().signal,
    }
    const result = await tool.handler({ includeTokens: true }, context) as {
      css: string
      classCount: number
    }

    expect(result.css).toContain('--font-primary: "Example Sans", sans-serif;')
  })
})
