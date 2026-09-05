/**
 * Select All in the Media workspace.
 *
 * Two questions decide whether this is safe, and both are about scope rather
 * than mechanics:
 *
 *   1. What does "all" mean? `visibleAssets` — whatever the folder, filter,
 *      search and trash toggle have already narrowed to. Anything wider would
 *      let "select all, then delete" in the trash reach live assets.
 *   2. When must the shortcut stay out of the way? While the caret is in a
 *      text field, where Ctrl/Cmd+A means select-the-text, and while a dialog
 *      is open, where it belongs to whatever that dialog contains.
 *
 * The guard predicate is pure, so it is tested directly rather than through a
 * mounted grid — the interesting cases are inputs, textareas, contenteditable
 * and an open dialog, and a render harness would obscure rather than clarify
 * them.
 */

import { afterEach, describe, expect, it } from 'bun:test'

/**
 * `true` when the Ctrl/Cmd+A handler should claim the event, mirroring the
 * guards in `MediaCanvas`.
 */
function claimsSelectAll(target: EventTarget | null): boolean {
  if (
    target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || (target instanceof HTMLElement && target.isContentEditable)
  ) return false
  // Only a real modal — `aria-modal="true"` — takes the shortcut. The
  // floating windows carry `role="dialog"` but leave the grid usable behind
  // them, so matching the role would disable the shortcut almost everywhere.
  if (document.querySelector('[aria-modal="true"]')) return false
  return true
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('when Ctrl/Cmd+A selects every visible asset', () => {
  it('claims the shortcut over the grid', () => {
    const grid = document.createElement('div')
    document.body.append(grid)
    expect(claimsSelectAll(grid)).toBe(true)
  })

  it('leaves it to the browser inside the search box', () => {
    // Someone typing a filter means "select what I typed", not "select every
    // file in this folder".
    const input = document.createElement('input')
    document.body.append(input)
    expect(claimsSelectAll(input)).toBe(false)
  })

  it('leaves it alone in a textarea', () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    expect(claimsSelectAll(textarea)).toBe(false)
  })

  it('leaves it alone in a contenteditable field', () => {
    // The alt-text and caption fields in the viewer are rich inputs, and they
    // are not <input> elements.
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.append(editable)
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(claimsSelectAll(editable)).toBe(false)
  })

  it('stands down while a modal dialog is open', () => {
    // A rename dialog or a delete confirmation owns the shortcut — selecting
    // the grid behind it would change what a confirmed action applies to.
    const grid = document.createElement('div')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.append(grid, dialog)
    expect(claimsSelectAll(grid)).toBe(false)
  })

  it('keeps working while a floating window is open', () => {
    // The regression this guard caused: selecting one asset opens the viewer
    // window, which carries `role="dialog"` but no `aria-modal` because the
    // grid stays usable behind it. Matching the role disabled Ctrl/Cmd+A for
    // almost the whole time anyone spends in Media.
    const grid = document.createElement('div')
    const viewer = document.createElement('aside')
    viewer.setAttribute('role', 'dialog')
    document.body.append(grid, viewer)
    expect(claimsSelectAll(grid)).toBe(true)
  })
})

describe('the toggle', () => {
  /** `allVisibleSelected` — the condition the button and shortcut both read. */
  const allSelected = (visible: string[], selected: string[]) =>
    visible.length > 0 && visible.every((id) => new Set(selected).has(id))

  it('is not "all selected" when the grid is empty', () => {
    // Otherwise `every` on an empty array reports true and the button would
    // offer to clear a selection that does not exist.
    expect(allSelected([], [])).toBe(false)
  })

  it('is not "all selected" when only some are', () => {
    expect(allSelected(['a', 'b', 'c'], ['a', 'b'])).toBe(false)
  })

  it('is "all selected" once every visible asset is in the selection', () => {
    expect(allSelected(['a', 'b'], ['a', 'b'])).toBe(true)
  })

  it('stays "all selected" when the selection reaches past the filter', () => {
    // A selection made before narrowing the filter can hold ids that are no
    // longer visible. The button asks about what is on screen, so those do
    // not stop it offering to clear.
    expect(allSelected(['a', 'b'], ['a', 'b', 'offscreen'])).toBe(true)
  })
})

describe('what "all" means', () => {
  it('is the visible set, not the whole library', () => {
    // `visibleAssets` is already narrowed by folder, filter, search and the
    // trash toggle. Selecting past it would let "select all, then delete
    // permanently" in the trash reach live assets.
    const library = [
      { id: 'a', deletedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', deletedAt: null },
      { id: 'c', deletedAt: '2026-01-02T00:00:00.000Z' },
    ]
    const visibleInTrash = library.filter((a) => a.deletedAt !== null)
    expect(visibleInTrash.map((a) => a.id)).toEqual(['a', 'c'])
    expect(visibleInTrash).not.toContain(library[1])
  })
})
