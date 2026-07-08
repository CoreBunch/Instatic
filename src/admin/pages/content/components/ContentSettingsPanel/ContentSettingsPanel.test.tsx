/**
 * ContentSettingsPanel — custom (non-built-in) field rendering.
 *
 * Regression for GH-163: fields the user adds to a post type must be
 * editable from the Content page's settings sidebar. The built-ins keep
 * their dedicated inputs; everything else renders generically through
 * `CellEditorRenderer`.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { buildPostTypeDefaultFields } from '@core/data/fields'
import type { DataRow, DataTable } from '@core/data/schemas'
import { ContentSettingsPanel } from './ContentSettingsPanel'

afterEach(cleanup)

function fakeCollection(): DataTable {
  return {
    id: 'tbl_posts',
    name: 'Posts',
    slug: 'posts',
    kind: 'postType',
    singularLabel: 'Post',
    pluralLabel: 'Posts',
    routeBase: '/blog',
    primaryFieldId: 'title',
    fields: [
      ...buildPostTypeDefaultFields(),
      { type: 'text', id: 'subtitle', label: 'Subtitle', description: 'Shown under the title' },
      {
        type: 'select',
        id: 'category',
        label: 'Category',
        options: [{ id: 'opt_news', label: 'News', value: 'news' }],
      },
      { type: 'boolean', id: 'featured', label: 'Featured' },
    ],
    system: true,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function fakeEntry(): DataRow {
  return {
    id: 'row_1',
    tableId: 'tbl_posts',
    cells: { title: 'Hello', slug: 'hello', subtitle: 'World' },
    slug: 'hello',
    status: 'draft',
    authorUserId: null,
    createdByUserId: null,
    updatedByUserId: null,
    publishedByUserId: null,
    author: null,
    createdBy: null,
    updatedBy: null,
    publishedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    publishedAt: null,
    scheduledPublishAt: null,
    deletedAt: null,
  }
}

async function renderPanel(overrides: Partial<Parameters<typeof ContentSettingsPanel>[0]> = {}) {
  const collection = fakeCollection()
  const onCustomCellChange = mock(() => {})
  render(
    <ContentSettingsPanel
      selectedEntry={fakeEntry()}
      authors={[]}
      authorsLoading={false}
      collections={[collection]}
      tables={[collection]}
      selectedCollection={collection}
      loading={false}
      slug="hello"
      slugId="slug-id"
      seoTitle=""
      seoTitleId="seo-title-id"
      seoDescription=""
      seoDescriptionId="seo-description-id"
      publicPath="/blog/hello"
      mediaError={null}
      featuredMediaId={null}
      featuredMediaAsset={null}
      customCells={{ subtitle: 'World' }}
      canEditEntry
      canMoveEntry
      canPublishEntry
      canChangeAuthor={false}
      onCollectionChange={mock(() => {})}
      onAuthorChange={mock(() => {})}
      onSlugChange={mock(() => {})}
      onSeoTitleChange={mock(() => {})}
      onSeoDescriptionChange={mock(() => {})}
      onCustomCellChange={onCustomCellChange}
      onStatusChange={mock(() => {})}
      onChooseFeaturedMedia={mock(() => {})}
      onClearFeaturedMedia={mock(() => {})}
      onEditFeaturedMedia={mock(() => {})}
      {...overrides}
    />,
  )
  // Wait for the lazy ContentCustomFields chunk to mount, then flush the
  // closed RelationPickerDialog's async no-op row load so its setState lands
  // inside act() instead of warning after the test body.
  await screen.findByTestId('content-custom-field-subtitle')
  await act(async () => {})
  return { onCustomCellChange }
}

describe('ContentSettingsPanel custom fields', () => {
  it('renders an editor for every custom field, none for built-ins', async () => {
    await renderPanel()

    expect(screen.getByTestId('content-custom-field-subtitle')).toBeTruthy()
    expect(screen.getByTestId('content-custom-field-category')).toBeTruthy()
    expect(screen.getByTestId('content-custom-field-featured')).toBeTruthy()
    // Built-ins keep their dedicated inputs — no generic editor for them.
    expect(screen.queryByTestId('content-custom-field-title')).toBeNull()
    expect(screen.queryByTestId('content-custom-field-body')).toBeNull()
  })

  it('shows the draft value and the field description', async () => {
    await renderPanel()

    const subtitleInput = screen.getByLabelText('Subtitle') as HTMLInputElement
    expect(subtitleInput.value).toBe('World')
    expect(screen.getByText('Shown under the title')).toBeTruthy()
  })

  it('propagates edits through onCustomCellChange', async () => {
    const { onCustomCellChange } = await renderPanel()

    fireEvent.change(screen.getByLabelText('Subtitle'), { target: { value: 'Universe' } })

    expect(onCustomCellChange).toHaveBeenCalledWith('subtitle', 'Universe')
  })

  it('renders custom fields read-only when the user cannot edit the entry', async () => {
    await renderPanel({ canEditEntry: false })

    const subtitleInput = screen.getByLabelText('Subtitle') as HTMLInputElement
    expect(subtitleInput.readOnly).toBe(true)
  })
})
