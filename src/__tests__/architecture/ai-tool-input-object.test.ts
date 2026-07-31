/**
 * Architecture Gate — provider-facing tool inputs are object-rooted schemas.
 *
 * Anthropic requires `input_schema.type === "object"` and rejects top-level
 * `anyOf`/`oneOf`/`allOf`; OpenAI-compatible providers and Instatic's MCP
 * adapter use the same canonical TypeBox schema. Keep that provider contract
 * in the shared registry instead of repairing schemas in individual drivers.
 */

import { describe, expect, it } from 'bun:test'
import { contentTools } from '../../../server/ai/tools/content'
import { siteTools } from '../../../server/ai/tools/site'

describe('AI tool input object gate', () => {
  it('every registered tool advertises an object-rooted input schema', () => {
    for (const tool of [...siteTools, ...contentTools]) {
      expect(
        tool.inputSchema.type,
        `${tool.name} must expose a top-level JSON Schema object`,
      ).toBe('object')
      expect(tool.inputSchema.anyOf, `${tool.name} cannot compose its schema root`).toBeUndefined()
      expect(tool.inputSchema.oneOf, `${tool.name} cannot compose its schema root`).toBeUndefined()
      expect(tool.inputSchema.allOf, `${tool.name} cannot compose its schema root`).toBeUndefined()
    }
  })
})
