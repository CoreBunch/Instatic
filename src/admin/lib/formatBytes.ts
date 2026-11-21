/**
 * Human-readable byte size for admin surfaces: media assets, the upload
 * queue, package sizes in the Dependencies panel.
 *
 * Binary units (1 KB = 1024 B). KB/MB show one decimal, GB shows two.
 * Surfaces with different needs (estimate ranges, MB-capped font sizes)
 * keep their own bespoke formatters intentionally.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
