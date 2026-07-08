# Content Workspace

The admin UI for creating and editing content entries across collections, accessible at `/admin/content`.

The Content workspace renders a three-pane shell — explorer sidebar, document canvas, and settings panel — using `AdminWorkspaceCanvasLayout`. Collections map to `data_tables` of `kind: 'postType'`; entries are `data_rows`. The body field stores and round-trips through a single Tiptap/ProseMirror document serialized to markdown.

---

## TL;DR

- **Entry:** `ContentPage.tsx` → `AdminWorkspaceCanvasLayout` — left sidebar, canvas, right settings panel.
- **Body editor:** `TiptapBodyEditor` — one ProseMirror document, not a block list. Body persists as markdown text in the `body` cell.
- **Inline marks:** bubble menu (B / I / code / strike / link). Block inserts: slash menu (`/`) + notch quick-actions.
- **Canvas modes:** `write` (bare editor surface) and `live` (entry rendered inside its template with real site styles).
- **Settings panel:** `ContentSettingsPanel` — entry-specific; hidden when no entry is selected. Reopened via the top-right notch when collapsed.
- **Hooks:** `useContentWorkspace` (CRUD + selection), `useContentEntryDraft` (field state + save/publish), `useContentMediaPicker` (media modal + featured media).
- **AI assistant:** `ContentAgentMount` docks the shared Agent Panel in the content rail. It exposes the live workspace through a content-specific bridge so agent writes mutate the open draft/editor state, not stale database rows.

---

## Component structure

```text
ContentPage.tsx
├── AdminWorkspaceCanvasLayout
│   ├── contentSidebar → ContentSidebar
│   │   ├── ContentExplorerPanel    ← collection + entry list, context menus
│   │   ├── MediaExplorerPanel      ← shared media panel in the content rail
│   │   └── ContentAgentMount       ← AI assistant panel
│   ├── contentCanvas → ContentDocumentCanvas
│   │   ├── CanvasNotch             ← quick-insert actions (Heading, Text, Media, Data token)
│   │   ├── ContentModeToggle       ← write / live mode switch
│   │   ├── TiptapBodyEditor        ← ProseMirror body surface
│   │   │   ├── BodyBubbleMenu      ← floating marks toolbar (B/I/code/strike/link)
│   │   │   ├── BodyFloatingMenu    ← block-type switcher on empty lines
│   │   │   ├── BodySlashMenu       ← slash (/) command menu
│   │   │   └── MediaNodeToolbar    ← toolbar on selected media nodes
│   │   └── LiveCanvas              ← template-rendered live preview
│   └── contentRightPanel → ContentSettingsPanel (entry-specific; absent when no entry)
```

---

## Body editor

`TiptapBodyEditor.tsx` is a single Tiptap 3 / ProseMirror document — not a list of independent block widgets.

### Storage

The canonical body is a **markdown string** in the `body` cell of the data row. The editor converts on each change:

```text
markdown text (stored) ←→ ProseMirror JSON (in-editor)
```

Round-trip functions live in `src/core/markdown/markdownDocument.ts`:
- `markdownToProseMirrorDoc(md)` — parse markdown → ProseMirror node tree
- `proseMirrorDocToMarkdown(doc)` — serialize ProseMirror node tree → markdown

The serializer produces stable, idempotent output. Existing entries load with no migration; the grammar is a strict superset of what was stored before.

### Supported grammar

| Category | Examples |
|----------|---------|
| Inline marks | `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, `[link](url)` |
| Headings | `## H2`, `### H3`, `#### H4` (`# H1` normalised to `## H2` — H1 is reserved for the title) |
| Lists | `- ` / `* ` bullets, `1. ` ordered, nested via 2-space indents |
| Block quote | `> ` |
| Code block | triple-backtick fence with optional language |
| Horizontal rule | `---` |
| Tables | GFM pipe-table syntax |
| Media | `![alt](src)` for images, `@[video](src)` for videos |
| Data tokens | `{source.field}` — plain inline text in the editor; resolved by the publisher at render time |

