/**
 * Two schema-driven control variants:
 *   - a `number` control with `presets` shows one-click preset buttons under
 *     the field, which still accepts any number
 *   - a `select` control whose options carry `iconSvg` renders as an icon
 *     button row instead of a dropdown.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PropertyControlRenderer } from '@site/property-controls/PropertyControlRenderer'
import type { PropertyControl } from '@core/module-engine'

afterEach(cleanup)

const ICON_A = '<svg viewBox="0 0 24 24"><path d="M4 6h16"/></svg>'
const ICON_B = '<svg viewBox="0 0 24 24"><path d="M6 4v16"/></svg>'

function renderControl(control: PropertyControl, value: unknown) {
  const changes: Array<[string, unknown]> = []
  const view = render(
    <PropertyControlRenderer
      propKey="myProp"
      control={control}
      value={value}
      onChange={(key, next) => changes.push([key, next])}
    />,
  )
  return { changes, ...view }
}

describe('number control presets', () => {
  const control: PropertyControl = { type: 'number', label: 'Collapse below', presets: [640, 768, 1024] }

  it('renders one button per preset, in order, next to the number field', () => {
    renderControl(control, 768)
    const group = screen.getByRole('group', { name: 'Collapse below presets' })
    const buttons = Array.from(group.querySelectorAll('button'))
    expect(buttons.map((button) => button.textContent)).toEqual(['640', '768', '1024'])
    expect(screen.getByRole('spinbutton')).toHaveProperty('value', '768')
  })

  it('marks the preset matching the current value as pressed, and none for a custom value', () => {
    const { unmount } = renderControl(control, 768)
    const pressed = () =>
      Array.from(screen.getByRole('group').querySelectorAll('button[aria-pressed="true"]')).map((b) => b.textContent)
    expect(pressed()).toEqual(['768'])
    unmount()

    renderControl(control, 913)
    expect(pressed()).toEqual([])
  })

  it('writes the preset as a number when its button is clicked', () => {
    const { changes } = renderControl(control, 768)
    fireEvent.click(screen.getByRole('button', { name: '1024' }))
    expect(changes).toEqual([['myProp', 1024]])
  })

  it('still accepts any typed number', () => {
    const { changes } = renderControl(control, 768)
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '913' } })
    expect(changes).toEqual([['myProp', 913]])
  })

  it('renders no preset group when the control has no presets', () => {
    renderControl({ type: 'number', label: 'Width' }, 10)
    expect(screen.queryByRole('group')).toBeNull()
    renderControl({ type: 'number', label: 'Width', presets: [] }, 10)
    expect(screen.queryByRole('group')).toBeNull()
  })
})

describe('select control icon row', () => {
  const control: PropertyControl = {
    type: 'select',
    label: 'Menu icon',
    options: [
      { value: 'horizontal-lines', label: 'Horizontal lines', iconSvg: ICON_A },
      { value: 'vertical-lines', label: 'Vertical lines', iconSvg: ICON_B },
    ],
  }

  it('renders an icon button per option instead of a dropdown, named by the option label', () => {
    const { container } = renderControl(control, 'horizontal-lines')
    expect(container.querySelector('select')).toBeNull()
    const first = screen.getByRole('button', { name: 'Horizontal lines' })
    const second = screen.getByRole('button', { name: 'Vertical lines' })
    expect(first.querySelector('svg path')?.getAttribute('d')).toBe('M4 6h16')
    expect(second.querySelector('svg path')?.getAttribute('d')).toBe('M6 4v16')
    expect(first.getAttribute('aria-pressed')).toBe('true')
    expect(second.getAttribute('aria-pressed')).toBe('false')
  })

  it('writes the clicked option value', () => {
    const { changes } = renderControl(control, 'horizontal-lines')
    fireEvent.click(screen.getByRole('button', { name: 'Vertical lines' }))
    expect(changes).toEqual([['myProp', 'vertical-lines']])
  })

  it('writes the original value type, not its string form', () => {
    const numeric: PropertyControl = {
      type: 'select',
      label: 'Columns',
      options: [
        { value: 1, label: 'One', iconSvg: ICON_A },
        { value: 2, label: 'Two', iconSvg: ICON_B },
      ],
    }
    const { changes } = renderControl(numeric, 1)
    fireEvent.click(screen.getByRole('button', { name: 'Two' }))
    expect(changes).toEqual([['myProp', 2]])
  })

  it('sanitises the icon markup, since a plugin schema can supply it', () => {
    const hostile: PropertyControl = {
      type: 'select',
      label: 'Icon',
      options: [{ value: 'a', label: 'A', iconSvg: '<svg onload="alert(1)"><script>alert(1)</script><path d="M0 0"/></svg>' }],
    }
    const { container } = renderControl(hostile, 'a')
    expect(container.querySelector('script')).toBeNull()
    expect(container.innerHTML).not.toContain('onload')
    expect(container.querySelector('svg path')).not.toBeNull()
  })

  it('keeps the dropdown when no option has an icon', () => {
    const plain: PropertyControl = {
      type: 'select',
      label: 'Target',
      options: [{ value: '_self', label: 'Same tab' }, { value: '_blank', label: 'New tab' }],
    }
    const { container } = renderControl(plain, '_self')
    expect(container.querySelector('select')).not.toBeNull()
  })
})
