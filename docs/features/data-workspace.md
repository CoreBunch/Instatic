# Data Workspace

The admin UI for managing `data_tables` schemas and raw-row editing, accessible at `/admin/data`.

The Data workspace lets operators define and edit table schemas (field types, routing, display settings) and directly inspect or edit individual rows. It has no Zustand store of its own — all data is fetched and mutated via the `useDataWorkspace` hook in `src/admin/pages/data/hooks/useDataWorkspace.ts`.

---

## TL;DR

- **Entry:** `DataPage.tsx` → `DataCanvas.tsx` — three-pane layout: sidebar + grid + inspector.
- **DataSidebar:** table list, table creation, import/export entry points.
- **DataGrid:** read-only spreadsheet over `data_rows` — cells display via `CellDisplayRenderer`, editing opens in the inspector. Owns search, status filter, sort, selection, group collapse, and column resize state. Sub-components handle toolbar, header row, group headers, skeleton loading, empty state, and bulk actions.
- **DataInspector:** right panel — switches between `RowDetail` (cell editor) and `TableSettings` (schema editor) based on row selection.
- **Context menus:** `DataTableContextMenu` handles table-list actions; `DataRowContextMenu` handles grid-row actions. Both use the shared `ContextMenu` primitive.
- **NewTableDialog** creates collection identity and its full field schema in one atomic request.
- **FieldSchemaComposer** is shared by new-table setup and `TableSettings`; `NewFieldDialog` also uses the same definitions for repeater item schemas.
- **TableSettings** adapts persisted-table locks and warnings into the shared composer through `FieldsSection`.
- Field classification: three tiers — mandatory built-ins (locked), optional built-ins (editable/deletable with badge), custom fields (fully editable/deletable).
- `RepeaterCell` authors ordered structured items with add, duplicate, reorder, and delete actions. A media-only repeater delegates to `MediaRepeaterGallery`, which reuses the Media workspace asset rows/tiles and shared grid/list preference.
- Mutations to system `page` and `component` rows request a retained Site-editor reload through `requestCmsSiteReload()` so `/admin/site` sees Data-created pages and Visual Components even when the editor store was already hydrated.

---

## Component structure

```text
DataPage.tsx
└── DataCanvas.tsx
    ├── DataSidebar.tsx             ← table list, new-table dialog, import/export
    │   └── DataTableContextMenu.tsx ← right-click table actions
    ├── DataGridSkeleton.tsx        ← full-canvas skeleton before any table is selected
    ├── DataGrid.tsx                ← container: owns interaction state, wires sub-components
    │   ├── DataGridToolbar.tsx     ← two-row header: title/subtitle, search, add row, sort indicator
    │   │   └── DataGridViewChips.tsx ← pill-style status/scope filter chips
    │   ├── DataGridHeaderRow.tsx   ← column header row: select-all checkbox + per-field headers
    │   │   └── DataGridHeaderCell.tsx ← single column header: type icon + label + sort caret
    │   ├── DataGridGroupHeader.tsx ← collapsible status section header (Published / Drafts / Archived)
    │   ├── DataGridRow.tsx         ← data row cells
    │   ├── DataGridSkeletonRows.tsx ← per-row shimmer cells during row loading
    │   ├── DataGridEmptyState.tsx  ← "no rows" message (empty table vs filtered result)
    │   ├── DataGridBulkActionBar.tsx ← floating bar for bulk publish / export / delete
    │   ├── DataRowContextMenu.tsx  ← right-click row actions
    │   ├── dataGridRows.ts         ← pure helpers: filter/sort/group pipeline, column sizing
    │   ├── useDataGridSelection.ts ← bulk-select state hook
    │   └── cells/                 ← per-type cell display + editor components
    └── DataInspector.tsx          ← right-hand inspector panel
        ├── RowDetail.tsx           ← row selected: cell-by-cell editor
        └── TableSettings.tsx       ← no row selected: schema + metadata editor
            └── FieldsSection.tsx   ← persisted-table adapter
                └── FieldSchemaComposer

NewTableDialog.tsx
└── FieldSchemaComposer             ← local schema draft submitted with table identity
    ├── FieldRow.tsx                ← ordered field summary
    └── NewFieldDialog.tsx          ← add/edit definition and repeater sub-fields
```

---

## DataInspector

