/**
 * Editor save bridge — lets the MCP editor-bridge listener flush a pending
 * draft save synchronously after a write tool runs.
 *
 * The built-in agent panel never needs this: its server-side read tools read
 * the browser-posted snapshot, so they always see live state. MCP's headless
 * read tools (`read_styles`, content reads) hit the DB, so a browser write that
 * only landed in the editor store would be invisible until the 30 s autosave
 * fires. `usePersistence` registers its save callback here; `useEditorMcpBridge`
 * calls `flushEditorSave()` right after a mutating tool so a follow-up headless
 * read sees the change.
 */
let saveFn: (() => Promise<void>) | null = null

/** Registered by `usePersistence`. Returns an unregister cleanup. */
export function registerEditorSave(fn: () => Promise<void>): () => void {
  saveFn = fn
  return () => {
    if (saveFn === fn) saveFn = null
  }
}

/** Flush a pending draft save. No-op when the editor isn't mounted. */
export async function flushEditorSave(): Promise<void> {
  if (saveFn) await saveFn()
}
