import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { RepeaterCell } from '@admin/pages/data/components/DataGrid/cells/RepeaterCell'
import type { DataField, RepeaterValue } from '@core/data/schemas'

afterEach(cleanup)

const field: Extract<DataField, { type: 'repeater' }> = {
  type: 'repeater',
  id: 'credits',
  label: 'Credits',
  itemLabelFieldId: 'name',
  fields: [
    { type: 'text', id: 'name', label: 'Name', required: true },
    { type: 'text', id: 'role', label: 'Role' },
  ],
}

function Harness() {
  const [value, setValue] = useState<RepeaterValue>([])
  return (
    <>
      <RepeaterCell
        field={field}
        value={value}
        onChange={(next) => setValue(next as RepeaterValue)}
        context="detail"
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  )
}

describe('RepeaterCell', () => {
  it('keeps the field label and muted item count in one heading row', () => {
    render(<Harness />)

    const label = screen.getByText('Credits')
    const count = screen.getByText('0 items')

    expect(label.parentElement).toBe(count.parentElement)
  })

  it('uses the Media grid and list views for media-only repeaters', async () => {
    const user = userEvent.setup()
    const galleryField: Extract<DataField, { type: 'repeater' }> = {
      type: 'repeater',
      id: 'gallery',
      label: 'Gallery',
      fields: [{ type: 'media', id: 'image', label: 'Image', mediaKind: 'image' }],
    }

    render(
      <RepeaterCell
        field={galleryField}
        value={[
          { id: 'empty-1', cells: { image: null } },
          { id: 'empty-2', cells: { image: null } },
        ]}
        onChange={() => undefined}
        context="detail"
      />,
    )

    expect(screen.getByRole('group', { name: 'Gallery view' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Grid view' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Collapse Item 1' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'List view' }))

    expect(screen.getByRole('button', { name: 'List view' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('adds, labels, duplicates, reorders, and removes structured items', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Add item' }))
    const inputs = screen.getAllByRole('textbox')
    await user.type(inputs[0]!, 'Annie')
    await user.type(inputs[1]!, 'Photographer')

    await user.click(screen.getByRole('button', { name: 'Duplicate item 1' }))
    expect(screen.getAllByRole('button', { name: 'Collapse Annie' })).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: 'Move item 2 up' }))
    await user.click(screen.getByRole('button', { name: 'Delete item 2' }))

    const value = JSON.parse(screen.getByTestId('value').textContent ?? '[]') as RepeaterValue
    expect(value).toHaveLength(1)
    expect(value[0]?.cells).toEqual({ name: 'Annie', role: 'Photographer' })
    expect(typeof value[0]?.id).toBe('string')
  })

  it('does not expose opaque media ids when a configured summary is empty', () => {
    const galleryField: Extract<DataField, { type: 'repeater' }> = {
      type: 'repeater',
      id: 'gallery',
      label: 'Gallery',
      itemLabelFieldId: 'caption',
      fields: [
        { type: 'media', id: 'image', label: 'Image', mediaKind: 'image' },
        { type: 'text', id: 'caption', label: 'Caption' },
      ],
    }

    render(
      <RepeaterCell
        field={galleryField}
        value={[{
          id: 'gallery-item',
          cells: { image: 'opaque-media-id', caption: '' },
        }]}
        onChange={() => undefined}
        context="detail"
      />,
    )

    expect(screen.getByRole('button', { name: 'Collapse Item 1' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /opaque-media-id/ })).toBeNull()
  })

  it('uses author-facing select labels in collapsed item summaries', () => {
    const selectField: Extract<DataField, { type: 'repeater' }> = {
      type: 'repeater',
      id: 'links',
      label: 'Links',
      itemLabelFieldId: 'placement',
      fields: [{
        type: 'select',
        id: 'placement',
        label: 'Placement',
        options: [
          { id: 'hero-primary', value: 'hero_primary', label: 'Hero primary' },
          { id: 'footer-secondary', value: 'footer_secondary', label: 'Footer secondary' },
        ],
      }],
    }

    render(
      <RepeaterCell
        field={selectField}
        value={[{ id: 'link-item', cells: { placement: 'hero-primary' } }]}
        onChange={() => undefined}
        context="detail"
      />,
    )

    expect(screen.getByRole('button', { name: 'Collapse Hero primary' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /hero-primary/ })).toBeNull()
  })

  it('uses author-facing multi-select labels in collapsed item summaries', () => {
    const multiSelectField: Extract<DataField, { type: 'repeater' }> = {
      type: 'repeater',
      id: 'tags',
      label: 'Tags',
      itemLabelFieldId: 'audience',
      fields: [{
        type: 'multiSelect',
        id: 'audience',
        label: 'Audience',
        options: [
          { id: 'architects', value: 'architects', label: 'Architects' },
          { id: 'photographers', value: 'photographers', label: 'Photographers' },
        ],
      }],
    }

    render(
      <RepeaterCell
        field={multiSelectField}
        value={[{
          id: 'tag-item',
          cells: { audience: ['architects', 'photographers'] },
        }]}
        onChange={() => undefined}
        context="detail"
      />,
    )

    expect(screen.getByRole('button', {
      name: 'Collapse Architects, Photographers',
    })).toBeTruthy()
  })
})
