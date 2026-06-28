/**
 * Architecture gate — AI drivers share ONE copy of the cross-provider helpers.
 *
 * Two pieces of behaviour MUST be identical across every provider driver, or
 * the same model error silently produces different outcomes per provider:
 *
 *   1. `parseToolArguments(json)` — how malformed tool-argument JSON is handled.
 *      Defined once in `server/ai/drivers/http/toolArgs.ts`; every driver
 *      imports it. A private re-implementation in a driver would let one
 *      provider diverge (e.g. return the raw string instead of `{}`), so we ban
 *      any local `function parse…Or…(` / `parseJsonOrEmpty` copies.
 *
 *   2. `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` — the literal that splits the cacheable
 *      static prompt prefix from the dynamic suffix. Producer (prompt builders)
 *      and consumers (drivers) must agree; a drifted copy silently breaks prompt
 *      caching. Defined once in `server/ai/runtime/types.ts`; everyone imports
 *      it. We ban any second `= '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'` literal.
 *
 * This is the gate that keeps the helpers from re-diverging after the
 * 2026-06 unification.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

const DRIVER_FILES = [
  'server/ai/drivers/anthropic.ts',
  'server/ai/drivers/responses-shared.ts',
  'server/ai/drivers/http/chatCompletions.ts',
]

describe('ai-driver-shared-helpers gate', () => {
  it('parseToolArguments has a single source in http/toolArgs.ts', () => {
    const src = read('server/ai/drivers/http/toolArgs.ts')
    expect(src).toContain('export function parseToolArguments')
  })

  it('every driver imports parseToolArguments from the shared module', () => {
    for (const file of DRIVER_FILES) {
      const src = read(file)
      expect(src).toMatch(/from\s+'(\.\/|\.\.\/)+(http\/)?toolArgs'/)
      // No private copy of the parser may shadow the shared one.
      expect(src).not.toMatch(/function\s+parseJsonOrEmpty\b/)
      expect(src).not.toMatch(/function\s+parseToolArguments\b/)
    }
  })

  it('no driver carries a private cryptoId copy', () => {
    for (const file of DRIVER_FILES) {
      expect(read(file)).not.toMatch(/function\s+cryptoId\b/)
    }
  })

  it('SYSTEM_PROMPT_DYNAMIC_BOUNDARY is declared exactly once', () => {
    const SCAN = [
      ...DRIVER_FILES,
      'server/ai/drivers/ollama.ts',
      'server/ai/drivers/types.ts',
      'server/ai/runtime/types.ts',
      'server/ai/tools/site/systemPrompt.ts',
      'server/ai/tools/content/systemPrompt.ts',
    ]
    const declRe = /SYSTEM_PROMPT_DYNAMIC_BOUNDARY\s*=\s*'__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'/g
    const declarers = SCAN.filter((f) => declRe.test(read(f)))
    expect(declarers).toEqual(['server/ai/runtime/types.ts'])
  })

  it('every driver imports the boundary constant rather than redefining it', () => {
    for (const file of DRIVER_FILES) {
      const src = read(file)
      expect(src).toContain('SYSTEM_PROMPT_DYNAMIC_BOUNDARY')
      expect(src).not.toMatch(/SYSTEM_PROMPT_DYNAMIC_BOUNDARY\s*=\s*'/)
    }
  })
})
