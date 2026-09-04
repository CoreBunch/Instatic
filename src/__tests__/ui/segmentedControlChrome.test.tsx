import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { cleanup, render, screen } from '@testing-library/react'
import { SegmentedControl } from '@ui/components/SegmentedControl'

afterEach(cleanup)

describe('SegmentedControl editor chrome variants', () => {
  it('presses exactly the segment matching the value', () => {
    render(
      <SegmentedControl
        value="layers"
        options={[
          { value: 'layers', label: 'Layers' },
          { value: 'site', label: 'Site' },
        ]}
        onChange={() => {}}
        look="tiles"
        data-testid="segmented-control"
      />,
    )

    expect(screen.getByRole('button', { name: 'Layers' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Site' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('renders clearable segment content separately from its close overlay', () => {
    render(
      <SegmentedControl
        value="2"
        options={[{ value: '2', label: '2', ariaLabel: '2 tracks' }]}
        onChange={() => {}}
        onClear={() => {}}
      />,
    )

    const button = screen.getByRole('button', { name: '2 tracks' })
    const content = screen.getByText('2')
    const clearOverlay = button.querySelector('[aria-hidden="true"]')

    expect(content.parentElement).toBe(button)
    expect(clearOverlay?.parentElement).toBe(button)
    expect(content).not.toBe(clearOverlay)
  })

  it('uses the tiles tab surface and top fade in Explorer Layers chrome', () => {
    const explorerSource = readFileSync('src/admin/pages/site/panels/ExplorerPanel/ExplorerPanel.tsx', 'utf8')
    const domPanelCss = readFileSync('src/admin/pages/site/panels/DomPanel/DomPanel.module.css', 'utf8')
    const leftSidebarCss = readFileSync(
      'src/admin/pages/site/sidebars/LeftSidebar/LeftSidebar.module.css',
      'utf8',
    )

    expect(explorerSource).toContain('look="tiles"')
    expect(domPanelCss).toContain('.searchRow::after')
    expect(domPanelCss).toContain('linear-gradient(180deg, var(--panel-fade-bg) 0%, transparent)')
    expect(leftSidebarCss).toContain('--panel-fade-bg: var(--bg-body)')
    expect(leftSidebarCss).toContain('--panel-fade-bg: var(--bg-surface)')
  })
})
