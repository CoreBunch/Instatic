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

  it('gives the always-visible remove cross (rowx) its own trailing row column', async () => {
    const { readFileSync } = await import('fs')
    const css = readFileSync(
      new URL('../../admin/pages/site/panels/PropertiesPanel/ClassPropertyRow.module.css', import.meta.url),
      'utf-8',
    )
    const controlCss = readFileSync(
      new URL('../../ui/components/ControlRow/ControlRow.module.css', import.meta.url),
      'utf-8',
    )
    const sectionCss = readFileSync(
      new URL('../../ui/components/Section/Section.module.css', import.meta.url),
      'utf-8',
    )

    // Row anatomy comes from ControlRow: a --control-label-column column
    // (100px in the panel, 52px in the popout narrow variant).
    expect(controlCss).toMatch(/grid-template-columns:\s*var\(--control-label-column\)\s+1fr/)
    expect(controlCss).toMatch(/--control-label-column:\s*100px/)
    expect(controlCss).toMatch(/--control-label-column:\s*52px/)

    // The section body claims its full inner width — it must NOT pay a
    // standing inset for a dash most rows don't have (prototype `.sec-body`).
    expect(sectionCss).toMatch(/\.sectionFlush\s+\.sectionContent\s*\{[^}]*padding-right:\s*0/s)

    // Instead, only a removable row opens a trailing column for the cross —
    // the prototype's `.row[data-added="true"]`.
    expect(css).toMatch(
      /\.propertyRowWrap\[data-removable="true"\]\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--control-height\)/s,
    )
    // The cross sits in that column, not overhanging the section.
    expect(css).not.toMatch(/\.removeBtn\.removeBtn\s*\{[^}]*position:\s*absolute/s)
    expect(css).toMatch(/\.removeBtn\.removeBtn\s*\{[^}]*width:\s*var\(--control-height\)/s)
    expect(css).toMatch(/\.removeBtn\.removeBtn\s*\{[^}]*height:\s*var\(--control-height\)/s)
    // Always visible — no hover-reveal opacity dance.
    expect(css).not.toMatch(/\.removeBtn[^{]*\{[^}]*opacity:\s*0/s)
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

    // Neutral affordance: a thin mark, bright text, and a quiet box on
    // hover — no danger tokens, no destructive styling.
    expect(rowSource).not.toContain('dangerHover')
    // The row handle wears the DASH from the shared glyph set — the × means
    // "clear this value" and lives inside the field (inspector-panel.md §5).
    expect(rowSource).toContain('<RemoveDashGlyph />')
    expect(rowSource).not.toContain('<RemoveXGlyph />')
    expect(css).toMatch(/\.removeBtn\.removeBtn\s*\{[^}]*color:\s*var\(--text-bright\)/s)
    expect(css).toMatch(/\.removeBtn\.removeBtn:hover[\s\S]*background:\s*var\(--bg-surface-2\)/s)
    expect(css).toMatch(/\.removeBtn\.removeBtn:hover[\s\S]*border:\s*1px solid var\(--border-muted\)/s)
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
