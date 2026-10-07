import React from 'react'
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PageSettingsDialog, type PageSettingsPayload } from '@admin/shared/dialogs/PageSettingsDialog'
import { makePage } from '../fixtures'

afterEach(cleanup)
describe('native page SEO settings', () => {
  it('edits separate SEO fields, alternatives and JSON-LD while keeping the display title', () => {
    const page = makePage({ id: 'p1', title: 'Display', slug: 'about' })
    page.seo = { title: 'Old SEO', description: 'Old description' }
    let saved: PageSettingsPayload | undefined
    render(<PageSettingsDialog page={page} pages={[page]} onCancel={() => {}} onSave={(value) => { saved = value }} />)
    fireEvent.change(screen.getByLabelText('SEO title'), { target: { value: 'Search title' } })
    fireEvent.change(screen.getByLabelText('Canonical URL'), { target: { value: '/canonical' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add language alternatives' }))
    fireEvent.change(screen.getByLabelText('Language tag 1'), { target: { value: 'fr' } })
    fireEvent.change(screen.getByLabelText('URL 1'), { target: { value: '/fr' } })
    fireEvent.change(screen.getByLabelText('Structured data (JSON-LD)'), { target: { value: '[{"@type":"WebSite","name":"{site.name}"}]' } })
    fireEvent.submit(document.getElementById('page-settings-form')!)
    expect(saved?.title).toBe('Display')
    expect(saved?.seo).toMatchObject({ title: 'Search title', description: 'Old description', canonical: '/canonical',
      alternates: [{ language: 'fr', href: '/fr' }], structuredData: [{ '@type': 'WebSite', name: '{site.name}' }] })
  })
  it('keeps malformed metadata visible and blocks submission with a field-local error', () => {
    const page = makePage({ id: 'p1', slug: 'about' })
    let saves = 0
    render(<PageSettingsDialog page={page} pages={[page]} onCancel={() => {}} onSave={() => { saves++ }} />)
    fireEvent.change(screen.getByLabelText('Structured data (JSON-LD)'), { target: { value: '{bad JSON' } })
    expect(screen.getByRole('alert').textContent).toContain('Invalid JSON')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(document.getElementById('page-settings-form')!)
    expect(saves).toBe(0)
    fireEvent.change(screen.getByLabelText('Structured data (JSON-LD)'), { target: { value: '[]' } })
    fireEvent.change(screen.getByLabelText('Canonical URL'), { target: { value: 'javascript:alert(1)' } })
    expect(screen.getByRole('alert').textContent).toContain('seo.canonical')
  })
  it('allows clearing metadata and makes content controls read-only for a structure-only editor', () => {
    const page = makePage({ id: 'p1', slug: 'about' })
    page.seo = { title: 'Old SEO', canonical: '/old', structuredData: [{ name: 'Old' }] }
    let saved: PageSettingsPayload | undefined
    const view = render(<PageSettingsDialog page={page} pages={[page]} onCancel={() => {}} onSave={(value) => { saved = value }} />)
    for (const name of ['SEO title', 'Canonical URL', 'Structured data (JSON-LD)']) fireEvent.change(screen.getByLabelText(name), { target: { value: '' } })
    fireEvent.submit(document.getElementById('page-settings-form')!)
    expect(saved?.seo).toBeUndefined()
    view.unmount()
    render(<PageSettingsDialog page={page} pages={[page]} canEditSeo={false} onCancel={() => {}} onSave={() => {}} />)
    expect(screen.getByLabelText('SEO title').closest('fieldset')?.disabled).toBe(true)
  })
})
