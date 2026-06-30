/**
 * Architecture gate — system prompt must NOT enumerate module ids.
 *
 * The canonical Anthropic agent pattern is progressive disclosure via
 * tools, not bulk context dumping. Module ids (base.container, base.text,
 * etc.) must be discovered through `site_list_modules` / `site_read_document`, not
 * baked into the static prompt prefix where they would bust the cache on
 * every registry change.
 *
 * This gate also checks that the prompt was updated to the HTML-native
 * style: `site_insert_html` must appear, and the phrase "Structure as HTML,
 * styling as CSS" must be present.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '../../../')
const PROMPT_FILE = join(REPO_ROOT, 'server/ai/tools/site/systemPrompt.ts')

const src = readFileSync(PROMPT_FILE, 'utf8')

describe('agent-system-prompt-no-module-enumeration gate', () => {
  it('does not contain a "Module ids:" enumeration heading', () => {
    expect(src).not.toContain('Module ids:')
  })

  it('does not contain the base.container module id literal', () => {
    // Module ids must be discovered via tools, not embedded in the prompt.
    expect(src).not.toContain('base.container')
  })

  it('does not contain the base.text module id literal', () => {
    expect(src).not.toContain('base.text')
  })

  it('references insertHtml in the static prefix', () => {
    // The HTML-native tool must be described so the agent knows to use it.
    expect(src).toContain('site_insert_html')
  })

  it('contains the "Structure as HTML, styling as CSS" guideline', () => {
    expect(src).toContain('Structure as HTML, styling as CSS')
  })
})
