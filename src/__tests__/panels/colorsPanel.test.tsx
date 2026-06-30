import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ColorsPanelBody } from '@site/panels/ColorsPanel'
import { useEditorStore } from '@site/store/store'
import { frameworkColorClassId } from '@core/framework'
import { makeSite } from '../fixtures'

// The Colors tab body is chrome-free; wrap it in a testid container so the
// existing `colors-panel` queries keep working.
function ColorsPanel() {
  return (
    <div data-testid="colors-panel">
      <ColorsPanelBody />
    </div>
  )
}

function resetStore() {
  useEditorStore.setState({
    site: makeSite(),
    activePageId: 'page-1',
    frameworkPanelOpen: true,
    frameworkPanelTab: 'colors',
    selectorsPanelOpen: false,
    dependenciesPanelOpen: false,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)
afterEach(cleanup)

describe('ColorsPanel', () => {
  it('creates a color token and generated utility classes', () => {
    render(<ColorsPanel />)

    expect(screen.getByTestId('colors-panel')).toBeDefined()
    expect(screen.getByText(/no colors yet/i)).toBeDefined()

    fireEvent.click(screen.getAllByRole('button', { name: /create color/i })[0])
    fireEvent.change(screen.getByRole('textbox', { name: /token name/i }), {
      target: { value: 'primary' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: /default color/i }), {
      target: { value: 'hsla(238, 100%, 62%, 1)' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))

    const token = useEditorStore.getState().site!.settings.framework!.colors.tokens[0]
    expect(token.slug).toBe('primary')
    expect(useEditorStore.getState().site!.styleRules[frameworkColorClassId(token.id, 'base', 'text')].name).toBe('text-primary')
    expect(screen.getByRole('button', { name: /edit color primary/i })).toBeDefined()
  })

  it('edits alternate color and fill utility from the expanded row', () => {
    const token = useEditorStore.getState().createFrameworkColorToken({
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      darkModeEnabled: true,
      generateUtilities: {
        text: true,
        background: true,
        border: true,
        fill: false,
      },
    })

    render(<ColorsPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit color primary' }))
    const panel = screen.getByTestId('colors-panel')
    expect(within(panel).queryByText(/light color/i)).toBeNull()
    expect(within(panel).queryByText(/alternate theme color/i)).toBeNull()
    expect(within(panel).getByText(/alt color/i)).toBeDefined()
    expect(within(panel).queryByRole('checkbox', { name: /alt color/i })).toBeNull()
    fireEvent.change(within(panel).getByRole('textbox', { name: /alt color/i }), {
      target: { value: 'hsla(238, 100%, 32%, 1)' },
    })
    fireEvent.blur(within(panel).getByRole('textbox', { name: /alt color/i }))
    fireEvent.click(within(panel).getByRole('switch', { name: /fill utility/i }))

    let updated = useEditorStore.getState().site!.settings.framework!.colors.tokens[0]
    expect(updated.darkValue).toBe('hsla(238, 100%, 32%, 1)')
    expect(updated.darkModeEnabled).toBe(true)
    expect(updated.generateUtilities.fill).toBe(true)
    expect(useEditorStore.getState().site!.styleRules[frameworkColorClassId(token.id, 'base', 'fill')]).toMatchObject({
      name: 'fill-primary',
      styles: { fill: 'var(--primary)' },
    })

    fireEvent.change(within(panel).getByRole('textbox', { name: /alt color/i }), {
      target: { value: '' },
    })
    fireEvent.blur(within(panel).getByRole('textbox', { name: /alt color/i }))
    updated = useEditorStore.getState().site!.settings.framework!.colors.tokens[0]
    expect(updated.darkModeEnabled).toBe(false)
  })

  it('uses color inputs switches previews and clamped variant counts', () => {
    useEditorStore.getState().createFrameworkColorToken({
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      generateTransparent: true,
      generateShades: { enabled: true, count: 4 },
      generateTints: { enabled: true, count: 4 },
    })

    render(<ColorsPanel />)

    fireEvent.change(screen.getByLabelText('Default color swatch primary'), {
      target: { value: '#ff0000' },
    })
    expect(useEditorStore.getState().site!.settings.framework!.colors.tokens[0].lightValue).toBe('#ff0000')

    fireEvent.click(screen.getByRole('button', { name: 'Edit color primary' }))
    const panel = screen.getByTestId('colors-panel')
    expect(within(panel).queryAllByRole('checkbox')).toHaveLength(0)
    expect(panel.querySelectorAll('[data-color-field="true"]').length).toBeGreaterThanOrEqual(2)
    expect(within(panel).getByLabelText('Shade preview primary d-1')).toBeDefined()
    expect(within(panel).getByLabelText('Tint preview primary l-1')).toBeDefined()

    fireEvent.click(within(panel).getByRole('switch', { name: /transparent variants/i }))
    expect(useEditorStore.getState().site!.settings.framework!.colors.tokens[0].generateTransparent).toBe(false)

    expect(within(panel).queryByRole('spinbutton', { name: /shade count/i })).toBeNull()
    const shadeStepper = within(panel).getByRole('group', { name: /shade variants/i })
    expect(within(shadeStepper).getByText('4')).toBeDefined()

    fireEvent.click(within(shadeStepper).getByRole('button', { name: /decrease shade variants/i }))
    expect(useEditorStore.getState().site!.settings.framework!.colors.tokens[0].generateShades.count).toBe(3)
    expect(within(shadeStepper).getByText('3')).toBeDefined()

    fireEvent.click(within(shadeStepper).getByRole('button', { name: /increase shade variants/i }))
    expect(useEditorStore.getState().site!.settings.framework!.colors.tokens[0].generateShades.count).toBe(4)
    expect(within(shadeStepper).getByText('4')).toBeDefined()
  })

  it('offers other color tokens as references inside the token editor', () => {
    useEditorStore.getState().createFrameworkColorToken({
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      generateTransparent: false,
      generateShades: { enabled: false, count: 0 },
      generateTints: { enabled: false, count: 0 },
    })
    const secondary = useEditorStore.getState().createFrameworkColorToken({
      slug: 'secondary',
      lightValue: 'hsla(0, 94%, 68%, 1)',
      generateTransparent: false,
      generateShades: { enabled: false, count: 0 },
      generateTints: { enabled: false, count: 0 },
    })

    render(<ColorsPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit color secondary' }))
    fireEvent.focus(within(screen.getByTestId('colors-panel')).getByRole('textbox', { name: /default color/i }))

    expect(screen.getByRole('listbox', { name: /default color color tokens/i })).toBeDefined()
    expect(screen.getByRole('option', { name: /--primary/i })).toBeDefined()
    expect(screen.queryByRole('option', { name: /--secondary/i })).toBeNull()

    fireEvent.click(screen.getByRole('option', { name: /--primary/i }))
    expect(
      useEditorStore.getState().site!.settings.framework!.colors.tokens.find((token) => token.id === secondary.id)?.lightValue,
    ).toBe('var(--primary)')
  })

  it('assigns a free-form category to a token via the editor input', () => {
    const token = useEditorStore.getState().createFrameworkColorToken({
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
    })

    render(<ColorsPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit color primary/i }))
    const panel = screen.getByTestId('colors-panel')
    const categoryInput = within(panel).getByRole('textbox', { name: /category/i })
    fireEvent.focus(categoryInput)
    fireEvent.change(categoryInput, { target: { value: 'Brand' } })
    fireEvent.blur(categoryInput)

    const updated = useEditorStore.getState().site!.settings.framework!.colors.tokens.find(
      (candidate) => candidate.id === token.id,
    )
    expect(updated?.category).toBe('Brand')
    expect(within(screen.getByRole('button', { name: 'Edit color primary' })).getByText('Brand')).toBeDefined()
    // The free-form label appears as a chip in the FilterBar derived from tokens.
    expect(screen.getByRole('button', { name: /^brand$/i })).toBeDefined()
  })

  it('suggests existing categories from other tokens via the autocomplete dropdown', () => {
    useEditorStore.getState().createFrameworkColorToken({
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      category: 'Brand',
    })
    const secondary = useEditorStore.getState().createFrameworkColorToken({
      slug: 'secondary',
      lightValue: 'hsla(0, 94%, 68%, 1)',
    })

    render(<ColorsPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit color secondary/i }))
    const panel = screen.getByTestId('colors-panel')
    const categoryInput = within(panel).getByRole('textbox', { name: /category/i })
    fireEvent.focus(categoryInput)

    expect(screen.getByRole('listbox', { name: /category suggestions/i })).toBeDefined()
    fireEvent.click(screen.getByRole('option', { name: 'Brand' }))

    expect(
      useEditorStore.getState().site!.settings.framework!.colors.tokens.find(
        (candidate) => candidate.id === secondary.id,
      )?.category,
    ).toBe('Brand')
  })

  it('drops a category from the filter bar when its last token loses the label', () => {
    const token = useEditorStore.getState().createFrameworkColorToken({
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      category: 'Brand',
    })

    render(<ColorsPanel />)

    expect(screen.getByRole('button', { name: /^brand$/i })).toBeDefined()

    act(() => {
      useEditorStore.getState().updateFrameworkColorToken(token.id, { category: '' })
    })

    expect(screen.queryByRole('button', { name: /^brand$/i })).toBeNull()
  })

  it('creates a color token with a chosen category from the create dialog', () => {
    useEditorStore.getState().createFrameworkColorToken({
      slug: 'existing',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      category: 'Brand',
    })

    render(<ColorsPanel />)

    fireEvent.click(screen.getAllByRole('button', { name: /create color/i })[0])
    fireEvent.change(screen.getByRole('textbox', { name: /token name/i }), {
      target: { value: 'primary' },
    })
    const categoryInput = screen.getByRole('textbox', { name: /category/i })
    fireEvent.focus(categoryInput)
    fireEvent.click(screen.getByRole('option', { name: 'Brand' }))
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))

    const created = useEditorStore.getState().site!.settings.framework!.colors.tokens.find(
      (candidate) => candidate.slug === 'primary',
    )
    expect(created?.category).toBe('Brand')
    expect(within(screen.getByRole('button', { name: 'Edit color primary' })).getByText('Brand')).toBeDefined()
  })

  it('opens a token context menu for duplicate reorder and remove actions', () => {
    const primary = useEditorStore.getState().createFrameworkColorToken({
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      generateTransparent: false,
      generateShades: { enabled: false, count: 0 },
      generateTints: { enabled: false, count: 0 },
    })
    const secondary = useEditorStore.getState().createFrameworkColorToken({
      slug: 'secondary',
      lightValue: 'hsla(0, 94%, 68%, 1)',
      generateTransparent: false,
      generateShades: { enabled: false, count: 0 },
      generateTints: { enabled: false, count: 0 },
    })

    render(<ColorsPanel />)

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Edit color primary' }))
    expect(screen.getByRole('menu', { name: /color token actions/i })).toBeDefined()
    fireEvent.click(screen.getByRole('menuitem', { name: /duplicate/i }))

    expect(useEditorStore.getState().site!.settings.framework!.colors.tokens.some((token) => token.slug === 'primary-copy')).toBe(true)

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Edit color secondary' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /move up/i }))
    expect(
      useEditorStore.getState().site!.settings.framework!.colors.tokens
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((token) => token.id)
        .slice(0, 2),
    ).toEqual([secondary.id, primary.id])

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Edit color primary' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /remove/i }))
    expect(useEditorStore.getState().site!.settings.framework!.colors.tokens.some((token) => token.id === primary.id)).toBe(false)
  })
})
