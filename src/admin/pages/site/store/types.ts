/**
 * Editor store — combined-state type.
 *
 * `EditorStore` is declared here as an EMPTY interface that each slice file
 * augments via `declare module './types' { interface
 * EditorStore extends MySlice {} }`. By the time a consumer references
 * `EditorStore`, all slice files have been loaded by the TS compiler and the
 * augmentations have merged together — `EditorStore` resolves to the full
 * union of every slice's state and actions.
 *
 * Why this shape?
 *
 * The naïve form — `export type EditorStore = SiteSlice & CanvasSlice & …` —
 * forces this module to import each slice's type, while every slice file
 * needs to import `EditorStore` for its `StateCreator<EditorStore, …, MySlice>`
 * generic. That creates a static-graph cycle (`types → slice → types`) at the
 * type level. The cycle is harmless at runtime (every edge is `import type`,
 * erased by tsc), but tools like madge that don't distinguish type-only
 * imports flag it as a circular dependency.
 *
 * Module augmentation breaks the cycle structurally:
 *   • `types.ts` imports nothing — it's a leaf node.
 *   • Each slice imports `EditorStore` (one-way).
 *   • Each slice extends `EditorStore` via `declare module` (no source-level
 *     import edge created — augmentation is type-system-only).
 *
 * To register a new slice:
 *   1. Define and export its slice interface from the slice file.
 *   2. Add a `declare module './types'` block alongside the
 *      slice interface declaring `interface EditorStore extends MySlice {}`.
 *   3. Wire its creator into `./store.ts`.
 *
 * NOTE: Don't add slice fields here directly. The whole point is that the
 * slice files own their own state shape and contribute it via augmentation.
 */
// EditorStore intentionally starts empty; slice files augment it.
// Allowed by `@typescript-eslint/no-empty-object-type`'s `allowWithName` rule
// configured in `eslint.config.js`.
export interface EditorStore {}

/**
 * Shared StateCreator alias for slices in the mutative-wrapped store.
 *
 * The store at `./store.ts` is composed via:
 *   create<EditorStore>()(subscribeWithSelector(mutative((...args) => ({...slices}))))
 *
 * The mutative middleware (zustand-mutative) lets slice writers mutate `state`
 * directly inside `set((state) => { state.foo = bar })` and applies Mutative's
 * `create()` for them. For TypeScript to type `set` accordingly (i.e. accept
 * void-returning mutators rather than requiring a returned new state), the
 * StateCreator needs the `['zustand/mutative', never]` mutator marker in its
 * second type parameter.
 *
 * Use this alias in every slice instead of `StateCreator<EditorStore, [], [], T>`.
 *
 * IMPORTANT: never call `create()`/`produce()` manually inside `set()`. The
 * middleware already does. Manual nesting yields revoked proxies in subscribers.
 * (`runHistoricMutation` is the one deliberate exception — it calls mutative
 * `create(get(), …, { enablePatches: true })` on a plain snapshot, NOT on a live
 * draft, to harvest the patches that feed the collab write path.)
 */
import type { Mutate, StateCreator, StoreApi } from 'zustand'
export type EditorStoreSliceCreator<T> = StateCreator<
  EditorStore,
  [['zustand/mutative', never]],
  [],
  T
>

/**
 * The editor store's api as the mutative middleware actually augments it: its
 * `setState` accepts a void-returning draft recipe, not just a partial.
 *
 * Anything that holds the store by reference (the collab binding, the plugin
 * runtime) must type it with this alias. A bare `StoreApi<EditorStore>` erases
 * the augmentation, which forces callers to either cast or hand-roll partial
 * patches — and a hand-rolled patch cannot reuse the draft-mutating helpers the
 * slices share, so state invariants get reimplemented and drift.
 */
export type EditorStoreApi = Mutate<StoreApi<EditorStore>, [['zustand/mutative', never]]>
