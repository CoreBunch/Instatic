import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewTableDialog } from '@admin/pages/data/components/NewTableDialog/NewTableDialog'
import { NewFieldDialog } from '@admin/pages/data/components/NewFieldDialog/NewFieldDialog'
import { FieldSchemaComposer } from '@admin/pages/data/components/FieldSchemaComposer'
import { TableSettings } from '@admin/pages/data/components/DataInspector/TableSettings'
import type {
  CreateDataTableInput,
  DataField,
  DataTable,
} from '@core/data/schemas'

afterEach(cleanup)

describe('NewTableDialog schema composer', () => {
  it('uses the post type schema without a kind switch for collections', async () => {
    const user = userEvent.setup()
    const created: CreateDataTableInput[] = []

    render(
      <NewTableDialog
        open
        onClose={() => undefined}
        onCreate={async (input) => {
          created.push(input)
        }}
        tables={[]}
        variant="collection"
      />,
    )

    expect(screen.getByRole('dialog', { name: 'New collection' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Table kind' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Data table' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Post type' })).toBeNull()
    expect(screen.getByText('Record structure')).toBeTruthy()
    expect(screen.getByText('/projects/entry-slug')).toBeTruthy()

    await user.type(screen.getByLabelText('Name'), 'Case Studies')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      name: 'Case Studies',
      slug: 'case-studies',
      kind: 'postType',
      routeBase: '/case-studies',
      primaryFieldId: 'title',
    })
  })

  it('only exposes the editable collection slug for post types', async () => {
    const user = userEvent.setup()

    render(
      <NewTableDialog
        open
        onClose={() => undefined}
        onCreate={async () => undefined}
        tables={[]}
      />,
    )

    await user.type(screen.getByLabelText('Name'), 'Case Studies')
    expect((screen.getByLabelText('Singular label') as HTMLInputElement).value).toBe('Case Study')
    expect(screen.queryByLabelText('Slug')).toBeNull()
    expect(screen.queryByText('Identity')).toBeNull()
    expect(screen.queryByText('Behavior')).toBeNull()
    expect(screen.queryByText('Kind')).toBeNull()

    const kindControl = screen.getByRole('group', { name: 'Table kind' })
    const nameInput = screen.getByLabelText('Name')
    expect(
      kindControl.compareDocumentPosition(nameInput) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Post type' }))
    const slugInput = screen.getByLabelText('Slug') as HTMLInputElement
    const routePreview = screen.getByText('/case-studies/entry-slug')
    expect(slugInput.value).toBe('case-studies')
    expect(
      slugInput.compareDocumentPosition(routePreview) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    await user.clear(screen.getByLabelText('Slug'))
    await user.type(screen.getByLabelText('Slug'), 'work')
    expect(screen.getByText('/work/entry-slug')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Data table' }))
    expect(screen.queryByLabelText('Slug')).toBeNull()
  })

  it('uses the slug placeholder in the empty route preview', async () => {
    const user = userEvent.setup()

    render(
      <NewTableDialog
        open
        onClose={() => undefined}
        onCreate={async () => undefined}
        tables={[]}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Post type' }))
    expect((screen.getByLabelText('Slug') as HTMLInputElement).placeholder).toBe('projects')
    expect(screen.getByText('/projects/entry-slug')).toBeTruthy()
  })

  it('assigns the primary field directly from eligible Schema rows', async () => {
    const user = userEvent.setup()
    const table: DataTable = {
      id: 'projects',
      name: 'Projects',
      slug: 'projects',
      kind: 'data',
      singularLabel: 'Project',
      pluralLabel: 'Projects',
      routeBase: '',
      primaryFieldId: 'name',
      system: false,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
      fields: [
        { type: 'text', id: 'name', label: 'Name' },
        { type: 'text', id: 'client', label: 'Client' },
      ],
    }
    const onUpdateTable = mock(async (input: Partial<DataTable>) => ({
      ...table,
      ...input,
    }))

    render(
      <TableSettings
        table={table}
        tables={[table]}
        rows={[]}
        onUpdateTable={onUpdateTable}
        onDeleteTable={async () => undefined}
        canEdit
        canDelete={false}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Display' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Schema · 2 fields' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add field' })).toBeTruthy()
    expect(screen.queryByText('Record fields')).toBeNull()
    expect(screen.queryByLabelText('Primary field')).toBeNull()
    expect(screen.queryByLabelText('Slug')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Routing' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Kind' })).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Name is the primary field' }).getAttribute('aria-pressed'),
    ).toBe('true')

    await user.click(screen.getByRole('button', { name: 'Set Client as primary field' }))
    expect(onUpdateTable).toHaveBeenCalledWith({ primaryFieldId: 'client' })
  })

  it('uses the shared first-letter accent pills for field types', () => {
    render(
      <FieldSchemaComposer
        fields={[
          { type: 'media', id: 'image', label: 'Image asset' },
          { type: 'repeater', id: 'gallery', label: 'Gallery', fields: [] },
        ]}
        tables={[]}
        onChange={() => undefined}
      />,
    )

    expect(screen.getByText('Media').getAttribute('data-accent')).toBe('m')
    expect(screen.getByText('Repeater').getAttribute('data-accent')).toBe('r')
  })

  it('derives the field ID from the label until the ID is changed manually', async () => {
    const user = userEvent.setup()
    const created: DataField[] = []

    render(
      <NewFieldDialog
        open
        onClose={() => undefined}
        existingFieldIds={[]}
        tables={[]}
        onCreate={async (field) => {
          created.push(field)
        }}
      />,
    )

    const labelInput = screen.getByLabelText(/^Label/) as HTMLInputElement
    const idInput = screen.getByLabelText(/^ID/) as HTMLInputElement
    const idLabel = screen.getByText('ID', { selector: 'label' })
    const typeLabel = screen.getByText('Type', { selector: 'label' })

    expect(
      labelInput.compareDocumentPosition(idInput) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(idLabel.parentElement?.parentElement).toBe(typeLabel.parentElement?.parentElement)

    await user.type(labelInput, '42 Hero Image')
    expect(idInput.value).toBe('field_42_hero_image')

    await user.clear(idInput)
    await user.type(idInput, 'cover')
    await user.type(labelInput, ' Updated')
    expect(idInput.value).toBe('cover')

    await user.click(screen.getByRole('button', { name: 'Create field' }))
    expect(created[0]).toMatchObject({
      type: 'text',
      id: 'cover',
      label: '42 Hero Image Updated',
    })
  })

  it('creates a table and its repeater schema in one atomic input', async () => {
    const user = userEvent.setup()
    const created: CreateDataTableInput[] = []
    const onCreate = mock(async (input: CreateDataTableInput) => {
      created.push(input)
    })

    render(
      <NewTableDialog
        open
        onClose={() => undefined}
        onCreate={onCreate}
        tables={[]}
      />,
    )

    await user.type(screen.getByLabelText('Name'), 'Projects')
    expect((screen.getByLabelText('Singular label') as HTMLInputElement).value).toBe('Project')
    expect((screen.getByLabelText('Plural label') as HTMLInputElement).value).toBe('Projects')
    await user.click(screen.getByRole('button', { name: 'Add field' }))

    const fieldDialog = screen.getAllByRole('dialog').at(-1)!
    await user.click(within(fieldDialog).getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: 'Repeater' }))
    await user.type(within(fieldDialog).getByLabelText(/^Label/), 'Gallery')
    expect((within(fieldDialog).getByLabelText(/^ID/) as HTMLInputElement).value).toBe('gallery')
    await user.click(within(fieldDialog).getByRole('button', { name: 'Add item field' }))

    const nestedDialog = screen.getAllByRole('dialog').at(-1)!
    await user.type(within(nestedDialog).getByLabelText(/^Label/), 'Caption')
    expect((within(nestedDialog).getByLabelText(/^ID/) as HTMLInputElement).value).toBe('caption')
    await user.click(within(nestedDialog).getByRole('button', { name: 'Create field' }))

    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(2))
    const repeaterDialog = screen.getAllByRole('dialog').at(-1)!
    await user.click(within(repeaterDialog).getByRole('button', { name: 'Create field' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit Gallery' })).toBeTruthy())
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement
    if (!nameInput.value) await user.type(nameInput, 'Projects')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(created[0]).toMatchObject({
      name: 'Projects',
      slug: 'projects',
      kind: 'data',
      primaryFieldId: 'name',
    })
    expect(created[0]?.fields).toContainEqual({
      type: 'repeater',
      id: 'gallery',
      label: 'Gallery',
      fields: [{ type: 'text', id: 'caption', label: 'Caption' }],
    })
  })

  it('keeps the table draft open when Escape closes its field dialog', async () => {
    const user = userEvent.setup()

    render(
      <NewTableDialog
        open
        onClose={() => undefined}
        onCreate={async () => undefined}
        tables={[]}
      />,
    )

    await user.type(screen.getByLabelText('Name'), 'Projects')
    await user.click(screen.getByRole('button', { name: 'Add field' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(2)

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1))
    expect(screen.getByRole('dialog', { name: 'New table' })).toBeTruthy()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Projects')
  })

  it('offers accessible move controls for top-level and repeater item fields', async () => {
    const user = userEvent.setup()
    let schemaFields: DataField[] = [
      { type: 'text', id: 'name', label: 'Name' },
      { type: 'text', id: 'caption', label: 'Caption' },
    ]
    const onSchemaChange = mock(async (fields: DataField[]) => {
      schemaFields = fields
    })

    const { rerender } = render(
      <FieldSchemaComposer fields={schemaFields} tables={[]} onChange={onSchemaChange} />,
    )
    await user.click(screen.getByRole('button', { name: 'Move Caption up' }))
    expect(schemaFields.map((field) => field.id)).toEqual(['caption', 'name'])

    const savedFields: DataField[] = []
    rerender(
      <NewFieldDialog
        open
        onClose={() => undefined}
        existingFieldIds={[]}
        tables={[]}
        initialField={{
          type: 'repeater',
          id: 'gallery',
          label: 'Gallery',
          fields: [
            { type: 'media', id: 'image', label: 'Image', mediaKind: 'image' },
            { type: 'text', id: 'caption', label: 'Caption' },
          ],
        }}
        onCreate={async (field) => {
          savedFields.push(field)
        }}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Move Caption up' }))
    const summarySelect = screen.getAllByRole('combobox').at(-1)!
    await user.click(summarySelect)
    expect(screen.getByRole('option', { name: 'Caption' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Image' })).toBeNull()
    await user.click(screen.getByRole('option', { name: 'Caption' }))
    await user.click(screen.getByRole('button', { name: 'Save field' }))

    expect(savedFields[0]?.type).toBe('repeater')
    if (savedFields[0]?.type === 'repeater') {
      expect(savedFields[0].fields.map((field) => field.id)).toEqual(['caption', 'image'])
    }
  })
})
