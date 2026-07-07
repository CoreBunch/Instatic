import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'

const GLOBALS_CSS = 'src/styles/globals.css'
const MIN_SMALL_TEXT_CONTRAST = 4.5
const MIN_SURFACE_CONTRAST = 1.2

function readTokenBlock(selector: string): Record<string, string> {
  const source = readFileSync(GLOBALS_CSS, 'utf8')
  const start = source.indexOf(selector)
  if (start === -1) throw new Error(`Missing CSS selector: ${selector}`)

  const openBrace = source.indexOf('{', start)
  if (openBrace === -1) throw new Error(`Missing CSS block for selector: ${selector}`)

  let depth = 0
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return Object.fromEntries(
          source
            .slice(openBrace + 1, index)
            .matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)
            .map((match) => [match[1], match[2].trim()]),
        )
      }
    }
  }

  throw new Error(`Unclosed CSS block for selector: ${selector}`)
}

function parseHexColor(value: string): [number, number, number] {
  const match = value.match(/^#([0-9a-f]{6})$/i)
  if (!match) throw new Error(`Expected hex color, got: ${value}`)

  const hex = match[1]
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ]
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  })

  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
}

function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(parseHexColor(foreground))
  const bg = relativeLuminance(parseHexColor(background))
  const light = Math.max(fg, bg)
  const dark = Math.min(fg, bg)
  return (light + 0.05) / (dark + 0.05)
}

describe('light theme accent contrast', () => {
  it('keeps the light body background distinct from primary surfaces', () => {
    const rootTokens = readTokenBlock(':root {')
    const lightTokens = {
      ...rootTokens,
      ...readTokenBlock(":root[data-editor-theme='light'],"),
    }

    expect(
      contrastRatio(lightTokens['--bg-body'], lightTokens['--bg-surface']),
      '--bg-body against --bg-surface',
    ).toBeGreaterThanOrEqual(MIN_SURFACE_CONTRAST)
  })

  it('keeps accent foregrounds readable on light admin surfaces', () => {
    const rootTokens = readTokenBlock(':root {')
    const lightTokens = {
      ...rootTokens,
      ...readTokenBlock(":root[data-editor-theme='light'],"),
    }
    const surfaces = ['--bg-surface', '--bg-surface-2'] as const

    for (let index = 1; index <= 10; index += 1) {
      const accent = `--accent-${index}`
      for (const surface of surfaces) {
        expect(
          contrastRatio(lightTokens[accent], lightTokens[surface]),
          `${accent} against ${surface}`,
        ).toBeGreaterThanOrEqual(MIN_SMALL_TEXT_CONTRAST)
      }
    }
  })
})
