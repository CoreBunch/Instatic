// ---------------------------------------------------------------------------
// Server-side settings API — read / replace persisted plugin settings
// ---------------------------------------------------------------------------

export interface ServerPluginSettingsApi {
  /**
   * Resolve a single setting value, returning `undefined` if unset. Reads
   * the live mirror — settings saved in the admin UI (or via `replace`)
   * are pushed into the running plugin immediately, no reload required.
   * This server-side read is the ONLY surface that returns real secret
   * values — every browser-bound payload masks secrets to `'***'`.
   */
  get: <T extends string | number | boolean = string>(key: string) => T | undefined
  /** Snapshot of every declared setting, populated with defaults. */
  getAll: () => Record<string, string | number | boolean>
  /**
   * Replace the full settings record. Validated against the plugin's
   * declared schema before persistence; the host pushes the merged record
   * back into the running VM, then emits `settings.changed`. Only the
   * host (admin user) is expected to call this normally — plugins
   * mutating their own settings is allowed but rare.
   */
  replace: (next: Record<string, unknown>) => Promise<void>
}
