/**
 * Data-binding affordance — position on toggle controls.
 *
 * The `{}` button sits in the control's top-right corner. A toggle row ends in
 * a switch whose thumb occupies exactly that corner, so on toggles the button
 * must move to the left of the switch instead of covering it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { cleanup, render, screen } from '@testing-library/react'
import { DynamicBindingControl } from '@site/property-controls/DynamicBindingControl'
import { clearDataMetaCache } from '@admin/shared/DataBindingPicker/cache'
import type { PropertyControl } from '@core/module-engine'

const BINDING_CSS = readFileSync(
  new URL('../../admin/pages/site/property-controls/DynamicBindingControl/DynamicBindingControl.module.css', import.meta.url),
  'utf8',
)
const SWITCH_CSS = readFileSync(
  new URL('../../ui/components/Switch/Switch.module.css', import.meta.url),
  'utf8',
)

const originalFetch = globalThis.fetch

beforeEach(() => {
  clearDataMetaCache()
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ meta: { tables: [] } }), { status: 200 })) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  clearDataMetaCache()
  globalThis.fetch = originalFetch
})

function renderAffordance(control: PropertyControl) {
  render(
    <DynamicBindingControl propKey="myProp" label="My prop" control={control} onSet={() => {}} onClear={() => {}}>
      <input aria-label="My prop" />
    </DynamicBindingControl>,
  )
  return screen.getByRole('button', { name: 'Bind My prop' })
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))
  if (!match) throw new Error(`No rule for ${selector}`)
  return match[1]
}

function px(body: string, property: string): number {
  const match = new RegExp(`(?:^|[;\\s])${property}:\\s*(\\d+)px`).exec(body)
  if (!match) throw new Error(`No px value for ${property}`)
  return Number(match[1])
}

const BESIDE_SWITCH = '.affordanceBtn[data-placement="beside-switch"]'

describe('binding affordance position', () => {
  it('marks the button as beside the switch on a toggle control', () => {
    const button = renderAffordance({ type: 'toggle', label: 'My prop' })
    expect(button.getAttribute('data-placement')).toBe('beside-switch')
  })

  it('keeps the corner position on every other bindable control', () => {
    const others: PropertyControl[] = [
      { type: 'text', label: 'My prop' },
      { type: 'url', label: 'My prop' },
      { type: 'number', label: 'My prop' },
      { type: 'image', label: 'My prop' },
    ]
    for (const control of others) {
      const button = renderAffordance(control)
      expect(button.hasAttribute('data-placement')).toBe(false)
      cleanup()
    }
  })

  it('offsets the marked button by more than the switch is wide, so the two cannot overlap', () => {
    const switchWidth = px(ruleBody(SWITCH_CSS, '.track'), 'width')
    const offset = px(ruleBody(BINDING_CSS, BESIDE_SWITCH), 'right')
    expect(offset).toBeGreaterThan(switchWidth)
  })

  it('would overlap the switch at the default corner position, which is why toggles need the offset', () => {
    expect(px(ruleBody(BINDING_CSS, '.affordanceBtn'), 'right')).toBeLessThan(
      px(ruleBody(SWITCH_CSS, '.track'), 'width'),
    )
  })
})
