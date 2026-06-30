/**
 * AI tool capability gating — the fix for security finding #1
 * (docs/plans/2026-06-12-security-hardening.md): granting `ai.chat` must not
 * hand the model a blanket read of users, documents, drafts, and media.
 *
 * Three layers under test:
 *   1. `toolAllowedForCapabilities` — the single gate helper (both axes:
 *      `mutates` ⇒ `ai.tools.write`, plus ANY-OF `requiredCapabilities`).
 *   2. `selectToolsForScope` — selection-time filtering (load-bearing gate:
 *      the tool loop only executes offered tools).
 *   3. `executeAiTool` — pre-dispatch re-check (defence in depth).
 */

import { describe, expect, it } from 'bun:test'
import { Type } from '@sinclair/typebox'
import { toolAllowedForCapabilities } from '../../../server/ai/tools/capabilityGate'
import { selectToolsForScope } from '../../../server/ai/tools'
import { executeAiTool } from '../../../server/ai/drivers/http/execTool'
import type { AiBrowserBridge, AiTool } from '../../../server/ai/runtime/types'
import type { CoreCapability } from '@core/capabilities'

function tool(partial: Partial<AiTool>): AiTool {
  return {
    name: 'x',
    description: 'x',
    scope: 'content',
    execution: 'server',
    inputSchema: Type.Object({}),
    ...partial,
  }
}

const NONE: readonly CoreCapability[] = []

describe('toolAllowedForCapabilities', () => {
  it('allows a read tool with no requiredCapabilities for any caller', () => {
    expect(toolAllowedForCapabilities(tool({}), NONE)).toBe(true)
  })

  it('blocks a tool whose requiredCapabilities the caller lacks', () => {
    const t = tool({ requiredCapabilities: ['users.manage'] })
    expect(toolAllowedForCapabilities(t, ['media.read'])).toBe(false)
  })

  it('allows when the caller has ANY of the requiredCapabilities', () => {
    const t = tool({ requiredCapabilities: ['data.custom.tables.read', 'data.custom.tables.manage'] })
    expect(toolAllowedForCapabilities(t, ['data.custom.tables.manage'])).toBe(true)
  })

  it('blocks a mutating tool when the caller lacks ai.tools.write', () => {
    const t = tool({ mutates: true })
    expect(toolAllowedForCapabilities(t, NONE)).toBe(false)
  })

  it('allows a mutating tool when the caller has ai.tools.write and any requiredCapabilities', () => {
    const t = tool({ mutates: true, requiredCapabilities: ['content.manage'] })
    expect(toolAllowedForCapabilities(t, ['ai.tools.write', 'content.manage'])).toBe(true)
  })

  it('blocks a mutating tool with ai.tools.write but missing requiredCapabilities', () => {
    const t = tool({ mutates: true, requiredCapabilities: ['content.manage'] })
    expect(toolAllowedForCapabilities(t, ['ai.tools.write'])).toBe(false)
  })
})

describe('selectToolsForScope capability filtering', () => {
  it('drops list_users for a caller without users.manage', () => {
    const names = selectToolsForScope('content', ['ai.chat']).map((t) => t.name)
    expect(names).not.toContain('content_list_users')
  })

  it('keeps list_users for a caller with users.manage', () => {
    const names = selectToolsForScope('content', ['ai.chat', 'users.manage']).map((t) => t.name)
    expect(names).toContain('content_list_users')
  })

  it('drops document read tools for a caller with only data.custom.tables.read', () => {
    const names = selectToolsForScope('content', ['ai.chat', 'data.custom.tables.read']).map((t) => t.name)
    expect(names).not.toContain('content_get_document')
    expect(names).not.toContain('list_documents')
    expect(names).not.toContain('content_search_documents')
    // schema tools stay — they only need a data-table read cap
    expect(names).toContain('content_list_collections')
  })

  it('drops list_media for a caller without media.read', () => {
    const names = selectToolsForScope('content', ['ai.chat']).map((t) => t.name)
    expect(names).not.toContain('content_list_media')
  })

  it('still filters write tools by ai.tools.write (existing behaviour preserved)', () => {
    const withoutWrite = selectToolsForScope('content', ['ai.chat', 'content.manage'])
    expect(withoutWrite.every((t) => !t.mutates)).toBe(true)
    const withWrite = selectToolsForScope('content', ['ai.chat', 'ai.tools.write', 'content.manage'])
    expect(withWrite.some((t) => t.mutates)).toBe(true)
  })
})

const noopBridge: AiBrowserBridge = {
  callBrowser: async () => ({ ok: false, error: 'no bridge' }),
}

describe('executeAiTool re-check', () => {
  it('refuses a server tool the caller lacks capabilities for, without running the handler', async () => {
    let handlerRan = false
    const gated = tool({
      name: 'content_list_users',
      requiredCapabilities: ['users.manage'],
      handler: async () => {
        handlerRan = true
        return { users: [] }
      },
    })
    const base = {
      db: {} as never,
      userId: 'u1',
      capabilities: ['ai.chat'] as readonly CoreCapability[],
      scope: 'content' as const,
      conversationId: 'c1',
      snapshot: undefined,
    }
    const out = await executeAiTool(gated, {}, noopBridge, new AbortController().signal, base)
    expect(out.ok).toBe(false)
    expect(handlerRan).toBe(false)
  })

  it('runs the handler when the caller holds a required capability', async () => {
    let handlerRan = false
    const gated = tool({
      name: 'content_list_users',
      requiredCapabilities: ['users.manage'],
      handler: async () => {
        handlerRan = true
        return { users: [] }
      },
    })
    const base = {
      db: {} as never,
      userId: 'u1',
      capabilities: ['ai.chat', 'users.manage'] as readonly CoreCapability[],
      scope: 'content' as const,
      conversationId: 'c1',
      snapshot: undefined,
    }
    const out = await executeAiTool(gated, {}, noopBridge, new AbortController().signal, base)
    expect(out.ok).toBe(true)
    expect(handlerRan).toBe(true)
  })
})
