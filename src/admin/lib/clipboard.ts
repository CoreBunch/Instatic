/**
 * One guarded clipboard write for the whole admin app.
 *
 * Resolves `true` on success and `false` when the browser exposes no
 * clipboard write API (insecure context, older browser) or the write was
 * rejected — the rejection is logged here so callers only decide what, if
 * anything, the user sees.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch (err) {
    console.error('[clipboard] write failed:', err)
    return false
  }
}
