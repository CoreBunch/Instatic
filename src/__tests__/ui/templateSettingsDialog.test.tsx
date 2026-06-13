import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TemplateSettingsDialog, type TemplateSettingsPayload } from '@admin/shared/dialogs/TemplateSettingsDialog/TemplateSettingsDialog'
import type { Page } from '@core/page-tree'

afterEach(cleanup)

const node = (id: string, moduleId: string, children: string[] = []) =>
  ({ id, moduleId, props: {}, breakpointOverrides: {}, children })

// A plain page with no base.outlet — a template can still be saved from it; the
// outlet is added later in the editor. The dialog does NOT gate on outlets.
const plainPage = (): Page => ({
  id: 'p1', slug: 'tpl', title: 'Tpl', rootNodeId: 'body',
  nodes: { body: node('body', 'base.body') },
} as unknown as Page)

function submit() {
  const form = document.getElementById('template-settings-form') as HTMLFormElement
  fireEvent.submit(form)
}

describe('TemplateSettingsDialog', () => {
  it('saves an everywhere target with no conditions key (no outlet required)', () => {
    let saved: TemplateSettingsPayload | null = null
    render(
      <TemplateSettingsDialog
        page={plainPage()}
        pages={[plainPage()]}
        onCancel={() => {}}
        onSave={(p) => { saved = p }}
      />,
    )
    // No outlet on the page, but Save is enabled — no guard.
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()

    submit()
    expect(saved).not.toBeNull()
    expect(saved!.template.target).toEqual({ kind: 'everywhere' })
    expect('conditions' in saved!.template).toBe(false)
  })

  it('saves a postTypes target with the checked slugs', () => {
    let saved: TemplateSettingsPayload | null = null
    render(
      <TemplateSettingsDialog
        page={plainPage()}
        pages={[plainPage()]}
        onCancel={() => {}}
        onSave={(p) => { saved = p }}
      />,
    )
    // Switch "Applies to" from Everywhere → Post types via keyboard.
    const combobox = screen.getByRole('combobox', { name: /applies to/i })
    combobox.focus()
    // First ArrowDown opens the listbox (highlight stays on the current value);
    // the second moves to "Post types"; Enter commits.
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    fireEvent.keyDown(combobox, { key: 'Enter' })

    // Check the fallback Posts post type.
    const postsCheckbox = screen.getByRole('checkbox', { name: /posts/i })
    fireEvent.click(postsCheckbox)

    submit()
    expect(saved).not.toBeNull()
    expect(saved!.template.target).toEqual({ kind: 'postTypes', tableSlugs: ['posts'] })
  })

  it('saves a notFound target (no post-type checkboxes shown)', () => {
    let saved: TemplateSettingsPayload | null = null
    render(
      <TemplateSettingsDialog
        page={plainPage()}
        pages={[plainPage()]}
        onCancel={() => {}}
        onSave={(p) => { saved = p }}
      />,
    )
    // Switch "Applies to" from Everywhere → Not found via keyboard: open,
    // move past "Post types" onto "Not found (404)", commit.
    const combobox = screen.getByRole('combobox', { name: /applies to/i })
    combobox.focus()
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    fireEvent.keyDown(combobox, { key: 'Enter' })

    // The post-type picker only belongs to the postTypes kind.
    expect(screen.queryByRole('checkbox')).toBeNull()

    submit()
    expect(saved).not.toBeNull()
    expect(saved!.template.target).toEqual({ kind: 'notFound' })
  })
})