### Insertion surfaces

| Surface | How |
|---------|-----|
| Bubble menu | Appears on text selection — bold / italic / code / strike / link |
| Slash menu (`/`) | Contextual command menu at the caret — headings, lists, quote, code block, divider, table, media, data token |
| Canvas notch | Top-center quick-action buttons — Heading, Text, Media, Insert data token. It does not show the Site editor's module picker. |
| Input rules | `# ` → H1 (normalised), `## ` → H2, `**x**` → bold, `- ` → bullet, `` ``` `` → code block, etc. |

### Imperative handle

`ContentDocumentCanvas` holds a `ref` to a `TiptapBodyEditorHandle`:

```ts
interface TiptapBodyEditorHandle {
  focusStart: () => void
  insertText: (text: string) => void
  insertMedia: (attrs: MediaAttributes) => void
  appendBlock: (kind: 'heading' | 'paragraph') => void
}
```

The parent calls this handle from the title-Enter handler, the notch actions, and the media-picker confirmation. The editor owns its own ProseMirror state; the parent never holds the doc tree.

### Why not drag-and-drop block reorder

The content editor is a document surface (one ProseMirror doc), not a visual editor canvas. Block reorder is done via cut/paste or keyboard move. Drag handles are the right primitive for the visual editor, not a writing surface.

---

## Collections and entries

Collections are `data_tables` with `kind: 'postType'`. The four system tables (`posts`, `pages`, `components`, `layouts`) are present on every install; additional collections are created via `ContentCollectionCreateDialog`.

`ContentExplorerPanel` renders all collections and their entries. Per-entry operations (publish, convert to draft, rename, duplicate, delete, move to collection) are exposed via context menus (`ContextMenu` per row).

`useContentWorkspace` (`src/admin/pages/content/hooks/useContentWorkspace.ts`) owns all collection and entry CRUD, loading state, and selection. It does not hold draft field state — that lives in `useContentEntryDraft`.

---

## Settings panel and reopen notch

`ContentSettingsPanel` is the right-hand panel. It is entry-specific: it renders only when an entry is selected (`contentRightPanel` is `undefined` when `workspace.selectedEntry` is `null`).
`AdminWorkspaceCanvasLayout` treats an absent `contentRightPanel` as "no right panel available",
so a persisted open state never reserves an empty right rail on a fresh install or after the last entry is cleared.

The panel exposes: status selector, slug, author (if the user has `canEditAnyContent`), collection (move entry), SEO title, SEO description, featured media — followed by the collection's **custom (non-built-in) fields**, rendered generically through the Data workspace's `CellEditorRenderer` (`context="detail"`). Relation fields open the shared `RelationPickerDialog` (target-table rows resolved for display by `useRelationTargetRows`); media fields carry their own picker. `pageTree` / `fieldSchema` fields are excluded — their cells hold whole documents, not values. Custom values live in `useContentEntryDraft`'s `customCells` and save through the same Save / Publish lifecycle as the built-ins.

When the panel is collapsed and an entry is selected, `AdminWorkspaceCanvasLayout` renders a compact notch in the top-right corner of the canvas (`data-testid="content-settings-notch"`) with a button labelled "Open settings panel". Clicking it reopens the panel without changing the selected entry. See [docs/editor.md](../editor.md) — "Admin shell layout" for the notch's implementation context.

---

## Canvas modes

`ContentModeToggle` switches between:
- **Write** (`contentMode === 'write'`): bare editor surface (`ContentDocumentCanvas` with `TiptapBodyEditor`).
- **Live** (`contentMode === 'live'`): entry rendered inside its template via `LiveCanvas`, with real site styles and inline editing.

The mode switch is client-only. The markdown body is the source of truth in both modes.

---

## Hooks

| Hook | Source | Owns |
|------|--------|------|
| `useContentWorkspace` | `hooks/useContentWorkspace.ts` | Collection list, entry list, selection, CRUD operations, error state |
| `useContentEntryDraft` | `hooks/useContentEntryDraft.ts` | In-memory field state (`title`, `body`, `slug`, `featuredMediaId`, `seoTitle`, `seoDescription`, plus `customCells` for the collection's non-built-in fields), save / publish / status-change handlers |
| `useContentMediaPicker` | `hooks/useContentMediaPicker.ts` | Media picker modal open/close, featured media asset hydration, body media insert |

---

## AI assistant

The Content workspace has its own `content` chat scope, mounted as the `agent` panel in `ContentSidebar` when the current user has `ai.chat`.

`ContentAgentMount` creates a fresh per-page `AgentSlice` store (`contentAgentStore.ts`) and registers a `ContentBridgeHandle` for the mounted `ContentPage`. The handle reads the current collections, selected entry, draft fields, schema, and current user via refs so the agent sees the same state the user sees. Tool writes go through that handle and then through `useContentWorkspace` / `useContentEntryDraft`, which keeps unsaved body/title/SEO/media changes and sidebar selection in sync.

The server registers 15 content-scope tools:

| Group | Tools |
|---|---|
| Server reads | `content_list_collections`, `content_get_collection_schema`, `content_list_documents`, `content_get_document`, `content_search_documents`, `content_list_users`, `content_list_media` |
| Browser writes/navigation | `content_create_document`, `content_delete_document`, `content_set_document_status`, `content_set_document_field`, `content_set_document_fields`, `content_set_document_author`, `content_set_active_document`, `content_set_active_collection` |

Body content is exchanged with the model as markdown. The browser bridge converts it to/from the Tiptap document when applying field writes, so the persisted `body` cell remains the same markdown source of truth used by the manual editor.

---

## Forbidden patterns

| Pattern | Why |
|---------|-----|
| Mutating block state via a block ID list | There are no blocks — one ProseMirror document, not a `ContentBlock[]` list |
| Calling `insertText` / `insertMedia` without checking `bodyEditorRef.current` | The ref is null before the editor mounts |
| Storing ProseMirror JSON in the `body` cell | Body is always markdown text; the editor does the conversion |
| Adding `useMemo` / `useCallback` in ContentPage or its hooks | React Compiler handles memoization; the only exception is async handlers extracted to module scope to avoid compiler bail-out (see `useContentEntryDraft`) |
| Opening the settings panel via a forced `setPropertiesPanel({ collapsed: false })` on mount | The persisted layout is the source of truth; only user actions (selecting an entry, clicking the notch) open the panel |
| Mutating content-agent writes directly against repositories | The browser bridge owns writes so unsaved draft state and the open Tiptap editor do not desync |

---

## Related

- [docs/editor.md](../editor.md) — admin shell layouts, `AdminWorkspaceCanvasLayout`, notch implementation
- [docs/features/data-workspace.md](data-workspace.md) — parallel workspace pattern for raw data tables
- [docs/features/content-storage.md](content-storage.md) — `data_tables` + `data_rows` schema, field types
- [docs/features/media.md](media.md) — media workspace, `MediaPickerModal`, upload pipeline
- [docs/features/agent.md](agent.md) — shared AI runtime, content-scope tools, and browser bridge
- Source-of-truth files:
  - `src/admin/pages/content/ContentPage.tsx` — workspace mount point
  - `src/admin/pages/content/agent/ContentAgentMount.tsx` — content Agent Panel mount and bridge registration
  - `src/admin/pages/content/agent/contentBridge.ts` — content agent browser-tool dispatcher
  - `src/admin/pages/content/agent/contentBridgeHandle.ts` — live content workspace bridge handle
  - `src/admin/pages/content/TiptapBodyEditor.tsx` — body editor
  - `src/admin/pages/content/hooks/useContentWorkspace.ts` — collection/entry state
  - `src/admin/pages/content/hooks/useContentEntryDraft.ts` — field draft state
  - `src/core/markdown/markdownDocument.ts` — markdown ↔ ProseMirror round-trip
  - `src/admin/layouts/AdminWorkspaceCanvasLayout/AdminWorkspaceCanvasLayout.tsx` — workspace shell + notch
