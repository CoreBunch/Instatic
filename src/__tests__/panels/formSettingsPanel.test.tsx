import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DataTable } from '@core/data/schemas'
import type { AnyModuleDefinition } from '@core/module-engine'
import type { Page, PageNode } from '@core/page-tree'
import { StepUpContext } from '@admin/shared/StepUp/StepUpContext'
import { FormSettingsPanelView } from '@site/panels/PropertiesPanel/FormSettingsPanel'
import { renderModuleTabContent } from '@site/panels/PropertiesPanel/renderModuleTabContent'
import type { FormSettingsAnalysis } from '@site/panels/PropertiesPanel/formSettingsAnalysis'

const table: DataTable = {
  id: 'contact_submissions',
  name: 'Contact submissions',
  slug: 'contact-submissions',
  kind: 'data',
  singularLabel: 'Submission',
  pluralLabel: 'Submissions',
  routeBase: '',
  primaryFieldId: 'email',
  system: false,
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  fields: [
    { id: 'email', label: 'Email', type: 'email', required: true, maxLength: 320 },
    { id: 'message', label: 'Message', type: 'longText', required: true },
  ],
}

const systemTables: DataTable[] = [
  {
    ...table,
    id: 'pages',
    name: 'Pages',
    slug: 'pages',
    kind: 'page',
    singularLabel: 'Page',
    pluralLabel: 'Pages',
    system: true,
  },
  {
    ...table,
    id: 'posts',
    name: 'Posts',
    slug: 'posts',
    kind: 'postType',
    singularLabel: 'Post',
    pluralLabel: 'Posts',
    system: true,
  },
  {
    ...table,
    id: 'components',
    name: 'Components',
    slug: 'components',
    kind: 'component',
    singularLabel: 'Component',
    pluralLabel: 'Components',
    system: true,
  },
]

const analysis: FormSettingsAnalysis = {
  kind: 'control',
  node: {
    id: 'input-email',
    moduleId: 'base.input',
    props: { fieldId: '', name: '', inputType: 'text' },
    children: [],
    breakpointOverrides: {},
    classIds: [],
  },
  form: {
    nodeId: 'form',
    formId: 'contact',
    mode: 'cms',
    targetTableId: 'contact_submissions',
  },
  table,
  field: null,
  compatibleFields: table.fields,
  inferredFields: [],
  missingFields: [],
  inferredTarget: null,
  warnings: [{
    code: 'unbound_control',
    message: 'Bind this control to a table field.',
    tone: 'warning',
  }],
}

