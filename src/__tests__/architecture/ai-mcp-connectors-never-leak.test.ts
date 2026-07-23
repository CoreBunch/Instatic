/**
 * Architecture gate — MCP connector secrets never leak.
 *
 * Mirrors `ai-credentials-never-leak.test.ts`: the wire-safe projection
 * (`toConnectionView`) and the wire schema (`McpConnectionViewSchema`) must not
 * expose the token or its hash. A connector token is shown to the operator
 * exactly once, in the create response — never in any list/read shape.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const STORE = join(import.meta.dir, '../../../server/ai/mcp/connectors/store.ts')

describe('MCP connector secrets never leak', () => {
  it('toConnectionView does not reference the token hash', () => {
    const src = readFileSync(STORE, 'utf8')
    const start = src.indexOf('export function toConnectionView')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n}', start) + 2)
    expect(body).not.toContain('tokenHash')
    expect(body).not.toContain('token_hash')
  })

  it('the wire view schema has no token / tokenHash field', async () => {
    const { McpConnectionViewSchema } = await import('@core/ai')
    const keys = Object.keys(McpConnectionViewSchema.properties)
    expect(keys).not.toContain('token')
    expect(keys).not.toContain('tokenHash')
    expect(keys).not.toContain('token_hash')
  })
})
