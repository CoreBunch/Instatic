/**
 * Content-source decision for `base.submit`, shared by the publisher
 * `render()` path (`index.ts`) and the canvas preview (`FormControls.tsx`) so
 * the two cannot drift. Mirrors `base.link`'s `linkUsesChildren` — see
 * `@modules/base/link/content` for why this is an explicit count check rather
 * than a `children ?? label` short-circuit (an empty children array is not
 * nullish).
 *
 * Rule: a submit button renders its children whenever it HAS children;
 * otherwise it falls back to the `label` prop. Imported icon-only submits
 * (an inline `<svg>` arrow, an icon-font `<i>`, an `<img>`) carry their icon
 * as real child nodes and must not be flattened to the label text.
 *
 * Non-component `.ts` leaf so the editor component can import it without
 * breaking React Fast Refresh (Constraint #309).
 */

/**
 * Whether the submit button should render its own children (`true`) or fall
 * back to the `label` prop (`false`), given how many rendered children it has.
 */
export function submitUsesChildren(childCount: number): boolean {
  return childCount > 0
}