`DataInspector.tsx` renders `RowDetail` when a row is selected or `TableSettings` when no row is selected. Both views are inside the same panel; the switch is driven by a `row: DataRow | null` prop.

```tsx
// DataInspector.tsx (simplified)
{row !== null ? (
  <RowDetail row={row} table={table} ... />
) : (
  <TableSettings table={table} rows={rows} ... />
)}
```

---

## TableSettings and field management

`TableSettings.tsx` renders collapsible sections (General, Routing, Schema, Kind, Danger zone). The **Schema** section delegates to `FieldsSection`; each eligible field row carries a star action for assigning the primary field directly where the structure is defined.

**System tables** (`posts`/`pages`/`components`/`layouts`) render a **reduced** panel containing only **Schema**, gated by `data.system.tables.manage`. General / Routing / Kind / Danger zone are hidden because a system table's identity is frozen (the server's `assertSystemTableUpdateAllowed` rejects identity + built-in-field changes for everyone). Managers can still add/manage **custom** fields and change the primary field from an eligible field row.

### Shared schema composer

`FieldSchemaComposer.tsx` owns the reusable field-list interaction:

- **Drag-and-drop reorder** — native HTML5 drag API; `handleDrop` reorders `table.fields` and calls `onUpdateTable`.
- **Edit** — opens `NewFieldDialog` with the author-facing label first and the immutable machine id/type beside each other.
- **Delete** — via `useConfirmDelete`; calls `onUpdateTable` with the field removed.
- **New field** — via `NewFieldDialog`.

For a new field, `NewFieldDialog` derives the machine ID from the label until
the author edits the ID manually. Existing IDs and types remain fixed so saved
row values keep stable keys.

`FieldsSection.tsx` computes table-specific lock, label, built-in, and delete
sets with `fieldGuards.ts`, then passes them into the composer.
`NewTableDialog.tsx` gives the same composer a local field array and submits
that array with collection identity in the single create request.

### Field classification — `fieldGuards.ts`

Tiers enforced by the guard functions:

| Tier | Field IDs | Edit affordance | Delete affordance |
|------|-----------|-----------------|-------------------|
| Mandatory built-in (postType) | `title`, `slug` | None — locked row, no edit/delete buttons | Blocked |
| Optional built-in (postType) | `body`, `featuredMedia`, `seoTitle`, `seoDescription` | Description + required only; label locked | Allowed |
| Built-in on a **system table** | every `builtIn` field | None — fully locked row | Blocked |
| Custom | all others | Fully editable | Allowed if not the primary field |

```ts
isMandatoryField(fieldId)           // title or slug on a postType
isOptionalBuiltIn(field)            // builtIn: true but not mandatory
isSystemBuiltInField(field, table)  // builtIn on a system table — frozen
isFieldFullyLocked(field, table)    // postType mandatory OR system built-in → no edit/delete/reorder
isFieldDeletable(field, table)      // false for primaryField or any fully-locked field
isLabelLocked(field, table)         // true for built-in postType fields and system built-ins
deleteTooltip(field, table)         // disabled-button tooltip text, or undefined
```

Built-in field **values** (row cells) stay editable on existing records everywhere, including the *structural* system tables (pages/components/layouts). The one remaining value lock is at **create** time: `protectedBuiltInCreateCellKey` (`@core/data/systemTableGuard`) rejects a create that supplies built-in cells for a structural system table, so those rows are born through their own authoring surfaces rather than the generic row endpoint. `posts` is exempt (`kind === 'postType'`), and the server enforces this in `server/handlers/cms/data/tables.ts`.

`FIELD_TYPE_LABELS` maps every `DataFieldType` to a human-readable string and
is shared by `FieldRow` and `FieldSchemaComposer`.

### Repeater authoring

`RepeaterCell.tsx` reads values through `readRepeaterCell`, initializes nested
cells through `emptyCellValue`, and writes the complete ordered value through
the ordinary row draft. Nested relation and media fields reuse their shared
pickers. Multi-media fields place `MediaPickerModal` in true multi-selection
mode: plain clicks toggle assets and the footer commits the entire selection.

When a repeater contains exactly one single-value media field,
`MediaRepeaterGallery.tsx` replaces the generic structured-item cards with the
Media workspace presentation. It renders the shared `AssetTile` / `AssetRow`
components, uses the same persisted grid/list switcher, fills empty slots from
a multi-selection picker, and keeps replace, reorder, and remove actions on
each asset. Removing an item never deletes the underlying Media library file.
Repeaters with additional fields continue to use the generic card editor.