describe('FormSettingsPanelView', () => {
  it('shows form context, warnings, and patches control props when a field is selected', () => {
    const patches: Record<string, unknown>[] = []
    render(
      <FormSettingsPanelView
        analysis={analysis}
        tables={[table]}
        tablesLoading={false}
        tablesError=""
        previewState="default"
        loading={false}
        error=""
        onPatchProps={(patch) => patches.push(patch)}
        onTargetTableChange={() => undefined}
        onCreateTable={() => undefined}
        onInsertMissingField={() => undefined}
        onPreviewStateChange={() => undefined}
      />,
    )

    expect(screen.getByText('Contact')).toBeDefined()
    expect(screen.getByText('Contact submissions')).toBeDefined()
    expect(screen.getByRole('status').textContent).toContain('Bind this control to a table field.')

    const select = document.querySelector('select[name="form-field-binding"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    fireEvent.change(select, { target: { value: 'email' } })

    expect(patches).toEqual([{
      fieldId: 'email',
      name: 'email',
      id: 'email-input',
      inputType: 'email',
      required: true,
      maxLength: 320,
    }])
  })

  it('lists only compatible target-table fields for the selected control type', () => {
    const choiceTable: DataTable = {
      ...table,
      fields: [
        ...table.fields,
        { id: 'plan', label: 'Plan', type: 'select', options: [
          { id: 'basic', label: 'Basic', value: 'basic' },
          { id: 'pro', label: 'Pro', value: 'pro' },
        ] },
        { id: 'consent', label: 'Consent', type: 'boolean', required: true },
      ],
    }
    const selectAnalysis: FormSettingsAnalysis = {
      ...analysis,
      node: node('select-plan', 'base.select', { fieldId: '', name: '', multiple: false }),
      table: choiceTable,
      compatibleFields: choiceTable.fields.filter((field) => field.type === 'select'),
      warnings: [],
    }
    const patches: Record<string, unknown>[] = []

    render(
      <FormSettingsPanelView
        analysis={selectAnalysis}
        tables={[choiceTable]}
        tablesLoading={false}
        tablesError=""
        previewState="default"
        loading={false}
        error=""
        onPatchProps={(patch) => patches.push(patch)}
        onTargetTableChange={() => undefined}
        onCreateTable={() => undefined}
        onInsertMissingField={() => undefined}
        onPreviewStateChange={() => undefined}
      />,
    )

    const select = document.querySelector('select[name="form-field-binding"]') as HTMLSelectElement
    const optionLabels = Array.from(select.options).map((option) => option.textContent)
    expect(optionLabels).toEqual(['Choose field', 'Plan (select)'])

    fireEvent.change(select, { target: { value: 'plan' } })
    expect(patches).toEqual([{
      fieldId: 'plan',
      name: 'plan',
      id: 'plan-select',
      required: false,
      multiple: false,
    }])
  })

  it('does not render for non-form modules', () => {
    const { container } = render(
      <FormSettingsPanelView
        analysis={{ ...analysis, kind: 'none' }}
        tables={[]}
        tablesLoading={false}
        tablesError=""
        previewState="default"
        loading={false}
        error=""
        onPatchProps={() => undefined}
        onTargetTableChange={() => undefined}
        onCreateTable={() => undefined}
        onInsertMissingField={() => undefined}
        onPreviewStateChange={() => undefined}
      />,
    )

    expect(container.firstChild).toBeNull()
  })

  it('lets a CMS form choose or create its target table inline', async () => {
    const targetChanges: string[] = []
    const createdNames: string[] = []
    const formAnalysis: FormSettingsAnalysis = {
      ...analysis,
      kind: 'form',
      node: node('form', 'base.form', { mode: 'cms', formId: 'contact-iA1PLODCLc4odPTZ8ljwv', targetTableId: '' }),
      form: { nodeId: 'form', formId: 'contact-iA1PLODCLc4odPTZ8ljwv', mode: 'cms', targetTableId: '' },
      table: null,
      field: null,
      compatibleFields: [],
      inferredFields: [{ id: 'email', label: 'Email', type: 'email', required: true }],
      missingFields: [],
      warnings: [],
    }

    render(
      <FormSettingsPanelView
        analysis={formAnalysis}
        tables={[table]}
        tablesLoading={false}
        tablesError=""
        previewState="default"
        loading={false}
        error=""
        onPatchProps={() => undefined}
        onTargetTableChange={(tableId) => targetChanges.push(tableId)}
        onCreateTable={(tableName) => { createdNames.push(tableName) }}
        onInsertMissingField={() => undefined}
        onPreviewStateChange={() => undefined}
      />,
    )

    const select = document.querySelector('select[name="form-target-table"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    fireEvent.change(select, { target: { value: 'contact_submissions' } })
    expect(targetChanges).toEqual(['contact_submissions'])

    const createButton = screen.getByRole('button', { name: 'Create table' })
    const targetControl = screen.getByTestId('form-target-table-control')
    expect(targetControl.contains(select)).toBe(true)
    expect(targetControl.contains(createButton)).toBe(true)
    expect(createButton.textContent?.trim()).toBe('')
    expect(createButton.hasAttribute('title')).toBe(false)
    fireEvent.click(createButton)
    const nameInput = screen.getByLabelText('Table name') as HTMLInputElement
    expect(nameInput.value).toBe('Contact submissions')
    fireEvent.change(nameInput, { target: { value: 'Support inbox' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(createdNames).toEqual(['Support inbox']))
  })

  it('offers only non-system data tables as CMS form targets', () => {
    const formAnalysis: FormSettingsAnalysis = {
      ...analysis,
      kind: 'form',
      node: node('form', 'base.form', { mode: 'cms', formId: 'contact', targetTableId: '' }),
      form: { nodeId: 'form', formId: 'contact', mode: 'cms', targetTableId: '' },
      table: null,
      field: null,
      compatibleFields: [],
      inferredFields: [{ id: 'email', label: 'Email', type: 'email', required: true }],
      missingFields: [],
      warnings: [],
    }

    render(
      <FormSettingsPanelView
        analysis={formAnalysis}
        tables={[...systemTables, table]}
        tablesLoading={false}
        tablesError=""
        previewState="default"
        loading={false}
        error=""
        onPatchProps={() => undefined}
        onTargetTableChange={() => undefined}
        onCreateTable={() => undefined}
        onInsertMissingField={() => undefined}
        onPreviewStateChange={() => undefined}
      />,
    )

    const select = document.querySelector('select[name="form-target-table"]') as HTMLSelectElement
    const optionLabels = Array.from(select.options).map((option) => option.textContent)
    expect(optionLabels).toEqual(['Choose table', 'Contact submissions'])
  })

  it('promotes mode and form id controls into the setup panel', () => {
    const patches: Record<string, unknown>[] = []
    const formAnalysis: FormSettingsAnalysis = {
      ...analysis,
      kind: 'form',
      node: node('form', 'base.form', { mode: 'cms', formId: 'contact', targetTableId: 'contact_submissions' }),
      form: { nodeId: 'form', formId: 'contact', mode: 'cms', targetTableId: 'contact_submissions' },
      field: null,
      compatibleFields: [],
      inferredFields: [{ id: 'email', label: 'Email', type: 'email', required: true }],
      missingFields: [],
      warnings: [],
    }

    render(
      <FormSettingsPanelView
        analysis={formAnalysis}
        tables={[table]}
        tablesLoading={false}
        tablesError=""
        previewState="default"
        loading={false}
        error=""
        onPatchProps={(patch) => patches.push(patch)}
        onTargetTableChange={() => undefined}
        onCreateTable={() => undefined}
        onInsertMissingField={() => undefined}
        onPreviewStateChange={() => undefined}
      />,
    )

    const modeControl = screen.getByTestId('form-mode')
    const previewControl = screen.getByTestId('form-preview-state')
    expect(modeControl.compareDocumentPosition(previewControl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('Mode').tagName).toBe('LABEL')
    expect(screen.getByText('Preview state').tagName).toBe('LABEL')

    fireEvent.click(screen.getByRole('button', { name: 'HTML action' }))
    expect(patches).toContainEqual({ mode: 'custom' })
    fireEvent.click(screen.getByRole('button', { name: 'HTTP request' }))
    expect(patches).toContainEqual({ mode: 'request' })

    const idInput = screen.getByLabelText('Form ID') as HTMLInputElement
    expect(idInput.value).toBe('contact')
    fireEvent.change(idInput, { target: { value: 'Support Requests' } })
    expect(patches).toContainEqual({ formId: 'Support-Requests' })
  })

  it('keeps the create-table action as a square icon beside the table select', async () => {
    const { readFileSync } = await import('fs')
    const source = readFileSync(
      new URL('../../admin/pages/site/panels/PropertiesPanel/FormSettingsPanel.tsx', import.meta.url),
      'utf-8',
    )
    const css = readFileSync(
      new URL('../../admin/pages/site/panels/PropertiesPanel/FormSettingsPanel.module.css', import.meta.url),
      'utf-8',
    )

    expect(source).toContain('className={styles.createTableButton}')
    expect(source).toContain('iconOnly')
    expect(source).toContain('tooltip="Create table"')
    expect(css).toMatch(/\.targetTableControl\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto;/)
  })

  it('offers missing table fields as one-click form nodes', () => {
    const inserted: string[] = []
    const formAnalysis: FormSettingsAnalysis = {
      ...analysis,
      kind: 'form',
      node: node('form', 'base.form', { mode: 'cms', formId: 'contact', targetTableId: 'contact_submissions' }),
      form: { nodeId: 'form', formId: 'contact', mode: 'cms', targetTableId: 'contact_submissions' },
      field: null,
      compatibleFields: [],
      inferredFields: [],
      missingFields: [table.fields[1]!],
      warnings: [],
    }

    render(
      <FormSettingsPanelView
        analysis={formAnalysis}
        tables={[table]}
        tablesLoading={false}
        tablesError=""
        previewState="default"
        loading={false}
        error=""
        onPatchProps={() => undefined}
        onTargetTableChange={() => undefined}
        onCreateTable={() => undefined}
        onInsertMissingField={(field) => inserted.push(field.id)}
        onPreviewStateChange={() => undefined}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add Message field' }))
    expect(inserted).toEqual(['message'])
  })

  it('switches editor-only form preview states from the setup panel', () => {
    const states: string[] = []
    render(
      <FormSettingsPanelView
        analysis={{ ...analysis, kind: 'form', node: node('form', 'base.form'), field: null }}
        tables={[table]}
        tablesLoading={false}
        tablesError=""
        previewState="default"
        loading={false}
        error=""
        onPatchProps={() => undefined}
        onTargetTableChange={() => undefined}
        onCreateTable={() => undefined}
        onInsertMissingField={() => undefined}
        onPreviewStateChange={(state) => states.push(state)}
      />,
    )

    expect(screen.getByTestId('form-preview-state')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Success' }))
    fireEvent.click(screen.getByRole('button', { name: 'Error' }))
    expect(states).toEqual(['success', 'error'])
  })
})

function node(id: string, moduleId: string, props: Record<string, unknown> = {}, children: string[] = []): PageNode {
  return {
    id,
    moduleId,
    props,
    children,
    breakpointOverrides: {},
    classIds: [],
  }
}

describe('renderModuleTabContent form setup slot', () => {
  it('renders the form setup panel before raw module props for form modules', async () => {
    const page: Page = {
      id: 'page-home',
      slug: 'index',
      title: 'Home',
      rootNodeId: 'body',
      nodes: {
        body: node('body', 'base.body', {}, ['form']),
        form: node('form', 'base.form', { mode: 'cms', formId: 'contact', targetTableId: '' }, ['input']),
        input: node('input', 'base.input', { fieldId: '', name: '', inputType: 'text' }),
      },
    }
    const definition = {
      id: 'base.input',
      name: 'Input',
      schema: {
        fieldId: { type: 'text', label: 'Field ID' },
      },
    } as AnyModuleDefinition

    render(
      <StepUpContext.Provider value={{ runStepUp: (action) => action() }}>
        {renderModuleTabContent({
          selectedNode: page.nodes.input!,
          selectedNodeId: 'input',
          definition,
          resolvedPropsForBreakpoint: page.nodes.input!.props,
          overrideKeys: new Set(),
          activeDocument: null,
          activePage: page,
          dynamicBindingsEnabled: false,
          enclosingLoopSource: undefined,
          enclosingLoopTableId: null,
          handleChange: () => undefined,
          handlePatch: () => undefined,
          onSetDynamicBinding: () => undefined,
          onClearDynamicBinding: () => undefined,
        })}
      </StepUpContext.Provider>,
    )

    const setupPanel = await waitFor(() => screen.getByTestId('form-settings-panel'))
    const rawFieldRow = screen.getByTestId('property-control-fieldId')
    expect(setupPanel.compareDocumentPosition(rawFieldRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not duplicate promoted base.form controls in the raw schema list', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tables: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch

    const page: Page = {
      id: 'page-home',
      slug: 'index',
      title: 'Home',
      rootNodeId: 'body',
      nodes: {
        body: node('body', 'base.body', {}, ['form']),
        form: node('form', 'base.form', { mode: 'cms', formId: 'contact', targetTableId: '' }, ['input']),
        input: node('input', 'base.input', { fieldId: '', name: '', inputType: 'text' }),
      },
    }
    const definition = {
      id: 'base.form',
      name: 'Form',
      schema: {
        mode: { type: 'select', label: 'Mode', options: [{ label: 'CMS-native', value: 'cms' }, { label: 'Custom action', value: 'custom' }] },
        formId: { type: 'text', label: 'Form ID' },
        targetTableId: { type: 'dataTable', label: 'Target data table', condition: { field: 'mode', eq: 'cms' } },
        successBehavior: { type: 'select', label: 'Success behavior', options: [{ label: 'Show message', value: 'message' }] },
      },
    } as AnyModuleDefinition

    try {
      render(
        <StepUpContext.Provider value={{ runStepUp: (action) => action() }}>
          {renderModuleTabContent({
            selectedNode: page.nodes.form!,
            selectedNodeId: 'form',
            definition,
            resolvedPropsForBreakpoint: page.nodes.form!.props,
            overrideKeys: new Set(),
            activeDocument: null,
            activePage: page,
            dynamicBindingsEnabled: false,
            enclosingLoopSource: undefined,
            enclosingLoopTableId: null,
            handleChange: () => undefined,
            handlePatch: () => undefined,
            onSetDynamicBinding: () => undefined,
            onClearDynamicBinding: () => undefined,
          })}
        </StepUpContext.Provider>,
      )

      await waitFor(() => screen.getByTestId('form-settings-panel'))
      expect(screen.queryByTestId('property-control-mode')).toBeNull()
      expect(screen.queryByTestId('property-control-formId')).toBeNull()
      expect(screen.queryByTestId('property-control-targetTableId')).toBeNull()
      expect(screen.getByTestId('property-control-successBehavior')).toBeDefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

afterEach(cleanup)
