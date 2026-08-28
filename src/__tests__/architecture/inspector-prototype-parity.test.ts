/**
 * Architecture Gate — inspector ↔ prototype parity.
 *
 * The Properties-panel redesign is specified by a hand-authored HTML
 * prototype (served at http://localhost:5599 via the `mock` entry in
 * .claude/launch.json). Its `.ui` block declares the geometry the panel is
 * built from — control heights, row gap, radius, label column — and its rules
 * pin the anatomy of the shared row shapes.
 *
 * Eyeballing screenshots is how those values drift. This gate reads the
 * prototype and asserts our tokens and CSS modules still agree with it, so a
 * mismatch fails a test run instead of surviving until someone notices.
 *
 * The prototype lives under `.tmp/` (untracked working material), so the
 * gate SKIPS when it is absent — CI and fresh clones stay green, while any
 * machine that has the prototype checks against it.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const PROJECT_ROOT = join(import.meta.dir, '../../../')
const PROTOTYPE = join(PROJECT_ROOT, '.tmp/mock/index.html')
const GLOBALS = join(PROJECT_ROOT, 'src/styles/globals.css')

const hasPrototype = existsSync(PROTOTYPE)
// Comments are stripped up front: the prototype annotates its rules heavily,
// and a comment sitting between two declarations would otherwise break the
// "previous declaration ended with ;" anchor the reader below relies on.
const prototype = hasPrototype
  ? readFileSync(PROTOTYPE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  : ''

/** Read a custom-property value out of the prototype's `.ui` token block. */
function prototypeToken(name: string): string | null {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(prototype)
  return match ? match[1].trim() : null
}

/** Read a declaration out of a named rule in the prototype. */
function prototypeDecl(selector: string, property: string): string | null {
  const rule = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(prototype)
  if (!rule) return null
  const decl = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(rule[1])
  return decl ? decl[1].trim() : null
}

function readSrc(relative: string): string {
  return readFileSync(join(PROJECT_ROOT, relative), 'utf8')
}

describe.skipIf(!hasPrototype)('inspector ↔ prototype parity', () => {
  it('the control scale in globals.css matches the prototype', () => {
    const globals = readSrc('src/styles/globals.css')
    for (const token of [
      '--control-height-sm',
      '--control-height',
      '--control-row-gap',
      '--control-radius',
    ]) {
      const expected = prototypeToken(token)
      expect(expected, `prototype declares ${token}`).not.toBeNull()
      expect(globals, `${GLOBALS} declares ${token}: ${expected}`).toContain(
        `${token}: ${expected};`,
      )
    }
  })

  it('the row label column matches the prototype', () => {
    // Prototype: `.row { grid-template-columns: var(--label-column) … }` with
    // `--label-column: 100px`, and `.row.narrow { --label-column: 52px }`.
    const controlRow = readSrc('src/ui/components/ControlRow/ControlRow.module.css')
    expect(controlRow).toContain(`--control-label-column: ${prototypeToken('--label-column')};`)
    expect(controlRow).toContain(`--control-label-column: ${prototypeDecl('.row.narrow', '--label-column')};`)
  })

  it('the Size section fuses value ⊕ mode on the prototype tracks', () => {
    const size = readSrc('src/admin/pages/site/panels/PropertiesPanel/SizeSection.module.css')
    const fused = prototypeDecl('.fused', 'grid-template-columns')
    expect(fused, 'prototype declares .fused tracks').not.toBeNull()
    expect(size.replace(/\s+/g, ' ')).toContain(`grid-template-columns: ${fused};`)
  })

  it('the ratio lock keeps the prototype bracket geometry', () => {
    const size = readSrc('src/admin/pages/site/panels/PropertiesPanel/SizeSection.module.css')
    expect(size).toContain(`width: ${prototypeDecl('.ratiolock', 'width')};`)
    expect(size).toContain(`height: ${prototypeDecl('.ratiolock', 'height')};`)
    // The bracket arms are pseudo-elements, same as the prototype.
    expect(size).toMatch(/\.ratioLock::before[\s\S]*\.ratioLock::after/)
  })

  it('fields are borderless fills on the prototype surfaces', () => {
    const input = readSrc('src/ui/components/Input/Input.module.css')
    expect(input).toContain(`background: ${prototypeDecl('.field', 'background')};`)
    expect(input).toContain(`background: ${prototypeDecl('.field:hover', 'background')};`)
  })

  it('the number stepper stays a hover-revealed 16px column', () => {
    const input = readSrc('src/ui/components/Input/Input.module.css')
    expect(input).toContain(`width: ${prototypeDecl('.stepper', 'width')};`)
    // Hidden at rest, revealed on hover / focus — the prototype's rule.
    expect(prototypeDecl('.stepper', 'opacity')).toBe('0')
    expect(input).toMatch(/\.spinner\s*\{[^}]*opacity:\s*0/s)
    expect(input).toMatch(/:hover\s+\.spinner[\s\S]*opacity:\s*1/)
  })
})

describe.skipIf(hasPrototype)('inspector ↔ prototype parity (prototype absent)', () => {
  it('skips when .tmp/mock/index.html is not present', () => {
    expect(hasPrototype).toBe(false)
  })
})
