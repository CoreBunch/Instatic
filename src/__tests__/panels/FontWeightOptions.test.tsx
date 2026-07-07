import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import type { FontEntry } from '@core/fonts'
import { StyleSectionsEditor } from '@site/panels/PropertiesPanel/StyleSectionsEditor'
import { setEditorPreference } from '@site/preferences/editorPreferences'
import { useEditorStore } from '@site/store/store'
import { makeSite } from '../fixtures'

const inter: FontEntry = {
  id: 'font-inter',
  source: 'google',
  family: 'Inter',
  variants: ['300', '400', '700', '900'],
  subsets: ['latin'],
  files: [
    { variant: '300', subset: 'latin', path: '/uploads/fonts/inter/300-latin.woff2', format: 'woff2' },
    { variant: '400', subset: 'latin', path: '/uploads/fonts/inter/400-latin.woff2', format: 'woff2' },
    { variant: '700', subset: 'latin', path: '/uploads/fonts/inter/700-latin.woff2', format: 'woff2' },
    { variant: '900', subset: 'latin', path: '/uploads/fonts/inter/900-latin.woff2', format: 'woff2' },
  ],
  category: 'Sans Serif',
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => {
  setEditorPreference('propertiesSectionsExpanded', true)
  useEditorStore.setState({
    site: makeSite({
      settings: {
        shortcuts: {},
        fonts: {
          items: [inter],
          tokens: [
            {
              id: 'token-primary',
              name: 'Primary',
              variable: 'font-primary',
              familyId: inter.id,
              fallback: 'sans-serif',
              order: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      },
    }),
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('font weight style options', () => {
  it('reflects the installed variants for the active font token', () => {
    renderFontWeightRow({ fontFamily: 'var(--font-primary)' })

    expect(fontWeightOptionValues()).toEqual(['', '300', '400', '700', '900'])
  })

  it('uses the default body font token when no explicit font family is set', () => {
    renderFontWeightRow({})

    expect(fontWeightOptionValues()).toEqual(['', '300', '400', '700', '900'])
  })
})

function renderFontWeightRow(styles: Record<string, unknown>): void {
  render(
    <StyleSectionsEditor
      storedStyles={styles}
      currentStyles={styles}
      sectionKey="base"
      styleQuery="font weight"
      onChange={() => {}}
      onRemove={() => {}}
      onClearProperty={() => {}}
      onClearProperties={() => {}}
      onPreview={() => {}}
      onClearPreview={() => {}}
    />,
  )
}

function fontWeightOptionValues(): string[] {
  const row = screen.getByTestId('css-property-row-fontWeight')
  const select = row.querySelector('select')
  expect(select).toBeInstanceOf(HTMLSelectElement)

  return Array.from(select?.options ?? [], (option) => option.value)
}
