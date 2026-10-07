import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConditionControl } from '@site/property-controls/ConditionControl'
import { PropertyControlRenderer } from '@site/property-controls/PropertyControlRenderer'
import { paramTypesCompatibleWithControl } from '@site/property-controls/paramTypeCompat'
import { FormMessageEditor } from '@modules/base/forms/FormControls'
import { FormMessageModule } from '@modules/base/forms'
import { resolveDynamicProps, buildTemplateRenderContext } from '@core/templates'
import { makePage, makeSite } from '../fixtures'

afterEach(cleanup)

describe('native form editor controls', () => {
  it('edits nested rules with native controls and emits structured values', () => {
    const change = mock(() => {})
    render(<ConditionControl propKey="condition" label="Visible when" value={{ and: [{ field: 'purpose', in: ['support','commercial'] }] }} onChange={change} />)
    fireEvent.change(screen.getByLabelText('Match value 2'), { target: { value: 'partner' } })
    expect(change).toHaveBeenLastCalledWith('condition', { and: [{ field: 'purpose', in: ['support','partner'] }] })
    fireEvent.click(screen.getByRole('button', { name: 'Remove condition' }))
    expect(change).toHaveBeenLastCalledWith('condition', null)
  })

  it('respects disabled authoring and surfaces invalid persisted conditions', () => {
    const change = mock(() => {})
    render(<PropertyControlRenderer propKey="requiredWhen" control={{ type: 'condition', label: 'Required when', category: 'layout' }} value="invalid" disabled onChange={change} />)
    expect(screen.getByRole('alert').textContent).toContain('invalid')
    expect((screen.getByRole('button', { name: 'Replace condition' }) as HTMLButtonElement).disabled).toBe(true)
    expect(paramTypesCompatibleWithControl({ type: 'condition', label: 'Rule' })).toEqual([])
  })

  it('uses catalogue-resolved state copy and preserves authored headings in all nine language frames', () => {
    for (const language of ['it','en','de','fr','es','pt','nl','pl','ro']) {
      const page = makePage({ language })
      const site = makeSite({ pages: [page], files: [{ id: 'catalogue', path: 'locale.json', type: 'config', content: JSON.stringify({ language, messages: { forms: { success: language + ' success' } } }), createdAt: 0, updatedAt: 0 }], settings: { shortcuts: {}, localization: { catalogues: [{ language, fileId: 'catalogue' }] } } })
      const copy = resolveDynamicProps({ text: '{site.translations.forms.success}' }, undefined, buildTemplateRenderContext(page, site, undefined)).text
      const state = render(<FormMessageEditor nodeId="state" isSelected={false} props={{ ...FormMessageModule.defaults, kind: 'success', source: 'state', editorPreviewState: 'success', editorPreviewMessage: String(copy) }} />)
      expect(screen.getByText(language + ' success')).toBeDefined()
      state.unmount()
      const authored = render(<FormMessageEditor nodeId="heading" isSelected={false} props={{ ...FormMessageModule.defaults, kind: 'success', source: 'authored', text: 'Authored heading', editorPreviewState: 'success', editorPreviewMessage: String(copy) }} />)
      expect(screen.getByText('Authored heading')).toBeDefined()
      expect(screen.queryByText(language + ' success')).toBeNull()
      authored.unmount()
    }
  })
})
