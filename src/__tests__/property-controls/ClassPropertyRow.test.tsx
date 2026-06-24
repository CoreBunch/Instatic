import { describe, expect, it } from 'bun:test'

describe('ClassPropertyRow remove button layout', () => {
  it('does not reserve a right-side gutter that shrinks property controls', async () => {
    const { readFileSync } = await import('fs')
    const css = readFileSync(
      new URL('../../admin/pages/site/panels/PropertiesPanel/ClassPropertyRow.module.css', import.meta.url),
      'utf-8',
    )

    expect(css).not.toMatch(/\.propertyRowWrap\[data-state="set"\]\s*\{[^}]*padding-right:/s)
  })

  it('overlays the remove button on the left label column with a fade', async () => {
    const { readFileSync } = await import('fs')
    const css = readFileSync(
      new URL('../../admin/pages/site/panels/PropertiesPanel/ClassPropertyRow.module.css', import.meta.url),
      'utf-8',
    )
    const controlCss = readFileSync(
      new URL('../../ui/components/ControlRow/ControlRow.module.css', import.meta.url),
      'utf-8',
    )
    const compactCss = css.replace(/\s+/g, '')
    const controlLabelColumn = controlCss.match(/grid-template-columns:\s*(\d+px)\s+1fr/)?.[1]

    expect(controlLabelColumn).toBe('100px')
    expect(css).toMatch(/--class-remove-label-column:\s*100px/)
    expect(css).toMatch(/--class-remove-row-center:\s*14px/)
    expect(css).toMatch(/--class-remove-button-size:\s*22px/)
    expect(css).toMatch(/--class-remove-fade-width:\s*36px/)
    expect(css).toMatch(/\.propertyRowWrap\[data-state="set"\]::after\s*\{[^}]*linear-gradient/s)
    expect(compactCss).toContain(
      '.removeBtn{position:absolute;top:calc(var(--class-remove-row-center)-(var(--class-remove-button-size)/2));left:calc(var(--class-remove-label-column)-var(--class-remove-button-size)-4px)',
    )
    expect(css).toMatch(/\.removeBtn\.removeBtn\s*\{[^}]*width:\s*var\(--class-remove-button-size\)/s)
    expect(css).toMatch(/\.removeBtn\.removeBtn\s*\{[^}]*height:\s*var\(--class-remove-button-size\)/s)
    expect(css).not.toMatch(/\.removeBtn\s*\{[^}]*right:/s)
    expect(css).not.toMatch(/\.removeBtn\s*\{[^}]*translateY\(-50%\)/s)
  })

  it('uses a neutral remove affordance instead of the destructive danger hover style', async () => {
    const { readFileSync } = await import('fs')
    const rowSource = readFileSync(
      new URL('../../admin/pages/site/panels/PropertiesPanel/ClassPropertyRow.tsx', import.meta.url),
      'utf-8',
    )
    const css = readFileSync(
      new URL('../../admin/pages/site/panels/PropertiesPanel/ClassPropertyRow.module.css', import.meta.url),
      'utf-8',
    )

    // Neutral affordance: no danger hover variant, default color is the
    // secondary-text token, hover shifts to the primary-text token. The exact
    // hover background treatment (subtle white tint, transparent + border, …)
    // is owned by visual design and not pinned here — the contract is just
    // "no danger tokens, no destructive styling".
    expect(rowSource).not.toContain('dangerHover')
    expect(rowSource).toContain('<CloseIcon size={16}')
    expect(css).toMatch(/\.removeBtn\.removeBtn\s*\{[^}]*color:\s*var\(--text-muted\)/s)
    expect(css).toMatch(/\.removeBtn\.removeBtn:hover[\s\S]*color:\s*var\(--text\)/s)
    expect(css).not.toContain('editor-danger')
  })
})

describe('StyleRuleComposer module style remove button layout', () => {
  it('does not reserve a right-side gutter for module-owned style rows', async () => {
    // Module-owned style rows were removed when classStyleBindings was deleted.
    // This gate ensures no moduleStyleRow padding-right accidentally reappears.
    const { readFileSync } = await import('fs')
    const css = readFileSync(
      new URL('../../admin/pages/site/panels/PropertiesPanel/StyleRuleComposer.module.css', import.meta.url),
      'utf-8',
    )

    expect(css).not.toMatch(/\.moduleStyleRow\s*\{[^}]*padding-right:/s)
  })
})
