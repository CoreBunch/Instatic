/**
 * FrameworkHome must degrade gracefully — not crash the editor body — when
 * `site.settings.fonts` is malformed (present, but without an `items` array).
 *
 * Every load path (client adapter AND server repository) runs the shell
 * through `parseSiteFontsSettings`, so validated sites can never carry this
 * shape. But the editor store is also written by paths outside those parsers
 * (live sync experiments, future plugins), and a field-level regression here
 * previously threw `TypeError: fonts is not iterable` inside
 * `useInstalledFontFaces`, unmounting the whole `site-editor-body` chunk.
 * FrameworkHome now reads fonts with the same tolerant
 * `s.site?.settings.fonts?.items ?? EMPTY` selector pattern as FontsSection.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { FrameworkHome } from '@site/panels/FrameworkPanel/FrameworkHome'
import { useEditorStore } from '@site/store/store'
import type { SiteFontsSettings } from '@core/fonts'
import { makeSite } from '../fixtures'

afterEach(cleanup)

function renderWithFonts(fonts: SiteFontsSettings | undefined): void {
  const site = makeSite()
  site.settings.fonts = fonts
  useEditorStore.setState({ site, activePageId: site.pages[0]!.id })
  render(<FrameworkHome />)
}

describe('FrameworkHome with malformed settings.fonts', () => {
  it('renders the overview instead of throwing when fonts has no items array', () => {
    // Deliberately malformed — simulates an unvalidated writer (e.g. a raw
    // projection) putting a fonts object without `items` into the store.
    renderWithFonts({} as SiteFontsSettings)
    expect(screen.getByText('Typography')).toBeTruthy()
    // Specimen falls back to the role-only labels — no token, no family.
    expect(screen.getByText('Heading')).toBeTruthy()
    expect(screen.getByText('Body')).toBeTruthy()
  })

  it('renders when fonts carries tokens but no items (partial object)', () => {
    renderWithFonts({
      tokens: [
        {
          id: 'token-1',
          name: 'Primary',
          variable: 'font-primary',
          fallback: 'sans-serif',
          order: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    } as SiteFontsSettings)
    // The token still labels the specimen; the missing items array must not
    // throw in useInstalledFontFaces or resolveFontTokenStack.
    expect(screen.getByText('Heading · --font-primary')).toBeTruthy()
  })

  it('still labels the specimen from a valid installed family', () => {
    renderWithFonts({
      items: [
        {
          id: 'font-1',
          source: 'custom',
          family: 'PP Neue Montreal',
          variants: ['400'],
          subsets: ['latin'],
          files: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    expect(screen.getByText('Heading · PP Neue Montreal')).toBeTruthy()
  })
})