---

## DataGrid

`DataGrid.tsx` is a read-only spreadsheet over `data_rows`. Cells render presentational chips / thumbnails / formatted values; editing opens in the row inspector. The file owns interaction state — search, status filter, sort, selection, group collapse, and column resize — and wires together focused sub-components.

### Sub-component breakdown

| File | Responsibility |
|------|----------------|
| `DataGridToolbar.tsx` | Two-row toolbar: title + row-count subtitle, search box, Add row button. Bottom row (publish-workflow tables): `DataGridViewChips` + active-sort indicator. |
| `DataGridViewChips.tsx` | Pill-style filter chips (All / Published / Scheduled / Drafts / Archived; Pages / Templates for page tables). |
| `DataGridHeaderRow.tsx` | Column header row: leading select-all checkbox, one `DataGridHeaderCell` per ordered field, trailing actions column. |
| `DataGridHeaderCell.tsx` | Single column header cell: field type icon + label + sort direction caret. Uses bare `<button>` (§8.8 exception — `role="columnheader"` inside CSS-Grid). |
| `DataGridGroupHeader.tsx` | Full-width collapsible section header (status dot + label + count). Uses bare `<button>` (§8.8 exception — grid-spanning disclosure toggle). |
| `DataGridRow.tsx` | One data row: checkbox, primary cell, field cells via `CellDisplayRenderer`, trailing action buttons. |
| `DataGridSkeletonRows.tsx` | Per-row shimmer cells shown while `loading === true`. Shared with `DataGridSkeleton` for identical column ladder + sticky positioning. |
| `DataGridEmptyState.tsx` | "No rows" message inside the grid. Distinguishes an empty table from a filter that matched nothing. |
| `DataGridBulkActionBar.tsx` | Floating action bar (via `FloatingActionBar`) visible when one or more rows are checked. Publish / draft / export / delete actions. |
| `DataGridSkeleton.tsx` | Full-canvas skeleton rendered by `DataCanvas` before any table is selected. Mirrors the grid chrome (toolbar, column header, rows) with generic column count. |
| `DataRowContextMenu.tsx` | Right-click row action menu — see [Context menus](#context-menus) below. |

### Pure helpers — `dataGridRows.ts`

All side-effect-free logic lives in `dataGridRows.ts` and is kept out of the component body:

- **Column sizing** — `getColumnWidth(field, isPrimary, primaryWidth)` maps field types to pixel widths.
- **Field ordering** — `getOrderedFields` puts the primary field first; `getSubtitleFieldId` identifies the slug field to collapse into the primary cell.
- **Filter + sort pipeline** — `filterAndSortRows({ rows, statusFilter, query, sort, … })` applies the status chip, text search, and comparator-based sort in order.
- **Grouping** — `groupRowsByStatus(visibleRows, hasPublishWorkflow, statusFilter)` buckets rows into `RowGroup[]` for publish-workflow tables when the active chip is `all` / `pages` / `templates`.
- **Status counts** — `computeStatusCounts(rows)` drives the chip badges.

### Selection state — `useDataGridSelection.ts`

`useDataGridSelection(visibleRows)` returns `DataGridSelection`: the checked id set, derived `allChecked` / `someChecked` / `headerChecked` flags, and `toggleRow` / `toggleAll` / `clearSelection` mutators. Selection is preserved across filter changes; the header checkbox reflects only currently-visible rows.

### Cell display

`CellDisplayRenderer.tsx` dispatches to the per-type display component from `cells/` based on `field.type`. The grid is read-only — `CellEditorRenderer.tsx` is used by `RowDetail.tsx` inside the inspector, not by the grid.

The primary-column width is persisted to `localStorage` via `usePrimaryColumnWidth.ts` (key: `instatic-data-grid-primary-widths-v1`).

Header cells render the field type icon by calling `getFieldIcon(field.type)({ size: 13 })` directly — not as a JSX component — to avoid the `react-hooks/static-components` lint rule for a plain icon call.

### Context menus

Right-click actions follow the same pattern used by the Site, Content, and Media workspaces:

- `DataGrid.tsx` selects the right-clicked row, stores the click coordinates, and renders `DataRowContextMenu` through the shared `ContextMenu` primitive.
- Page and component rows expose **Open in Site editor**. Post-type rows expose **Edit in Content**. Plain data rows expose **Open row**.
- Publish-workflow tables (`postType`, `page`, `component`) expose row-level **Publish**, **Move to draft**, and **Archive** actions when the caller provides `onSetRowStatus`.
- Row duplicate, export, and delete actions reuse the same workspace handlers as Add row, the bulk action bar, and trailing row buttons. Duplication calls `buildDuplicateRowCells` (`src/core/data/duplicateRow.ts`) — it deep-clones the cells, appends `(copy)` to the title, and generates a unique slug that avoids collisions with existing sibling rows.
- `DataSidebar.tsx` selects the right-clicked table and renders `DataTableContextMenu`. The menu exposes **Open table**, **Table settings**, and **Delete table**.
- Table deletion is disabled in the menu for system tables, tables with rows, and sessions without table-management permission. The explanatory tooltip comes from the Button primitive's `aria-disabled` path.

Unhandled admin right-clicks are intercepted by `src/admin/shared/AdminContextMenuGuard/`. Existing app menus call `preventDefault()` at their source, so the guard only shows its danger flash when no app context menu handled the event.

---

## Import / export

Bulk transfer is split by direction:

- Import opens the global canonical Site Import modal (`src/admin/modals/SiteImport`). A CMS-exported `SiteBundle` JSON is detected there, previewed against `/admin/api/cms/import/preview`, and applied through `/admin/api/cms/import`. Successful bundle imports emit an admin event so mounted Data views refresh their table and row caches.
- `ExportDialog.tsx` / `useExportEstimate.ts` — count estimate → CMS bundle JSON download.

Both actions are opened from `DataSidebar`.

---

## Forbidden patterns

| Pattern | Why |
|---------|-----|
| Reaching into `cells_json` directly | Use the readers in `src/core/data/cells.ts` |
| Reimplementing title copy naming or slug collision logic when duplicating rows | Use `buildDuplicateRowCells` from `src/core/data/duplicateRow.ts` |
| Comparing field classification inline | Import from `fieldGuards.ts` |
| Adding a `kind === 'postType'` branch inside `FieldsSection` | Classification belongs in `fieldGuards.ts`; `FieldsSection` reads `isMandatoryField`, `isOptionalBuiltIn`, etc. |
| Editing a field's type or machine id after creation | `NewFieldDialog` disables both while editing so stored row values keep stable keys |
| Allowing a repeater inside a repeater | `RepeaterItemFieldSchema` excludes `repeater`, `pageTree`, and `fieldSchema` |
| Writing manual `useMemo`/`useCallback` in any of these components | React Compiler auto-memoizes; use only the repository-level documented exceptions |
| Putting filter / sort / group logic in `DataGrid.tsx` | That logic lives in `dataGridRows.ts` (pure, side-effect free). `DataGrid.tsx` only holds interaction state and wires sub-components. |
| Treating the DataGrid as an inline cell editor | The grid is read-only. `CellEditorRenderer.tsx` belongs to the inspector (`RowDetail.tsx`), not to the grid. |
| Adding a "Table settings" shortcut to the `DataPage` toolbar | `TableSettings` is reached by deselecting a row — the inspector switches automatically. A duplicate toolbar affordance was removed; `src/__tests__/admin/data/dataPageToolbar.test.ts` prevents it from returning. |

---

## Related

- [docs/features/content-storage.md](content-storage.md) — `DataField` schema, field types, `data_tables` / `data_rows` structure
- [docs/reference/ui-primitives.md](../reference/ui-primitives.md) — `Button`, `Input`, `Select`, `Switch` usage
- [docs/reference/persistence-keys.md](../reference/persistence-keys.md) — `instatic-data-grid-primary-widths-v1`
- Source-of-truth files:
  - `src/admin/pages/data/` — all Data workspace components
  - `src/admin/pages/data/components/DataInspector/` — inspector, field management modules
  - `src/core/data/schemas.ts` — `DataField` union, `DataFieldType`
  - `src/core/data/fields.ts` — `isPostTypeBuiltInFieldId`, `POST_TYPE_MANDATORY_FIELD_IDS`
  - `src/core/data/cells.ts` — typed cell readers
  - `src/core/data/duplicateRow.ts` — `buildDuplicateRowCells` (title copy + slug collision avoidance)
