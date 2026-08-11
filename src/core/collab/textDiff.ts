/**
 * Minimal-splice bridge between string snapshots and Y.Text operations.
 *
 * The editor's text surfaces (contentEditable inline editing, the
 * properties-panel textarea) produce whole-string snapshots per input event.
 * Replacing the whole Y.Text would destroy concurrent remote edits; instead
 * the common prefix/suffix is preserved and only the changed middle is
 * spliced — so a remote insertion outside the splice survives the merge.
 */
import type * as Y from 'yjs'

export function applyTextDiff(text: Y.Text, oldValue: string, newValue: string): void {
  if (oldValue === newValue) return

  let prefix = 0
  const maxPrefix = Math.min(oldValue.length, newValue.length)
  while (prefix < maxPrefix && oldValue[prefix] === newValue[prefix]) prefix++

  let suffix = 0
  const maxSuffix = Math.min(oldValue.length, newValue.length) - prefix
  while (
    suffix < maxSuffix &&
    oldValue[oldValue.length - 1 - suffix] === newValue[newValue.length - 1 - suffix]
  ) {
    suffix++
  }

  const deleteCount = oldValue.length - prefix - suffix
  if (deleteCount > 0) text.delete(prefix, deleteCount)
  const inserted = newValue.slice(prefix, newValue.length - suffix)
  if (inserted.length > 0) text.insert(prefix, inserted)
}
